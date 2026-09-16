/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The key the agent host's credential vault is encrypted with. The host
// runs in a utility process, which has no `safeStorage`, so main owns the
// key: it makes one, wraps it with the OS keychain, and hands the raw key
// over at fork. Where the platform has no keychain (a Linux box with no
// secret service), none is passed and the host falls back to a 0600 key
// file of its own.

import { app, safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_BYTES = 32;
const FILE = "credential-key.bin";

let cached: string | null = null;

function keyPath(): string {
  return join(app.getPath("userData"), FILE);
}

/**
 * The vault key as base64, or null when the OS cannot protect one. Made on
 * first use and stable after that — losing it loses every stored key.
 */
export function credentialKey(): string | null {
  if (cached) return cached;
  if (!safeStorage.isEncryptionAvailable()) return null;
  const path = keyPath();
  if (existsSync(path)) {
    try {
      const key = safeStorage.decryptString(readFileSync(path));
      if (Buffer.from(key, "base64").length === KEY_BYTES) {
        cached = key;
        return cached;
      }
      console.error("[credentials] the stored vault key is malformed; making a new one");
    } catch (error) {
      // A keychain entry the OS rotated, or a file copied from another
      // machine: the keys it protected are unreadable either way.
      console.error(`[credentials] could not read the vault key: ${(error as Error)?.message ?? "unknown"}`);
    }
  }
  const fresh = randomBytes(KEY_BYTES).toString("base64");
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(path, safeStorage.encryptString(fresh), { mode: 0o600 });
  } catch (error) {
    console.error(`[credentials] could not store the vault key: ${(error as Error)?.message ?? "unknown"}`);
    return null;
  }
  cached = fresh;
  return cached;
}
