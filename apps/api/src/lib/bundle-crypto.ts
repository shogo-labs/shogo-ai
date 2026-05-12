// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * bundle-crypto
 *
 * Passphrase-based encryption for the optional `encryptedSecrets` blob in
 * `.shogo-project` bundles. Goals:
 *
 *   - Zero new deps: uses Node/Bun's built-in `crypto.subtle` (Web Crypto).
 *   - Strong-enough for offline file transfer: PBKDF2-SHA256 (600,000 iters)
 *     stretches the user's passphrase into a 256-bit key, then AES-256-GCM
 *     authenticates and encrypts the JSON payload.
 *   - Per-export random salt + IV — no nonce reuse across bundles.
 *
 * NOT a replacement for proper key management. This is for trusted users
 * moving an agent between their own workspaces who want to skip re-typing
 * tokens. Public bundles should ship with `encryptedSecrets` omitted entirely.
 */
import { webcrypto } from 'node:crypto'

// PBKDF2 parameters. 600k iterations is OWASP's 2023 recommendation for
// PBKDF2-SHA256; tune up over time as compute gets cheaper.
const PBKDF2_ITERS = 600_000
const PBKDF2_HASH = 'SHA-256'
const KEY_LEN_BITS = 256
const SALT_LEN = 16 // bytes
const IV_LEN = 12 // bytes (GCM standard)

// `as any` cast: Bun/Node's `webcrypto.subtle` is structurally identical to
// the DOM `SubtleCrypto` but uses different (incompatible-by-name)
// `BufferSource` and `CryptoKey` types. Using `any` at this single boundary
// keeps the rest of the module type-clean.
const subtle = webcrypto.subtle as any

function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<any> {
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: PBKDF2_HASH },
    baseKey,
    { name: 'AES-GCM', length: KEY_LEN_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

export interface EncryptedSecretsBlob {
  alg: 'aes-256-gcm'
  kdf: 'pbkdf2-sha256'
  iters: number
  salt: string // base64
  iv: string // base64
  ct: string // base64 (ciphertext + GCM auth tag)
}

/**
 * Encrypt a JSON-serialisable payload with a passphrase.
 * Returns the blob shape that lives at `project.json -> encryptedSecrets`.
 */
export async function encryptSecrets(
  payload: unknown,
  passphrase: string,
): Promise<EncryptedSecretsBlob> {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.')
  }
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_LEN))
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_LEN))
  const key = await deriveKey(passphrase, salt)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ctBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return {
    alg: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iters: PBKDF2_ITERS,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ctBuf)),
  }
}

/**
 * Decrypt a previously encrypted blob. Returns the parsed payload.
 * Throws on wrong passphrase / tampered ciphertext (GCM auth fails).
 */
export async function decryptSecrets<T = unknown>(
  blob: EncryptedSecretsBlob,
  passphrase: string,
): Promise<T> {
  if (!blob || blob.alg !== 'aes-256-gcm' || blob.kdf !== 'pbkdf2-sha256') {
    throw new Error('Unsupported encryptedSecrets format.')
  }
  const salt = b64ToBytes(blob.salt)
  const iv = b64ToBytes(blob.iv)
  const ct = b64ToBytes(blob.ct)
  // Use the iters from the blob if present (forward-compat with future bumps).
  // Currently we only know how to derive with the constant we shipped, but
  // we honour blob.iters so future blobs encrypted with a higher count still
  // work with no code change.
  const iters = typeof blob.iters === 'number' && blob.iters > 0 ? blob.iters : PBKDF2_ITERS
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iters, hash: PBKDF2_HASH },
    baseKey,
    { name: 'AES-GCM', length: KEY_LEN_BITS },
    false,
    ['decrypt'],
  )
  let ptBuf: ArrayBuffer
  try {
    ptBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  } catch {
    // GCM tag mismatch — wrong passphrase or tampered blob. Don't leak which.
    throw new Error('Could not decrypt — passphrase may be incorrect.')
  }
  const text = new TextDecoder().decode(ptBuf)
  return JSON.parse(text) as T
}

// ─── .env helpers (used by the export route) ─────────────────────
//
// We parse `.env` at export time so we can split it into:
//   - public values (kept in the bundle as a `.env.example` showing keys only)
//   - secret values (stripped from the bundle, surfaced as requiredCredentials,
//     and optionally moved into the encryptedSecrets blob).

export interface ParsedEnvLine {
  key: string
  value: string
  raw: string // original line (for re-emitting comments + whitespace)
  isComment: boolean
}

export function parseEnvFile(text: string): ParsedEnvLine[] {
  const out: ParsedEnvLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      out.push({ key: '', value: '', raw, isComment: true })
      continue
    }
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx <= 0) {
      out.push({ key: '', value: '', raw, isComment: true })
      continue
    }
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    // Strip surrounding quotes (common .env style).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out.push({ key, value, raw, isComment: false })
  }
  return out
}
