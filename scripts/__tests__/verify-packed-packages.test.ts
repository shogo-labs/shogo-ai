// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-524: the packed-tarball gate repacked at `0.0.0-gate` but left the
 * already-stamped `@shogo-ai/*` sibling specs at the tag version, so its
 * `npm install` reached the registry for siblings that had not been published
 * yet. That blocked v2.6.2 from ever reaching npm.
 *
 * These exercise the rewrite as a pure function — a temp package directory and
 * no npm, no packing. The first case is the one that fails on main.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rewriteManifestForPublish, rewritePackagesForPublish } from '../verify-packed-packages'

const GATE_VERSION = '0.0.0-gate'

function fixture(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-publish-rewrite-'))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return dir
}

function readManifest(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

/** The shape publish-sdk.yml's rewrite leaves behind on a tag build. */
function stampedLikePublishWorkflow(): Record<string, unknown> {
  return {
    name: '@shogo-ai/sdk',
    version: '2.6.2',
    dependencies: { '@shogo-ai/agent': '2.6.2', '@shogo-ai/core': '^2.6.2' },
    peerDependencies: { '@shogo-ai/voice': '2.6.2', mobx: '^6' },
    optionalDependencies: { '@shogo-ai/email': '~2.6.2' },
    devDependencies: { '@shogo-ai/db': '2.6.2' },
    exports: { '.': { import: './dist/index.js', development: './src/index.ts' } },
  }
}

describe('rewriteManifestForPublish', () => {
  it('points already-stamped sibling specs at the version being packed', () => {
    const dir = fixture(stampedLikePublishWorkflow())
    try {
      rewriteManifestForPublish(dir, GATE_VERSION)
      const manifest = readManifest(dir)

      expect(manifest.version).toBe(GATE_VERSION)
      expect(manifest.dependencies['@shogo-ai/agent']).toBe(GATE_VERSION)
      expect(manifest.dependencies['@shogo-ai/core']).toBe(GATE_VERSION)
      expect(manifest.peerDependencies['@shogo-ai/voice']).toBe(GATE_VERSION)
      expect(manifest.optionalDependencies['@shogo-ai/email']).toBe(GATE_VERSION)
      expect(manifest.devDependencies['@shogo-ai/db']).toBe(GATE_VERSION)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives a raw workspace manifest the same result', () => {
    const dir = fixture({
      name: '@shogo-ai/sdk',
      version: '1.7.0',
      dependencies: { '@shogo-ai/core': 'workspace:*', '@shogo-ai/agent': 'workspace:^' },
      optionalDependencies: { '@shogo-ai/voice': 'workspace:*' },
      exports: { '.': { import: './dist/index.js', development: './src/index.ts' } },
    })
    try {
      rewriteManifestForPublish(dir, GATE_VERSION)
      const manifest = readManifest(dir)

      expect(manifest.version).toBe(GATE_VERSION)
      expect(manifest.dependencies).toEqual({
        '@shogo-ai/core': GATE_VERSION,
        '@shogo-ai/agent': GATE_VERSION,
      })
      expect(manifest.optionalDependencies).toEqual({ '@shogo-ai/voice': GATE_VERSION })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('strips non-sibling workspace deps and leaves third-party and registry specs alone', () => {
    const dir = fixture({
      name: '@shogo-ai/sdk',
      version: '1.7.0',
      dependencies: {
        '@repo/shared': 'workspace:*',
        injectable: 'workspace:*',
        mobx: '^6',
        zod: '3.23.8',
        '@shogo-ai/core': 'workspace:*',
      },
    })
    try {
      rewriteManifestForPublish(dir, GATE_VERSION)
      const manifest = readManifest(dir)

      expect(manifest.dependencies).toEqual({ mobx: '^6', zod: '3.23.8', '@shogo-ai/core': GATE_VERSION })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('strips the development export condition and keeps the rest', () => {
    const dir = fixture({
      name: '@shogo-ai/sdk',
      version: '1.7.0',
      exports: {
        '.': { types: './dist/index.d.ts', development: './src/index.ts', import: './dist/index.js' },
        './bucket': { development: './src/bucket/index.ts', require: './dist/bucket/index.cjs' },
      },
    })
    try {
      rewriteManifestForPublish(dir, GATE_VERSION)
      const manifest = readManifest(dir)

      expect(manifest.exports['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' })
      expect(manifest.exports['./bucket']).toEqual({ require: './dist/bucket/index.cjs' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns the original text so the caller restores the checkout byte-for-byte', () => {
    const dir = fixture(stampedLikePublishWorkflow())
    try {
      const before = readFileSync(join(dir, 'package.json'), 'utf8')
      const original = rewriteManifestForPublish(dir, GATE_VERSION)
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).not.toBe(before)

      writeFileSync(join(dir, 'package.json'), original)
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves no tag-version reference behind after the publish rewrite then the gate rewrite', () => {
    // publish-sdk.yml stamps at 2.6.2; the gate then repacks. The tarball the gate
    // installs must ask for nothing but the gate version, or npm goes looking for
    // an unpublished 2.6.2 and the release dies (the v2.6.2 failure).
    const dir = fixture({
      name: '@shogo-ai/sdk',
      version: '1.7.0',
      dependencies: { '@shogo-ai/agent': 'workspace:*', '@shogo-ai/core': 'workspace:*' },
      optionalDependencies: { '@shogo-ai/voice': 'workspace:*' },
    })
    try {
      rewritePackagesForPublish([dir], '2.6.2')
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('2.6.2')

      rewriteManifestForPublish(dir, GATE_VERSION)
      const text = readFileSync(join(dir, 'package.json'), 'utf8')
      expect(text).not.toContain('2.6.2')
      expect(text).toContain(GATE_VERSION)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent: rewriting twice at the same version changes nothing', () => {
    const dir = fixture(stampedLikePublishWorkflow())
    try {
      rewriteManifestForPublish(dir, GATE_VERSION)
      const once = readFileSync(join(dir, 'package.json'), 'utf8')
      rewriteManifestForPublish(dir, GATE_VERSION)
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(once)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
