// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression: a published metal VM restores the project's source over a
// pool VM whose template install is still running. The source carries the
// dev workspace's `.shogo/install-marker`, which matches the project's
// package.json, and the half-written node_modules already has every
// top-level package. PreviewManager trusted both, skipped the install, and
// started the API server against missing transitive packages
// (`Cannot find module '@libsql/core/config'`), crash-looping until the
// install finished. It must wait for the in-flight install instead.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pkg } from '@shogo/shared-runtime'
import { PreviewManager } from '../preview-manager'
import {
  _resetWorkspaceInstallMutex,
  computePackageJsonHash,
  runWorkspaceInstall,
  writeInstallMarker,
  writeInstallPlatformMarker,
} from '../workspace-defaults'

const realInstallAsync = pkg.installAsync
let dir: string
let finishInstall: () => void
let installs = 0

beforeEach(() => {
  _resetWorkspaceInstallMutex()
  installs = 0
  ;(pkg as any).installAsync = () => {
    installs++
    return new Promise<void>((r) => (finishInstall = r))
  }
  dir = mkdtempSync(join(tmpdir(), 'shogo-pm-inflight-'))
})

afterEach(() => {
  ;(pkg as any).installAsync = realInstallAsync
  _resetWorkspaceInstallMutex()
  rmSync(dir, { recursive: true, force: true })
})

describe('PreviewManager install gate with an install in flight', () => {
  test('waits for the running install instead of trusting a restored marker', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@libsql/client': '^0.15.0' } }))
    mkdirSync(join(dir, 'node_modules', '@libsql', 'client'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '@libsql', 'client', 'package.json'), '{"name":"@libsql/client"}')
    writeInstallPlatformMarker(dir)
    writeInstallMarker(dir, computePackageJsonHash(dir)!)

    const poolInstall = runWorkspaceInstall(dir, { frozen: true })
    const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 8080 })
    let gateDone = false
    const gate = (pm as any).installDepsIfNeeded({}, dir).then(() => (gateDone = true))

    await new Promise((r) => setTimeout(r, 50))
    expect(gateDone).toBe(false)

    finishInstall()
    await poolInstall
    await gate
    expect(gateDone).toBe(true)
    expect(installs).toBe(1)
  })
})
