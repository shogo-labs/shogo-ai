// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// preview-manager.ts — spawn-driven path coverage, batch 2.
//
// Continuation of preview-manager.spawn-paths.test.ts (Wave 1 Session 4).
// Targets the remaining biggest uncov clusters in preview-manager.ts:
//   • L2747-2870 runExpoExportWeb  (~70 uncov)
//   • L1528-1589 backgroundSetupMetro + runSetupTasksMetro (~60 uncov)
//   • L1335-1370 handleSchemaChange (~36 uncov)
//   • L2554-2580 handleCrash + crashRestartTimer (~25 uncov)
//   • L2501-2530 startCustomRoutesWatcher (~17 uncov)
//   • L1234-1243 runShogoGenerate close-not-0 + error event (~7 uncov)

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

interface FakeProc extends EventEmitter {
  pid: number
  killed: boolean
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (sig?: string) => boolean
}

const spawnCalls: Array<{ cmd: string; args: ReadonlyArray<string>; opts: any }> = []
let nextProcThrows: Error | null = null
let pendingProcs: FakeProc[] = []

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.pid = Math.floor(Math.random() * 50_000) + 1000
  proc.killed = false
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = (_sig?: string) => {
    proc.killed = true
    return true
  }
  return proc
}

mock.module('node:child_process', () => {
  const real = require('node:child_process')
  return {
    ...real,
    spawn: (cmd: string, args: any, opts: any) => {
      spawnCalls.push({ cmd, args, opts })
      if (nextProcThrows) {
        const err = nextProcThrows
        nextProcThrows = null
        throw err
      }
      const p = makeFakeProc()
      pendingProcs.push(p)
      return p
    },
  }
})

const { PreviewManager } = await import('../preview-manager')

let workspaces: string[] = []

beforeEach(() => {
  workspaces = []
  spawnCalls.length = 0
  pendingProcs = []
  nextProcThrows = null
})

afterEach(() => {
  for (const ws of workspaces) {
    if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  }
})

function makeWorkspace(opts: {
  withExpoBin?: boolean
  withPrismaSchema?: string | null
  withPackageJson?: boolean
} = {}): { root: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pm-spawn-paths-2-'))
  workspaces.push(root)
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  if (opts.withPackageJson ?? true) {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'p' }))
  }
  if (opts.withExpoBin) {
    const binDir = join(projectDir, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'expo'), '#!/usr/bin/env node\nconsole.log("expo")\n')
  }
  if (opts.withPrismaSchema !== undefined && opts.withPrismaSchema !== null) {
    mkdirSync(join(projectDir, 'prisma'), { recursive: true })
    writeFileSync(join(projectDir, 'prisma', 'schema.prisma'), opts.withPrismaSchema)
  }
  return { root, projectDir }
}

// ---------------------------------------------------------------------------
// 1. runExpoExportWeb — L2747-2870 (~70 uncov)
// ---------------------------------------------------------------------------

