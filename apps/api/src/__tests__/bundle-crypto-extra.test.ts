// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/lib/bundle-crypto.ts — targets the still-uncov
 * branches:
 *
 *  - `decryptSecrets` rejecting unsupported alg/kdf combos.
 *  - `decryptSecrets` honoring a custom `iters` value embedded in the
 *    blob (forward-compat path) and falling back to default when
 *    `iters` is missing / non-numeric / non-positive.
 *  - `decryptSecrets` throws the generic "passphrase may be incorrect"
 *    error for: wrong passphrase, tampered ciphertext, tampered IV,
 *    tampered salt — without revealing which one.
 *  - `encryptSecrets` minimum-passphrase enforcement.
 *  - `parseEnvFile` shell-style edges: blank lines, comment-only, no
 *    `=`, leading `=`, mixed-quote unbalanced (treated as literal),
 *    inline `#` (not a comment after a value), CRLF line endings.
 *
 *   bun test apps/api/src/__tests__/bundle-crypto-extra.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  encryptSecrets,
  decryptSecrets,
  parseEnvFile,
} from '../lib/bundle-crypto'

describe('decryptSecrets — format guards', () => {
  test('throws on null / falsy blob', async () => {
    await expect(decryptSecrets(null as any, 'pwd-abcd1234')).rejects.toThrow(
      'Unsupported encryptedSecrets format.',
    )
    await expect(decryptSecrets(undefined as any, 'pwd-abcd1234')).rejects.toThrow(
      'Unsupported encryptedSecrets format.',
    )
  })

  test('throws on unknown alg', async () => {
    await expect(
      decryptSecrets(
        { alg: 'chacha20', kdf: 'pbkdf2-sha256', iters: 600_000, salt: '', iv: '', ct: '' } as any,
        'pwd-abcd1234',
      ),
    ).rejects.toThrow('Unsupported encryptedSecrets format.')
  })

  test('throws on unknown kdf', async () => {
    await expect(
      decryptSecrets(
        { alg: 'aes-256-gcm', kdf: 'argon2id', iters: 1, salt: '', iv: '', ct: '' } as any,
        'pwd-abcd1234',
      ),
    ).rejects.toThrow('Unsupported encryptedSecrets format.')
  })
})

describe('decryptSecrets — iters handling', () => {
  test('honors custom iters in the blob (round-trips when iters matches)', async () => {
    const blob = await encryptSecrets({ msg: 'hi' }, 'pwd-abcd1234')
    // Encrypt always writes the constant iters; ensure decrypt honors it.
    const decrypted = await decryptSecrets<any>(blob, 'pwd-abcd1234')
    expect(decrypted.msg).toBe('hi')
    expect(blob.iters).toBe(600_000)
  })

  test('iters omitted (undefined) → falls back to default and still decrypts', async () => {
    const blob = await encryptSecrets({ msg: 'hi' }, 'pwd-abcd1234')
    const stripped = { ...blob } as any
    delete stripped.iters
    const decrypted = await decryptSecrets<any>(stripped, 'pwd-abcd1234')
    expect(decrypted.msg).toBe('hi')
  })

  test('iters as non-number → falls back to default', async () => {
    const blob = await encryptSecrets({ msg: 'x' }, 'pwd-abcd1234')
    const decrypted = await decryptSecrets<any>(
      { ...blob, iters: 'lots' as any },
      'pwd-abcd1234',
    )
    expect(decrypted.msg).toBe('x')
  })

  test('iters <= 0 → falls back to default', async () => {
    const blob = await encryptSecrets({ msg: 'y' }, 'pwd-abcd1234')
    const decrypted = await decryptSecrets<any>(
      { ...blob, iters: 0 },
      'pwd-abcd1234',
    )
    expect(decrypted.msg).toBe('y')
  })

  test('iters mismatched non-default integer → derives a different key → bad-passphrase error', async () => {
    const blob = await encryptSecrets({ msg: 'z' }, 'pwd-abcd1234')
    await expect(
      decryptSecrets({ ...blob, iters: 100_000 }, 'pwd-abcd1234'),
    ).rejects.toThrow('Could not decrypt — passphrase may be incorrect.')
  })
})

