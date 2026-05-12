// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Repro: imported Expo project never rebuilds in cloud
// =====================================================
//
// User-reported symptom (2026-05-12):
//   "I built an expo app on my local shogo and then imported it to the cloud
//    and it kind of worked but it never rebuilt"
//
// What this test pins
// -------------------
// The cloud open-an-imported-Expo-project flow goes through the warm-pool
// path. By the time the agent's CanvasBuildManager runs its first build,
// the workspace is in a "hybrid" state because:
//
//   1. Pool pre-seed (server.ts ~3855-3879) drops a Vite/react-app
//      runtime template + installs Vite into node_modules/ on every
//      warm pod, with no TECH_STACK_ID yet.
//   2. /pool/assign arrives with TECH_STACK_ID=expo-three. onAssign
//      wipes only files/, memory/, skills/ — package.json,
//      vite.config.ts, and node_modules/.bin/vite all survive.
//   3. seedTechStack('expo-three') runs with a `!existsSync(dest)`
//      filter — it lays down app/, app.json, babel.config.js,
//      metro.config.js, but does NOT replace the Vite package.json or
//      delete the Vite bin shim.
//   4. S3 sync overlays the user's Expo package.json on top, but the
//      Vite shim in node_modules/.bin/vite remains.
//   5. CanvasBuildManager.resolveBundler() prefers `vite` over `expo`
//      in KNOWN_BUNDLERS — so it runs `vite build` against an Expo
//      app every time, including on every triggerRebuild().
//
// The test deterministically reconstructs that disk state and asserts
// the bug from three angles:
//
//   A1: initial canvas build picks the Expo bundler, not Vite.
//   A2: on agent edit (watcher.onFileChanged('app/index.tsx', ...)),
//       the rebuild also picks Expo, not Vite.
//   A3: the Vite shim is never invoked at all during the run.
//
// On `main` all three should fail because resolveBundler picks Vite
// first regardless of .tech-stack.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CanvasBuildManager } from '../canvas-build-manager'
import { CanvasFileWatcher } from '../canvas-file-watcher'
import { seedTechStack } from '../workspace-defaults'

const IS_WINDOWS = process.platform === 'win32'

// Each test gets its own tmp dir so chokidar singletons / leftover
// dist/ from a prior run can't contaminate later assertions.
let TMP: string
let invocationLog: string

