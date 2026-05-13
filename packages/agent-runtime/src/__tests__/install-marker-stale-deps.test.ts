// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression: BOTH marker-match short-circuits (preview-manager
// `installDepsIfNeeded` AND workspace-defaults `ensureWorkspaceDeps`)
// must verify that all top-level deps are actually present in
// `node_modules/` before trusting the install-marker. A stale marker
// whose hash matches the current `package.json` but whose node_modules
// is missing key packages is the cloud-recycle failure mode.
//
// Why this matters (cloud Expo recycle bug, 2026-05-13)
// -----------------------------------------------------
// In Kubernetes, `S3Sync` uploads the workspace as a tar that EXCLUDES
// `node_modules/`. Installed deps are pushed via a separate "deps
// cache" pointer (`deps-hash.txt` + tarball) that only populates AFTER
// a full successful install. If a pod:
//   1. claims a fresh project,
//   2. runs `bun install` against the imported Expo workspace,
//   3. writes `.shogo/install-marker` (sha256 of package.json),
//   4. periodic sync uploads the workspace (marker included,
//      node_modules excluded),
//   5. then dies (502, OOM, scale-down) BEFORE deps-cache uploads,
// the next pod claims the project, downloads the workspace tar (gets
// the install-marker), but starts with the warm-pool template's
// pre-seeded `node_modules` (Vite, not Expo). Marker hash matches
// package.json hash → both ensureWorkspaceDeps and PreviewManager
// short-circuit, skip install, and the bundler can't find `expo`,
// `@react-three/fiber`, etc. The preview never recovers because every
// subsequent pod inherits the same poisoned state.
//
// Observed on staging project 9e7ecdc7-3390-488f-8af2-c0ea6ff0e91b
// across three pod assignments (warm-pool-12f8b04f → -f1db7eb1 →
// -277b6c61). Manually deleting `.shogo/install-marker` on the live
// pod unblocked it; this test pins the code that does the same
// recovery automatically.
//
// Run: bun test packages/agent-runtime/src/__tests__/install-marker-stale-deps.test.ts

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock the package manager surface so we can detect WHETHER an install
// was attempted without actually invoking bun. Both call sites
// (workspace-defaults and preview-manager) ultimately hit
// `pkg.installAsync` — preview-manager via `pkg.installAsync` directly,
// workspace-defaults via the same module.
const installCalls: Array<{ dir: string; opts: any }> = []
mock.module('@shogo/shared-runtime', () => ({
  pkg: {
    installAsync: async (dir: string, opts: any) => {
      installCalls.push({ dir, opts })
      // Throw so we exit the install path immediately — we only need
      // to assert the call was attempted, not that bun ran.
      throw new Error('test-stub: installAsync not actually executed')
    },
    installSync: () => {
      installCalls.push({ dir: 'sync', opts: {} })
      throw new Error('test-stub: installSync not actually executed')
    },
  },
}))

const { ensureWorkspaceDeps, writeInstallMarker, computePackageJsonHash } =
  await import('../workspace-defaults')

const PLATFORM_TAG = `${process.platform}-${process.arch}`

let TMP: string

beforeEach(() => {
  installCalls.length = 0
  TMP = mkdtempSync(join(tmpdir(), 'shogo-stale-marker-'))
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

/**
 * Seed the exact disk shape produced by the cloud-recycle failure:
 *   - Expo `package.json` declaring `expo` + other deps.
 *   - `node_modules/` populated as if from the warm-pool's Vite
 *     template — has `.bin/vite` but NONE of the Expo deps actually
 *     installed.
 *   - `.shogo/install-marker` containing sha256(package.json) —
 *     written by a previous pod that ran install then died before its
 *     deps cache could upload.
 */
function seedPoisonedWorkspace(): string {
  const pkg = {
    name: 'expo-app',
    dependencies: {
      expo: '~51.0.0',
      'expo-router': '~3.5.0',
      '@react-three/fiber': '^8.16.0',
      react: '18.2.0',
    },
  }
  writeFileSync(join(TMP, 'package.json'), JSON.stringify(pkg))

  // Warm-pool template's pre-seed: vite is there, nothing else.
  mkdirSync(join(TMP, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(TMP, 'node_modules', '.bin', 'vite'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  })
  // Pretend the platform matches so the platform-mismatch reinstall
  // gate doesn't fire — we want to isolate the marker-match path.
  writeFileSync(join(TMP, 'node_modules', '.shogo-platform'), PLATFORM_TAG + '\n')

  // Toxic marker: hash matches the Expo package.json. None of the
  // declared deps (`expo`, `expo-router`, `@react-three/fiber`) exist
  // under `node_modules/`.
  mkdirSync(join(TMP, '.shogo'), { recursive: true })
  const expectedHash = computePackageJsonHash(TMP)!
  writeInstallMarker(TMP, expectedHash)

  return expectedHash
}

describe('ensureWorkspaceDeps — install-marker stale-deps probe', () => {
  test('marker matches package.json but expo deps missing → forces install', async () => {
    const expectedHash = seedPoisonedWorkspace()
    // Sanity: the hash actually matches what we wrote.
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/)

    let threw = false
    try {
      await ensureWorkspaceDeps(TMP)
    } catch {
      threw = true
    }

    // The fix means we MUST have reached the install path despite the
    // matching marker. Without the fix, ensureWorkspaceDeps returns
    // early on the marker-match short-circuit (line ~1119) and
    // installCalls stays empty.
    expect(installCalls.length).toBe(1)
    expect(installCalls[0]!.dir).toBe(TMP)
    expect(threw).toBe(true) // our stub throws on entry
  })

  test('marker matches package.json AND deps fully present → still short-circuits', async () => {
    // Inverse: legitimate "I really did install everything" case.
    // Pin the happy path so the new probe doesn't force a redundant
    // reinstall on every restart of an already-installed workspace.
    const pkg = {
      name: 'expo-app',
      dependencies: {
        expo: '~51.0.0',
      },
    }
    writeFileSync(join(TMP, 'package.json'), JSON.stringify(pkg))
    mkdirSync(join(TMP, 'node_modules', 'expo'), { recursive: true })
    // findMissingTopLevelDeps checks for `<dep>/package.json` exactly.
    writeFileSync(join(TMP, 'node_modules', 'expo', 'package.json'), '{"name":"expo"}')
    writeFileSync(join(TMP, 'node_modules', '.shogo-platform'), PLATFORM_TAG + '\n')

    mkdirSync(join(TMP, '.shogo'), { recursive: true })
    writeInstallMarker(TMP, computePackageJsonHash(TMP)!)

    await ensureWorkspaceDeps(TMP)

    expect(installCalls.length).toBe(0)
  })
})
