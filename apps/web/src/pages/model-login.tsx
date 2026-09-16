/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The first screen: how the editor's agent signs in. Signing in with
// Claude or ChatGPT runs the CLI's own login — theirs are the flows those
// accounts are licensed for — and a brought key covers everything else,
// including a model running on this machine. The editor itself needs none
// of this, so there is a way past it.

import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";
import { useFullscreenState } from "@/hooks/use-fullscreen-state";

import { ByokDialog } from "@/agent-chat/byok-dialog";
import {
  authState,
  cancelSignIn,
  clearAuthError,
  deleteCredential,
  ensureAuthListening,
  openExternal,
  signIn,
  signOut,
  submitToken,
} from "@/agent-chat/auth-store";
import { agentAvailable, chatState, refreshHarnesses, setSkippedAgentLogin } from "@/agent-chat/store";

import type { HarnessId, HarnessInfo } from "@diffusionstudio/agent-chat";

const INSTALL_URLS: Record<HarnessId, string> = {
  claude: "https://docs.claude.com/en/docs/claude-code/setup",
  codex: "https://developers.openai.com/codex/cli/",
};

type Choice = {
  harness: HarnessId;
  icon: string;
  label: string;
  /** What the account is called where the user signs in. */
  account: string;
  installLabel: string;
};

const CHOICES: Choice[] = [
  { harness: "claude", icon: "claude", label: "Continue with Claude", account: "Anthropic", installLabel: "Install Claude Code" },
  { harness: "codex", icon: "large-openai", label: "Continue with ChatGPT", account: "OpenAI", installLabel: "Install Codex" },
];

type ModelLoginPageProps = {
  /**
   * Set when the screen is open over a running app rather than in front of
   * it. It then closes instead of recording that the first screen was
   * skipped — that choice was already made.
   */
  onDismiss?: () => void;
};

