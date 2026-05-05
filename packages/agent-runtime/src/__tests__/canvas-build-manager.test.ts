// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// CanvasBuildManager is now stack-aware: it accepts either Vite or Expo as
// the bundler binary. These tests pin the contract so a future stack
// addition (e.g. parcel, rspack) doesn't silently regress the gate, and
// verify the atomic dist.staging -> dist swap that fixes the
// "rebuild deletes dist, refresh 404s" regression.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CanvasBuildManager } from '../canvas-build-manager'

const TMP = join(tmpdir(), 'test-canvas-build-manager')
const IS_WINDOWS = process.platform === 'win32'

/**
 * Write a fake bundler shim that exits 0 (and optionally writes a
 * `<stagingDir>/index.html` payload first, to exercise the atomic-swap
 * commit). Cross-platform: on POSIX we drop a `#!/bin/sh` script with
 * exec bit set; on Windows we drop a `.CMD` wrapper next to it because
 * `child_process.spawn` can't execute a no-extension shell script
 * there. CanvasBuildManager.resolveBundler picks the right shim per-OS,
 * mirroring the same logic in PreviewManager.
 */
function writeShim(
  binDir: string,
  name: string,
  opts: { exitCode?: number; stagingPayload?: string; stagingDir?: string },
): void {
  const exitCode = opts.exitCode ?? 0
  const stagingDir = opts.stagingDir ?? 'dist.staging'
  const stagingPath = join(TMP, stagingDir)
  const indexPath = join(stagingPath, 'index.html')

  if (IS_WINDOWS) {
    // .CMD shim — written to the location PreviewManager / Canvas-
    // BuildManager probe first on win32. We escape ^ for HTML angle
    // brackets so `echo` doesn't mangle the body.
    const lines: string[] = ['@echo off']
    if (opts.stagingPayload != null) {
      lines.push(`md "${stagingPath}" 2>nul`)
      const escaped = opts.stagingPayload
        .replaceAll('<', '^<')
        .replaceAll('>', '^>')
        .replaceAll('&', '^&')
      lines.push(`>"${indexPath}" echo ${escaped}`)
    }
    lines.push(`exit /b ${exitCode}`)
    writeFileSync(join(binDir, `${name}.CMD`), lines.join('\r\n') + '\r\n')
    return
  }

  // POSIX shim
  const lines: string[] = ['#!/bin/sh', 'set -e']
  if (opts.stagingPayload != null) {
    lines.push(`mkdir -p '${stagingPath}'`)
    lines.push(`cat > '${indexPath}' <<'EOF'`)
    lines.push(opts.stagingPayload)
    lines.push('EOF')
  }
  lines.push(`exit ${exitCode}`)
  writeFileSync(join(binDir, name), lines.join('\n') + '\n', { mode: 0o755 })
}

function freshWorkspace(opts: {
  withVite?: boolean
  withExpo?: boolean
  withPkg?: boolean
  /**
   * If set, the fake bundler shim writes `index.html` (with this body)
   * into `<TMP>/<stagingDir>/` before exiting 0. Used to verify the
   * atomic swap into `dist/` end-to-end.
   */
  stagingPayload?: string
  stagingDir?: string
} = {}) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  if (opts.withPkg !== false) {
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { build: 'echo built' } }),
    )
  }
  const binDir = join(TMP, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })

  const shimOpts = {
    stagingPayload: opts.stagingPayload,
    stagingDir: opts.stagingDir,
  }
  if (opts.withVite) writeShim(binDir, 'vite', shimOpts)
  if (opts.withExpo) writeShim(binDir, 'expo', shimOpts)
}

