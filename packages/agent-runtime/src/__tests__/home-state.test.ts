// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * home-state: scan / pack / encrypt / restore of the persisted HOME paths.
 * Real `tar` in both directions over temp directories.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  HOME_STATE_MAX_ENTRIES,
  HomeStateDecryptError,
  HomeStateInvalidArchiveError,
  HomeStateTooLargeError,
  decryptHomeState,
  encryptHomeState,
  homeStateTag,
  packHomeState,
  parseHomeStateKey,
  restoreHomeState,
  scanHomeState,
  validateArchiveNames,
  type HomeStateKey,
} from '../home-state'

const KEY: HomeStateKey = { key: randomBytes(32), version: 1 }

let root: string
let home: string
let stage: string

function put(rel: string, body: string, mode = 0o644): void {
  const p = join(home, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
  chmodSync(p, mode)
}

function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), 'utf-8')
}

function mode(dir: string, rel: string): number {
  return lstatSync(join(dir, rel)).mode & 0o777
}

async function packed(dir = home): Promise<Uint8Array> {
  const p = await packHomeState(dir, { stageDir: stage })
  if (!p) throw new Error('nothing packed')
  return p.gz
}

function freshHome(): string {
  const h = join(root, `home-${Math.random().toString(36).slice(2)}`)
  mkdirSync(h)
  return h
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'home-state-'))
  home = join(root, 'home')
  stage = join(root, 'stage')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scan', () => {
  test('includes only the persisted paths', () => {
    put('.ssh/id_ed25519', 'KEY', 0o600)
    put('.oci/config', '[DEFAULT]')
    put('workspace/src/app.ts', 'not persisted')
    put('.npm/_cacache/x', 'not persisted')
    put('.bun/install/cache/x', 'not persisted')
    put('random.txt', 'not persisted')
    const rels = scanHomeState(home).entries.map((e) => e.rel)
    expect(rels).toContain('.ssh/id_ed25519')
    expect(rels).toContain('.oci/config')
    expect(rels.some((r) => r.startsWith('workspace') || r.startsWith('.npm') || r.startsWith('.bun'))).toBe(false)
    expect(rels).not.toContain('random.txt')
  })

  test('skips cache directories nested under persisted paths', () => {
    put('.config/gh/hosts.yml', 'token: x')
    put('.config/someapp/Cache/blob', 'x'.repeat(1000))
    put('.config/chromium/Default/History', 'x')
    const rels = scanHomeState(home).entries.map((e) => e.rel)
    expect(rels).toContain('.config/gh/hosts.yml')
    expect(rels.some((r) => r.includes('/Cache'))).toBe(false)
    expect(rels.some((r) => r.includes('chromium'))).toBe(false)
  })

  test('keeps symlinks inside HOME, skips ones that leave it', () => {
    put('.kube/real-config', 'apiVersion: v1')
    symlinkSync('real-config', join(home, '.kube/config'))
    symlinkSync('/etc/passwd', join(home, '.kube/escape'))
    const scan = scanHomeState(home)
    expect(scan.entries.find((e) => e.rel === '.kube/config')?.kind).toBe('symlink')
    expect(scan.entries.some((e) => e.rel === '.kube/escape')).toBe(false)
    expect(scan.skipped).toContain('.kube/escape')
  })

  test('refuses past the entry ceiling rather than truncating', () => {
    mkdirSync(join(home, '.config/many'), { recursive: true })
    for (let i = 0; i <= HOME_STATE_MAX_ENTRIES; i++) writeFileSync(join(home, `.config/many/f${i}`), '')
    expect(() => scanHomeState(home)).toThrow(HomeStateTooLargeError)
  })
})

describe('tag', () => {
  test('null when nothing is persisted', () => {
    put('workspace/a', 'x')
    expect(homeStateTag(scanHomeState(home))).toBeNull()
  })

  test('stable while idle, changes on content, mtime and mode', () => {
    put('.ssh/id_ed25519', 'KEY', 0o600)
    const t0 = homeStateTag(scanHomeState(home))
    expect(homeStateTag(scanHomeState(home))).toBe(t0)

    chmodSync(join(home, '.ssh/id_ed25519'), 0o644)
    const t1 = homeStateTag(scanHomeState(home))
    expect(t1).not.toBe(t0)

    utimesSync(join(home, '.ssh/id_ed25519'), new Date(), new Date(Date.now() + 5000))
    const t2 = homeStateTag(scanHomeState(home))
    expect(t2).not.toBe(t1)

    put('.ssh/id_ed25519.pub', 'PUB')
    expect(homeStateTag(scanHomeState(home))).not.toBe(t2)
  })
})

