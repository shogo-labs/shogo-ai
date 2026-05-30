// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Symmetric secret encryption for at-rest credentials (e.g. custom model
 * provider API keys stored in the `ModelProvider` table).
 *
 * Uses AES-256-GCM with a 32-byte master key supplied via the
 * `SECRETS_ENCRYPTION_KEY` environment variable (base64 or hex encoded).
 * GCM gives us authenticated encryption: tampering with the ciphertext or
 * IV fails the auth-tag check on decrypt instead of silently returning
 * garbage.
 *
 * Stored blob format (all base64, colon-delimited):
 *   v1:<iv>:<authTag>:<ciphertext>
 *
 * Design notes:
 *  - We fail CLOSED. If the master key is missing or malformed, both
 *    encrypt and decrypt throw rather than persisting/returning plaintext.
 *    Callers (admin routes, registry) surface this as a 500 / startup
 *    error so a misconfigured environment can never store a key in the
 *    clear or leak one.
 *  - The version prefix (`v1`) lets us rotate the scheme later without
 *    ambiguity.
 *  - This is intentionally separate from `crypto-util.ts`, which only does
 *    timing-safe comparison and log redaction (no reversible crypto).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12 // 96-bit nonce, the GCM-recommended size
const KEY_BYTES = 32 // AES-256
const VERSION = 'v1'

/**
 * Resolve and validate the 32-byte master key from the environment.
 * Accepts base64 or hex. Throws if absent or the wrong length.
 */
function getMasterKey(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY
  if (!raw || raw.trim() === '') {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY is not set — cannot encrypt/decrypt provider credentials. ' +
        'Provision a 32-byte key (base64 or hex) before storing model provider keys.',
    )
  }
  const trimmed = raw.trim()

  // Try base64 first, then hex; both must decode to exactly 32 bytes.
  let key: Buffer | null = null
  try {
    const b64 = Buffer.from(trimmed, 'base64')
    if (b64.length === KEY_BYTES) key = b64
  } catch {
    // fall through to hex
  }
  if (!key && /^[0-9a-fA-F]+$/.test(trimmed)) {
    const hex = Buffer.from(trimmed, 'hex')
    if (hex.length === KEY_BYTES) key = hex
  }

  if (!key) {
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (base64 or hex). ` +
        'Generate one with: openssl rand -base64 32',
    )
  }
  return key
}

/** True when a usable master key is configured. Never throws. */
export function isSecretCryptoConfigured(): boolean {
  try {
    getMasterKey()
    return true
  } catch {
    return false
  }
}

/**
 * Encrypt a plaintext secret. Returns an opaque, versioned blob safe to
 * persist. Throws if the master key is missing/invalid (fail closed).
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new Error('encryptSecret expects a string')
  }
  const key = getMasterKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/**
 * Decrypt a blob produced by `encryptSecret`. Throws if the master key is
 * missing/invalid, the format is unrecognized, or the auth tag fails
 * (tampering / wrong key).
 */
export function decryptSecret(blob: string): string {
  if (!blob || typeof blob !== 'string') {
    throw new Error('decryptSecret expects a non-empty string')
  }
  const parts = blob.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('decryptSecret: unrecognized ciphertext format')
  }
  const key = getMasterKey()
  const iv = Buffer.from(parts[1], 'base64')
  const authTag = Buffer.from(parts[2], 'base64')
  const ciphertext = Buffer.from(parts[3], 'base64')
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Produce a non-reversible display mask for a secret, e.g. `sk-si…3xaa`.
 * Used by read APIs so admins can recognize which key is configured
 * without ever returning the plaintext or ciphertext.
 */
export function maskSecret(plaintext: string): string {
  if (!plaintext) return ''
  if (plaintext.length <= 8) return '••••'
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`
}