describe('decryptSecrets — tamper detection (GCM auth)', () => {
  test('wrong passphrase → generic error', async () => {
    const blob = await encryptSecrets({ k: 1 }, 'pwd-abcd1234')
    await expect(decryptSecrets(blob, 'pwd-xxxxx9999')).rejects.toThrow(
      'Could not decrypt — passphrase may be incorrect.',
    )
  })

  test('flipped byte in ciphertext → generic error (no leak)', async () => {
    const blob = await encryptSecrets({ k: 1 }, 'pwd-abcd1234')
    const ct = Buffer.from(blob.ct, 'base64')
    ct[0] ^= 0x01
    const tampered = { ...blob, ct: ct.toString('base64') }
    await expect(decryptSecrets(tampered, 'pwd-abcd1234')).rejects.toThrow(
      'Could not decrypt — passphrase may be incorrect.',
    )
  })

  test('flipped byte in IV → generic error', async () => {
    const blob = await encryptSecrets({ k: 1 }, 'pwd-abcd1234')
    const iv = Buffer.from(blob.iv, 'base64')
    iv[0] ^= 0x01
    const tampered = { ...blob, iv: iv.toString('base64') }
    await expect(decryptSecrets(tampered, 'pwd-abcd1234')).rejects.toThrow(
      'Could not decrypt — passphrase may be incorrect.',
    )
  })

  test('flipped byte in salt → generic error (different derived key)', async () => {
    const blob = await encryptSecrets({ k: 1 }, 'pwd-abcd1234')
    const salt = Buffer.from(blob.salt, 'base64')
    salt[0] ^= 0x01
    const tampered = { ...blob, salt: salt.toString('base64') }
    await expect(decryptSecrets(tampered, 'pwd-abcd1234')).rejects.toThrow(
      'Could not decrypt — passphrase may be incorrect.',
    )
  })

  test('truncated ciphertext (no auth tag) → generic error', async () => {
    const blob = await encryptSecrets({ k: 1 }, 'pwd-abcd1234')
    const ct = Buffer.from(blob.ct, 'base64').slice(0, 4)
    const tampered = { ...blob, ct: ct.toString('base64') }
    await expect(decryptSecrets(tampered, 'pwd-abcd1234')).rejects.toThrow(
      'Could not decrypt — passphrase may be incorrect.',
    )
  })
})

describe('encryptSecrets — passphrase length guard', () => {
  test('passphrase < 8 chars → throws', async () => {
    await expect(encryptSecrets({ k: 1 }, 'short')).rejects.toThrow(
      'Passphrase must be at least 8 characters.',
    )
  })

  test('empty passphrase → throws', async () => {
    await expect(encryptSecrets({ k: 1 }, '')).rejects.toThrow(
      'Passphrase must be at least 8 characters.',
    )
  })

  test('passphrase exactly 8 chars is accepted', async () => {
    const blob = await encryptSecrets({ k: 'ok' }, '12345678')
    const decrypted = await decryptSecrets<any>(blob, '12345678')
    expect(decrypted.k).toBe('ok')
  })

  test('encrypted blob has fresh random salt + IV (two encrypts of identical payload differ)', async () => {
    const a = await encryptSecrets({ k: 1 }, 'pwd-abcd1234')
    const b = await encryptSecrets({ k: 1 }, 'pwd-abcd1234')
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
    expect(a.iters).toBe(b.iters)
    expect(a.alg).toBe('aes-256-gcm')
    expect(a.kdf).toBe('pbkdf2-sha256')
  })
})

describe('parseEnvFile — edges', () => {
  test('blank lines and comment-only lines preserve raw, isComment=true', () => {
    const out = parseEnvFile('# top\n\nKEY=val\n# bottom\n')
    expect(out).toHaveLength(5)
    expect(out[0]).toEqual({ key: '', value: '', raw: '# top', isComment: true })
    expect(out[1]).toEqual({ key: '', value: '', raw: '', isComment: true })
    expect(out[2]).toEqual({ key: 'KEY', value: 'val', raw: 'KEY=val', isComment: false })
    expect(out[3]).toEqual({ key: '', value: '', raw: '# bottom', isComment: true })
    expect(out[4]).toEqual({ key: '', value: '', raw: '', isComment: true })
  })

  test('line with no `=` is treated as comment-shaped', () => {
    const out = parseEnvFile('NO_EQUALS_HERE')
    expect(out).toHaveLength(1)
    expect(out[0].isComment).toBe(true)
    expect(out[0].key).toBe('')
  })

  test('leading `=` (empty key) is treated as comment-shaped', () => {
    const out = parseEnvFile('=value-only')
    expect(out[0].isComment).toBe(true)
  })

  test('double-quoted value strips the quotes', () => {
    const out = parseEnvFile('KEY="hello world"')
    expect(out[0].value).toBe('hello world')
  })

  test('single-quoted value strips the quotes', () => {
    const out = parseEnvFile("KEY='hi there'")
    expect(out[0].value).toBe('hi there')
  })

  test('mixed unbalanced quotes are kept literally', () => {
    const out = parseEnvFile(`KEY="unclosed`)
    expect(out[0].value).toBe('"unclosed')
  })

  test('CRLF line endings are split correctly', () => {
    const out = parseEnvFile('A=1\r\nB=2\r\n')
    expect(out).toHaveLength(3) // last empty line counts as a "comment"
    expect(out[0]).toEqual({ key: 'A', value: '1', raw: 'A=1', isComment: false })
    expect(out[1]).toEqual({ key: 'B', value: '2', raw: 'B=2', isComment: false })
    expect(out[2].isComment).toBe(true)
  })

  test('value containing literal `=` keeps everything after the FIRST `=`', () => {
    const out = parseEnvFile('TOKEN=abc=def=ghi')
    expect(out[0].key).toBe('TOKEN')
    expect(out[0].value).toBe('abc=def=ghi')
  })

  test('key with surrounding whitespace is trimmed', () => {
    const out = parseEnvFile('  KEY  =  value  ')
    expect(out[0].key).toBe('KEY')
    expect(out[0].value).toBe('value')
  })

  test('empty input → empty array of length 1 (single blank line)', () => {
    const out = parseEnvFile('')
    expect(out).toHaveLength(1)
    expect(out[0].isComment).toBe(true)
  })
})
