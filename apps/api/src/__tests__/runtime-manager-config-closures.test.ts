// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage for closures + small private branches in apps/api lib/runtime/manager.ts
// that the existing 8-file v4 suite doesn't reach:
//
//   - WorkerRuntimeManager config closures (L143-145 spawnCommand, L151-156 resolveBin)
//     incl. AGENT_RUNTIME_ENTRY env override and the existsSync->null branch
//   - private getProjectWorkspaceId (L971-983), success + prisma-throws branches
//   - stop() legacy-agentProcess fallback (L1832-1860) incl. timeout->SIGKILL escalation
//     AND the normal 'exit' event path
//   - stop() runtime.process branch (L1862-1875) incl. SIGKILL escalation + exit-event path
//   - startHealthCheck (L1973-1981) — drive the setInterval callback once

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

const capturedWorkerConfigs: Array<Record<string, unknown>> = []

mock.module('@shogo-ai/worker/runtime-manager', () => {
  class FakeWorkerRuntimeManager {
    config: Record<string, unknown>
    constructor(config: Record<string, unknown>) {
      this.config = config
      capturedWorkerConfigs.push(config)
    }
    async stop() {}
    async spawn() {}
    async restart() {}
    async getHealth() { return null }
    isManaged(_p: string) { return false }
  }
  return { WorkerRuntimeManager: FakeWorkerRuntimeManager }
})

mock.module('child_process', () => ({
  execSync: () => '',
  execFile: () => {},
  execFileSync: () => '',
  exec: () => {},
  spawn: () => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => true,
    killed: false,
    exitCode: null,
  }),
}))

const fakePrismaState: { workspaceId: string | null; throws: boolean } = {
  workspaceId: 'ws-real-123',
  throws: false,
}

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async () => {
        if (fakePrismaState.throws) throw new Error('boom')
        return { workspaceId: fakePrismaState.workspaceId }
      },
    },
  },
}))

const {
  RuntimeManager,
  __resetRuntimeManagerInternalsForTests,
} = await import('../lib/runtime/manager')

beforeEach(() => {
  capturedWorkerConfigs.length = 0
  __resetRuntimeManagerInternalsForTests()
  delete process.env.AGENT_RUNTIME_ENTRY
  fakePrismaState.workspaceId = 'ws-real-123'
  fakePrismaState.throws = false
})

afterEach(() => {
  delete process.env.AGENT_RUNTIME_ENTRY
  __resetRuntimeManagerInternalsForTests()
})

describe('WorkerRuntimeManager config closures (constructor wiring)', () => {
  test('spawnCommand returns { command: bun, args: [run, entry] }', () => {
    new RuntimeManager()
    expect(capturedWorkerConfigs).toHaveLength(1)
    const cfg = capturedWorkerConfigs[0] as {
      spawnCommand: (entry: string) => { command: string; args: string[] }
    }
    const result = cfg.spawnCommand('/tmp/foo.ts')
    expect(result.command).toMatch(/bun/)
    expect(result.args).toEqual(['run', '/tmp/foo.ts'])
  })

  test('resolveBin: AGENT_RUNTIME_ENTRY env override wins when file exists', () => {
    // Use the running interpreter as a known-existing file that's portable
    // across macOS and Linux (Linux's /proc/self/exe doesn't exist on macOS).
    process.env.AGENT_RUNTIME_ENTRY = process.execPath
    new RuntimeManager()
    const cfg = capturedWorkerConfigs[0] as {
      resolveBin: () => { path: string; source: string } | null
    }
    const result = cfg.resolveBin()
    expect(result).not.toBeNull()
    expect(result?.path).toBe(process.execPath)
    expect(result?.source).toBe('env')
  })

  test('resolveBin: returns null when neither env override nor RUNTIME_SERVER exist', () => {
    process.env.AGENT_RUNTIME_ENTRY = '/definitely/does/not/exist-xyzzy-' + Date.now()
    new RuntimeManager()
    const cfg = capturedWorkerConfigs[0] as {
      resolveBin: () => { path: string; source: string } | null
    }
    const result = cfg.resolveBin()
    expect(result).toBeNull()
  })

  test('idleMs defaults to the 45-min local reaper when SHOGO_LOCAL_MODE=true, undefined otherwise', () => {
    const prev = process.env.SHOGO_LOCAL_MODE
    const prevIdle = process.env.RUNTIME_LOCAL_IDLE_MS
    delete process.env.RUNTIME_LOCAL_IDLE_MS
    // Local mode no longer disables the idle reaper (idleMs: 0); it now runs
    // it on a 45-min default so runtimes don't accumulate forever. An explicit
    // RUNTIME_LOCAL_IDLE_MS override still wins.
    process.env.SHOGO_LOCAL_MODE = 'true'
    new RuntimeManager()
    expect(capturedWorkerConfigs[0]!.idleMs).toBe(45 * 60 * 1000)

    capturedWorkerConfigs.length = 0
    process.env.RUNTIME_LOCAL_IDLE_MS = '1234'
    new RuntimeManager()
    expect(capturedWorkerConfigs[0]!.idleMs).toBe(1234)
    delete process.env.RUNTIME_LOCAL_IDLE_MS

    capturedWorkerConfigs.length = 0
    process.env.SHOGO_LOCAL_MODE = 'false'
    new RuntimeManager()
    expect(capturedWorkerConfigs[0]!.idleMs).toBeUndefined()

    if (prev === undefined) delete process.env.SHOGO_LOCAL_MODE
    else process.env.SHOGO_LOCAL_MODE = prev
    if (prevIdle === undefined) delete process.env.RUNTIME_LOCAL_IDLE_MS
    else process.env.RUNTIME_LOCAL_IDLE_MS = prevIdle
  })
})