export function ModelLoginPage(props: ModelLoginPageProps = {}) {
  const isFullscreen = useFullscreenState();
  const [byokOpen, setByokOpen] = createSignal(false);
  const [token, setToken] = createSignal("");
  const [tokenFor, setTokenFor] = createSignal<HarnessId | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  onMount(() => {
    ensureAuthListening();
    refreshHarnesses();
  });

  const harness = (id: HarnessId): HarnessInfo | undefined => chatState.harnesses.find((entry) => entry.id === id);
  // Nothing probed yet reads as present: an install prompt that turns out
  // to be wrong is worse than one that appears a moment late.
  const installed = (id: HarnessId) => harness(id)?.status !== "not-installed";
  const ready = (id: HarnessId) => harness(id)?.status === "ready";
  const busy = () => authState.running !== null;

  /** The paste-a-token way out, offered only when the CLI asked for a terminal. */
  const needsToken = createMemo(() => !!authState.error && /setup-token|needs a terminal/i.test(authState.error));

  const start = async (choice: Choice) => {
    if (busy()) return;
    if (!installed(choice.harness)) {
      await openExternal(INSTALL_URLS[choice.harness]);
      return;
    }
    clearAuthError();
    setTokenFor(null);
    const outcome = await signIn(choice.harness, "subscription");
    if (outcome.ok) toast.success(`Signed in to ${choice.account}`);
    else if (/needs a terminal|setup-token/i.test(outcome.detail ?? "")) setTokenFor(choice.harness);
  };

  const useDeviceCode = async (id: HarnessId) => {
    if (busy()) return;
    clearAuthError();
    const outcome = await signIn(id, "device");
    if (outcome.ok) toast.success("Signed in");
  };

  const applyToken = async (event: SubmitEvent) => {
    event.preventDefault();
    const id = tokenFor();
    const value = token().trim();
    if (!id || !value || submitting()) return;
    setSubmitting(true);
    const outcome = await submitToken(id, value);
    setSubmitting(false);
    if (!outcome.ok) return;
    setToken("");
    setTokenFor(null);
    clearAuthError();
    toast.success("Token accepted");
  };

  const disconnect = async (id: HarnessId) => {
    await signOut(id).catch((error: Error) => toast.error("Could not sign out", { description: error.message }));
  };

  /** Closing the overlay, or recording that the first screen was got past. */
  const dismiss = () => {
    if (props.onDismiss) props.onDismiss();
    else setSkippedAgentLogin(true);
  };

  const removeCredential = async (id: string, label: string) => {
    try {
      await deleteCredential(id);
      toast.success(`${label} removed`);
    } catch (error) {
      toast.error("Could not remove that key", { description: (error as Error).message });
    }
  };

  return (
    <div class="flex flex-col bg-background fixed inset-0 z-999 overflow-y-auto">
      <Show when={!!window.desktop && !isFullscreen()}>
        <div class="absolute inset-x-0 top-0 h-10 z-20" style="-webkit-app-region: drag;" />
      </Show>
      <Show when={!window.desktop}>
        <div class="flex items-center gap-1 p-4">
          <Icon name="diffusion-logo" class="size-6" />
          <span class="text-sm font-450 text-foreground">Diffusion Studio</span>
        </div>
      </Show>

      <div class="flex flex-1 items-center justify-center py-16">
        <div class="flex w-80 flex-col gap-3">
          <div class="flex flex-col gap-4 rounded-xl bg-accent/40 p-4">
            <div class="flex flex-col gap-1">
              <h2 class="text-[12px] font-450 text-foreground">Connect an agent</h2>
              <p class="text-xs text-muted-foreground">
                The editor writes your video as code and an agent edits it. Sign in with the account you already pay for, or bring your own key.
              </p>
            </div>

            <div class="flex flex-col gap-2">
              <For each={CHOICES}>
                {(choice) => (
                  <Show
                    when={!ready(choice.harness)}
                    fallback={
                      <div class="flex h-7 items-center gap-2 rounded-md bg-secondary px-2">
                        <Icon name={choice.icon} class="size-5" />
                        <span class="min-w-0 flex-1 truncate text-xs text-foreground">{harness(choice.harness)?.label} connected</span>
                        <button
                          type="button"
                          class="shrink-0 text-[10px] text-muted-foreground underline hover:text-foreground"
                          onClick={() => void disconnect(choice.harness)}
                        >
                          Sign out
                        </button>
                      </div>
                    }
                  >
                    <Button
                      variant="secondary"
                      class="w-full gap-0 px-0.5"
                      disabled={busy()}
                      onClick={() => void start(choice)}
                    >
                      <Icon name={choice.icon} class="size-6" />
                      <span class="min-w-0 flex-1 text-center">
                        {installed(choice.harness) ? choice.label : choice.installLabel}
                      </span>
                      <span class="size-6 shrink-0" aria-hidden="true">
                        <Show when={!installed(choice.harness)}>
                          <Icon name="external-link" class="size-4" />
                        </Show>
                      </span>
                    </Button>
                  </Show>
                )}
              </For>

              <Button variant="secondary" class="w-full gap-0 px-0.5" disabled={busy()} onClick={() => setByokOpen(true)}>
                <Icon name="password-lock" class="size-6" />
                <span class="min-w-0 flex-1 text-center">Use your own API key</span>
                <span class="size-6 shrink-0" aria-hidden="true" />
              </Button>
              <p class="px-1 text-[10px] leading-3.5 text-muted-foreground">
                OpenAI, Anthropic, OpenRouter, Groq, Together, DeepSeek, Mistral, xAI, Ollama, LM Studio, or any OpenAI-compatible endpoint.
              </p>
            </div>

            {/* What the CLI is doing, while it does it. */}
            <Show when={busy()}>
              <div class="flex flex-col gap-2 rounded-lg bg-background/60 p-2.5">
                <div class="flex items-center gap-2">
                  <Icon name="spinner-loader" class="size-4 animate-spin" />
                  <span class="min-w-0 flex-1 truncate text-xs text-foreground">Waiting for you to finish in the browser…</span>
                  <button
                    type="button"
                    class="shrink-0 text-[10px] text-muted-foreground underline hover:text-foreground"
                    onClick={() => void cancelSignIn(authState.running!)}
                  >
                    Cancel
                  </button>
                </div>
                <Show when={authState.code}>
                  <p class="text-xs text-muted-foreground">
                    Code: <span class="font-mono text-foreground">{authState.code}</span>
                  </p>
                </Show>
                <Show when={authState.url}>
                  <button
                    type="button"
                    class="self-start truncate text-[10px] text-muted-foreground underline hover:text-foreground"
                    onClick={() => void openExternal(authState.url!)}
                  >
                    Open the sign-in page again
                  </button>
                </Show>
                <Show when={authState.lines.length > 0}>
                  <p class="max-h-16 overflow-y-auto whitespace-pre-wrap break-words text-[10px] leading-3.5 text-muted-foreground">
                    {authState.lines.slice(-6).join("\n")}
                  </p>
                </Show>
              </div>
            </Show>

            <Show when={!busy() && authState.error}>
              <div class="flex flex-col gap-2 rounded-lg bg-destructive/10 p-2.5">
                <p class="text-xs text-destructive">{authState.error}</p>
                <Show when={!tokenFor() && !needsToken()}>
                  <button
                    type="button"
                    class="self-start text-[10px] text-muted-foreground underline hover:text-foreground"
                    onClick={() => void useDeviceCode("codex")}
                  >
                    Try signing in with a device code instead
                  </button>
                </Show>
              </div>
            </Show>

            {/* The way in when the CLI's own login will not run headless. */}
            <Show when={tokenFor() || needsToken()}>
              <form class="flex flex-col gap-2" onSubmit={applyToken}>
                <TextField>
                  <TextFieldLabel uiSize="compact" class="text-xs text-muted-foreground">
                    Paste the token from <span class="font-mono">claude setup-token</span>
                  </TextFieldLabel>
                  <TextFieldInput
                    uiSize="compact"
                    type="password"
                    autocomplete="off"
                    spellcheck={false}
                    placeholder="sk-ant-oat…"
                    value={token()}
                    onInput={(e) => setToken(e.currentTarget.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    onKeyUp={(e) => e.stopPropagation()}
                  />
                </TextField>
                <Button type="submit" class="w-full" disabled={submitting() || !token().trim()}>
                  {submitting() ? "Checking…" : "Use this token"}
                </Button>
              </form>
            </Show>

            <Show when={chatState.credentials.length > 0}>
              <div class="flex flex-col gap-1.5">
                <span class="text-xs text-muted-foreground">Your keys</span>
                <For each={chatState.credentials}>
                  {(credential) => (
                    <div class="flex h-7 items-center gap-2 rounded-md bg-secondary px-2">
                      <Icon name="password-lock" class="size-4" />
                      <span class="min-w-0 flex-1 truncate text-xs text-foreground">{credential.label}</span>
                      <span class="shrink-0 text-[10px] text-muted-foreground">{credential.models.length} models</span>
                      <button
                        type="button"
                        aria-label={`Remove ${credential.label}`}
                        class="shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => void removeCredential(credential.id, credential.label)}
                      >
                        <Icon name="trash" class="size-4" />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <Show when={agentAvailable()}>
            <Button class="w-full" onClick={dismiss}>
              {props.onDismiss ? "Done" : "Continue to the editor"}
            </Button>
          </Show>

          <button type="button" class="px-1 text-center text-xs text-muted-foreground underline hover:text-foreground" onClick={dismiss}>
            {props.onDismiss ? "Close" : agentAvailable() ? "Skip for now" : "Continue without an agent"}
          </button>

          <span class="px-1 text-center text-[10px] leading-3.5 text-muted-foreground">
            A Diffusion Studio account is optional — connect one in Settings for generated images, video and voice.
          </span>
        </div>
      </div>

      <ByokDialog open={byokOpen()} onClose={() => setByokOpen(false)} />
    </div>
  );
}