describe('encryption', () => {
  test('round-trips, and the ciphertext does not contain the plaintext', async () => {
    put('.ssh/id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY----- super-secret', 0o600)
    const gz = await packed()
    const blob = encryptHomeState(gz, { key: KEY, projectId: 'p1' })
    expect(Buffer.from(blob).includes(Buffer.from(gz.subarray(0, 32)))).toBe(false)
    expect(Buffer.from(blob).includes(Buffer.from('super-secret'))).toBe(false)
    expect(Buffer.from(decryptHomeState(blob, { key: KEY, projectId: 'p1' })).equals(Buffer.from(gz))).toBe(true)
  })

  test('a blob from one project does not open in another', () => {
    const blob = encryptHomeState(new Uint8Array([1, 2, 3]), { key: KEY, projectId: 'p1' })
    expect(() => decryptHomeState(blob, { key: KEY, projectId: 'p2' })).toThrow(HomeStateDecryptError)
  })

  test('wrong key, flipped byte, truncation and foreign bytes are all rejected', () => {
    const blob = encryptHomeState(new Uint8Array(100), { key: KEY, projectId: 'p1' })
    const other: HomeStateKey = { key: randomBytes(32), version: 1 }
    expect(() => decryptHomeState(blob, { key: other, projectId: 'p1' })).toThrow(HomeStateDecryptError)

    const flipped = new Uint8Array(blob)
    flipped[flipped.length - 1] ^= 0xff
    expect(() => decryptHomeState(flipped, { key: KEY, projectId: 'p1' })).toThrow(HomeStateDecryptError)

    expect(() => decryptHomeState(blob.subarray(0, 20), { key: KEY, projectId: 'p1' })).toThrow(HomeStateDecryptError)
    expect(() => decryptHomeState(new Uint8Array(64), { key: KEY, projectId: 'p1' })).toThrow(HomeStateDecryptError)
  })

  test('the key version in the header is authenticated and must match', () => {
    const blob = encryptHomeState(new Uint8Array(10), { key: KEY, projectId: 'p1' })
    const v2: HomeStateKey = { key: KEY.key, version: 2 }
    expect(() => decryptHomeState(blob, { key: v2, projectId: 'p1' })).toThrow(/key version 1/)
    const relabeled = new Uint8Array(blob)
    relabeled[5] = 2
    expect(() => decryptHomeState(relabeled, { key: v2, projectId: 'p1' })).toThrow(HomeStateDecryptError)
  })

  test('random IV: the same input never encrypts the same way twice', () => {
    const a = encryptHomeState(new Uint8Array(10), { key: KEY, projectId: 'p1' })
    const b = encryptHomeState(new Uint8Array(10), { key: KEY, projectId: 'p1' })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
  })

  test('parseHomeStateKey accepts a 32-byte base64 key and rejects anything else', () => {
    const k = randomBytes(32).toString('base64')
    expect(parseHomeStateKey({ HOME_STATE_KEY: k })?.version).toBe(1)
    expect(parseHomeStateKey({ HOME_STATE_KEY: k, HOME_STATE_KEY_VERSION: '3' })?.version).toBe(3)
    expect(parseHomeStateKey({})).toBeNull()
    expect(parseHomeStateKey({ HOME_STATE_KEY: randomBytes(16).toString('base64') })).toBeNull()
    expect(parseHomeStateKey({ HOME_STATE_KEY: k, HOME_STATE_KEY_VERSION: '0' })).toBeNull()
  })
})