function freshTmp(label: string): string {
  const dir = join(
    tmpdir(),
    `shogo-expo-cloud-rebuild-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Drop a fake bundler shim that:
 *   - appends its `name` to `invocationLog` (so A3 can prove the Vite
 *     shim was never invoked, even if no output landed in dist/), and
 *   - writes `dist.staging/index.html` with a body that names the
 *     bundler (so A1/A2 can prove which shim produced the dist
 *     contents currently being served).
 *
 * Cross-platform: POSIX gets a `#!/bin/sh` script with exec bit set;
 * Windows gets a `.CMD` shim. Mirrors writeShim() in
 * canvas-build-manager.test.ts.
 */
function writeBundlerShim(workspaceDir: string, name: 'vite' | 'expo'): void {
  const binDir = join(workspaceDir, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const stagingDir = join(workspaceDir, 'dist.staging')
  const indexPath = join(stagingDir, 'index.html')
  const body = `<html>${name}-built-this</html>`

  if (IS_WINDOWS) {
    const lines = [
      '@echo off',
      `>>"${invocationLog}" echo ${name}`,
      `md "${stagingDir}" 2>nul`,
      `>"${indexPath}" echo ^<html^>${name}-built-this^</html^>`,
      'exit /b 0',
    ]
    writeFileSync(join(binDir, `${name}.CMD`), lines.join('\r\n') + '\r\n')
    return
  }

  const lines = [
    '#!/bin/sh',
    'set -e',
    `echo ${name} >> '${invocationLog}'`,
    `mkdir -p '${stagingDir}'`,
    `cat > '${indexPath}' <<'EOF'`,
    body,
    'EOF',
    'exit 0',
  ]
  writeFileSync(join(binDir, name), lines.join('\n') + '\n', { mode: 0o755 })
}

/**
 * Recreate the disk state of a warm pod immediately after pool pre-seed
 * (Vite/react-app installed, no TECH_STACK_ID yet). This is what
 * survives `onAssign`'s narrow wipe.
 */
function seedPoolPreSeedState(workspaceDir: string): void {
  const vitePkg = {
    name: 'pool-preseed',
    private: true,
    type: 'module',
    dependencies: {
      vite: '5.0.0',
      react: '18.3.1',
      'react-dom': '18.3.1',
    },
  }
  writeFileSync(
    join(workspaceDir, 'package.json'),
    JSON.stringify(vitePkg, null, 2),
  )
  writeFileSync(
    join(workspaceDir, 'vite.config.ts'),
    'export default { plugins: [] }\n',
  )
  writeFileSync(join(workspaceDir, '.tech-stack'), 'react-app')

  // Install marker mirrors what seedRuntimeTemplate's caller writes
  // after the warm pod's bun install. Keeps the test honest about
  // why ensureWorkspaceDeps short-circuits in the cloud.
  mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
  const hash = createHash('sha256').update(JSON.stringify(vitePkg)).digest('hex')
  writeFileSync(join(workspaceDir, '.shogo', 'install-marker'), hash)
  writeFileSync(
    join(workspaceDir, '.shogo', 'config.json'),
    JSON.stringify({ canvasMode: 'code' }),
  )

  // The Vite bin shim. This is what resolveBundler() finds first
  // because vite comes before expo in KNOWN_BUNDLERS.
  writeBundlerShim(workspaceDir, 'vite')
}

/**
 * Recreate what the S3 sync extracts on top of the pre-seed when an
 * imported Expo workspace lands on a warm pod. We replace package.json
 * (mirroring tar overwrite) and lay down the Expo-only files. The
 * Vite shim is intentionally NOT removed — that's the bug surface.
 */
function overlayImportedExpoWorkspace(workspaceDir: string): void {
  const expoPkg = {
    name: 'imported-expo-app',
    private: true,
    main: 'expo-router/entry',
    dependencies: {
      expo: '52.0.0',
      'expo-router': '4.0.0',
      react: '18.3.1',
      'react-native': '0.76.0',
    },
  }
  writeFileSync(
    join(workspaceDir, 'package.json'),
    JSON.stringify(expoPkg, null, 2),
  )

  // Expo bin shim — installed by the imported package.json's expo dep.
  // Per the user's report ("kind of worked"), node_modules ends up
  // with both shims after the cloud's deps reconciliation.
  writeBundlerShim(workspaceDir, 'expo')

  mkdirSync(join(workspaceDir, 'app'), { recursive: true })
  writeFileSync(
    join(workspaceDir, 'app', 'index.tsx'),
    `import { Text } from 'react-native'\nexport default () => <Text>hi</Text>\n`,
  )
  writeFileSync(
    join(workspaceDir, 'app', '_layout.tsx'),
    `import { Stack } from 'expo-router'\nexport default () => <Stack />\n`,
  )
  writeFileSync(
    join(workspaceDir, 'app.json'),
    JSON.stringify({ expo: { name: 'imported', slug: 'imported' } }),
  )
  writeFileSync(
    join(workspaceDir, 'babel.config.js'),
    'module.exports = { presets: ["babel-preset-expo"] }\n',
  )
  writeFileSync(
    join(workspaceDir, 'metro.config.js'),
    'module.exports = require("expo/metro-config").getDefaultConfig(__dirname)\n',
  )

  writeFileSync(join(workspaceDir, '.tech-stack'), 'expo-three')
}

function resetCanvasFileWatcherSingleton(): void {
  // Singleton survives between tests; force a fresh watcher per workspace
  // so the second test doesn't keep a chokidar handle on the first
  // workspace's tmp dir.
  // @ts-expect-error — accessing private static for test isolation
  CanvasFileWatcher.instance?.close?.()
  // @ts-expect-error — accessing private static for test isolation
  CanvasFileWatcher.instance = null
}

beforeEach(() => {
  resetCanvasFileWatcherSingleton()
  TMP = freshTmp('case')
  invocationLog = join(TMP, '.invocations.log')
  writeFileSync(invocationLog, '') // start empty
})

afterEach(() => {
  resetCanvasFileWatcherSingleton()
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  delete process.env.TECH_STACK_ID
})

function readInvocations(): string[] {
  if (!existsSync(invocationLog)) return []
  return readFileSync(invocationLog, 'utf-8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Block until either `predicate()` returns true or the timeout elapses.
 * Used to wait for the debounced rebuild after `triggerRebuild()`
 * (BUILD_DEBOUNCE_MS = 500ms) without coupling the test to internal timing.
 */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return predicate()
}

describe('Expo cloud rebuild repro', () => {
  test('imported Expo project picks Expo bundler (not Vite) on first build (A1)', async () => {
    seedPoolPreSeedState(TMP)
    overlayImportedExpoWorkspace(TMP)
    seedTechStack(TMP, 'expo-three') // mirrors initializeEssentials line 3651
    process.env.TECH_STACK_ID = 'expo-three'

    let buildErr: string | null = null
    const mgr = new CanvasBuildManager(TMP, {
      onBuildComplete: () => {},
      onBuildError: (err) => { buildErr = err },
    })

    await mgr.start()

    expect(buildErr).toBeNull()
    expect(existsSync(join(TMP, 'dist', 'index.html'))).toBe(true)

    // A1: dist/ must reflect the Expo build, NOT the Vite shim's output.
    // On `main` this fails because resolveBundler picks vite first
    // (KNOWN_BUNDLERS = ['vite', 'expo']) regardless of .tech-stack.
    const dist = readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')
    expect(dist).toContain('expo-built-this')
    expect(dist).not.toContain('vite-built-this')
  })

  test('agent edit to app/*.tsx triggers Expo rebuild (A2)', async () => {
    seedPoolPreSeedState(TMP)
    overlayImportedExpoWorkspace(TMP)
    seedTechStack(TMP, 'expo-three')
    process.env.TECH_STACK_ID = 'expo-three'

    const mgr = new CanvasBuildManager(TMP, {
      onBuildComplete: () => {},
      onBuildError: () => {},
    })
    const watcher = CanvasFileWatcher.getInstance(TMP)
    watcher.setOnRebuild(() => mgr.triggerRebuild())

    await mgr.start()

    // Agent edits app/index.tsx — write the file (so a chokidar-only
    // setup would also see it) and notify via the explicit gateway-
    // tools path the test relies on.
    writeFileSync(
      join(TMP, 'app', 'index.tsx'),
      `import { Text } from 'react-native'\nexport default () => <Text>edited</Text>\n`,
    )
    watcher.onFileChanged('app/index.tsx', join(TMP, 'app', 'index.tsx'))

    // Debounced build (500ms) → wait until the second invocation lands.
    const sawSecondBuild = await waitFor(() => readInvocations().length >= 2)
    expect(sawSecondBuild).toBe(true)

    // A2: after the rebuild, dist/ still reflects an Expo build.
    // On `main` this is either stale (vite still wins resolveBundler
    // and rebuilds dist with vite-built-this) or the rebuild was
    // never invoked at all.
    const dist = readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8')
    expect(dist).toContain('expo-built-this')
    expect(dist).not.toContain('vite-built-this')
  })

  test('Vite shim is never invoked when .tech-stack=expo-three (A3)', async () => {
    seedPoolPreSeedState(TMP)
    overlayImportedExpoWorkspace(TMP)
    seedTechStack(TMP, 'expo-three')
    process.env.TECH_STACK_ID = 'expo-three'

    const mgr = new CanvasBuildManager(TMP, {
      onBuildComplete: () => {},
      onBuildError: () => {},
    })
    const watcher = CanvasFileWatcher.getInstance(TMP)
    watcher.setOnRebuild(() => mgr.triggerRebuild())

    await mgr.start()
    watcher.onFileChanged('app/index.tsx', join(TMP, 'app', 'index.tsx'))
    await waitFor(() => readInvocations().length >= 2)
    // Small extra settle so a misrouted rebuild has time to log.
    await new Promise((r) => setTimeout(r, 200))

    // A3: pin the bug from a third angle so the fix can't shave A1/A2
    // by, say, post-processing dist/ — the Vite shim must never run
    // for a tech-stack-locked Expo workspace.
    const invocations = readInvocations()
    expect(invocations.length).toBeGreaterThan(0)
    expect(invocations).not.toContain('vite')
    for (const tool of invocations) {
      expect(tool).toBe('expo')
    }
  })
})
