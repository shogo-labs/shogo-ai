// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { decryptSecrets, encryptSecrets, parseEnvFile } from '../lib/bundle-crypto'

describe('bundle crypto', () => {
  test('encrypts and decrypts JSON payloads with the same passphrase', async () => {
    const payload = { apiKey: 'sk-test', nested: { enabled: true }, count: 3 }

    const blob = await encryptSecrets(payload, 'correct horse battery staple')
    const decrypted = await decryptSecrets<typeof payload>(blob, 'correct horse battery staple')

    expect(blob).toMatchObject({
      alg: 'aes-256-gcm',
      kdf: 'pbkdf2-sha256',
      iters: expect.any(Number),
      salt: expect.any(String),
      iv: expect.any(String),
      ct: expect.any(String),
    })
    expect(decrypted).toEqual(payload)
  })

  test('rejects weak passphrases, unsupported blobs, and wrong passphrases', async () => {
    await expect(encryptSecrets({ ok: true }, 'short')).rejects.toThrow(/at least 8/)
    await expect(decryptSecrets({ alg: 'x' } as any, 'long-enough')).rejects.toThrow(/Unsupported/)

    const blob = await encryptSecrets({ secret: 'value' }, 'long-enough')
    await expect(decryptSecrets(blob, 'another-passphrase')).rejects.toThrow(/Could not decrypt/)
  })
})

describe('parseEnvFile', () => {
  test('preserves comments and parses quoted/unquoted assignments', () => {
    const parsed = parseEnvFile([
      '# comment',
      '',
      'PLAIN=value',
      'SPACED = value with spaces ',
      'DOUBLE=\"quoted value\"',
      "SINGLE='single quoted'",
      'NOT_AN_ASSIGNMENT',
    ].join('\n'))

    expect(parsed).toEqual([
      { key: '', value: '', raw: '# comment', isComment: true },
      { key: '', value: '', raw: '', isComment: true },
      { key: 'PLAIN', value: 'value', raw: 'PLAIN=value', isComment: false },
      { key: 'SPACED', value: 'value with spaces', raw: 'SPACED = value with spaces ', isComment: false },
      { key: 'DOUBLE', value: 'quoted value', raw: 'DOUBLE=\"quoted value\"', isComment: false },
      { key: 'SINGLE', value: 'single quoted', raw: "SINGLE='single quoted'", isComment: false },
      { key: '', value: '', raw: 'NOT_AN_ASSIGNMENT', isComment: true },
    ])
  })
})
