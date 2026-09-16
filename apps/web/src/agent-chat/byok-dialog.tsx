/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bringing a key. One dialog for every provider: the presets fill the base
// URL in, and anything OpenAI-compatible — a gateway, a box on the desk —
// is the last entry with the URL typed by hand. The key is checked against
// its endpoint before it is stored, so a typo is caught here rather than at
// the start of a turn.

import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { toast } from "somoto";

import { PROVIDER_PRESETS, presetById } from "@diffusionstudio/agent-chat";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";

import { openExternal, saveCredential } from "./auth-store";

import type { CredentialSummary, ProviderPreset } from "@diffusionstudio/agent-chat";

type ByokDialogProps = {
  open: boolean;
  /** The credential being changed; null when adding one. */
  edit?: CredentialSummary | null;
  onClose(): void;
  /** Called with what was stored, so a caller can select it straight away. */
  onSaved?(credential: CredentialSummary): void;
};

const DEFAULT_PRESET = PROVIDER_PRESETS[0]!;

/** A readable name for an endpoint nobody named: `api.example.com` from its URL. */
function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "Custom";
  }
}

export function ByokDialog(props: ByokDialogProps) {
  const [presetId, setPresetId] = createSignal(DEFAULT_PRESET.id);
  const [baseUrl, setBaseUrl] = createSignal(DEFAULT_PRESET.baseUrl);
  const [apiKey, setApiKey] = createSignal("");
  const [chatApi, setChatApi] = createSignal<"chat" | "responses">(DEFAULT_PRESET.chatApi);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** Set once the form has been seeded for the credential being edited. */
  const [seededFor, setSeededFor] = createSignal<string | null>(null);

  const preset = createMemo<ProviderPreset>(() => presetById(presetId()) ?? DEFAULT_PRESET);
  const editing = () => props.edit ?? null;

  // Seeded once per opening, keyed by what is being edited, so reopening
  // for another credential refills the form and reopening for the same one
  // does not throw away what is half-typed.
  createEffect(() => {
    const target = editing();
    const key = target?.id ?? (props.open ? "new" : null);
    if (!props.open || seededFor() === key) return;
    setSeededFor(key);
    setError(null);
    setApiKey("");
    setSaving(false);
    if (target) {
      setPresetId(target.provider);
      setBaseUrl(target.baseUrl);
      setChatApi(target.chatApi);
    } else {
      setPresetId(DEFAULT_PRESET.id);
      setBaseUrl(DEFAULT_PRESET.baseUrl);
      setChatApi(DEFAULT_PRESET.chatApi);
    }
  });

  const choosePreset = (next: ProviderPreset) => {
    setPresetId(next.id);
    setBaseUrl(next.baseUrl);
    setChatApi(next.chatApi);
    setError(null);
  };

  const keyRequired = () => !preset().keyless && !editing()?.hasKey;
  const canSave = () => !saving() && !!baseUrl().trim() && (!keyRequired() || !!apiKey().trim());

  const close = () => {
    setSeededFor(null);
    props.onClose();
  };

  const submit = async (event?: SubmitEvent) => {
    event?.preventDefault();
    if (!canSave()) return;
    setSaving(true);
    setError(null);
    const current = preset();
    const url = baseUrl().trim();
    try {
      const saved = await saveCredential({
        ...(editing()?.id ? { id: editing()!.id } : {}),
        label: current.id === "custom" ? hostLabel(url) : current.label,
        provider: current.id,
        wire: current.wire,
        baseUrl: url,
        apiKey: apiKey().trim(),
        chatApi: current.wire === "anthropic" ? "chat" : chatApi(),
      });
      toast.success(`${saved.label} connected`, {
        description: saved.models.length ? `${saved.models.length} models available` : "No models listed by that endpoint",
      });
      props.onSaved?.(saved);
      close();
    } catch (failure) {
      setError((failure as Error)?.message ?? "That key could not be saved");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && !saving() && close()}>
      <DialogContent class="max-w-96">
        <DialogHeader>
          <DialogTitle>{editing() ? "Edit API key" : "Use your own API key"}</DialogTitle>
          <DialogDescription>
            The key stays on this machine, encrypted, and is only ever passed to the agent that runs your edits.
          </DialogDescription>
        </DialogHeader>

        <form class="flex flex-col gap-3" onSubmit={submit}>
          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-muted-foreground">Provider</span>
            <DropdownMenu placement="bottom-start">
              <DropdownMenuTrigger
                as="button"
                type="button"
                disabled={!!editing()}
                class="flex h-7 items-center justify-between rounded-md border border-border-input px-2 text-xs text-foreground hover:bg-input disabled:opacity-50 focus-ring"
              >
                <span class="truncate">{preset().label}</span>
                <Icon name="chevron-down" class="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="w-64">
                  <For each={[...PROVIDER_PRESETS]}>
                    {(entry) => (
                      <DropdownMenuItem onSelect={() => choosePreset(entry)}>
                        <span class="min-w-0 flex-1 truncate">{entry.label}</span>
                        <Show when={entry.id === presetId()}>
                          <Icon name="confirm-check" class="size-6" />
                        </Show>
                      </DropdownMenuItem>
                    )}
                  </For>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
            <p class="text-[10px] leading-3.5 text-muted-foreground">
              {preset().wire === "anthropic"
                ? "Runs through Claude Code."
                : "Runs through Codex. Any OpenAI-compatible endpoint works, including one on this machine."}
            </p>
          </div>

          <TextField>
            <TextFieldLabel uiSize="compact" class="text-xs text-muted-foreground">
              Base URL
            </TextFieldLabel>
            <TextFieldInput
              uiSize="compact"
              type="url"
              spellcheck={false}
              placeholder="https://api.example.com/v1"
              value={baseUrl()}
              onInput={(e) => setBaseUrl(e.currentTarget.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            />
          </TextField>

          <TextField>
            <TextFieldLabel uiSize="compact" class="text-xs text-muted-foreground">
              API key{preset().keyless ? " (optional)" : ""}
            </TextFieldLabel>
            <TextFieldInput
              uiSize="compact"
              type="password"
              autocomplete="off"
              spellcheck={false}
              placeholder={editing()?.hasKey ? "Stored — leave blank to keep it" : preset().keyless ? "Not needed for a local server" : "sk-…"}
              value={apiKey()}
              onInput={(e) => setApiKey(e.currentTarget.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            />
            <Show when={preset().keyUrl}>
              <button
                type="button"
                class="self-start text-[10px] text-muted-foreground underline hover:text-foreground"
                onClick={() => void openExternal(preset().keyUrl!)}
              >
                Get a key
              </button>
            </Show>
          </TextField>

          <Show when={preset().wire === "openai-compatible"}>
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-muted-foreground">API style</span>
              <div class="flex gap-1">
                <Button type="button" size="small" variant={chatApi() === "chat" ? "on" : "secondary"} onClick={() => setChatApi("chat")}>
                  Chat completions
                </Button>
                <Button type="button" size="small" variant={chatApi() === "responses" ? "on" : "secondary"} onClick={() => setChatApi("responses")}>
                  Responses
                </Button>
              </div>
            </div>
          </Show>

          <Show when={error()}>
            <p class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error()}</p>
          </Show>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={close} disabled={saving()}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave()}>
              {saving() ? "Checking…" : editing() ? "Save" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
