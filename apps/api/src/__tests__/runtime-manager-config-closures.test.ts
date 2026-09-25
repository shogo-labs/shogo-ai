// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage for closures + small private branches in apps/api lib/runtime/manager.ts
// that the existing 8-file v4 suite doesn't reach:
//
//   - WorkerRuntimeManager config closures (L143-145 spawnCommand, L151-156 resolveBin)
//     incl. AGENT_RUNTIME_ENTRY env override and the existsSync->null branch
//   - private getProjectWorkspaceId (L971-983), success + prisma-throws branches
//   - startHealthCheck (L1973-1981) — drive the setInterval callback once

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

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
  test('spawnCommand runs the source entry with the development condition', () => {
    new RuntimeManager()
    expect(capturedWorkerConfigs).toHaveLength(1)
    const cfg = capturedWorkerConfigs[0] as {
      spawnCommand: (entry: string) => { command: string; args: string[] }
    }
    const result = cfg.spawnCommand('/tmp/foo.ts')
    expect(result.command).toMatch(/bun/)
    expect(result.args).toEqual(['--conditions=development', 'run', '/tmp/foo.ts'])
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
