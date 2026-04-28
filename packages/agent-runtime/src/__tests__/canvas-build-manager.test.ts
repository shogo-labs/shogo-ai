// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// CanvasBuildManager is now stack-aware: it accepts either Vite or Expo as
// the bundler binary. These tests pin the contract so a future stack
// addition (e.g. parcel, rspack) doesn't silently regress the gate.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CanvasBuildManager } from '../canvas-build-manager'

const TMP = '/tmp/test-canvas-build-manager'

function freshWorkspace(opts: { withVite?: boolean; withExpo?: boolean; withPkg?: boolean } = {}) {
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
  if (opts.withVite) writeFileSync(join(binDir, 'vite'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  if (opts.withExpo) writeFileSync(join(binDir, 'expo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
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