describe('pack + restore', () => {
  test('round-trips files, modes and in-HOME symlinks into a fresh home', async () => {
    put('.ssh/id_ed25519', 'PRIVATE', 0o600)
    put('.ssh/id_ed25519.pub', 'PUBLIC', 0o644)
    put('.oci/config', '[DEFAULT]\nkey_file=~/.oci/key.pem')
    put('.oci/key.pem', 'PEM', 0o600)
    put('.kube/real', 'apiVersion: v1')
    symlinkSync('real', join(home, '.kube/config'))
    put('.gitconfig', '[user]\n name = agent')
    chmodSync(join(home, '.ssh'), 0o700)

    const gz = await packed()
    const target = freshHome()
    const { units } = await restoreHomeState(target, gz, { sameOwner: false })

    expect(units).toEqual(expect.arrayContaining(['.ssh', '.oci', '.kube', '.gitconfig']))
    expect(read(target, '.ssh/id_ed25519')).toBe('PRIVATE')
    expect(mode(target, '.ssh/id_ed25519')).toBe(0o600)
    expect(mode(target, '.ssh')).toBe(0o700)
    expect(read(target, '.oci/key.pem')).toBe('PEM')
    expect(lstatSync(join(target, '.kube/config')).isSymbolicLink()).toBe(true)
    expect(read(target, '.kube/config')).toBe('apiVersion: v1')
    expect(readdirSync(target).some((n) => n.startsWith('.shogo-home-restore-'))).toBe(false)
  })

  test('replaces a unit wholesale: files deleted before the export stay deleted', async () => {
    put('.ssh/id_ed25519', 'NEW', 0o600)
    const gz = await packed()

    const target = freshHome()
    mkdirSync(join(target, '.ssh'))
    writeFileSync(join(target, '.ssh/stale_key'), 'from a previous life')
    await restoreHomeState(target, gz, { sameOwner: false })

    expect(read(target, '.ssh/id_ed25519')).toBe('NEW')
    expect(existsSync(join(target, '.ssh/stale_key'))).toBe(false)
  })

  test('.config is restored per tool, so image-provided config the project never had survives', async () => {
    put('.config/gh/hosts.yml', 'user: agent')
    const gz = await packed()

    const target = freshHome()
    mkdirSync(join(target, '.config/image-tool'), { recursive: true })
    writeFileSync(join(target, '.config/image-tool/settings.json'), '{"shipped":true}')
    mkdirSync(join(target, '.config/gh'), { recursive: true })
    writeFileSync(join(target, '.config/gh/stale.yml'), 'stale')
    await restoreHomeState(target, gz, { sameOwner: false })

    expect(read(target, '.config/gh/hosts.yml')).toBe('user: agent')
    expect(existsSync(join(target, '.config/gh/stale.yml'))).toBe(false)
    expect(read(target, '.config/image-tool/settings.json')).toBe('{"shipped":true}')
  })

  test('units absent from the archive are left alone', async () => {
    put('.oci/config', 'oci')
    const gz = await packed()
    const target = freshHome()
    mkdirSync(join(target, '.aws'))
    writeFileSync(join(target, '.aws/credentials'), 'untouched')
    await restoreHomeState(target, gz, { sameOwner: false })
    expect(read(target, '.aws/credentials')).toBe('untouched')
  })

  test('repairs loose private-key permissions on restore', async () => {
    put('.ssh/id_rsa', 'PRIVATE', 0o644)
    put('.ssh/known_hosts', 'host', 0o644)
    put('.netrc', 'machine x login y password z', 0o644)
    const target = freshHome()
    await restoreHomeState(target, await packed(), { sameOwner: false })
    expect(mode(target, '.ssh/id_rsa')).toBe(0o600)
    expect(mode(target, '.ssh/known_hosts')).toBe(0o644)
    expect(mode(target, '.netrc')).toBe(0o600)
  })

  test('a typical credential set packs to a few KB, not a padded tar record', async () => {
    put('.ssh/id_ed25519', 'x'.repeat(400), 0o600)
    put('.oci/config', 'tenancy=ocid1...')
    const gz = await packed()
    expect(gz.byteLength).toBeLessThan(4096)
  })

  test('packHomeState returns null when there is nothing to persist', async () => {
    put('workspace/a', 'x')
    expect(await packHomeState(home, { stageDir: stage })).toBeNull()
  })
})

describe('restore rejects hostile archives before touching HOME', () => {
  async function tarFrom(build: (dir: string) => void, members: string[]): Promise<Uint8Array> {
    const src = mkdtempSync(join(root, 'evil-'))
    build(src)
    const proc = Bun.spawn(['tar', '-czf', '-', '-C', src, ...members], {
      stdout: 'pipe',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
    await proc.exited
    return out
  }

  test('names outside the persisted paths', async () => {
    const gz = await tarFrom((d) => {
      mkdirSync(join(d, 'workspace'))
      writeFileSync(join(d, 'workspace/x'), 'x')
    }, ['workspace'])
    const target = freshHome()
    await expect(restoreHomeState(target, gz, { sameOwner: false })).rejects.toThrow(HomeStateInvalidArchiveError)
    expect(existsSync(join(target, 'workspace'))).toBe(false)
  })

  test('a symlink that would point outside HOME once restored', async () => {
    const gz = await tarFrom((d) => {
      mkdirSync(join(d, '.ssh'))
      symlinkSync('../../../../etc', join(d, '.ssh/out'))
    }, ['.ssh'])
    const target = freshHome()
    writeFileSync(join(target, '.bashrc'), 'keep')
    await expect(restoreHomeState(target, gz, { sameOwner: false })).rejects.toThrow(/symlink leaving HOME/)
    expect(existsSync(join(target, '.ssh'))).toBe(false)
    expect(read(target, '.bashrc')).toBe('keep')
  })

  test('validateArchiveNames: absolute paths and traversal', () => {
    expect(() => validateArchiveNames(['/etc/passwd'])).toThrow(/absolute/)
    expect(() => validateArchiveNames(['.ssh/../../etc/passwd'])).toThrow(/traversal/)
    expect(() => validateArchiveNames(['./.ssh/', './.ssh/id', '.config/gh/hosts.yml'])).not.toThrow()
  })
})
