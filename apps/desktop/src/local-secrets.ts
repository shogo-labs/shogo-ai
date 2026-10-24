// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop app's instance secret for at-rest credential encryption
 * (`SECRETS_ENCRYPTION_KEY`).
 *
 * Cloud gets this key from its environment (a per-region k8s secret). A
 * packaged desktop never set it at all: `apps/api/src/lib/secret-crypto.ts`
 * deliberately has no fallback and fails closed, so on a fresh install every
 * `encryptSecret()` call site threw — native provider keys, custom providers,
 * GitHub connect, Slack installs, managed integrations, app-install keys,
 * trigger webhook secrets (SHO-75). This module generates a key once, next to
 * `.auth-secret`, and `local-server.ts` passes it to the api child.
 *
 * The file lives in the data dir beside `shogo.db` on purpose: the key and the
 * ciphertext it protects are then backed up, restored and deleted together, so
 * a fresh data dir can never be left holding rows it cannot decrypt.
 *
 * Electron-free (the caller supplies the data dir) so it can be unit-tested —
 * same pattern as `local-api-supervisor.ts`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const SECRETS_ENCRYPTION_KEY_FILENAME = '.secrets-encryption-key'

const KEY_BYTES = 32

/** Decoded key length, or 0 when the value is not a 32-byte base64/hex key. */
export function secretsEncryptionKeyBytes(raw: string): number {
  const trimmed = raw.trim()
  if (!trimmed) return 0
  if (Buffer.from(trimmed, 'base64').length === KEY_BYTES) return KEY_BYTES
  if (/^[0-9a-fA-F]+$/.test(trimmed) && Buffer.from(trimmed, 'hex').length === KEY_BYTES) {
    return KEY_BYTES
  }
  return 0
}

export function secretsEncryptionKeyPath(dataDir: string): string {
  return path.join(dataDir, SECRETS_ENCRYPTION_KEY_FILENAME)
}

/**
 * Return the install's `SECRETS_ENCRYPTION_KEY`, generating and persisting one
 * on first call. A key that already exists is returned verbatim and never
 * rotated: replacing it would orphan every row encrypted with the old one.
 *
 * A file that exists but does not decode to 32 bytes is left untouched (again,
 * so stored credentials are not orphaned) and reported — the api then fails
 * closed on its own, which is visible in `[LocalAPI]` boot logs.
 */
export function getOrCreateSecretsEncryptionKey(dataDir: string): string {
  const keyPath = secretsEncryptionKeyPath(dataDir)

  if (fs.existsSync(keyPath)) {
    const stored = fs.readFileSync(keyPath, 'utf-8').trim()
    if (secretsEncryptionKeyBytes(stored)) return stored
    console.error(
      `[Desktop] ${SECRETS_ENCRYPTION_KEY_FILENAME} at ${keyPath} does not decode to ${KEY_BYTES} bytes ` +
        '(base64 or hex). Leaving it untouched so stored credentials are not orphaned; ' +
        'encrypted-credential features will stay disabled until it is fixed or removed.',
    )
    return stored
  }

  fs.mkdirSync(dataDir, { recursive: true })
  const secret = randomBytes(KEY_BYTES).toString('base64')
  fs.writeFileSync(keyPath, secret, { mode: 0o600 })
  return secret
}
