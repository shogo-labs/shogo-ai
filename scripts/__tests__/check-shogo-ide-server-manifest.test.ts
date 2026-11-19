// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { validateManifest, type ServerManifest } from '../check-shogo-ide-server-manifest'

const expected = {
  artifactId: 'shogo-ide-server-0feedbf3d9ba-0123456789ab',
  commit: '0feedbf3d9bac4e27e50d5475fe45336a67fbd7b',
  inputsHash: `0123456789ab${'0'.repeat(52)}`,
}
const targets = ['win32-x64', 'darwin-arm64'] as const

function manifest(overrides: Partial<ServerManifest> = {}): ServerManifest {
  const assets: ServerManifest['assets'] = {}
  for (const target of targets) {
    const file = `${expected.artifactId}-${target}.tar.gz`
    assets[target] = {
      file,
      url: `https://github.com/shogo-labs/shogo-ai/releases/download/${expected.artifactId}/${file}`,
      sha256: 'a'.repeat(64),
      size: 1234,
    }
  }
  return { ...expected, assets, ...overrides }
}

describe('validateManifest', () => {
  test('accepts a manifest that matches the repo', () => {
    expect(validateManifest(manifest(), expected, { targets })).toEqual([])
  })

  test('flags a stale inputs hash and artifact id', () => {
    const errors = validateManifest(manifest({ inputsHash: 'f'.repeat(64), artifactId: 'old' }), expected, { targets })
    expect(errors.some((e) => e.includes('inputsHash is stale'))).toBe(true)
    expect(errors.some((e) => e.includes('artifactId old'))).toBe(true)
  })

  test('flags a commit that differs from the lock', () => {
    const errors = validateManifest(manifest({ commit: 'b'.repeat(40) }), expected, { targets })
    expect(errors[0]).toContain('does not match code-oss.lock.json')
  })

  test('flags a missing desktop target', () => {
    const m = manifest()
    delete m.assets['darwin-arm64']
    expect(validateManifest(m, expected, { targets })).toEqual(['no asset for darwin-arm64'])
  })

  test('flags a wrong url, bad hash and non-positive size', () => {
    const m = manifest()
    m.assets['win32-x64'] = { ...m.assets['win32-x64'], url: 'https://evil.example/x.tar.gz', sha256: 'xyz', size: 0 }
    const errors = validateManifest(m, expected, { targets })
    expect(errors).toHaveLength(3)
    expect(errors.join('\n')).toMatch(/url should be/)
    expect(errors.join('\n')).toMatch(/sha256 is not 64 hex/)
    expect(errors.join('\n')).toMatch(/size must be a positive integer/)
  })
})