describe('CanvasBuildManager bundler-bin gate', () => {
  beforeEach(() => freshWorkspace())
  afterEach(() => rmSync(TMP, { recursive: true, force: true }))

  test('skips build when no bundler bin is present', async () => {
    freshWorkspace({})
    let completed = false
    let errored = false
    const mgr = new CanvasBuildManager(TMP, {
      onBuildComplete: () => { completed = true },
      onBuildError: () => { errored = true },
    })
    await mgr.start()
    // No bin → runBuild() returns early; neither callback fires.
    expect(completed).toBe(false)
    expect(errored).toBe(false)
  })

  test('skips build when package.json is missing', async () => {
    freshWorkspace({ withPkg: false, withVite: true })
    let completed = false
    const mgr = new CanvasBuildManager(TMP, {
      onBuildComplete: () => { completed = true },
      onBuildError: () => {},
    })
    await mgr.start()
    expect(completed).toBe(false)
  })

  test('runs build when only Vite bin is present (existing Vite contract)', async () => {
    freshWorkspace({ withVite: true })
    let completed = false
    let errored = false
    const mgr = new CanvasBuildManager(TMP, {
      onBuildComplete: () => { completed = true },
      onBuildError: () => { errored = true },
    })
    await mgr.start()
    // The shim script `echo built` exits 0 → onBuildComplete fires.
    expect(completed).toBe(true)
    expect(errored).toBe(false)
  })

  test('runs build when only Expo bin is present (Metro contract)', async () => {
    freshWorkspace({ withExpo: true })
    let completed = false
    let errored = false
    const mgr = new CanvasBuildManager(TMP, {
      onBuildComplete: () => { completed = true },
      onBuildError: () => { errored = true },
    })
    await mgr.start()
    expect(completed).toBe(true)
    expect(errored).toBe(false)
  })
})

describe('CanvasBuildManager atomic dist swap', () => {
  beforeEach(() => freshWorkspace())
  afterEach(() => rmSync(TMP, { recursive: true, force: true }))

  test('promotes dist.staging into dist on successful build', async () => {
    // Vite shim writes a payload into dist.staging/index.html and exits 0.
    freshWorkspace({ withVite: true, stagingPayload: '<html>fresh</html>' })
    const mgr = new CanvasBuildManager(TMP, {
      onBuildComplete: () => {},
      onBuildError: () => {},
    })
    await mgr.start()

    expect(existsSync(join(TMP, 'dist', 'index.html'))).toBe(true)
    expect(readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8'))
      .toContain('fresh')
    // Staging dir must be gone — left in place it would confuse the
    // next build.
    expect(existsSync(join(TMP, 'dist.staging'))).toBe(false)
  })

  test('preserves the previous dist on failed build', async () => {
    // Seed an existing dist with content the runtime is currently serving.
    freshWorkspace({ withVite: false })
    mkdirSync(join(TMP, 'dist'), { recursive: true })
    writeFileSync(join(TMP, 'dist', 'index.html'), '<html>previous</html>')

    // Now drop in a vite shim that fails (exit 1) without producing output.
    const binDir = join(TMP, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    writeShim(binDir, 'vite', { exitCode: 1 })

    let completed = false
    let errored = false
    const mgr = new CanvasBuildManager(TMP, {
      onBuildComplete: () => { completed = true },
      onBuildError: () => { errored = true },
    })
    await mgr.start()

    expect(completed).toBe(false)
    expect(errored).toBe(true)
    // Critical: the old build must still be serveable. Without the
    // staging-dir + atomic-swap behavior, a failed `expo export`
    // would have wiped dist/ and left a permanent 404.
    expect(readFileSync(join(TMP, 'dist', 'index.html'), 'utf-8'))
      .toContain('previous')
    // Failed build: any partial staging output must be cleaned up.
    expect(existsSync(join(TMP, 'dist.staging'))).toBe(false)
  })

  test('isBuilding flips during runBuild and clears afterwards', async () => {
    freshWorkspace({ withVite: true, stagingPayload: '<html>x</html>' })
    const mgr = new CanvasBuildManager(TMP, {
      onBuildComplete: () => {},
      onBuildError: () => {},
    })
    expect(mgr.isBuilding).toBe(false)
    const startPromise = mgr.start()
    // We can't reliably observe isBuilding=true here without racing the
    // shim, but we can confirm it's settled once the build finishes.
    await startPromise
    expect(mgr.isBuilding).toBe(false)
  })
})
