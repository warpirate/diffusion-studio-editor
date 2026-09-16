/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The wire between the chat UI and the agent host: JSON text frames over a
// WebSocket. Browser-safe — nothing here knows about Node, Electron or where
// a project lives. The host owns all state; the UI is a view over a snapshot
// (`chats.open`) plus the events that follow it.

export type HarnessId = "claude" | "codex";

/**
 * The single dropdown's value: which harness, which of its models, and —
 * when the model comes from a key the user brought — which stored
 * credential carries it. Without a credential the harness uses whatever
 * login the CLI has of its own.
 */
export type ModelRef = { harness: HarnessId; model: string; credentialId?: string };

export type HarnessStatus = "ready" | "not-installed" | "signed-out" | "error" | "checking";

export type HarnessInfo = {
  id: HarnessId;
  /** "Claude Code" | "Codex" */
  label: string;
  status: HarnessStatus;
  /** e.g. "Run `codex login` in a terminal" */
  detail?: string;
  version?: string;
  models: { id: string; label: string }[];
  defaultModel?: string;
};

// ---------------------------------------------------------------------------
// Credentials
//
// A credential is a key the user brought, kept by the host and never sent
// back out. Which wire it speaks decides which harness can carry it: Codex
// speaks OpenAI's, Claude Code speaks Anthropic's, and neither translates.

export type ProviderWire = "openai-compatible" | "anthropic";

/** Which harness a wire rides on. The pairing is fixed, not a preference. */
export const WIRE_HARNESS: Record<ProviderWire, HarnessId> = {
  "openai-compatible": "codex",
  anthropic: "claude",
};

export type ProviderPreset = {
  id: string;
  label: string;
  wire: ProviderWire;
  /** Empty when the user must type one (a self-hosted endpoint). */
  baseUrl: string;
  /** Codex's `wire_api`: the Responses API where the provider has it, chat completions otherwise. */
  chatApi: "chat" | "responses";
  /** A local server takes any string as its key, so the field can stay empty. */
  keyless?: boolean;
  /** Shown under the key field: where to get one. */
  keyUrl?: string;
};

/**
 * What the BYOK dialog offers. Ordered as the dialog lists them; `custom`
 * stays last because it is the escape hatch, not a recommendation.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "openai", label: "OpenAI", wire: "openai-compatible", baseUrl: "https://api.openai.com/v1", chatApi: "responses", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic", wire: "anthropic", baseUrl: "https://api.anthropic.com", chatApi: "chat", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openrouter", label: "OpenRouter", wire: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", chatApi: "chat", keyUrl: "https://openrouter.ai/keys" },
  { id: "groq", label: "Groq", wire: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", chatApi: "chat", keyUrl: "https://console.groq.com/keys" },
  { id: "together", label: "Together AI", wire: "openai-compatible", baseUrl: "https://api.together.xyz/v1", chatApi: "chat", keyUrl: "https://api.together.ai/settings/api-keys" },
  { id: "deepseek", label: "DeepSeek", wire: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", chatApi: "chat", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "mistral", label: "Mistral", wire: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", chatApi: "chat", keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "xai", label: "xAI", wire: "openai-compatible", baseUrl: "https://api.x.ai/v1", chatApi: "chat", keyUrl: "https://console.x.ai" },
  { id: "ollama", label: "Ollama", wire: "openai-compatible", baseUrl: "http://localhost:11434/v1", chatApi: "chat", keyless: true },
  { id: "lmstudio", label: "LM Studio", wire: "openai-compatible", baseUrl: "http://localhost:1234/v1", chatApi: "chat", keyless: true },
  { id: "custom", label: "Other (OpenAI-compatible)", wire: "openai-compatible", baseUrl: "", chatApi: "chat" },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** A stored credential as the UI sees it: everything except the key. */
export type CredentialSummary = {
  id: string;
  /** What the picker shows, e.g. "OpenRouter". */
  label: string;
  /** The preset it came from, or "custom". */
  provider: string;
  wire: ProviderWire;
  harness: HarnessId;
  baseUrl: string;
  chatApi: "chat" | "responses";
  /** What the endpoint listed at save time; the picker's rows. */
  models: { id: string; label: string }[];
  defaultModel?: string;
  /** Whether a key was stored at all (a local server may need none). */
  hasKey: boolean;
  createdAt: number;
};

