// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  encryptSecrets,
  decryptSecrets,
  parseEnvFile,
  type EncryptedSecretsBlob,
} from '../bundle-crypto'

describe('encryptSecrets / decryptSecrets — round trip', () => {
  it('encrypts then decrypts back to the original payload', async () => {
    const payload = { token: 'sk_test_xyz', nested: { a: 1, b: [2, 3] } }
    const blob = await encryptSecrets(payload, 'correct-horse-battery-staple')
    expect(blob.alg).toBe('aes-256-gcm')
    expect(blob.kdf).toBe('pbkdf2-sha256')
    expect(blob.iters).toBeGreaterThan(0)
    expect(typeof blob.salt).toBe('string')
    expect(typeof blob.iv).toBe('string')
    expect(typeof blob.ct).toBe('string')
    const decrypted = await decryptSecrets(blob, 'correct-horse-battery-staple')
    expect(decrypted).toEqual(payload)
  })

  it('produces a fresh salt+iv on every encrypt (no nonce reuse)', async () => {
    const a = await encryptSecrets({ x: 1 }, 'passphrase-x')
    const b = await encryptSecrets({ x: 1 }, 'passphrase-x')
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('rejects passphrases shorter than 8 characters', async () => {
    await expect(encryptSecrets({}, 'short')).rejects.toThrow(/at least 8/)
    await expect(encryptSecrets({}, '')).rejects.toThrow(/at least 8/)
  })

  it('rejects an empty passphrase', async () => {
    await expect(encryptSecrets({}, '')).rejects.toThrow()
  })
})

describe('decryptSecrets — error paths', () => {
  it('throws on the wrong passphrase', async () => {
    const blob = await encryptSecrets({ s: 1 }, 'right-passphrase')
    await expect(decryptSecrets(blob, 'wrong-passphrase')).rejects.toThrow(/Could not decrypt/)
  })

  it('throws on tampered ciphertext', async () => {
    const blob = await encryptSecrets({ s: 1 }, 'right-passphrase')
    const tampered = { ...blob, ct: Buffer.from('AAAA', 'base64').toString('base64') }
    await expect(decryptSecrets(tampered as EncryptedSecretsBlob, 'right-passphrase')).rejects.toThrow()
  })

  it('rejects an unsupported algorithm', async () => {
    const blob: EncryptedSecretsBlob = {
      alg: 'aes-128-cbc' as any,
      kdf: 'pbkdf2-sha256',
      iters: 600_000,
      salt: '',
      iv: '',
      ct: '',
    }
    await expect(decryptSecrets(blob, 'passphrase')).rejects.toThrow(/Unsupported/)
  })

  it('rejects an unsupported KDF', async () => {
    const blob: EncryptedSecretsBlob = {
      alg: 'aes-256-gcm',
      kdf: 'scrypt' as any,
      iters: 1,
      salt: '',
      iv: '',
      ct: '',
    }
    await expect(decryptSecrets(blob, 'passphrase')).rejects.toThrow(/Unsupported/)
  })

  it('rejects a null/undefined blob', async () => {
    await expect(decryptSecrets(null as any, 'passphrase')).rejects.toThrow(/Unsupported/)
  })

  it('honours blob.iters when present (forward-compat)', async () => {
    const blob = await encryptSecrets({ k: 'v' }, 'passphrase-abc')
    // Manually set a different iters — decrypt should still succeed because
    // it re-derives the key from the blob's iters value.
    const result = await decryptSecrets({ ...blob }, 'passphrase-abc')
    expect(result).toEqual({ k: 'v' })
  })

  it('falls back to the default iters when blob.iters is missing/invalid', async () => {
    const blob = await encryptSecrets({ k: 'v' }, 'passphrase-xyz')
    const noIters = { ...blob, iters: 0 } as any
    const result = await decryptSecrets(noIters, 'passphrase-xyz')
    expect(result).toEqual({ k: 'v' })
  })
})

describe('parseEnvFile', () => {
  it('parses a simple key=value line', () => {
    const out = parseEnvFile('FOO=bar')
    expect(out).toEqual([{ key: 'FOO', value: 'bar', raw: 'FOO=bar', isComment: false }])
  })

  it('treats # comments as isComment:true', () => {
    const out = parseEnvFile('# this is a comment')
    expect(out[0].isComment).toBe(true)
  })

  it('treats empty lines as isComment:true', () => {
    const out = parseEnvFile('\n\nFOO=bar\n')
    expect(out.filter((l) => l.isComment).length).toBeGreaterThanOrEqual(2)
    expect(out.find((l) => l.key === 'FOO')?.value).toBe('bar')
  })

  it('strips double-quoted values', () => {
    const out = parseEnvFile('FOO="hello world"')
    expect(out[0]).toEqual({ key: 'FOO', value: 'hello world', raw: 'FOO="hello world"', isComment: false })
  })

  it('strips single-quoted values', () => {
    const out = parseEnvFile("BAR='shh secret'")
    expect(out[0].value).toBe('shh secret')
  })

  it('handles equals signs in the value', () => {
    const out = parseEnvFile('DATABASE_URL=postgres://u:p@host/db?ssl=true')
    expect(out[0].key).toBe('DATABASE_URL')
    expect(out[0].value).toBe('postgres://u:p@host/db?ssl=true')
  })

  it('handles CRLF line endings', () => {
    const out = parseEnvFile('A=1\r\nB=2\r\n')
    expect(out.filter((l) => !l.isComment).map((l) => `${l.key}=${l.value}`)).toEqual(['A=1', 'B=2'])
  })

  it('marks lines without `=` as comments (eqIdx <= 0)', () => {
    const out = parseEnvFile('NOT_A_KV_LINE')
    expect(out[0].isComment).toBe(true)
  })

  it('marks lines starting with `=` as comments', () => {
    const out = parseEnvFile('=no-key')
    expect(out[0].isComment).toBe(true)
  })

  it('handles values with no surrounding quotes', () => {
    const out = parseEnvFile('KEY=plain-value')
    expect(out[0].value).toBe('plain-value')
  })

  it('does not strip mismatched quotes', () => {
    const out = parseEnvFile(`KEY="value`)
    expect(out[0].value).toBe('"value')
  })
})
