// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression: a project that calls `bun add` during its build then triggers a
// publish ends up permanently stranded on "Installing dependencies…" in the
// canvas.  The sequence that caused it:
//   1. preview starts → installDepsIfNeeded → marker written → phase = 'ready'
//   2. agent runs `bun add <pkg>` → package.json changes → marker stale
//   3. buildForPublish calls installDepsIfNeeded → package.json hash mismatch
//      → phase set to 'installing' unconditionally
//   4. buildForPublish never resets phase → canvas sees 'installing' forever
//
// The fix: installDepsIfNeeded must not change `_phase` when `this.started`
// is already true (i.e. the preview is already serving).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pkg } from '@shogo/shared-runtime'
import { PreviewManager } from '../preview-manager'
import {
  _resetWorkspaceInstallMutex,
  computePackageJsonHash,
  writeInstallMarker,
  writeInstallPlatformMarker,
} from '../workspace-defaults'

const realInstallAsync = pkg.installAsync
let dir: string

beforeEach(() => {
  _resetWorkspaceInstallMutex()
  ;(pkg as any).installAsync = () => Promise.resolve()
  dir = mkdtempSync(join(tmpdir(), 'shogo-pm-publish-phase-'))
})

afterEach(() => {
  ;(pkg as any).installAsync = realInstallAsync
  _resetWorkspaceInstallMutex()
  rmSync(dir, { recursive: true, force: true })
})

describe('installDepsIfNeeded — phase guard when preview is already serving', () => {
  test('does not change _phase to installing when started=true (publish path)', async () => {
    // Set up a project with a valid marker so the first install is a no-op.
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { react: '^19.0.0' } }),
    )
    mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'react', 'package.json'), '{"name":"react"}')
    writeInstallPlatformMarker(dir)
    writeInstallMarker(dir, computePackageJsonHash(dir)!)

    const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 8080 })

    // Mark the preview as already started (simulates a live preview).
    ;(pm as any).started = true
    ;(pm as any)._phase = 'ready'

    // Simulate what `bun add` does: change package.json so the marker is stale.
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { react: '^19.0.0', 'qrcode.react': '^4.2.0' },
      }),
    )

    // Calling installDepsIfNeeded now should run the install (hash mismatch)
    // but must NOT flip _phase away from 'ready'.
    await (pm as any).installDepsIfNeeded({}, dir)

    expect((pm as any)._phase).toBe('ready')
  })

  test('does change _phase to installing when started=false (startup path)', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { react: '^19.0.0' } }),
    )
    // No node_modules, no marker → fresh install path.
    const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 8080 })
    ;(pm as any).started = false
    ;(pm as any)._phase = 'starting'

    let phaseWhileInstalling: string | null = null
    const realInstall = (pkg as any).installAsync
    ;(pkg as any).installAsync = async () => {
      phaseWhileInstalling = (pm as any)._phase
    }

    await (pm as any).installDepsIfNeeded({}, dir)
    ;(pkg as any).installAsync = realInstall

    expect(phaseWhileInstalling).toBe('installing')
  })
})
