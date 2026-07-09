// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression for "genuine cold-boot failure -> infinite loading preview"
// (audit Finding 2). When backgroundSetup() (deps install / prisma / build /
// API spawn) threw, start() only logged it: `_phase` stayed wedged at
// 'building'/'starting-api', `running` stayed false, and nothing surfaced the
// error — so the client spun on "loading preview" forever.
//
// The fix routes a background-setup failure to a terminal `phase='failed'`
// (with a reason in getStatus().errors.setup) so the UI can show a real error.
// A preview that already reached 'ready' (prebuilt dist serving) must NOT be
// demoted by a later background step blowing up.
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('@shogo/shared-runtime', () => ({
  pkg: {
    prismaGenerateAsync: async () => {},
    prismaDbPushAsync: async () => {},
  },
  resolveBinInvocation: () => null,
}))

import { PreviewManager } from '../preview-manager'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-fail-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function mk() {
  return new PreviewManager({
    workspaceDir: dir,
    runtimePort: 38351,
    publicUrl: 'https://preview.example/abc',
    localMode: false,
  }) as any
}

// A vite project (package.json present) with NO prebuilt dist -> cold build.
function coldProject() {
  const p = join(dir, 'project')
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'x' }))
  return p
}

// Stub the internal setup steps so start()/backgroundSetup runs without spawning
// anything real; the caller decides which step (if any) throws.
function stubInternals(m: any) {
  m.cleanupLegacyRuntimeLogs = () => {}
  m.clearRuntimeConsoleLog = () => {}
  m.resolveDevServer = () => 'vite'
  m.installDepsIfNeeded = async () => {}
  m.runPrismaIfNeeded = async () => {}
  m.startBuildWatch = async () => {}
  m.startApiServer = async () => {}
}

const flush = () => new Promise((r) => setTimeout(r, 25))

describe('PreviewManager cold-boot failure -> phase=failed', () => {
  it('marks phase=failed (not an infinite spinner) when a setup step throws', async () => {
    coldProject()
    const m = mk()
    stubInternals(m)
    m.installDepsIfNeeded = async () => {
      throw new Error('npm install exited 1')
    }

    await m.start()
    await flush() // backgroundSetup is fire-and-forget

    expect(m.phase).toBe('failed')
    const st = m.getStatus()
    expect(st.running).toBe(false)
    expect(st.phase).toBe('failed')
    expect(st.errors.setup).toContain('npm install exited 1')
  })

  it('surfaces a failure from a later step (build) too', async () => {
    coldProject()
    const m = mk()
    stubInternals(m)
    m.startBuildWatch = async () => {
      throw new Error('vite build failed')
    }

    await m.start()
    await flush()

    expect(m.phase).toBe('failed')
    expect(m.getStatus().errors.setup).toContain('vite build failed')
  })

  it('reaches phase=ready and running=true on a clean cold boot', async () => {
    coldProject()
    const m = mk()
    stubInternals(m)

    await m.start()
    await flush()

    expect(m.phase).toBe('ready')
    expect(m.getStatus().running).toBe(true)
    expect(m.getStatus().errors.setup).toBeNull()
  })

  it('does NOT demote an already-serving prebuilt dist to failed', async () => {
    const p = join(dir, 'project')
    mkdirSync(join(p, 'dist'), { recursive: true })
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'x' }))
    writeFileSync(join(p, 'dist', 'index.html'), '<html></html>')

    const m = mk()
    stubInternals(m)
    // A background step blows up AFTER the static dist is already serving.
    m.startApiServer = async () => {
      throw new Error('server.tsx crashed on boot')
    }

    await m.start()
    await flush()

    // The static preview keeps serving; the failure must not flip it to failed.
    expect(m.phase).toBe('ready')
    expect(m.getStatus().running).toBe(true)
  })

  it('markSetupFailed is a no-op once ready, terminal otherwise', () => {
    const m = mk()
    m._phase = 'building'
    m.markSetupFailed(new Error('boom'))
    expect(m.phase).toBe('failed')
    expect(m.getStatus().errors.setup).toBe('boom')

    // Already ready -> untouched.
    const m2 = mk()
    m2._phase = 'ready'
    m2.markSetupFailed(new Error('late boom'))
    expect(m2.phase).toBe('ready')
  })

  it('a fresh start() clears a prior failed marker', async () => {
    coldProject()
    const m = mk()
    stubInternals(m)
    m._phase = 'failed'
    m.lastSetupError = 'old failure'

    await m.start()
    await flush()

    expect(m.phase).toBe('ready')
    expect(m.getStatus().errors.setup).toBeNull()
  })
})
