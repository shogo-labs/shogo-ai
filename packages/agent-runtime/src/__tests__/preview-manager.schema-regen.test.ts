// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression for the "loading preview" wedge (2026-07 metal incident):
//
// The preview readiness probe the Cloudflare preview-router Worker polls keys
// off `getStatus().running`, which was `started && _phase === 'ready'`. When the
// agent edits prisma/schema.prisma mid-session, `handleSchemaChange()` (and the
// `sync()` tool) re-run `runPrismaIfNeeded`, which moves `_phase` to
// 'generating-prisma'/'pushing-db' — and NEITHER path restored `_phase='ready'`
// afterwards. So an already-serving project's `running` flipped to false and the
// preview stuck on "loading preview" forever (on metal the Worker gates on
// `running` before proxying to the box; on Knative Kourier hid the bug).
//
// These tests pin: (a) the phase is restored to 'ready' after an in-place regen,
// (b) `running` stays true throughout a regen of an already-ready project, and
// (c) `running` is still false during the FIRST cold build (never ready yet).
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let prismaGenerateImpl: (cwd: string) => Promise<void> = async () => {}
let prismaDbPushImpl: (cwd: string, opts: any) => Promise<void> = async () => {}

mock.module('@shogo/shared-runtime', () => ({
  pkg: {
    prismaGenerateAsync: (cwd: string) => prismaGenerateImpl(cwd),
    prismaDbPushAsync: (cwd: string, opts: any) => prismaDbPushImpl(cwd, opts),
  },
  resolveBinInvocation: (_cwd: string, _bin: string) => null,
}))

import { PreviewManager } from '../preview-manager'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-regen-'))
  prismaGenerateImpl = async () => {}
  prismaDbPushImpl = async () => {}
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function mk() {
  return new PreviewManager({
    workspaceDir: dir,
    runtimePort: 38306,
    publicUrl: 'https://preview.example/abc',
    localMode: false,
  }) as any
}

function projectWithSchema() {
  const p = join(dir, 'project')
  mkdirSync(join(p, 'prisma'), { recursive: true })
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'x' }))
  writeFileSync(
    join(p, 'prisma/schema.prisma'),
    'model User {\n  id Int @id @default(autoincrement())\n}\n',
  )
  return p
}

// An already-serving manager: started, phase=ready, everReady latched.
function servingManager() {
  const m = mk()
  m.started = true
  m._phase = 'ready'
  m.healSchemaHeader = () => {}
  m.healPrismaConfig = () => {}
  m.runShogoGenerate = async () => true
  m.startApiServer = async () => {}
  m.killApiServer = async () => {}
  m.startSchemaWatcher = () => {}
  // Latch everReady the way the real readiness poll does.
  expect(m.getStatus().running).toBe(true)
  return m
}

describe('PreviewManager readiness gate (running)', () => {
  it('is false during the first cold build (never reached ready)', () => {
    const m = mk()
    m.started = true
    m._phase = 'building'
    expect(m.getStatus().running).toBe(false)
  })

  it('stays true during an in-place regen once ready was reached', () => {
    const m = mk()
    m.started = true
    m._phase = 'ready'
    expect(m.getStatus().running).toBe(true) // latches everReady
    // Simulate the regen window: phase moved off ready, regenerating in flight.
    m._phase = 'pushing-db'
    m.regenerating = true
    expect(m.getStatus().running).toBe(true)
  })

  it('is false when wedged off ready WITHOUT an active regen (pre-fix state)', () => {
    const m = mk()
    m.started = true
    m._phase = 'ready'
    m.getStatus() // latch everReady
    m._phase = 'pushing-db'
    m.regenerating = false
    expect(m.getStatus().running).toBe(false)
  })
})

describe('PreviewManager.handleSchemaChange — phase restore', () => {
  it('restores phase=ready and keeps running true across the whole regen', async () => {
    projectWithSchema()
    const m = servingManager()

    let runningDuringPush: boolean | undefined
    let phaseDuringPush: string | undefined
    prismaDbPushImpl = async () => {
      phaseDuringPush = m.phase
      runningDuringPush = m.getStatus().running
    }

    await m.handleSchemaChange()

    // The regen genuinely moved through pushing-db...
    expect(phaseDuringPush).toBe('pushing-db')
    // ...but the preview never reported not-running (no "loading preview" flap)...
    expect(runningDuringPush).toBe(true)
    // ...and the phase is restored so the readiness probe passes afterwards.
    expect(m.phase).toBe('ready')
    expect(m.getStatus().running).toBe(true)
  })

  it('restores phase=ready even when regeneration fails (serves last-good dist)', async () => {
    projectWithSchema()
    const m = servingManager()
    m.runShogoGenerate = async () => false

    await m.handleSchemaChange()

    expect(m.phase).toBe('ready')
    expect(m.getStatus().running).toBe(true)
  })

  it('restores phase=ready even if db push throws', async () => {
    projectWithSchema()
    const m = servingManager()
    const err = mock(() => {}); console.error = err as any
    prismaDbPushImpl = async () => { throw new Error('db push boom') }

    await m.handleSchemaChange()

    expect(m.phase).toBe('ready')
    expect(m.getStatus().running).toBe(true)
  })
})

describe('PreviewManager.sync — phase restore', () => {
  it('restores phase=ready after a full regen cycle', async () => {
    projectWithSchema()
    const m = servingManager()

    const res = await m.sync()

    expect(m.phase).toBe('ready')
    expect(m.getStatus().running).toBe(true)
    expect(res.ok).toBeDefined()
  })

  it('re-arms the schema watcher and clears regenerating in the finally', async () => {
    projectWithSchema()
    const m = servingManager()
    let watcherStarted = 0
    m.startSchemaWatcher = () => { watcherStarted++ }

    await m.sync()

    expect(m.regenerating).toBe(false)
    expect(watcherStarted).toBe(1)
  })
})
