/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent chat host as a utility process: forked from the ESM bundle
// esbuild puts in dist/, configured over parentPort (never argv, which
// every process can read), restarted with backoff when it dies. The
// renderer asks for the endpoint over the existing IPC and talks to the
// host over its own WebSocket from there.

import { app, utilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { credentialKey } from "./credential-key";

import type { UtilityProcess } from "electron";

type AgentChatOptions = { dataDir: string; mcpUrl: string | null; version: string };

const DEV_ORIGIN = "http://localhost:5173";
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10_000];
const STOP_GRACE_MS = 3000;

let child: UtilityProcess | null = null;
let endpoint: { url: string } | null = null;
let options: AgentChatOptions | null = null;
let token = "";
let restarts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function spawn(): void {
  if (!options || stopped) return;
  const vaultKey = credentialKey();
  const path = join(app.getAppPath(), "dist", "agent-host.mjs");
  const proc = utilityProcess.fork(path, [], { serviceName: "Agent Chat", stdio: "inherit" });
  child = proc;

  proc.on("spawn", () => {
    proc.postMessage({
      type: "start",
      config: {
        token,
        dataDir: options!.dataDir,
        // Read at fork, not at start: the keychain is only ready once the
        // app is, and a null here just moves the vault to its own key file.
        ...(vaultKey ? { credentialKey: vaultKey } : {}),
        mcp: options!.mcpUrl ? { name: "diffusion", url: options!.mcpUrl } : null,
        version: options!.version,
        allowedOrigins: app.isPackaged ? ["file://", "null"] : ["file://", "null", DEV_ORIGIN],
      },
    });
  });

  proc.on("message", (message: { type?: string; url?: string; message?: string }) => {
    if (message?.type === "listening" && typeof message.url === "string") {
      endpoint = { url: message.url };
      restarts = 0;
      console.log(`[agent-chat] host listening at ${message.url.replace(/token=.*$/, "token=…")}`);
    } else if (message?.type === "error") {
      console.error(`[agent-chat] host failed to start: ${message.message}`);
    }
  });

  proc.on("exit", (code) => {
    if (child !== proc) return;
    child = null;
    endpoint = null;
    if (stopped) return;
    const delay = RESTART_DELAYS_MS[Math.min(restarts, RESTART_DELAYS_MS.length - 1)]!;
    restarts += 1;
    console.error(`[agent-chat] host exited (${code}); restarting in ${delay} ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawn();
    }, delay);
  });
}

/** Generates the token and forks the host. Call once, after `whenReady`. */
export function startAgentChat(next: AgentChatOptions): void {
  options = next;
  token = randomBytes(32).toString("base64url");
  stopped = false;
  restarts = 0;
  spawn();
}

/** Where the host is right now: null while it is (re)starting. */
export function agentChatEndpoint(): { url: string } | null {
  return endpoint;
}

/** Best effort: a host that is down or restarting leaves the chats behind. They aren't trashed with the folder. */
export function deleteProjectChats(projectId: string): void {
  if (projectId && endpoint) child?.postMessage({ type: "deleteProject", projectId });
}

/** Asks the host to stop (it kills its harness trees), then kills it after a grace period. */
export function stopAgentChat(): void {
  stopped = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const proc = child;
  child = null;
  endpoint = null;
  if (!proc) return;
  try {
    proc.postMessage({ type: "stop" });
  } catch {
    // Already gone.
  }
  const timer = setTimeout(() => proc.kill(), STOP_GRACE_MS);
  proc.once("exit", () => clearTimeout(timer));
}
