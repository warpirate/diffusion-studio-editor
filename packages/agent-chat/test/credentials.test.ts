/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BYOK_ENV_VAR, codexProviderArgs, credentialEnv, normalizeBaseUrl, validateBaseUrl } from "../src/host/providers";
import { CredentialVault } from "../src/host/vault";

import type { ResolvedCredential } from "../src/host/providers";

const credential = (overrides: Partial<ResolvedCredential> = {}): ResolvedCredential => ({
  id: "c1",
  label: "OpenRouter",
  provider: "openrouter",
  wire: "openai-compatible",
  harness: "codex",
  baseUrl: "https://openrouter.ai/api/v1",
  chatApi: "chat",
  models: [{ id: "x/y", label: "y" }],
  hasKey: true,
  createdAt: 1,
  apiKey: "sk-secret",
  ...overrides,
});

describe("validateBaseUrl", () => {
  it("keeps https and drops trailing slashes", () => {
    expect(validateBaseUrl("https://api.example.com/v1/")).toEqual({ ok: true, url: "https://api.example.com/v1" });
    expect(normalizeBaseUrl("https://a.b//")).toBe("https://a.b");
  });

  it("allows plain http only on this machine", () => {
    expect(validateBaseUrl("http://localhost:11434/v1").ok).toBe(true);
    expect(validateBaseUrl("http://127.0.0.1:1234/v1").ok).toBe(true);
    expect(validateBaseUrl("http://api.example.com/v1")).toMatchObject({ ok: false });
  });

  it("refuses what is not a URL, and other schemes", () => {
    expect(validateBaseUrl("")).toMatchObject({ ok: false });
    expect(validateBaseUrl("not a url")).toMatchObject({ ok: false });
    expect(validateBaseUrl("ftp://example.com")).toMatchObject({ ok: false });
    expect(validateBaseUrl("file:///etc/passwd")).toMatchObject({ ok: false });
  });
});

describe("codexProviderArgs", () => {
  it("names the variable the key lives in, never the key", () => {
    const args = codexProviderArgs(credential());
    const joined = args.join(" ");
    expect(joined).not.toContain("sk-secret");
    expect(joined).toContain(`model_providers.byok.env_key="${BYOK_ENV_VAR}"`);
    expect(joined).toContain('model_provider="byok"');
    expect(joined).toContain('model_providers.byok.base_url="https://openrouter.ai/api/v1"');
    expect(joined).toContain("model_providers.byok.requires_openai_auth=false");
  });

  it("quotes a label with characters TOML would choke on", () => {
    const args = codexProviderArgs(credential({ label: 'He said "hi"' }));
    expect(args).toContain('model_providers.byok.name="He said \\"hi\\""');
  });

  it("carries the wire the provider actually speaks", () => {
    expect(codexProviderArgs(credential({ chatApi: "responses" })).join(" ")).toContain('wire_api="responses"');
  });
});

describe("credentialEnv", () => {
  it("gives Codex only the one variable it was told to read", () => {
    expect(credentialEnv(credential())).toEqual({ [BYOK_ENV_VAR]: "sk-secret" });
  });

  it("gives Claude Code the Anthropic key, and nothing else for the default host", () => {
    const env = credentialEnv(credential({ wire: "anthropic", harness: "claude", baseUrl: "https://api.anthropic.com" }));
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-secret" });
  });

  it("adds the gateway variables when the endpoint is not Anthropic's own", () => {
    const env = credentialEnv(credential({ wire: "anthropic", harness: "claude", baseUrl: "https://gateway.internal/anthropic" }));
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sk-secret",
      ANTHROPIC_BASE_URL: "https://gateway.internal/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-secret",
    });
  });

  it("sends a placeholder for a local server that was given no key", () => {
    expect(credentialEnv(credential({ apiKey: "", hasKey: false }))).toEqual({ [BYOK_ENV_VAR]: "local" });
  });
});

describe("CredentialVault", () => {
  let dir: string;
  let vault: CredentialVault;
  const key = randomBytes(32).toString("base64");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-chat-vault-"));
    vault = new CredentialVault({ dataDir: dir, key });
    // The endpoint is not this test's subject; the models it would list are.
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ data: [{ id: "b/model" }, { id: "a/model" }] }), { headers: { "content-type": "application/json" } }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const input = {
    label: "OpenRouter",
    provider: "openrouter",
    wire: "openai-compatible" as const,
    baseUrl: "https://openrouter.ai/api/v1/",
    apiKey: "sk-secret",
  };

  it("stores a key, and never hands it back", async () => {
    const saved = await vault.save(input);
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved.hasKey).toBe(true);
    expect(saved.harness).toBe("codex");
    expect(saved.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(vault.list()[0]).not.toHaveProperty("apiKey");
    expect(vault.resolve(saved.id)?.apiKey).toBe("sk-secret");
  });

  it("lists what the endpoint offers, sorted, with the first as the default", async () => {
    const saved = await vault.save(input);
    expect(saved.models.map((model) => model.id)).toEqual(["a/model", "b/model"]);
    expect(saved.defaultModel).toBe("a/model");
  });

  it("writes nothing readable to disk", async () => {
    await vault.save(input);
    const onDisk = readFileSync(join(dir, "credentials.enc"), "utf8");
    expect(onDisk).not.toContain("sk-secret");
    expect(onDisk).not.toContain("openrouter.ai");
  });

  it("reads back what another vault with the same key wrote", async () => {
    const saved = await vault.save(input);
    const reopened = new CredentialVault({ dataDir: dir, key });
    await reopened.load();
    expect(reopened.resolve(saved.id)?.apiKey).toBe("sk-secret");
  });

  it("starts empty rather than throwing when the key has changed", async () => {
    await vault.save(input);
    const other = new CredentialVault({ dataDir: dir, key: randomBytes(32).toString("base64"), log: () => {} });
    await other.load();
    expect(other.list()).toEqual([]);
  });

  it("keeps the stored key when an edit leaves the field blank", async () => {
    const saved = await vault.save(input);
    const edited = await vault.save({ ...input, id: saved.id, apiKey: "", label: "Renamed" });
    expect(edited.id).toBe(saved.id);
    expect(edited.label).toBe("Renamed");
    expect(vault.resolve(saved.id)?.apiKey).toBe("sk-secret");
  });

  it("refuses a base URL it would not send a key to", async () => {
    await expect(vault.save({ ...input, baseUrl: "http://api.example.com/v1" })).rejects.toThrow(/only allowed/i);
  });

  it("forgets a credential that is deleted", async () => {
    const saved = await vault.save(input);
    await vault.delete(saved.id);
    expect(vault.has(saved.id)).toBe(false);
    expect(vault.resolve(saved.id)).toBeNull();
  });

  it("puts a pasted token into the environment probes and children read", async () => {
    expect(vault.tokenEnv()).toEqual({});
    await vault.setToken("claude", "  sk-ant-oat-x  ");
    expect(vault.hasToken("claude")).toBe(true);
    expect(vault.tokenEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x" });
    await vault.clearToken("claude");
    expect(vault.tokenEnv()).toEqual({});
  });
});
