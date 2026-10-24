// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRODUCTION: a packaged desktop never set `SECRETS_ENCRYPTION_KEY`, so
 * `apps/api/src/lib/secret-crypto.ts` (which fails closed by design) made every
 * encrypted-credential feature throw on a fresh install. The shipped app's api
 * child had `SHOGO_LOCAL_MODE`, `SHOGO_APP_DATABASE_URL` and
 * `BETTER_AUTH_SECRET` but no secrets key, and `platform_settings` held zero
 * `provider-key.%` rows — nothing was ever encrypted locally (SHO-75).
 *
 * These tests drive the real filesystem and the real crypto: a generated key
 * must be stable across launches and must actually work with `encryptSecret` /
 * `decryptSecret`, otherwise the desktop would persist rows it cannot read.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SECRETS_ENCRYPTION_KEY_FILENAME,
  getOrCreateSecretsEncryptionKey,
} from '../local-secrets'
import { decryptSecret, encryptSecret } from '../../../api/src/lib/secret-crypto'

const tempDirs: string[] = []

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-local-secrets-'))
  tempDirs.push(dir)
  return dir
}

function keyPath(dataDir: string): string {
  return path.join(dataDir, SECRETS_ENCRYPTION_KEY_FILENAME)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('getOrCreateSecretsEncryptionKey', () => {
  test('generates a 32-byte key file on first call', () => {
    const dataDir = tempDataDir()

    const key = getOrCreateSecretsEncryptionKey(dataDir)

    expect(fs.existsSync(keyPath(dataDir))).toBe(true)
    expect(Buffer.from(fs.readFileSync(keyPath(dataDir), 'utf-8').trim(), 'base64')).toHaveLength(32)
    expect(Buffer.from(key, 'base64')).toHaveLength(32)
  })

  test('returns the same key on later calls and does not rewrite the file', () => {
    const dataDir = tempDataDir()
    const first = getOrCreateSecretsEncryptionKey(dataDir)
    const statBefore = fs.statSync(keyPath(dataDir))
    const contentBefore = fs.readFileSync(keyPath(dataDir), 'utf-8')

    Bun.sleepSync(25)
    const second = getOrCreateSecretsEncryptionKey(dataDir)
    expect(second).toBe(first)

    const statAfter = fs.statSync(keyPath(dataDir))
    expect(fs.readFileSync(keyPath(dataDir), 'utf-8')).toBe(contentBefore)
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs)
  })

  test('an existing valid key wins over a generated one', () => {
    const dataDir = tempDataDir()
    const known = Buffer.alloc(32, 7).toString('base64')
    fs.writeFileSync(keyPath(dataDir), `${known}\n`, { mode: 0o600 })

    expect(getOrCreateSecretsEncryptionKey(dataDir)).toBe(known)
    expect(fs.readFileSync(keyPath(dataDir), 'utf-8')).toBe(`${known}\n`)
  })

  test('accepts a hex key file without touching it', () => {
    const dataDir = tempDataDir()
    const knownHex = Buffer.alloc(32, 3).toString('hex')
    fs.writeFileSync(keyPath(dataDir), knownHex, { mode: 0o600 })

    expect(getOrCreateSecretsEncryptionKey(dataDir)).toBe(knownHex)
    expect(fs.readFileSync(keyPath(dataDir), 'utf-8')).toBe(knownHex)
  })

  test('a malformed key file is reported with its path and never overwritten', () => {
    const dataDir = tempDataDir()
    fs.writeFileSync(keyPath(dataDir), 'not-a-key', { mode: 0o600 })
    const logged: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    }

    try {
      expect(getOrCreateSecretsEncryptionKey(dataDir)).toBe('not-a-key')
    } finally {
      console.error = originalError
    }

    expect(logged.join('\n')).toContain(keyPath(dataDir))
    expect(fs.readFileSync(keyPath(dataDir), 'utf-8')).toBe('not-a-key')
  })

  test.skipIf(process.platform === 'win32')('writes the key file with mode 0600', () => {
    const dataDir = tempDataDir()

    getOrCreateSecretsEncryptionKey(dataDir)

    expect(fs.statSync(keyPath(dataDir)).mode & 0o777).toBe(0o600)
  })

  test('the generated key round-trips through the api secret crypto', () => {
    const dataDir = tempDataDir()
    const key = getOrCreateSecretsEncryptionKey(dataDir)
    const previous = process.env.SECRETS_ENCRYPTION_KEY
    process.env.SECRETS_ENCRYPTION_KEY = key
    try {
      const blob = encryptSecret('sk-test-provider-key')
      expect(blob.startsWith('v1:')).toBe(true)
      expect(decryptSecret(blob)).toBe('sk-test-provider-key')
    } finally {
      if (previous === undefined) delete process.env.SECRETS_ENCRYPTION_KEY
      else process.env.SECRETS_ENCRYPTION_KEY = previous
    }
  })
})