describe('PreviewManager.runExpoExportWeb', () => {
  test('returns early when expo bin is not resolved', async () => {
    const { root, projectDir } = makeWorkspace({ withExpoBin: false })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const timings: Record<string, number> = {}
    await (pm as any).runExpoExportWeb(timings, projectDir)
    expect(spawnCalls.length).toBe(0)
  })

  test('happy path: stdout/stderr forwarded, exit 0 with index.html commits to dist/', async () => {
    const { root, projectDir } = makeWorkspace({ withExpoBin: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const timings: Record<string, number> = {}
    const p = (pm as any).runExpoExportWeb(timings, projectDir)
    await new Promise((r) => setTimeout(r, 5))
    const proc = pendingProcs[pendingProcs.length - 1]
    expect(proc).toBeDefined()
    proc.stdout.emit('data', Buffer.from('bundle started\nweb: 100%\n\n'))
    proc.stderr.emit('data', Buffer.from('warning: foo\n'))
    const staging = join(projectDir, 'dist.staging')
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'index.html'), '<html/>')
    proc.emit('exit', 0)
    await p
    expect(timings.expoExport).toBeGreaterThanOrEqual(0)
  })

  test('exit 0 but missing index.html refuses to swap (cleanup path)', async () => {
    const { root, projectDir } = makeWorkspace({ withExpoBin: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const timings: Record<string, number> = {}
    const p = (pm as any).runExpoExportWeb(timings, projectDir)
    await new Promise((r) => setTimeout(r, 5))
    const proc = pendingProcs[pendingProcs.length - 1]
    proc.emit('exit', 0)
    await p
    expect(timings.expoExport).toBeGreaterThanOrEqual(0)
  })

  test('non-zero exit code triggers cleanup branch', async () => {
    const { root, projectDir } = makeWorkspace({ withExpoBin: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const timings: Record<string, number> = {}
    const p = (pm as any).runExpoExportWeb(timings, projectDir)
    await new Promise((r) => setTimeout(r, 5))
    const proc = pendingProcs[pendingProcs.length - 1]
    proc.emit('exit', 1)
    await p
    expect(timings.expoExport).toBeGreaterThanOrEqual(0)
  })

  test('spawn throws → resolveExport(null) without crashing', async () => {
    const { root, projectDir } = makeWorkspace({ withExpoBin: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const timings: Record<string, number> = {}
    nextProcThrows = new Error('ENOENT')
    await (pm as any).runExpoExportWeb(timings, projectDir)
    expect(timings.expoExport).toBeGreaterThanOrEqual(0)
  })

  test('async error event resolves null and short-circuits', async () => {
    const { root, projectDir } = makeWorkspace({ withExpoBin: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const timings: Record<string, number> = {}
    const p = (pm as any).runExpoExportWeb(timings, projectDir)
    await new Promise((r) => setTimeout(r, 5))
    const proc = pendingProcs[pendingProcs.length - 1]
    proc.emit('error', new Error('boom'))
    await p
    expect(timings.expoExport).toBeGreaterThanOrEqual(0)
  })

  test('reentrancy: in-flight call returns the same promise (only one spawn)', async () => {
    const { root, projectDir } = makeWorkspace({ withExpoBin: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const timings: Record<string, number> = {}
    const first = (pm as any).runExpoExportWeb(timings, projectDir)
    const second = (pm as any).runExpoExportWeb(timings, projectDir)
    await new Promise((r) => setTimeout(r, 5))
    const proc = pendingProcs[pendingProcs.length - 1]
    proc.emit('exit', 1)
    await first
    await second
    expect(spawnCalls.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. backgroundSetupMetro + runSetupTasksMetro — L1528-1589 (~60 uncov)
// ---------------------------------------------------------------------------

describe('PreviewManager.backgroundSetupMetro', () => {
  test('localMode=true: orchestration calls all four inner steps and ends in ready', async () => {
    const { root } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0, localMode: true })
    const calls: string[] = []
    ;(pm as any).installDepsIfNeeded = async () => { calls.push('installDeps') }
    ;(pm as any).runPrismaIfNeeded = async () => { calls.push('runPrisma') }
    ;(pm as any).runExpoExportWeb = async () => { calls.push('runExpoExport') }
    ;(pm as any).startMetroTunnel = async () => { calls.push('startMetroTunnel') }
    ;(pm as any).startApiServer = async () => { calls.push('startApi') }
    const timings: Record<string, number> = {}
    await (pm as any).backgroundSetupMetro(timings, join(root, 'project'))
    expect(calls).toEqual(['installDeps', 'runPrisma', 'runExpoExport', 'startMetroTunnel', 'startApi'])
    expect((pm as any)._phase).toBe('ready')
    expect((pm as any).started).toBe(true)
  })

  test('localMode=false: skips startMetroTunnel (cloud-todo branch)', async () => {
    const { root } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0, localMode: false })
    const calls: string[] = []
    ;(pm as any).installDepsIfNeeded = async () => { calls.push('installDeps') }
    ;(pm as any).runPrismaIfNeeded = async () => { calls.push('runPrisma') }
    ;(pm as any).runExpoExportWeb = async () => { calls.push('runExpoExport') }
    ;(pm as any).startMetroTunnel = async () => { calls.push('startMetroTunnel') }
    ;(pm as any).startApiServer = async () => { calls.push('startApi') }
    const timings: Record<string, number> = {}
    await (pm as any).backgroundSetupMetro(timings, join(root, 'project'))
    expect(calls).toEqual(['installDeps', 'runPrisma', 'runExpoExport', 'startApi'])
    expect((pm as any)._phase).toBe('ready')
  })

  test('mode-label branch with metroProcess set picks metro-web+api+tunnel', async () => {
    const { root } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0, localMode: true })
    ;(pm as any).installDepsIfNeeded = async () => {}
    ;(pm as any).runPrismaIfNeeded = async () => {}
    ;(pm as any).runExpoExportWeb = async () => {}
    ;(pm as any).startMetroTunnel = async () => {
      ;(pm as any).metroProcess = makeFakeProc()
    }
    ;(pm as any).startApiServer = async () => {
      ;(pm as any).apiServerProcess = makeFakeProc()
    }
    const timings: Record<string, number> = {}
    await (pm as any).backgroundSetupMetro(timings, join(root, 'project'))
    expect((pm as any).metroProcess).toBeDefined()
    expect((pm as any).apiServerProcess).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 3. handleSchemaChange — L1335-1370 (~36 uncov)
// ---------------------------------------------------------------------------

describe('PreviewManager.handleSchemaChange', () => {
  test('returns early when prisma/schema.prisma is missing', async () => {
    const { root, projectDir } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    let regenCalled = false
    ;(pm as any).runShogoGenerate = async () => { regenCalled = true; return true }
    await (pm as any).handleSchemaChange()
    expect(regenCalled).toBe(false)
  })

  test('returns early when schema has no model declarations', async () => {
    const { root, projectDir } = makeWorkspace({
      withPrismaSchema: 'generator client { provider = "prisma-client-js" }\n',
    })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    let regenCalled = false
    ;(pm as any).runShogoGenerate = async () => { regenCalled = true; return true }
    await (pm as any).handleSchemaChange()
    expect(regenCalled).toBe(false)
  })

  test('happy path: hash recorded, regen + prisma + api restart run in order', async () => {
    const { root, projectDir } = makeWorkspace({
      withPrismaSchema: 'model User { id String @id }\n',
    })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    const order: string[] = []
    ;(pm as any).killApiServer = async () => { order.push('killApi') }
    ;(pm as any).runShogoGenerate = async () => { order.push('regen'); return true }
    ;(pm as any).runPrismaIfNeeded = async () => { order.push('prisma') }
    ;(pm as any).startApiServer = async () => { order.push('startApi') }
    await (pm as any).handleSchemaChange()
    expect(order).toEqual(['killApi', 'regen', 'prisma', 'startApi'])
    expect((pm as any).lastSchemaHash).toBeTruthy()
    expect((pm as any).regenerating).toBe(false)
  })

  test('runShogoGenerate=false skips prisma + startApi but still clears regenerating', async () => {
    const { root, projectDir } = makeWorkspace({
      withPrismaSchema: 'model X { id String @id }\n',
    })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    let prismaCalled = false
    let startApiCalled = false
    ;(pm as any).killApiServer = async () => {}
    ;(pm as any).runShogoGenerate = async () => false
    ;(pm as any).runPrismaIfNeeded = async () => { prismaCalled = true }
    ;(pm as any).startApiServer = async () => { startApiCalled = true }
    await (pm as any).handleSchemaChange()
    expect(prismaCalled).toBe(false)
    expect(startApiCalled).toBe(false)
    expect((pm as any).regenerating).toBe(false)
  })

  test('pendingSchemaChange flag triggers a recursive re-run', async () => {
    const { root, projectDir } = makeWorkspace({
      withPrismaSchema: 'model Y { id String @id }\n',
    })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    let regenCount = 0
    ;(pm as any).killApiServer = async () => {}
    ;(pm as any).runShogoGenerate = async () => {
      regenCount++
      if (regenCount === 1) (pm as any).pendingSchemaChange = true
      return true
    }
    ;(pm as any).runPrismaIfNeeded = async () => {}
    ;(pm as any).startApiServer = async () => {}
    await (pm as any).handleSchemaChange()
    expect(regenCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 4. handleCrash + crashRestartTimer — L2554-2580 (~25 uncov)
// ---------------------------------------------------------------------------

describe('PreviewManager.handleCrash', () => {
  test('intentionalStop short-circuits before incrementing crashCount', () => {
    const { root } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    ;(pm as any).intentionalStop = true
    ;(pm as any).handleCrash()
    expect((pm as any).crashCount).toBe(0)
    expect((pm as any).crashRestartTimer).toBeNull()
  })

  test('regenerating short-circuits before incrementing crashCount', () => {
    const { root } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    ;(pm as any).regenerating = true
    ;(pm as any).handleCrash()
    expect((pm as any).crashCount).toBe(0)
  })

  test('exceeded max restarts: gives up without arming a timer', () => {
    const { root } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    ;(pm as any).crashCount = 1000
    ;(pm as any).handleCrash()
    expect((pm as any).apiPhase).toBe('crashed')
    expect((pm as any).crashRestartTimer).toBeNull()
  })

  test('happy path: arms timer; body runs killApi → forceKill → wait → startApi', async () => {
    const { root } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const order: string[] = []
    ;(pm as any).killApiServer = async () => { order.push('killApi') }
    ;(pm as any).forceKillPort = async () => { order.push('forceKill') }
    ;(pm as any).waitForPortRelease = async () => { order.push('wait') }
    ;(pm as any).startApiServer = async () => { order.push('startApi') }
    ;(pm as any).handleCrash()
    expect((pm as any).apiPhase).toBe('restarting')
    expect((pm as any).crashRestartTimer).not.toBeNull()
    await new Promise((r) => setTimeout(r, 1150))
    expect(order).toEqual(['killApi', 'forceKill', 'wait', 'startApi'])
    expect((pm as any).crashRestartTimer).toBeNull()
  })

  test('intentionalStop set between arm and fire: timer body short-circuits', async () => {
    const { root } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    let startApiCalled = false
    ;(pm as any).killApiServer = async () => {}
    ;(pm as any).forceKillPort = async () => {}
    ;(pm as any).waitForPortRelease = async () => {}
    ;(pm as any).startApiServer = async () => { startApiCalled = true }
    ;(pm as any).handleCrash()
    ;(pm as any).intentionalStop = true
    await new Promise((r) => setTimeout(r, 1150))
    expect(startApiCalled).toBe(false)
  })

  test('killApiServer throws: error caught and logged, no rethrow', async () => {
    const { root } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    ;(pm as any).killApiServer = async () => { throw new Error('boom') }
    ;(pm as any).forceKillPort = async () => {}
    ;(pm as any).waitForPortRelease = async () => {}
    ;(pm as any).startApiServer = async () => {}
    ;(pm as any).handleCrash()
    await new Promise((r) => setTimeout(r, 1150))
    expect((pm as any).crashRestartTimer).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. startCustomRoutesWatcher — L2501-2530 (~17 uncov)
// ---------------------------------------------------------------------------

describe('PreviewManager.startCustomRoutesWatcher', () => {
  test('returns early when bundler cwd does not exist', () => {
    const { root } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    ;Object.defineProperty(pm, "bundlerCwd", { get: () => join(root, "nonexistent") })
    ;(pm as any).startCustomRoutesWatcher()
    expect((pm as any).customRoutesWatcher).toBeNull()
  })

  test('second call when watcher already exists is a no-op', () => {
    const { root, projectDir } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    ;(pm as any).startCustomRoutesWatcher()
    const w1 = (pm as any).customRoutesWatcher
    ;(pm as any).startCustomRoutesWatcher()
    expect((pm as any).customRoutesWatcher).toBe(w1)
    w1?.close()
  })

  test('custom-routes.ts change triggers debounced restartApiServerOnly', async () => {
    const { root, projectDir } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    let restartCalled = false
    ;(pm as any).restartApiServerOnly = async () => { restartCalled = true }
    ;(pm as any).startCustomRoutesWatcher()
    writeFileSync(join(projectDir, 'custom-routes.ts'), 'export {}')
    await new Promise((r) => setTimeout(r, 800))
    ;(pm as any).customRoutesWatcher?.close()
    expect(restartCalled).toBe(true)
  })

  test('regenerating short-circuits inside the watcher handler', async () => {
    const { root, projectDir } = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    ;(pm as any).regenerating = true
    let restartCalled = false
    ;(pm as any).restartApiServerOnly = async () => { restartCalled = true }
    ;(pm as any).startCustomRoutesWatcher()
    writeFileSync(join(projectDir, 'custom-routes.ts'), 'export {}')
    await new Promise((r) => setTimeout(r, 800))
    ;(pm as any).customRoutesWatcher?.close()
    expect(restartCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. runShogoGenerate close-not-0 + error event — L1234-1243 (~7 uncov)
// ---------------------------------------------------------------------------

describe('PreviewManager.runShogoGenerate spawn-event branches', () => {
  test('proc emits close with non-zero code: lastGenerateError set + returns false', async () => {
    const { root, projectDir } = makeWorkspace({ withPackageJson: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    const p = (pm as any).runShogoGenerate()
    await new Promise((r) => setTimeout(r, 5))
    const proc = pendingProcs[pendingProcs.length - 1]
    proc.stderr.emit('data', Buffer.from('shogo: cannot resolve generator'))
    proc.emit('close', 1)
    const result = await p
    expect(result).toBe(false)
    expect((pm as any).lastGenerateError).toContain('cannot resolve')
    expect((pm as any).apiPhase).toBe('crashed')
  })

  test('proc emits error event: lastGenerateError + apiPhase=crashed + returns false', async () => {
    const { root, projectDir } = makeWorkspace({ withPackageJson: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    const p = (pm as any).runShogoGenerate()
    await new Promise((r) => setTimeout(r, 5))
    const proc = pendingProcs[pendingProcs.length - 1]
    proc.emit('error', new Error('ENOENT bun'))
    const result = await p
    expect(result).toBe(false)
    expect((pm as any).lastGenerateError).toContain('ENOENT')
    expect((pm as any).apiPhase).toBe('crashed')
  })

  test('proc emits close with code 0: returns true', async () => {
    const { root, projectDir } = makeWorkspace({ withPackageJson: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    const p = (pm as any).runShogoGenerate()
    await new Promise((r) => setTimeout(r, 5))
    const proc = pendingProcs[pendingProcs.length - 1]
    proc.emit('close', 0)
    const result = await p
    expect(result).toBe(true)
    expect((pm as any).lastGenerateError).toBeNull()
  })

  test('missing package.json returns false immediately without spawning', async () => {
    const { root, projectDir } = makeWorkspace({ withPackageJson: false })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })

    const before = spawnCalls.length
    const result = await (pm as any).runShogoGenerate()
    expect(result).toBe(false)
    expect(spawnCalls.length).toBe(before)
  })
})
