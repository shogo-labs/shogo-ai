// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for scripts/materialize-runtime-template.ts.
 *
 * The script guards its CLI `main()` behind `import.meta.main`, so importing
 * it here does not trigger any work. We inject a stub version resolver so the
 * tests never hit npm / the network.
 *
 *   bun test scripts/__tests__/materialize-runtime-template.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materialize } from '../materialize-runtime-template.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function tmpManifest(pkg: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'materialize-'))
  const p = join(dir, 'package.json')
  writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
  return p
}

const stub = () => '9.9.9'

describe('materialize-runtime-template', () => {
  test('rewrites @shogo-ai/* workspace:* to ^version', async () => {
    const p = tmpManifest({
      name: 'x',
      dependencies: { '@shogo-ai/sdk': 'workspace:*', react: '^19.0.0' },
    })
    const changed = await materialize(p, stub)
    expect(changed).toBe(true)
    const after = JSON.parse(readFileSync(p, 'utf8'))
    expect(after.dependencies['@shogo-ai/sdk']).toBe('^9.9.9')
    // Untouched non-workspace deps.
    expect(after.dependencies.react).toBe('^19.0.0')
    // Hard guard: no workspace: specifier survives.
    expect(readFileSync(p, 'utf8')).not.toContain('"workspace:')
  })

  test('also handles devDependencies', async () => {
    const p = tmpManifest({
      name: 'x',
      devDependencies: { '@shogo-ai/cli': 'workspace:^' },
    })
    expect(await materialize(p, stub)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8')).devDependencies['@shogo-ai/cli']).toBe('^9.9.9')
  })

  test('idempotent: no-op on an already-concrete manifest', async () => {
    const p = tmpManifest({
      name: 'x',
      dependencies: { '@shogo-ai/sdk': '^9.9.9' },
    })
    expect(await materialize(p, stub)).toBe(false)
    expect(JSON.parse(readFileSync(p, 'utf8')).dependencies['@shogo-ai/sdk']).toBe('^9.9.9')
  })

  test('preserves trailing-newline style', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'materialize-'))
    const p = join(dir, 'package.json')
    writeFileSync(p, JSON.stringify({ dependencies: { '@shogo-ai/sdk': 'workspace:*' } }, null, 2))
    await materialize(p, stub)
    expect(readFileSync(p, 'utf8').endsWith('\n')).toBe(false)
  })

  test('throws on a non-@shogo-ai workspace dep (unshippable)', async () => {
    const p = tmpManifest({
      name: 'x',
      dependencies: { '@acme/private': 'workspace:*' },
    })
    await expect(materialize(p, stub)).rejects.toThrow(/not an @shogo-ai/)
  })

  test('throws when the manifest does not exist', async () => {
    await expect(materialize(join(tmpdir(), 'does-not-exist-xyz', 'package.json'), stub)).rejects.toThrow(/not found/)
  })

  test('the real runtime-template manifest materializes with no workspace: leak', async () => {
    // Guards against shipping a `workspace:*` specifier a pod can't resolve,
    // and against the template gaining a non-@shogo-ai workspace dep that
    // materialize would have to strip/fail on.
    const src = join(REPO_ROOT, 'templates', 'runtime-template', 'package.json')
    const dir = mkdtempSync(join(tmpdir(), 'materialize-real-'))
    const copy = join(dir, 'package.json')
    copyFileSync(src, copy)

    expect(await materialize(copy, stub)).toBe(true)
    const after = readFileSync(copy, 'utf8')
    expect(after).not.toContain('"workspace:')
    expect(JSON.parse(after).dependencies['@shogo-ai/sdk']).toBe('^9.9.9')
  })
})
