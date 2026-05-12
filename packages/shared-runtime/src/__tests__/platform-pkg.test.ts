// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for the Windows-aware install-routing in platform-pkg.ts.
// We can't reasonably exercise the full install flow in a unit test
// (would require spawning npm/bun against a real package.json), so the
// coverage here focuses on the small but fragile detection function
// `isNodeAvailableOnWindows` which now drives the bun-fallback path.
//
// On non-Windows hosts, `isNodeAvailableOnWindows` is hard-wired to
// return true (bun is the only manager); we still smoke-test that
// invariant so a future "make this multi-platform" refactor can't
// silently regress it.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, chmodSync } from 'fs'
import { join } from 'path'
import {
  isNodeAvailableOnWindows,
  isNodeAvailableOnUnix,
  resolveBinInvocation,
  _resetUnixNodeCache,
} from '../platform-pkg'

const TMP = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'test-platform-pkg')

// `isNodeAvailableOnWindows` short-circuits to `true` when the standard
// install directory (`C:\Program Files\nodejs\npm.cmd`) exists, *before*
// it ever walks the PATH. So any "no npm anywhere" assertion is only
// meaningful when that file isn't present on the test host.
const SYSTEM_NPM_CMD = 'C:\\Program Files\\nodejs\\npm.cmd'
const HOST_HAS_SYSTEM_NPM = process.platform === 'win32' && existsSync(SYSTEM_NPM_CMD)

describe('isNodeAvailableOnWindows', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  test('returns true on non-Windows hosts regardless of PATH', () => {
    if (process.platform === 'win32') return // skip on Windows
    expect(isNodeAvailableOnWindows('')).toBe(true)
    expect(isNodeAvailableOnWindows(undefined)).toBe(true)
    expect(isNodeAvailableOnWindows('/totally/bogus')).toBe(true)
  })

  test('returns true on Windows when npm.cmd is on PATH (synthetic dir)', () => {
    if (process.platform !== 'win32') return // PATH walk only checked on Windows
    const dir = join(TMP, 'fake-node')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'npm.cmd'), '')
    // Exercise the PATH walk — should find the synthetic npm.cmd.
    expect(isNodeAvailableOnWindows(dir)).toBe(true)
  })

  test('returns false on Windows when no PATH entry contains npm.cmd (and system Node is absent)', () => {
    if (process.platform !== 'win32') return
    if (HOST_HAS_SYSTEM_NPM) return // host has a system Node install — short-circuit makes this test meaningless
    const dir = join(TMP, 'no-npm')
    mkdirSync(dir, { recursive: true })
    expect(isNodeAvailableOnWindows(dir)).toBe(false)
  })

  test('handles undefined PATH on Windows without throwing', () => {
    if (process.platform !== 'win32') return
    // Falls through to the standard install dir check; that may or may
    // not exist on the host. The contract is "must not throw".
    expect(() => isNodeAvailableOnWindows(undefined)).not.toThrow()
  })
})

// ----------------------------------------------------------------------
// Coverage for the Unix-side `node`-on-PATH probe that gates the bun
// fallback. The Shogo Desktop bundle ships bun but not node, and the
// Electron-spawned API process inherits a launchctl PATH that often
// lacks any user-installed node — so the probe must answer "no" in
// that case and let the .bin shim spawn route through bundled bun.
// ----------------------------------------------------------------------

describe('isNodeAvailableOnUnix', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    _resetUnixNodeCache()
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    _resetUnixNodeCache()
  })

  test('returns false on Windows hosts regardless of PATH', () => {
    if (process.platform !== 'win32') return
    const dir = join(TMP, 'fake-node')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'node'), '')
    expect(isNodeAvailableOnUnix(dir)).toBe(false)
  })

  test('returns true on Unix when `node` is present in a PATH entry', () => {
    if (process.platform === 'win32') return
    const dir = join(TMP, 'fake-node')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'node'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, 'node'), 0o755)
    expect(isNodeAvailableOnUnix(`/totally/bogus:${dir}:/also/bogus`)).toBe(true)
  })

  test('returns false on Unix when no PATH entry contains `node`', () => {
    if (process.platform === 'win32') return
    const dir = join(TMP, 'empty')
    mkdirSync(dir, { recursive: true })
    // Override the process's real PATH so `undefined`/`''` exercise the
    // probe's empty-PATH branch instead of falling through to whatever
    // the dev machine has installed.
    const prev = process.env.PATH
    try {
      process.env.PATH = dir
      _resetUnixNodeCache()
      expect(isNodeAvailableOnUnix(dir)).toBe(false)
      process.env.PATH = ''
      _resetUnixNodeCache()
      expect(isNodeAvailableOnUnix(undefined)).toBe(false)
      expect(isNodeAvailableOnUnix('')).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.PATH
      else process.env.PATH = prev
      _resetUnixNodeCache()
    }
  })

  test('survives empty PATH segments without throwing', () => {
    if (process.platform === 'win32') return
    expect(() => isNodeAvailableOnUnix('::::')).not.toThrow()
    expect(isNodeAvailableOnUnix('::::')).toBe(false)
  })
})

// ----------------------------------------------------------------------
// `resolveBinInvocation` — the helper that decides whether to spawn a
// `node_modules/.bin/<tool>` shim directly or route through bundled
// `bun` to bypass the shim's `#!/usr/bin/env node` shebang when no
// system node is on PATH. This is what unblocks `vite build --watch`
// and `CanvasBuildManager` from exit-code-127-ing on Shogo Desktop.
// ----------------------------------------------------------------------