/** What `credentials.save` takes. The key goes in and never comes back. */
export type CredentialInput = {
  /** Set to replace an existing credential in place. */
  id?: string;
  label: string;
  provider: string;
  wire: ProviderWire;
  baseUrl: string;
  apiKey: string;
  chatApi?: "chat" | "responses";
  models?: { id: string; label: string }[];
  defaultModel?: string;
};

// ---------------------------------------------------------------------------
// Signing in to a harness
//
// The CLIs own their own logins, so the app drives theirs rather than
// keeping a second copy: it runs `codex login` / `claude auth login` and
// reports what they print. `device` is the flow that shows a code instead
// of needing a browser the child can reach.

export type AuthMethod = "subscription" | "console" | "device";

export type AuthEvent =
  | { type: "started"; harness: HarnessId; method: AuthMethod }
  /** A URL for the user to open, with the code to type when there is one. */
  | { type: "url"; harness: HarnessId; url: string; code?: string }
  /** A line the CLI printed, for the progress log. */
  | { type: "output"; harness: HarnessId; text: string }
  | { type: "finished"; harness: HarnessId; ok: boolean; detail?: string };

export type ChatStatus = "idle" | "running" | "waiting";

export type ChatSummary = {
  id: string;
  projectId: string;
  title: string;
  harness: HarnessId;
  model: string;
  /** The credential the chat runs on, when it is not the CLI's own login. */
  credentialId?: string;
  /** `waiting` = a question needs the user. */
  status: ChatStatus;
  createdAt: number;
  updatedAt: number;
};

export type ToolStatus = "running" | "done" | "failed";

export type ToolImage = { mediaType: string; data: string };

export type Item =
  | { id: string; kind: "user"; text: string; attachments?: string[] }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "reasoning"; text: string }
  | { id: string; kind: "tool"; name: string; title: string; detail?: string; output?: string; images?: ToolImage[]; status: ToolStatus }
  | { id: string; kind: "question"; questions: Question[]; answers: Record<string, string[]> | null }
  | { id: string; kind: "notice"; level: "info" | "error"; text: string };

export type ItemKind = Item["kind"];

export type TurnStatus = "completed" | "interrupted" | "failed";

export type ChatEvent =
  | { type: "turn.started"; turnId: string; model: string; user: Item }
  | { type: "item.started"; item: Item }
  /** Appends to an open assistant / reasoning item. */
  | { type: "item.delta"; itemId: string; text: string }
  /** The full, final item; replaces whatever was started under that id. */
  | { type: "item.completed"; item: Item }
  | { type: "turn.completed"; turnId: string; status: TurnStatus; error?: string }
  | { type: "request.opened"; request: PendingRequest }
  | { type: "request.resolved"; requestId: string; outcome: "answered" | "skipped" | "cancel" }
  | { type: "chat.updated"; chat: ChatSummary };

/** The only kind of request in v1. Tagged, so approvals can be added later without a protocol change. */
export type PendingRequest = { id: string; type: "question"; questions: Question[] };

export type Question = {
  /** Claude: the full question text (the SDK looks answers up by it); Codex: its id. */
  id: string;
  /** Short chip label, ≤ 12 chars. */
  header: string;
  question: string;
  /** Empty = free text only. */
  options: { label: string; description: string }[];
  multiSelect: boolean;
  /** Claude: always; Codex: isOther. */
  allowOther: boolean;
  /** Codex isSecret → password field. */
  secret: boolean;
};

export type RequestResponse = { answers: Record<string, string[]> } | "skip" | "cancel";

// ---------------------------------------------------------------------------
// Methods

export type ChatSnapshot = {
  chat: ChatSummary;
  items: Item[];
  /** Events with `seq` at or below this are already in `items`. */
  seq: number;
  /** A question the harness is waiting on, so a late client can still answer it. */
  pending: PendingRequest | null;
};

