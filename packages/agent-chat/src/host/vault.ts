/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Where brought keys live: one AES-256-GCM file under the data dir. The
// host runs in a utility process, which has no Electron `safeStorage`, so
// the embedder hands it a key at start (desktop keeps that key in the OS
// keychain) and a plain `node` host falls back to a 0600 key file beside
// the vault. Keys go out to a spawned child and nowhere else — never to a
// client, never into an argument list, never into the log.

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WIRE_HARNESS } from "../protocol";
import { listModels, normalizeBaseUrl, validateBaseUrl } from "./providers";

import type { CredentialInput, CredentialSummary, HarnessId, ProviderWire } from "../protocol";
import type { ResolvedCredential } from "./providers";

type StoredCredential = CredentialSummary & { apiKey: string };

/**
 * What the encrypted blob holds. `tokens` are the long-lived ones a CLI's
 * own login produced and handed over (Claude Code's `setup-token`); they
 * are not credentials — they go into the environment every child and probe
 * sees, so the CLI behaves exactly as if it had been signed in normally.
 */
type VaultData = { credentials: StoredCredential[]; tokens: Partial<Record<HarnessId, string>> };

type VaultFile = { v: 1; iv: string; tag: string; data: string };

const KEY_BYTES = 32;
const IV_BYTES = 12;

export type VaultOptions = {
  dataDir: string;
  /** 32 bytes, base64. Omitted: a key file next to the vault is used or made. */
  key?: string;
  log?: (message: string) => void;
};

export class CredentialVault {
  private readonly options: VaultOptions;
  private readonly file: string;
  private readonly keyFile: string;
  private credentials: StoredCredential[] = [];
  private tokens: Partial<Record<HarnessId, string>> = {};
  private key: Buffer | null = null;
  private loaded = false;
  /** Serializes writes, so two saves cannot interleave on one file. */
  private writing: Promise<void> = Promise.resolve();