describe('RuntimeManager.getProjectWorkspaceId (private)', () => {
  test('returns prisma.project.workspaceId on success', async () => {
    fakePrismaState.workspaceId = 'ws-abc'
    const rm = new RuntimeManager() as unknown as {
      getProjectWorkspaceId: (id: string) => Promise<string | null>
    }
    expect(await rm.getProjectWorkspaceId('proj-1')).toBe('ws-abc')
  })

  test('returns null when prisma returns project with null workspaceId', async () => {
    fakePrismaState.workspaceId = null
    const rm = new RuntimeManager() as unknown as {
      getProjectWorkspaceId: (id: string) => Promise<string | null>
    }
    expect(await rm.getProjectWorkspaceId('proj-2')).toBeNull()
  })

  test('returns null when prisma throws', async () => {
    fakePrismaState.throws = true
    const rm = new RuntimeManager() as unknown as {
      getProjectWorkspaceId: (id: string) => Promise<string | null>
    }
    expect(await rm.getProjectWorkspaceId('proj-3')).toBeNull()
  })
})

describe('RuntimeManager.stop legacy fallback paths', () => {
  function fakeChild() {
    const ee = new EventEmitter() as EventEmitter & {
      kill: (sig: string) => boolean
      killed: boolean
    }
    ee.kill = (() => { ee.killed = true; return true }) as never
    ee.killed = false
    return ee
  }

  test('stop(): legacy agentProcess path — graceful exit before SIGKILL timer fires', async () => {
    const rm = new RuntimeManager()
    const child = fakeChild()
    ;(rm as unknown as { runtimes: Map<string, unknown> }).runtimes.set('proj-legacy', {
      status: 'running',
      port: 37100,
      agentProcess: child,
      process: null,
    })
    const stopPromise = rm.stop('proj-legacy')
    queueMicrotask(() => child.emit('exit'))
    await stopPromise
    expect(child.killed).toBe(true)
  })

  test('stop(): legacy agentProcess path — SIGKILL escalation when exit never fires', async () => {
    const rm = new RuntimeManager()
    const child = fakeChild()
    // Override kill so the killed flag stays false on SIGTERM
    let killCalls: string[] = []
    child.kill = ((sig: string) => {
      killCalls.push(sig)
      if (sig === 'SIGKILL') child.killed = true
      return true
    }) as never
    ;(rm as unknown as { runtimes: Map<string, unknown> }).runtimes.set('proj-stuck', {
      status: 'running',
      port: 37101,
      agentProcess: child,
      process: null,
    })
    // Override the 3000ms grace via vi-style monkey-patch on setTimeout
    const origSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void, _ms: number) =>
      origSetTimeout(cb, 5)) as never
    try {
      await rm.stop('proj-stuck')
    } finally {
      globalThis.setTimeout = origSetTimeout
    }
    expect(killCalls).toContain('SIGTERM')
    expect(killCalls).toContain('SIGKILL')
  })

  test('stop(): runtime.process path — graceful exit', async () => {
    const rm = new RuntimeManager()
    const proc = fakeChild()
    ;(rm as unknown as { runtimes: Map<string, unknown> }).runtimes.set('proj-proc', {
      status: 'running',
      port: 37102,
      agentProcess: null,
      process: proc,
    })
    const stopPromise = rm.stop('proj-proc')
    queueMicrotask(() => proc.emit('exit'))
    await stopPromise
    expect(proc.killed).toBe(true)
  })

  test('stop(): runtime.process path — SIGKILL escalation', async () => {
    const rm = new RuntimeManager()
    const proc = fakeChild()
    let killCalls: string[] = []
    proc.kill = ((sig: string) => {
      killCalls.push(sig)
      if (sig === 'SIGKILL') proc.killed = true
      return true
    }) as never
    ;(rm as unknown as { runtimes: Map<string, unknown> }).runtimes.set('proj-proc2', {
      status: 'running',
      port: 37103,
      agentProcess: null,
      process: proc,
    })
    const origSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void, _ms: number) =>
      origSetTimeout(cb, 5)) as never
    try {
      await rm.stop('proj-proc2')
    } finally {
      globalThis.setTimeout = origSetTimeout
    }
    expect(killCalls).toContain('SIGTERM')
    expect(killCalls).toContain('SIGKILL')
  })

  test('stop(): no-op when projectId not in runtimes map', async () => {
    const rm = new RuntimeManager()
    await rm.stop('never-started')
  })
})

describe('RuntimeManager.startHealthCheck (private) — timer callback', () => {
  test('drives getHealth from the interval, swallowing thrown errors', async () => {
    const rm = new RuntimeManager() as unknown as {
      startHealthCheck: (id: string) => void
      stopHealthCheck: (id: string) => void
      getHealth: (id: string) => Promise<unknown>
      config: { healthCheckInterval: number }
      healthCheckTimers: Map<string, NodeJS.Timeout>
    }
    let calls = 0
    rm.getHealth = async () => {
      calls += 1
      throw new Error('health probe failed')
    }
    rm.config.healthCheckInterval = 5
    rm.startHealthCheck('proj-hc')
    expect(rm.healthCheckTimers.has('proj-hc')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    rm.stopHealthCheck('proj-hc')
    expect(calls).toBeGreaterThanOrEqual(1)
  })
})
