/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What a brought key is worth: which models the endpoint behind it offers,
// and how to hand it to a harness. Nothing here is stored — the vault does
// that; this only talks to the endpoint and shapes spawn arguments.

import type { CredentialSummary, ProviderWire } from "../protocol";

/** A stored credential with its key put back: what a spawn needs. */
export type ResolvedCredential = CredentialSummary & { apiKey: string };

/**
 * The variable a brought key rides in. Codex is told the name rather than
 * the value (`env_key`), so the key is never in an argument list, where
 * every process on the machine could read it.
 */
export const BYOK_ENV_VAR = "DIFFUSION_BYOK_KEY";

/** The provider id Codex is configured under. Ours alone; the user's own stay untouched. */
export const BYOK_PROVIDER_ID = "byok";

/** A key a local server will accept: it wants the header present, not valid. */
const PLACEHOLDER_KEY = "local";

const PROBE_TIMEOUT_MS = 15_000;

/** Trailing slashes make `${base}/models` a double slash, which some gateways 404. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * A base URL we are willing to send a key to: http(s) only, and plain http
 * only on the loopback a local server listens on.
 */
export function validateBaseUrl(url: string): { ok: true; url: string } | { ok: false; reason: string } {
  const normalized = normalizeBaseUrl(url);
  if (!normalized) return { ok: false, reason: "A base URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, reason: `${normalized} is not a URL` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "The base URL must be http or https" };
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
  if (parsed.protocol === "http:" && !local) {
    return { ok: false, reason: "Plain http is only allowed for a server on this machine" };
  }
  return { ok: true, url: normalized };
}

type ModelRow = { id: string; label: string };

/**
 * The wire id is the label. A gateway's `vendor/model` ids say which
 * vendor is being paid, which is a different question from which gateway,
 * and two vendors behind one gateway routinely offer the same model name —
 * so the prefix stays, and the rows stay distinguishable.
 */
function sortModels(rows: ModelRow[]): ModelRow[] {
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    const message = (error as Error)?.name === "AbortError" ? `${url} did not answer in time` : `Could not reach ${url}`;
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) throw new Error("The endpoint rejected that key");
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(`${url} did not answer with JSON — check the base URL`);
  }
}

/**
 * The models an endpoint lists. Both wires answer with `{ data: [{ id }] }`,
 * so one shape reads them; an endpoint that lists none is still usable —
 * the dialog lets the model be typed in that case.
 */
export async function listModels(params: { wire: ProviderWire; baseUrl: string; apiKey: string }): Promise<ModelRow[]> {
  const base = normalizeBaseUrl(params.baseUrl);
  const key = params.apiKey.trim() || PLACEHOLDER_KEY;
  const anthropic = params.wire === "anthropic";
  // Anthropic's base URL is the host, not a version segment; OpenAI-compatible ones include it.
  const url = anthropic ? `${base}/v1/models?limit=100` : `${base}/models`;
  const headers: Record<string, string> = anthropic
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${key}` };
  const body = (await fetchJson(url, headers)) as { data?: { id?: unknown; display_name?: unknown }[] };
  const rows: ModelRow[] = [];
  for (const entry of body.data ?? []) {
    if (typeof entry?.id !== "string" || !entry.id) continue;
    const display = typeof entry.display_name === "string" && entry.display_name ? entry.display_name : entry.id;
    rows.push({ id: entry.id, label: display });
  }
  return sortModels(rows);
}

/**
 * The `-c` overrides that point Codex at a brought endpoint. They go on the
 * command line, so nothing is written to `~/.codex/config.toml` — the user's
 * own configuration survives whatever the app does.
 */
export function codexProviderArgs(credential: ResolvedCredential): string[] {
  const id = BYOK_PROVIDER_ID;
  const toml = (value: string) => JSON.stringify(value); // TOML basic strings are JSON strings.
  return [
    "-c",
    `model_provider=${toml(id)}`,
    "-c",
    `model_providers.${id}.name=${toml(credential.label)}`,
    "-c",
    `model_providers.${id}.base_url=${toml(normalizeBaseUrl(credential.baseUrl))}`,
    "-c",
    `model_providers.${id}.wire_api=${toml(credential.chatApi)}`,
    "-c",
    `model_providers.${id}.env_key=${toml(BYOK_ENV_VAR)}`,
    // Ours is not an OpenAI login, so the app-server must not demand one.
    "-c",
    `model_providers.${id}.requires_openai_auth=false`,
  ];
}

/**
 * What a brought key adds to a child's environment. Claude Code reads the
 * Anthropic variables directly; Codex reads only the one its `env_key`
 * names. `ANTHROPIC_AUTH_TOKEN` is what a gateway in front of Anthropic
 * wants, so a non-default base URL sets both.
 */
export function credentialEnv(credential: ResolvedCredential): Record<string, string> {
  const key = credential.apiKey || PLACEHOLDER_KEY;
  if (credential.wire === "openai-compatible") return { [BYOK_ENV_VAR]: key };
  const base = normalizeBaseUrl(credential.baseUrl);
  const env: Record<string, string> = { ANTHROPIC_API_KEY: key };
  if (base && base !== "https://api.anthropic.com") {
    env.ANTHROPIC_BASE_URL = base;
    env.ANTHROPIC_AUTH_TOKEN = key;
  }
  return env;
}
