/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Signing in, and the keys the user brought. The host owns both; this is
// the view over them plus the calls that change them. The progress of a
// running sign-in is ours alone — it is worth watching while it happens
// and worth nothing once it has.

import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";

import { client } from "./connection";
import { ensureConnected, whenOpen } from "./store";

import type { AuthMethod, CredentialInput, CredentialSummary, HarnessId, ProviderWire } from "@diffusionstudio/agent-chat";

/** How many of a CLI's lines the progress panel keeps. */
const LOG_MAX = 40;

type AuthState = {
  /** The harness whose sign-in is running, if any. */
  running: HarnessId | null;
  /** What the CLI has printed, newest last. */
  lines: string[];
  /** The page to open, once the CLI has said where it is. */
  url: string | null;
  /** The code to type there, for a device flow. */
  code: string | null;
  /** Why the last sign-in did not work. Cleared when the next one starts. */
  error: string | null;
};

const [authState, setAuthState] = createStore<AuthState>({ running: null, lines: [], url: null, code: null, error: null });

export { authState };

/**
 * Whether the agent setup screen is open over the app. The same screen the
 * first launch shows, reachable later from the model picker — a harness
 * that signed itself out mid-session is fixed where it is noticed.
 */
const [setupOpen, setSetupOpen] = createSignal(false);
export { setupOpen as agentSetupOpen };
export const openAgentSetup = () => setSetupOpen(true);
export const closeAgentSetup = () => setSetupOpen(false);

let listening = false;

/** Starts mirroring the host's sign-in events. Idempotent. */
export function ensureAuthListening(): void {
  ensureConnected();
  if (listening) return;
  listening = true;
  client.onAuth((event) => {
    switch (event.type) {
      case "started":
        setAuthState({ running: event.harness, lines: [], url: null, code: null, error: null });
        return;
      case "url":
        setAuthState({ url: event.url, code: event.code ?? null });
        // The CLI opens a browser itself where it can; on a desktop that
        // refused, this is the one that works. A second open is harmless.
        void openExternal(event.url);
        return;
      case "output":
        setAuthState("lines", (lines) => [...lines, event.text].slice(-LOG_MAX));
        return;
      case "finished":
        setAuthState({ running: null, error: event.ok ? null : (event.detail ?? "Sign-in did not complete") });
        return;
    }
  });
}

export function clearAuthError(): void {
  setAuthState("error", null);
}

export async function openExternal(url: string): Promise<void> {
  if (window.desktop) {
    await mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url }).catch(() => {});
    return;
  }
  window.open(url, "_blank", "noopener");
}

/**
 * Runs a harness's own sign-in. Resolves when the CLI has exited — the
 * progress in between arrives as events, so the caller can just await this.
 */
export async function signIn(harness: HarnessId, method: AuthMethod = "subscription"): Promise<{ ok: boolean; detail?: string }> {
  ensureAuthListening();
  await whenOpen();
  try {
    return await client.request("auth.login", { harness, method });
  } catch (error) {
    const detail = (error as Error)?.message ?? "Sign-in failed";
    setAuthState({ running: null, error: detail });
    return { ok: false, detail };
  }
}

export async function cancelSignIn(harness: HarnessId): Promise<void> {
  await whenOpen();
  await client.request("auth.cancel", { harness }).catch(() => {});
}

export async function signOut(harness: HarnessId): Promise<void> {
  await whenOpen();
  await client.request("auth.logout", { harness });
}

/** The paste-a-token fallback, for a CLI whose sign-in will not run without a terminal. */
export async function submitToken(harness: HarnessId, token: string): Promise<{ ok: boolean; detail?: string }> {
  await whenOpen();
  try {
    return await client.request("auth.token", { harness, token });
  } catch (error) {
    const detail = (error as Error)?.message ?? "That token was not accepted";
    setAuthState("error", detail);
    return { ok: false, detail };
  }
}

/** Checks a key against its endpoint and returns what it offers. Throws with a readable reason. */
export async function probeCredential(params: { wire: ProviderWire; baseUrl: string; apiKey: string }): Promise<{ id: string; label: string }[]> {
  await whenOpen();
  const { models } = await client.request("credentials.probe", params);
  return models;
}

export async function saveCredential(input: CredentialInput): Promise<CredentialSummary> {
  await whenOpen();
  return client.request("credentials.save", input);
}

export async function deleteCredential(id: string): Promise<void> {
  await whenOpen();
  await client.request("credentials.delete", { id });
}