describe('resolveBinInvocation', () => {
  let prevBunPath: string | undefined
  let prevPath: string | undefined

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    prevBunPath = process.env.SHOGO_BUN_PATH
    prevPath = process.env.PATH
    _resetUnixNodeCache()
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    if (prevBunPath === undefined) delete process.env.SHOGO_BUN_PATH
    else process.env.SHOGO_BUN_PATH = prevBunPath
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    _resetUnixNodeCache()
  })

  test('returns null when the .bin shim is missing', () => {
    expect(resolveBinInvocation(TMP, 'vite')).toBeNull()
  })

  /**
   * Create a realistic vite layout under `dir/`:
   *   node_modules/vite/bin/vite.js  (with the broken shebang)
   *   node_modules/.bin/vite -> ../vite/bin/vite.js  (symlink, like npm/bun emit)
   */
  function seedViteShim(dir: string): { jsEntry: string; shim: string } {
    const viteDir = join(dir, 'node_modules', 'vite', 'bin')
    const binDir = join(dir, 'node_modules', '.bin')
    mkdirSync(viteDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    const jsEntry = join(viteDir, 'vite.js')
    writeFileSync(jsEntry, '#!/usr/bin/env node\nconsole.log("vite")\n')
    chmodSync(jsEntry, 0o755)
    const shim = join(binDir, 'vite')
    symlinkSync('../vite/bin/vite.js', shim)
    return { jsEntry, shim }
  }

  test('returns the shim directly when system node is on PATH', () => {
    if (process.platform === 'win32') return
    const { shim } = seedViteShim(TMP)

    // Pretend node is installed by seeding a fake one on the PATH the
    // probe walks. (The probe only checks existence, not executability.)
    const nodeDir = join(TMP, 'fake-node-bin')
    mkdirSync(nodeDir, { recursive: true })
    writeFileSync(join(nodeDir, 'node'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(nodeDir, 'node'), 0o755)
    process.env.PATH = nodeDir
    _resetUnixNodeCache()

    const inv = resolveBinInvocation(TMP, 'vite')
    expect(inv).not.toBeNull()
    expect(inv!.cmd).toBe(shim)
    expect(inv!.argsPrefix).toEqual([])
  })

  test('falls back to bundled bun + JS entry when node is missing on Unix', () => {
    if (process.platform === 'win32') return
    const { jsEntry } = seedViteShim(TMP)

    process.env.PATH = join(TMP, 'no-node-here') // does not exist; no node available
    process.env.SHOGO_BUN_PATH = '/opt/shogo/bun'
    _resetUnixNodeCache()

    const inv = resolveBinInvocation(TMP, 'vite')
    expect(inv).not.toBeNull()
    expect(inv!.cmd).toBe('/opt/shogo/bun')
    expect(inv!.argsPrefix).toEqual([jsEntry])
  })

  test('defaults bun cmd to bare "bun" when SHOGO_BUN_PATH is unset', () => {
    if (process.platform === 'win32') return
    seedViteShim(TMP)

    process.env.PATH = join(TMP, 'no-node-here')
    delete process.env.SHOGO_BUN_PATH
    _resetUnixNodeCache()

    const inv = resolveBinInvocation(TMP, 'vite')
    expect(inv).not.toBeNull()
    expect(inv!.cmd).toBe('bun')
  })

  test('falls back to direct shim when shim is a regular file (not a symlink)', () => {
    if (process.platform === 'win32') return
    // Bun's hardlink-fallback mode can copy the .bin entry as a regular
    // file instead of a symlink. In that case readlink would throw, so
    // we degrade to the original direct-spawn behavior (which may still
    // fail with exit 127, but matches pre-fix behavior — best we can do).
    const binDir = join(TMP, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    const shim = join(binDir, 'vite')
    writeFileSync(shim, '#!/usr/bin/env node\n')
    chmodSync(shim, 0o755)

    process.env.PATH = join(TMP, 'no-node-here')
    _resetUnixNodeCache()

    const inv = resolveBinInvocation(TMP, 'vite')
    expect(inv).not.toBeNull()
    expect(inv!.cmd).toBe(shim)
    expect(inv!.argsPrefix).toEqual([])
  })

  test('returns null when shim symlink is dangling (broken install)', () => {
    if (process.platform === 'win32') return
    // A dangling .bin shim means the package's install was truncated
    // (e.g. bun crashed mid-extract). existsSync follows symlinks and
    // reports false, so the helper returns null and the caller's
    // "vite not found in node_modules" branch handles it cleanly —
    // same as if the shim never existed at all.
    const binDir = join(TMP, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    const shim = join(binDir, 'vite')
    symlinkSync('../vite/bin/vite.js', shim) // dangling

    process.env.PATH = join(TMP, 'no-node-here')
    _resetUnixNodeCache()

    expect(resolveBinInvocation(TMP, 'vite')).toBeNull()
  })

  test('handles paths with spaces correctly (Library/Application Support)', () => {
    if (process.platform === 'win32') return
    const workspace = join(TMP, 'Library', 'Application Support', 'Shogo', 'workspaces', 'abc')
    mkdirSync(workspace, { recursive: true })
    const { jsEntry } = seedViteShim(workspace)

    process.env.PATH = join(TMP, 'no-node-here')
    process.env.SHOGO_BUN_PATH = '/opt/shogo/bun'
    _resetUnixNodeCache()

    const inv = resolveBinInvocation(workspace, 'vite')
    expect(inv).not.toBeNull()
    expect(inv!.cmd).toBe('/opt/shogo/bun')
    // The JS entry must be an absolute path (so the eventual spawn doesn't
    // depend on cwd) AND must preserve the spaces verbatim — child_process
    // .spawn argv arrays are not shell-tokenized, so spaces are safe.
    expect(inv!.argsPrefix).toEqual([jsEntry])
    expect(jsEntry).toContain('Application Support')
  })
})