export type MethodMap = {
  "harnesses.list": { params: { refresh?: boolean }; result: HarnessInfo[] };
  "chats.list": { params: { projectId: string }; result: ChatSummary[] };
  "chats.open": { params: { chatId: string }; result: ChatSnapshot };
  "chats.close": { params: { chatId: string }; result: void };
  "chats.delete": { params: { chatId: string }; result: void };
  "turn.send": {
    params: {
      chatId?: string;
      projectId: string;
      cwd: string;
      text: string;
      attachments?: string[];
      model: ModelRef;
    };
    result: { chatId: string };
  };
  "turn.interrupt": { params: { chatId: string }; result: void };
  "request.respond": {
    params: { chatId: string; requestId: string; response: RequestResponse };
    result: void;
  };
  /** Runs the harness's own login. Resolves when the CLI exits; progress arrives as `auth` events. */
  "auth.login": { params: { harness: HarnessId; method?: AuthMethod }; result: { ok: boolean; detail?: string } };
  /** Ends a login that is still running. */
  "auth.cancel": { params: { harness: HarnessId }; result: void };
  "auth.logout": { params: { harness: HarnessId }; result: void };
  /** The paste-a-token fallback, for a CLI whose login will not run without a terminal. */
  "auth.token": { params: { harness: HarnessId; token: string }; result: { ok: boolean; detail?: string } };
  "credentials.list": { params: Record<string, never>; result: CredentialSummary[] };
  "credentials.save": { params: CredentialInput; result: CredentialSummary };
  "credentials.delete": { params: { id: string }; result: void };
  /** Checks a key against its endpoint and returns what it offers, before anything is stored. */
  "credentials.probe": {
    params: { wire: ProviderWire; baseUrl: string; apiKey: string };
    result: { models: { id: string; label: string }[] };
  };
};

export type Method = keyof MethodMap;
export type MethodParams<M extends Method> = MethodMap[M]["params"];
export type MethodResult<M extends Method> = MethodMap[M]["result"];

export type ErrorCode =
  | "bad-request"
  | "not-found"
  | "busy"
  | "harness-mismatch"
  | "harness-unavailable"
  | "no-request"
  /** A login ran and did not end signed in. */
  | "auth-failed"
  /** A key the endpoint would not accept, or a base URL that answered nothing. */
  | "credential-invalid"
  | "internal";

export type HostError = { code: ErrorCode; message: string };

// ---------------------------------------------------------------------------
// Envelopes

export type ClientMsg = { t: "req"; id: string; method: Method; params: unknown };

export type HostMsg =
  | { t: "res"; id: string; ok: true; data: unknown }
  | { t: "res"; id: string; ok: false; error: HostError }
  | { t: "event"; chatId: string; seq: number; event: ChatEvent }
  /** Pushed whenever the probes change. */
  | { t: "harnesses"; harnesses: HarnessInfo[] }
  /** Progress of a login that is running; broadcast, so any window can watch it. */
  | { t: "auth"; event: AuthEvent }
  /** Pushed whenever the stored credentials change. */
  | { t: "credentials"; credentials: CredentialSummary[] };

/** Title = first user message, whitespace-collapsed, truncated to 60 chars. */
export const TITLE_MAX = 60;

export function titleFor(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TITLE_MAX) return collapsed || "New chat";
  return collapsed.slice(0, TITLE_MAX - 1).trimEnd() + "…";
}

export const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * Whether a harness list is an answer rather than a placeholder. The host
 * replies to a new connection at once with `checking` for every harness,
 * before it has run anything, so a list having arrived says nothing about
 * what is installed. A gate that reads the placeholder as "nothing is
 * ready" shows its sign-in screen to someone who is already signed in, for
 * as long as the probes take.
 */
export function harnessesSettled(harnesses: HarnessInfo[]): boolean {
  return harnesses.length > 0 && harnesses.every((harness) => harness.status !== "checking");
}

export const HARNESS_IDS: readonly HarnessId[] = ["claude", "codex"];

export function isHarnessId(value: unknown): value is HarnessId {
  return value === "claude" || value === "codex";
}
