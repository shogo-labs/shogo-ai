// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for scripts/materialize-runtime-template.ts.
 *
 * The script guards its CLI `main()` behind `import.meta.main`, so importing
 * it here does not trigger any work. We inject a stub version resolver and a
 * stub registry probe so the tests never hit npm / the network.
 *
 *   bun test scripts/__tests__/materialize-runtime-template.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materialize, waitForPublishedVersion } from '../materialize-runtime-template.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function tmpManifest(pkg: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'materialize-'))
  const p = join(dir, 'package.json')
  writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
  return p
}

const stub = () => '9.9.9'
const instantSleep = () => Promise.resolve()

describe('materialize-runtime-template', () => {
  test('rewrites @shogo-ai/* workspace:* to an exact version (no caret)', async () => {
    const p = tmpManifest({
      name: 'x',
      dependencies: { '@shogo-ai/sdk': 'workspace:*', react: '^19.0.0' },
    })
    const changed = await materialize(p, stub)
    expect(changed).toBe(true)
    const after = JSON.parse(readFileSync(p, 'utf8'))
    // Exact (SHO-522): a range would be re-resolved against npm at install
    // time and could pick up a newer, possibly broken release.
    expect(after.dependencies['@shogo-ai/sdk']).toBe('9.9.9')
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
    expect(JSON.parse(readFileSync(p, 'utf8')).devDependencies['@shogo-ai/cli']).toBe('9.9.9')
  })

  test('idempotent: no-op on an already-concrete manifest', async () => {
    const p = tmpManifest({
      name: 'x',
      dependencies: { '@shogo-ai/sdk': '9.9.9' },
    })
    expect(await materialize(p, stub)).toBe(false)
    expect(JSON.parse(readFileSync(p, 'utf8')).dependencies['@shogo-ai/sdk']).toBe('9.9.9')
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
    expect(JSON.parse(after).dependencies['@shogo-ai/sdk']).toBe('9.9.9')
  })
})

describe('exact pin for a release tag (SHO-522)', () => {
  const sdkManifest = () =>
    tmpManifest({
      name: 'x',
      dependencies: { '@shogo-ai/sdk': 'workspace:*', '@shogo-ai/cli': 'workspace:*' },
    })

  test('pins the tag version once npm serves it, even though latest is older', async () => {
    // Stub resolves npm `latest` to the PREVIOUS release — exactly the
    // v2.6.1 shape where the image pinned ^2.6.0.
    const p = sdkManifest()
    const probes: string[] = []
    await materialize(p, () => '2.6.0', {
      pinVersion: '2.6.1',
      probe: async (name, version) => {
        probes.push(`${name}@${version}`)
        // Appears on the 3rd poll, like a registry catching up after publish.
        return probes.length >= 3
      },
      sleep: instantSleep,
    })
    const deps = JSON.parse(readFileSync(p, 'utf8')).dependencies
    expect(deps['@shogo-ai/sdk']).toBe('2.6.1')
    // Other @shogo-ai packages still resolve from the registry (latest).
    expect(deps['@shogo-ai/cli']).toBe('2.6.0')
    expect(probes).toEqual(['@shogo-ai/sdk@2.6.1', '@shogo-ai/sdk@2.6.1', '@shogo-ai/sdk@2.6.1'])
  })

  test('fails loudly (non-zero exit shape) when the version never appears', async () => {
    const p = sdkManifest()
    const before = readFileSync(p, 'utf8')
    await expect(
      materialize(p, () => '2.6.0', {
        pinVersion: '2.6.1',
        probe: async () => false,
        sleep: instantSleep,
        waitTimeoutMs: 0,
      }),
    ).rejects.toThrow(/never served @shogo-ai\/sdk@2\.6\.1/)
    // Never falls back to `latest` — the manifest is untouched.
    expect(readFileSync(p, 'utf8')).toBe(before)
  })

  test('a v-prefixed pin is accepted (v2.6.1 -> 2.6.1)', async () => {
    const p = sdkManifest()
    await materialize(p, () => '2.6.0', {
      pinVersion: 'v2.6.1',
      probe: async () => true,
      sleep: instantSleep,
    })
    expect(JSON.parse(readFileSync(p, 'utf8')).dependencies['@shogo-ai/sdk']).toBe('2.6.1')
  })

  test('a pin does not wait when the manifest is already materialized', async () => {
    const p = tmpManifest({ name: 'x', dependencies: { '@shogo-ai/sdk': '2.5.0' } })
    let probed = 0
    expect(
      await materialize(p, () => '2.6.0', {
        pinVersion: '2.6.1',
        probe: async () => {
          probed++
          return true
        },
        sleep: instantSleep,
      }),
    ).toBe(false)
    expect(probed).toBe(0)
    expect(JSON.parse(readFileSync(p, 'utf8')).dependencies['@shogo-ai/sdk']).toBe('2.5.0')
  })
})

describe('waitForPublishedVersion', () => {
  test('returns once the exact version is served', async () => {
    let calls = 0
    const res = await waitForPublishedVersion('@shogo-ai/sdk', '2.6.1', {
      probe: async () => ++calls >= 2,
      sleep: instantSleep,
      pollIntervalMs: 1,
    })
    expect(res).toMatchObject({ name: '@shogo-ai/sdk', version: '2.6.1', attempts: 2 })
  })

  test('reports how long it waited before timing out', async () => {
    await expect(
      waitForPublishedVersion('@shogo-ai/voice', '2.6.1', {
        probe: async () => false,
        sleep: instantSleep,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(/never served @shogo-ai\/voice@2\.6\.1 within 0s/)
  })
})
