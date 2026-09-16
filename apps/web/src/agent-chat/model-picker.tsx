/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One dropdown for harness and model: Claude Code's models, then Codex's,
// fed by the host's probes. A harness that is not ready is one disabled row
// that says why, never hidden, so the picker also says what this works with.

import { For, Show } from "solid-js";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";

import type { HarnessId, HarnessInfo, ModelRef } from "@diffusionstudio/agent-chat";

import { openAgentSetup } from "./auth-store";
import { chatState, ensureConnected, modelLabel, refreshHarnesses, usableCredentials } from "./store";

/** The icons `lib/agents.ts` used, by harness. */
export const harnessIcon = (harness: HarnessId | null | undefined): string =>
  harness === "claude" ? "claude-code" : harness === "codex" ? "codex" : "fx";

function unavailableLabel(harness: HarnessInfo): string {
  switch (harness.status) {
    case "not-installed":
      return "Not installed — set up";
    case "signed-out":
      return "Signed out — sign in";
    case "checking":
      return "Checking…";
    default:
      return harness.detail ?? "Unavailable";
  }
}

/** Whether a row for a harness that is not ready should take a click. */
const actionable = (harness: HarnessInfo): boolean => harness.status === "not-installed" || harness.status === "signed-out";

type ModelPickerProps = {
  value: ModelRef | null;
  onSelect(ref: ModelRef): void;
  class?: string;
};

export function ModelPicker(props: ModelPickerProps) {
  ensureConnected();
  const harnesses = () => chatState.harnesses;

  return (
    <DropdownMenu placement="bottom-start" onOpenChange={(open) => open && refreshHarnesses()}>
      <DropdownMenuTrigger
        as="button"
        type="button"
        aria-label="Choose the agent and model"
        class={`flex h-7 shrink-0 items-center rounded-md pl-0.5 pr-2 text-xs font-450 text-muted-foreground hover:bg-muted focus-ring ${props.class ?? ""}`}
      >
        <span class="grid size-6 shrink-0 place-items-center overflow-clip">
          <Icon name={harnessIcon(props.value?.harness)} />
        </span>
        <span class="max-w-40 truncate">{modelLabel(props.value)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="w-56">
          <Show when={harnesses().length === 0}>
            <DropdownMenuGroup>
              <DropdownMenuItem disabled>
                <span class="min-w-0 flex-1 truncate text-muted-foreground">
                  {chatState.connection === "unavailable" ? "Chat runs in the desktop app" : "Connecting…"}
                </span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </Show>
          <For each={harnesses()}>
            {(harness, index) => (
              <>
                <Show when={index() > 0}>
                  <DropdownMenuSeparator />
                </Show>
                <DropdownMenuGroup>
                  <DropdownMenuGroupLabel>{harness.label}</DropdownMenuGroupLabel>
                  <Show when={harness.status === "ready" && harness.detail}>
                    {/* "Update Claude Code": the harness works, but is older than we test against. */}
                    <p class="px-2 pb-1 text-[10px] leading-3.5 text-muted-foreground">{harness.detail}</p>
                  </Show>
                  <Show
                    when={harness.status === "ready"}
                    fallback={
                      <DropdownMenuItem disabled={!actionable(harness)} onSelect={() => actionable(harness) && openAgentSetup()}>
                        <Icon name={harnessIcon(harness.id)} />
                        <span class="min-w-0 flex-1 truncate text-muted-foreground">{unavailableLabel(harness)}</span>
                      </DropdownMenuItem>
                    }
                  >
                    <For each={harness.models}>
                      {(model) => (
                        <DropdownMenuItem onSelect={() => props.onSelect({ harness: harness.id, model: model.id })}>
                          <Icon name={harnessIcon(harness.id)} />
                          <span class="min-w-0 flex-1 truncate">{model.label}</span>
                          <Show when={props.value?.harness === harness.id && props.value?.model === model.id}>
                            <Icon name="confirm-check" class="size-6" />
                          </Show>
                        </DropdownMenuItem>
                      )}
                    </For>
                  </Show>
                </DropdownMenuGroup>
              </>
            )}
          </For>

          {/* Brought keys, each its own group: the provider is the heading,
              because two of them can carry models of the same name. */}
          <For each={usableCredentials()}>
            {(credential) => (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuGroupLabel>{credential.label}</DropdownMenuGroupLabel>
                  <Show
                    when={credential.models.length > 0}
                    fallback={
                      <DropdownMenuItem onSelect={() => openAgentSetup()}>
                        <Icon name="password-lock" />
                        <span class="min-w-0 flex-1 truncate text-muted-foreground">No models listed — edit key</span>
                      </DropdownMenuItem>
                    }
                  >
                    <For each={credential.models}>
                      {(model) => (
                        <DropdownMenuItem
                          onSelect={() => props.onSelect({ harness: credential.harness, model: model.id, credentialId: credential.id })}
                        >
                          <Icon name="password-lock" />
                          <span class="min-w-0 flex-1 truncate">{model.label}</span>
                          <Show when={props.value?.credentialId === credential.id && props.value?.model === model.id}>
                            <Icon name="confirm-check" class="size-6" />
                          </Show>
                        </DropdownMenuItem>
                      )}
                    </For>
                  </Show>
                </DropdownMenuGroup>
              </>
            )}
          </For>

          <Show when={chatState.connection !== "unavailable"}>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => openAgentSetup()}>
                <Icon name="plus-add" />
                <span class="min-w-0 flex-1 truncate">Add an API key…</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </Show>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}
