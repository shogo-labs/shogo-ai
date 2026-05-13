// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression: ensureWorkspaceDeps must NOT short-circuit on the
// `existsSync(viteBin)` fast path when the workspace's package.json
// doesn't actually depend on Vite.
//
// Why this matters (cloud Expo import bug, 2026-05-12)
// -----------------------------------------------------
// Warm pods are pre-seeded with the Vite/react-app runtime template.
// `bun install` runs at pre-seed time, leaving `node_modules/.bin/vite`
// and a `.shogo-platform=linux-arm64` marker in node_modules.
//
// When the user imports an Expo project, the S3 sync overlays an Expo
// `package.json`, an Expo `bun.lock`, and (toxically) the exporting
// machine's `.shogo/install-marker` — a sha256 of THEIR Expo
// package.json. On the cloud pod, that marker happens to match the
// just-imported package.json hash, so `PreviewManager.installDepsIfNeeded`
// later skips install ("hash matches").
//
// `ensureWorkspaceDeps` had its own, EARLIER short-circuit:
//   } else if (existsSync(viteBin)) {
//     if (installedPlatform === PLATFORM_TAG) return
//   }
// Vite bin exists (warm-pod leftover) + linux-arm64 marker matches →
// returns immediately, even though the user's Expo deps were never
// installed. Result: workspace claims to be expo-three (`.tech-stack`),
// CanvasBuildManager (after fix `0ef3131e`) refuses to fall back to
// vite, and there's no `expo` bin to run the build with — preview
// "kind of works" (warm pod's Vite output is still served from dist/)
// but never rebuilds.
//
// The fix: gate the viteBin short-circuit on the workspace ACTUALLY
// depending on vite. The same `workspacePkgUsesVite` check that exists
// later in the function (around the template-copy fast path) needs to
// gate this earlier branch too.

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `pkg.installAsync` is the only `@shogo/shared-runtime` surface used
// by workspace-defaults.ts (verified via `rg`). We mock the whole
// module here so the test can detect whether the install path was
// reached without actually shelling out to bun.
const installCalls: Array<{ dir: string; opts: any }> = []
mock.module('@shogo/shared-runtime', () => ({
  pkg: {
    installAsync: async (dir: string, opts: any) => {
      installCalls.push({ dir, opts })
      // Throw so the function bails out before reaching `writeInstallMarker`
      // / `writePlatformMarker`. We're testing whether the call was
      // ATTEMPTED, not its outcome.
      throw new Error('test-stub: installAsync not actually executed')
    },
  },
}))

const { ensureWorkspaceDeps } = await import('../workspace-defaults')

const PLATFORM_TAG = `${process.platform}-${process.arch}`

let TMP: string

beforeEach(() => {
  installCalls.length = 0
  TMP = mkdtempSync(join(tmpdir(), 'shogo-ensure-deps-mismatch-'))
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

/**
 * Disk shape: warm pod was pre-seeded with Vite (`.bin/vite` +
 * platform marker) → user's Expo workspace was overlaid (Expo
 * `package.json`, no Expo deps installed yet).
 */
function seedHybridState(stackPkg: object): void {
  writeFileSync(join(TMP, 'package.json'), JSON.stringify(stackPkg))
  mkdirSync(join(TMP, 'node_modules', '.bin'), { recursive: true })
  // Vite shim left over from the warm-pod pre-seed install.
  writeFileSync(join(TMP, 'node_modules', '.bin', 'vite'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  })
  // Platform marker matches current platform — the second condition
  // of the buggy short-circuit. We use the test runner's actual
  // platform so the gate is genuinely live.
  writeFileSync(join(TMP, 'node_modules', '.shogo-platform'), PLATFORM_TAG + '\n')
}

describe('ensureWorkspaceDeps — stack mismatch on viteBin fast path', () => {
  test('Expo package.json + leftover .bin/vite must NOT short-circuit', async () => {
    seedHybridState({
      name: 'expo-app',
      dependencies: { expo: '~51.0.0', react: '18.2.0' },
    })

    // The function will throw because our installAsync stub throws —
    // we only care that it REACHED installAsync (i.e. did NOT
    // short-circuit on the viteBin fast path).
    let threw = false
    try {
      await ensureWorkspaceDeps(TMP)
    } catch {
      threw = true
    }

    expect(installCalls.length).toBe(1)
    expect(installCalls[0]!.dir).toBe(TMP)
    // Confirm we reached the install path even on the throw side
    // (defense-in-depth — install path is the only one that calls
    // installAsync).
    expect(threw).toBe(true)
  })

  test('Vite package.json + .bin/vite + matching marker DOES short-circuit (existing contract)', async () => {
    // Inverse case: legitimate Vite workspace. Pin the existing
    // happy-path so the fix doesn't accidentally also force
    // reinstalls on real Vite stacks.
    seedHybridState({
      name: 'vite-app',
      dependencies: { vite: '^5.0.0', react: '18.2.0' },
    })

    await ensureWorkspaceDeps(TMP)

    // No install attempted — the function correctly skipped because
    // the workspace IS a Vite workspace and vite is already present.
    expect(installCalls.length).toBe(0)
  })
})
