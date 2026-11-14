// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UnsupportedTargetError,
  loadServerManifest,
  parseServerManifest,
  resolveServerAsset,
  serverTarget,
  type ServerManifest,
} from '../code-oss-server/manifest'

const ARTIFACT = 'shogo-ide-server-0feedbf3d9ba-5c20845b4d6c'

function manifest(): ServerManifest {
  return {
    artifactId: ARTIFACT,
    commit: '0feedbf3d9bac4e27e50d5475fe45336a67fbd7b',
    inputsHash: '5'.repeat(64),
    assets: {
      'win32-x64': {
        file: `${ARTIFACT}-win32-x64.tar.gz`,
        url: `https://github.com/shogo-labs/shogo-ai/releases/download/${ARTIFACT}/${ARTIFACT}-win32-x64.tar.gz`,
        sha256: 'a'.repeat(64),
        size: 123,
      },
    },
  }
}

describe('serverTarget', () => {
  test.each([
    ['win32', 'x64', 'win32-x64'],
    ['darwin', 'arm64', 'darwin-arm64'],
    ['darwin', 'x64', 'darwin-x64'],
    ['linux', 'x64', 'linux-x64'],
  ])('%s/%s -> %s', (platform, arch, expected) => {
    expect(serverTarget(platform, arch)).toBe(expected as ReturnType<typeof serverTarget>)
  })

  test('unsupported targets map to null', () => {
    expect(serverTarget('win32', 'arm64')).toBeNull()
    expect(serverTarget('linux', 'arm64')).toBeNull()
  })
})

describe('parseServerManifest', () => {
  test('accepts a valid manifest and ignores unknown targets', () => {
    const raw = { ...manifest(), assets: { ...manifest().assets, 'freebsd-x64': { nope: true } } }
    expect(parseServerManifest(raw)).toEqual(manifest())
  })

  test.each([
    ['artifactId', { artifactId: 'evil' }],
    ['commit', { commit: 'abc' }],
    ['inputsHash', { inputsHash: 'z' }],
  ])('rejects a bad %s', (_field, patch) => {
    expect(() => parseServerManifest({ ...manifest(), ...patch })).toThrow(/Invalid Shogo IDE server manifest/)
  })

  test('rejects a non-https url, bad sha and non-positive size', () => {
    for (const patch of [{ url: 'http://x/y.tar.gz' }, { sha256: 'xyz' }, { size: 0 }, { file: '../x.tar.gz' }]) {
      const m = manifest()
      const raw = { ...m, assets: { 'win32-x64': { ...m.assets['win32-x64'], ...patch } } }
      expect(() => parseServerManifest(raw)).toThrow(/win32-x64/)
    }
  })

  test('loadServerManifest explains a missing manifest', () => {
    expect(() => loadServerManifest(join(tmpdir(), 'no-such-manifest.json'))).toThrow(/does not include the Shogo IDE server manifest/)
  })

  test('loadServerManifest reads a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-manifest-'))
    try {
      writeFileSync(join(dir, 'm.json'), JSON.stringify(manifest()))
      expect(loadServerManifest(join(dir, 'm.json')).artifactId).toBe(ARTIFACT)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveServerAsset', () => {
  test('returns the manifest asset', () => {
    expect(resolveServerAsset(manifest(), 'win32-x64', {})).toEqual(manifest().assets['win32-x64']!)
  })

  test('SHOGO_IDE_SERVER_BASE_URL swaps the host and keeps file and checksum', () => {
    const asset = resolveServerAsset(manifest(), 'win32-x64', { SHOGO_IDE_SERVER_BASE_URL: 'http://127.0.0.1:9/' })
    expect(asset.url).toBe(`http://127.0.0.1:9/${ARTIFACT}-win32-x64.tar.gz`)
    expect(asset.sha256).toBe('a'.repeat(64))
  })

  test('a target missing from the manifest is unsupported', () => {
    expect(() => resolveServerAsset(manifest(), 'darwin-arm64', {})).toThrow(UnsupportedTargetError)
    expect(() => resolveServerAsset(manifest(), 'darwin-arm64', {})).toThrow('Shogo IDE is not available for darwin-arm64 yet.')
  })
})
