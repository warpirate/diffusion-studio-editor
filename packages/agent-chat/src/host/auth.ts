/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Signing in without leaving the app. The CLIs already own their logins —
// and theirs are the ones an Anthropic or OpenAI account is licensed for —
// so this runs `codex login` / `claude auth login` as children, forwards
// whatever URL or code they print, and reports how they ended. Nothing
// here implements an OAuth flow of its own.

import { spawn } from "node:child_process";

import { killTree, needsShell, quoteArg, resolveBinary, runOnce } from "./env";

import type { ChildProcess } from "node:child_process";
import type { AuthEvent, AuthMethod, HarnessId } from "../protocol";
import type { HostEnv } from "./env";

export type AuthEmit = (event: AuthEvent) => void;

export type LoginOutcome = { ok: boolean; detail?: string };

/** A login waits on a person, so it waits a long time — but not forever. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** How much of a child's output is kept for the failure message. */
const OUTPUT_MAX = 4096;

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/;
/** The shape every device flow prints: two groups of four, e.g. `WDJB-MJHT`. */
const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

/**
 * What a CLI says when it wanted a terminal and got a pipe. The app has no
 * TTY to give it, so the answer is the paste-a-token path instead.
 */
function needsTerminal(text: string): boolean {
  return /raw mode|not a tty|stdin is not|requires? (?:an? )?(?:interactive )?(?:terminal|tty)|ink.*raw/i.test(text);
}

function loginArgs(harness: HarnessId, method: AuthMethod): string[] {
  if (harness === "codex") return method === "device" ? ["login", "--device-auth"] : ["login"];
  return ["auth", "login", method === "console" ? "--console" : "--claudeai"];
}

function logoutArgs(harness: HarnessId): string[] {
  return harness === "codex" ? ["logout"] : ["auth", "logout"];
}

/**
 * The environment a login runs in: the user's, minus anything that would
 * pre-answer the question being asked. A stored token left in place would
 * make `claude auth status` report a login that the browser flow never made.
 */
function loginEnv(env: HostEnv): Record<string, string> {
  const { CLAUDE_CODE_OAUTH_TOKEN: _token, ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _auth, CODEX_API_KEY: _codex, ...rest } = env.env;
  return rest;
}

export class AuthRunner {
  private readonly emit: AuthEmit;
  private readonly log: (message: string) => void;
  private readonly running = new Map<HarnessId, ChildProcess>();

  constructor(emit: AuthEmit, log?: (message: string) => void) {
    this.emit = emit;
    this.log = log ?? (() => {});
  }

  /** Whether a login is running right now; a second one for the same harness is refused. */
  isRunning(harness: HarnessId): boolean {
    return this.running.has(harness);
  }

  /**
   * Runs the harness's login and resolves once the CLI has exited. Progress
   * — the URL to open, the code to type, each line it printed — arrives as
   * events while this is pending.
   */
  async login(harness: HarnessId, method: AuthMethod, env: HostEnv): Promise<LoginOutcome> {
    if (this.running.has(harness)) return { ok: false, detail: "A sign-in is already running" };
    const binary = resolveBinary(harness, env);
    if (!binary) return { ok: false, detail: `${harness === "codex" ? "Codex" : "Claude Code"} is not installed` };

    this.emit({ type: "started", harness, method });
    const shell = needsShell(binary);
    const args = loginArgs(harness, method);
    const child = spawn(shell ? `"${binary}"` : binary, shell ? args.map(quoteArg) : args, {
      env: loginEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
      shell,
      windowsHide: true,
    });
    this.running.set(harness, child);

    let output = "";
    let sentUrl = false;
    const onChunk = (chunk: Buffer | string) => {
      const text = String(chunk);
      output = (output + text).slice(-OUTPUT_MAX);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.emit({ type: "output", harness, text: trimmed });
        const url = URL_PATTERN.exec(trimmed)?.[0];
        // Only the first URL matters: what follows is usually the same one wrapped.
        if (url && !sentUrl) {
          sentUrl = true;
          const code = DEVICE_CODE_PATTERN.exec(output)?.[1];
          this.emit({ type: "url", harness, url, ...(code ? { code } : {}) });
        }
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    const timer = setTimeout(() => void killTree(child), LOGIN_TIMEOUT_MS);
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("exit", (exit) => resolve(exit));
    }).finally(() => {
      clearTimeout(timer);
      this.running.delete(harness);
    });

    // The exit code is a hint; whether the CLI reports a login is the answer.
    const signedIn = await this.check(harness, env);
    const outcome = this.outcome(harness, code, signedIn, output);
    this.emit({ type: "finished", harness, ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail } : {}) });
    if (!outcome.ok) this.log(`${harness} login failed: ${outcome.detail ?? "unknown"}`);
    return outcome;
  }

  private outcome(harness: HarnessId, code: number | null, signedIn: boolean | null, output: string): LoginOutcome {
    if (signedIn === true) return { ok: true };
    if (needsTerminal(output)) {
      return {
        ok: false,
        detail:
          harness === "claude"
            ? "Claude Code's sign-in needs a terminal. Run `claude setup-token` in one and paste the token here instead."
            : "Codex's sign-in needs a terminal. Try the device-code option, or run `codex login` in one.",
      };
    }
    if (signedIn === false || code !== 0) {
      const lastLine = output.split(/\r?\n/).filter((line) => line.trim()).pop();
      return { ok: false, detail: lastLine?.trim() || `Sign-in ended with code ${code ?? "none"}` };
    }
    // The CLI exited cleanly but has no way to report status: take it at its word.
    return { ok: true };
  }

  /** Ends a login that is still waiting on a browser. */
  cancel(harness: HarnessId): void {
    const child = this.running.get(harness);
    if (!child) return;
    this.running.delete(harness);
    void killTree(child);
    this.emit({ type: "finished", harness, ok: false, detail: "Sign-in cancelled" });
  }

  async logout(harness: HarnessId, env: HostEnv): Promise<void> {
    const binary = resolveBinary(harness, env);
    if (!binary) return;
    await runOnce(binary, logoutArgs(harness), env, 15_000);
  }

  /**
   * Whether the CLI reports a usable login. Null when it cannot say — an
   * older build with no status command — which the caller reads as "the
   * first turn will tell us".
   */
  async check(harness: HarnessId, env: HostEnv): Promise<boolean | null> {
    const binary = resolveBinary(harness, env);
    if (!binary) return false;
    if (harness === "claude") {
      const output = await runOnce(binary, ["auth", "status"], env, 10_000);
      if (!output) return null;
      try {
        const parsed = JSON.parse(output.slice(output.indexOf("{"))) as { loggedIn?: unknown };
        if (typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
      } catch {
        // Not JSON: fall through to reading the words.
      }
      return /not (?:logged|signed) in|logged out/i.test(output) ? false : /logged in|authenticated/i.test(output) ? true : null;
    }
    const output = await runOnce(binary, ["login", "status"], env, 10_000);
    if (!output) return null;
    return /not (?:logged|signed) in|logged out|no (?:stored )?credentials/i.test(output) ? false : true;
  }
}