  constructor(options: VaultOptions) {
    this.options = options;
    this.file = join(options.dataDir, "credentials.enc");
    this.keyFile = join(options.dataDir, "credentials.key");
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private async resolveKey(): Promise<Buffer> {
    if (this.key) return this.key;
    const given = this.options.key ? Buffer.from(this.options.key, "base64") : null;
    if (given && given.length === KEY_BYTES) {
      this.key = given;
      return given;
    }
    if (given) this.log("vault: the key given is not 32 bytes; falling back to the key file");
    try {
      const existing = Buffer.from((await readFile(this.keyFile, "utf8")).trim(), "base64");
      if (existing.length === KEY_BYTES) {
        this.key = existing;
        return existing;
      }
      this.log("vault: the key file is malformed; a new one is being written and stored keys are lost");
    } catch {
      // No key file yet: the first run writes one.
    }
    const fresh = randomBytes(KEY_BYTES);
    await mkdir(this.options.dataDir, { recursive: true });
    await writeFile(this.keyFile, fresh.toString("base64"), { encoding: "utf8", mode: 0o600 });
    // `mode` is ignored when the file already existed, so the bits are set outright.
    await chmod(this.keyFile, 0o600).catch(() => {});
    this.key = fresh;
    return fresh;
  }

  /** Reads the vault. A file that will not decrypt is reported and treated as empty, never thrown. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return;
    }
    try {
      const key = await this.resolveKey();
      const parsed = JSON.parse(raw) as VaultFile;
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
      const data = JSON.parse(plain) as VaultData;
      this.credentials = Array.isArray(data?.credentials) ? data.credentials.filter((entry) => entry && typeof entry.id === "string") : [];
      this.tokens = data?.tokens && typeof data.tokens === "object" ? data.tokens : {};
    } catch (error) {
      // A rotated OS key, or a file from another machine: the stored keys
      // are gone either way, and the user is asked for them again.
      this.log(`vault: could not read stored credentials (${(error as Error)?.message ?? "unknown"}); starting empty`);
      this.credentials = [];
      this.tokens = {};
    }
  }

  private persist(): Promise<void> {
    const next = this.writing.then(async () => {
      const key = await this.resolveKey();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const plain: VaultData = { credentials: this.credentials, tokens: this.tokens };
      const data = Buffer.concat([cipher.update(JSON.stringify(plain), "utf8"), cipher.final()]);
      const file: VaultFile = { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
      await mkdir(this.options.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.file);
      await chmod(this.file, 0o600).catch(() => {});
    });
    // A failed write must not wedge every write after it.
    this.writing = next.catch(() => {});
    return next;
  }

  /** What a client may see: every credential, without its key. */
  list(): CredentialSummary[] {
    return this.credentials.map(redact);
  }

  /** The credential plus its key, for a spawn. Null when it has been deleted since. */
  resolve(id: string): ResolvedCredential | null {
    const found = this.credentials.find((entry) => entry.id === id);
    return found ? { ...found } : null;
  }

  has(id: string): boolean {
    return this.credentials.some((entry) => entry.id === id);
  }

  /**
   * Stores a credential after checking it against its endpoint, so a key
   * that cannot work is refused where the user can still fix it rather
   * than at the start of a turn. Throws with a readable reason.
   */
  async save(input: CredentialInput): Promise<CredentialSummary> {
    await this.load();
    const wire: ProviderWire = input.wire === "anthropic" ? "anthropic" : "openai-compatible";
    const checked = validateBaseUrl(input.baseUrl);
    if (!checked.ok) throw new Error(checked.reason);
    const apiKey = (input.apiKey ?? "").trim();
    const existing = input.id ? this.credentials.find((entry) => entry.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("That credential no longer exists");
    // An edit that leaves the key field empty keeps the key already stored.
    const effectiveKey = apiKey || existing?.apiKey || "";

    let models = input.models?.filter((model) => model?.id) ?? [];
    if (models.length === 0) {
      models = await listModels({ wire, baseUrl: checked.url, apiKey: effectiveKey });
    }

    const summaryDefault = input.defaultModel && models.some((model) => model.id === input.defaultModel) ? input.defaultModel : models[0]?.id;
    const record: StoredCredential = {
      id: existing?.id ?? randomUUID(),
      label: input.label.trim() || input.provider,
      provider: input.provider,
      wire,
      harness: WIRE_HARNESS[wire],
      baseUrl: normalizeBaseUrl(checked.url),
      chatApi: input.chatApi === "responses" ? "responses" : "chat",
      models,
      ...(summaryDefault ? { defaultModel: summaryDefault } : {}),
      hasKey: !!effectiveKey,
      createdAt: existing?.createdAt ?? Date.now(),
      apiKey: effectiveKey,
    };
    this.credentials = existing
      ? this.credentials.map((entry) => (entry.id === record.id ? record : entry))
      : [...this.credentials, record];
    await this.persist();
    return redact(record);
  }

  async delete(id: string): Promise<void> {
    await this.load();
    const before = this.credentials.length;
    this.credentials = this.credentials.filter((entry) => entry.id !== id);
    if (this.credentials.length !== before) await this.persist();
  }

  /**
   * The environment a long-lived token adds. Merged into the hydrated env
   * before any probe or spawn, so `claude auth status` and a running turn
   * agree about whether there is a login.
   */
  tokenEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.tokens.claude) env.CLAUDE_CODE_OAUTH_TOKEN = this.tokens.claude;
    if (this.tokens.codex) env.CODEX_API_KEY = this.tokens.codex;
    return env;
  }

  hasToken(harness: HarnessId): boolean {
    return !!this.tokens[harness];
  }

  async setToken(harness: HarnessId, token: string): Promise<void> {
    await this.load();
    const trimmed = token.trim();
    if (trimmed) this.tokens = { ...this.tokens, [harness]: trimmed };
    else this.tokens = { ...this.tokens, [harness]: undefined };
    await this.persist();
  }

  async clearToken(harness: HarnessId): Promise<void> {
    await this.load();
    if (!this.tokens[harness]) return;
    this.tokens = { ...this.tokens, [harness]: undefined };
    await this.persist();
  }
}

function redact(credential: StoredCredential): CredentialSummary {
  const { apiKey: _apiKey, ...summary } = credential;
  return summary;
}
