// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-75 acceptance — the desktop provisions `SECRETS_ENCRYPTION_KEY` itself.
 *
 * The dev's `local-secrets.test.ts` covers the helper's contract. This file
 * covers the acceptance criteria that unit test cannot reach:
 *
 *  1. the bytes the helper *persists* (not just the value it returns) are what
 *     the api accepts, in the directory that also holds `shogo.db`;
 *  2. two separate launches (separate processes) reuse one key — no rotation;
 *  3. `startLocalServer()` really hands the api child the key, next to
 *     `BETTER_AUTH_SECRET` and unconditionally (the wiring is the bug);
 *  4. a malformed file is left untouched and the api stays fail-closed;
 *  5. neither provisioning path ever logs the key itself.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  SECRETS_ENCRYPTION_KEY_FILENAME,
  getOrCreateSecretsEncryptionKey,
  secretsEncryptionKeyPath,
} from '../local-secrets'
import { isSecretCryptoConfigured } from '../../../api/src/lib/secret-crypto'

const tempDirs: string[] = []

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-local-secrets-acceptance-'))
  tempDirs.push(dir)
  return dir
}

function withKeyEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.SECRETS_ENCRYPTION_KEY
  if (value === undefined) delete process.env.SECRETS_ENCRYPTION_KEY
  else process.env.SECRETS_ENCRYPTION_KEY = value
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.SECRETS_ENCRYPTION_KEY
    else process.env.SECRETS_ENCRYPTION_KEY = previous
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('SHO-75 desktop secrets key provisioning', () => {
  test('a fresh data dir gets a key the api accepts, stored beside shogo.db', () => {
    const dataDir = tempDataDir()

    getOrCreateSecretsEncryptionKey(dataDir)

    const keyPath = path.join(dataDir, SECRETS_ENCRYPTION_KEY_FILENAME)
    expect(fs.existsSync(keyPath)).toBe(true)
    // The api validates the *file's* bytes, not the helper's return value.
    const persisted = fs.readFileSync(keyPath, 'utf-8').trim()
    expect(Buffer.from(persisted, 'base64')).toHaveLength(32)
    expect(withKeyEnv(persisted, () => isSecretCryptoConfigured())).toBe(true)
    // Same directory as the database: backup/restore/delete move them together.
    expect(fs.readdirSync(dataDir)).toContain(SECRETS_ENCRYPTION_KEY_FILENAME)
    expect(secretsEncryptionKeyPath(dataDir)).toBe(keyPath)
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600)
    }
  })

  test('two separate launches reuse one key and never rotate it', () => {
    const dataDir = tempDataDir()
    const helper = pathToFileURL(path.resolve(__dirname, '..', 'local-secrets.ts')).href
    const runner = path.join(dataDir, 'launch.ts')
    fs.writeFileSync(
      runner,
      `import { getOrCreateSecretsEncryptionKey } from ${JSON.stringify(helper)}\n` +
        `process.stdout.write(getOrCreateSecretsEncryptionKey(process.argv[2]))\n`,
    )

    const launch = () => {
      const child = Bun.spawnSync([process.execPath, runner, dataDir], { stdout: 'pipe', stderr: 'pipe' })
      if (child.exitCode !== 0) throw new Error(`launch failed: ${child.stderr.toString()}`)
      return child.stdout.toString().trim()
    }

    const first = launch()
    const contentAfterFirst = fs.readFileSync(secretsEncryptionKeyPath(dataDir), 'utf-8')
    const second = launch()
    const contentAfterSecond = fs.readFileSync(secretsEncryptionKeyPath(dataDir), 'utf-8')

    expect(Buffer.from(first, 'base64')).toHaveLength(32)
    expect(second).toBe(first)
    expect(contentAfterSecond).toBe(contentAfterFirst)
  })

  test('startLocalServer hands the api child the key, unconditionally, beside BETTER_AUTH_SECRET', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'local-server.ts'), 'utf-8')
    const pathsSrc = fs.readFileSync(path.resolve(__dirname, '..', 'paths.ts'), 'utf-8')

    expect(src).toContain("import { getOrCreateSecretsEncryptionKey } from './local-secrets'")
    const wiring = /^ {4}SECRETS_ENCRYPTION_KEY: getOrCreateSecretsEncryptionKey\(getDataDir\(\)\),$/m
    expect(src).toMatch(wiring)
    // Not behind a spread or a ternary (cloud-authed users encrypt tokens too).
    expect(src).not.toMatch(/SECRETS_ENCRYPTION_KEY:\s*[^\n]*\?[^\n]*getOrCreateSecretsEncryptionKey/)
    // Same env object as the one instance secret that always existed.
    const keyAt = src.indexOf('SECRETS_ENCRYPTION_KEY: getOrCreateSecretsEncryptionKey')
    const authAt = src.indexOf('BETTER_AUTH_SECRET: getOrCreateAuthSecret()')
    expect(authAt).toBeGreaterThan(-1)
    expect(Math.abs(keyAt - authAt)).toBeLessThan(600)
    // getDataDir() is the directory that holds shogo.db.
    expect(pathsSrc).toMatch(/getDbPath\(\)[^{]*\{[\s\S]*?path\.join\(getDataDir\(\), 'shogo\.db'\)/)
  })

  test('a malformed key file is left untouched and the api stays fail-closed', () => {
    const dataDir = tempDataDir()
    const keyPath = secretsEncryptionKeyPath(dataDir)
    fs.writeFileSync(keyPath, 'not-a-key', { mode: 0o600 })
    const logged: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    }
    let value = ''
    try {
      value = getOrCreateSecretsEncryptionKey(dataDir)
    } finally {
      console.error = originalError
    }

    expect(logged.join('\n')).toContain(keyPath)
    expect(fs.readFileSync(keyPath, 'utf-8')).toBe('not-a-key')
    expect(value).toBe('not-a-key')
    expect(withKeyEnv(value, () => isSecretCryptoConfigured())).toBe(false)
  })

  test('the api boot line reports only whether encryption is configured', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'api', 'src', 'local-server.ts'),
      'utf-8',
    )

    expect(src).toContain('[LocalAPI] secrets encryption:')
    expect(src).toContain('isSecretCryptoConfigured()')
    expect(src).not.toMatch(/console\.(log|warn|error)\([\s\S]{0,400}process\.env\.SECRETS_ENCRYPTION_KEY/)
  })

  test('neither provisioning path logs the key', () => {
    const dataDir = tempDataDir()
    const sink: string[] = []
    const originals = { log: console.log, warn: console.warn, error: console.error }
    console.log = (...args: unknown[]) => { sink.push(args.map(String).join(' ')) }
    console.warn = (...args: unknown[]) => { sink.push(args.map(String).join(' ')) }
    console.error = (...args: unknown[]) => { sink.push(args.map(String).join(' ')) }
    let key = ''
    try {
      key = getOrCreateSecretsEncryptionKey(dataDir)
    } finally {
      console.log = originals.log
      console.warn = originals.warn
      console.error = originals.error
    }

    expect(key.length).toBeGreaterThan(0)
    expect(sink.join('\n')).not.toContain(key)
  })
})
