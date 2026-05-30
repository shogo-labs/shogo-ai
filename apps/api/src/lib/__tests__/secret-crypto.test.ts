// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/lib/secret-crypto.ts.
 *
 *   bun test apps/api/src/lib/__tests__/secret-crypto.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { randomBytes } from 'node:crypto'

const ORIG_KEY = process.env.SECRETS_ENCRYPTION_KEY

function setKey(): string {
  const key = randomBytes(32).toString('base64')
  process.env.SECRETS_ENCRYPTION_KEY = key
  return key
}

// Re-import fresh each time so module-level state (none here, but defensive)
// is clean. The module reads the env var lazily inside each call, so a plain
// import is sufficient.
const { encryptSecret, decryptSecret, maskSecret, isSecretCryptoConfigured } = await import('../secret-crypto')

describe('secret-crypto', () => {
  beforeEach(() => {
    setKey()
  })
  afterEach(() => {
    if (ORIG_KEY === undefined) delete process.env.SECRETS_ENCRYPTION_KEY
    else process.env.SECRETS_ENCRYPTION_KEY = ORIG_KEY
  })

  test('round-trips a secret', () => {
    const plaintext = 'sk-sibaghjedsxj939rokadg6ibwxub1qgonv53c8eyj7av3xaa'
    const blob = encryptSecret(plaintext)
    expect(blob).not.toContain(plaintext)
    expect(blob.startsWith('v1:')).toBe(true)
    expect(decryptSecret(blob)).toBe(plaintext)
  })

  test('produces distinct ciphertext per call (random IV)', () => {
    const a = encryptSecret('same')
    const b = encryptSecret('same')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('same')
    expect(decryptSecret(b)).toBe('same')
  })

  test('round-trips unicode + empty string', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('')
    expect(decryptSecret(encryptSecret('🔑 café 你好'))).toBe('🔑 café 你好')
  })

  test('accepts a hex-encoded master key', () => {
    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('hex')
    const blob = encryptSecret('hex-keyed')
    expect(decryptSecret(blob)).toBe('hex-keyed')
  })

  test('fails closed (throws) without a master key', () => {
    delete process.env.SECRETS_ENCRYPTION_KEY
    expect(isSecretCryptoConfigured()).toBe(false)
    expect(() => encryptSecret('x')).toThrow(/SECRETS_ENCRYPTION_KEY/)
    expect(() => decryptSecret('v1:a:b:c')).toThrow(/SECRETS_ENCRYPTION_KEY/)
  })

  test('rejects a master key of the wrong length', () => {
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64')
    expect(isSecretCryptoConfigured()).toBe(false)
    expect(() => encryptSecret('x')).toThrow(/32 bytes/)
  })

  test('rejects tampered ciphertext (auth tag fails)', () => {
    const blob = encryptSecret('integrity')
    const parts = blob.split(':')
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[3], 'base64')
    ct[0] = ct[0] ^ 0xff
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${ct.toString('base64')}`
    expect(() => decryptSecret(tampered)).toThrow()
  })

  test('rejects an unrecognized blob format', () => {
    expect(() => decryptSecret('not-a-valid-blob')).toThrow(/format/)
    expect(() => decryptSecret('v2:a:b:c')).toThrow(/format/)
  })

  test('mask never reveals the full secret', () => {
    expect(maskSecret('sk-sibaghjedsxj939rokadg6ibwxub1qgonv53c8eyj7av3xaa')).toBe('sk-s…3xaa')
    expect(maskSecret('short')).toBe('••••')
    expect(maskSecret('')).toBe('')
  })
})
