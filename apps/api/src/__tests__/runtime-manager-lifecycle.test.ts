// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { RuntimeManager } from '../lib/runtime/manager'

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function fakeProcess() {
  const proc = {
    killed: false,
    exitCode: null as number | null,
    kill: mock((_signal?: string) => {
      proc.killed = true
      return true
    }),
    on: mock((event: string, cb: () => void) => {
      if (event === 'exit') queueMicrotask(cb)
      return proc
    }),
  }
  return proc
}

function managerWithRuntime(overrides: Record<string, unknown> = {}) {
  const rm = new RuntimeManager({ healthCheckInterval: 50 }) as unknown as RuntimeManager & {
    runtimes: Map<string, any>
    usedPorts: Set<number>
    healthCheckTimers: Map<string, NodeJS.Timeout>
    startHealthCheck: (projectId: string) => void
    stopHealthCheck: (projectId: string) => void
    toPublicRuntime: (runtime: any) => any
  }
  const runtime = {
    id: 'proj-1',
    port: 37123,
    agentPort: 38123,
    status: 'running',
    url: 'http://localhost:37123',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    process: fakeProcess(),
    agentProcess: fakeProcess(),
    lastHealthCheck: undefined,
    ...overrides,
  }
  rm.runtimes.set('proj-1', runtime)
  rm.usedPorts.add(runtime.port)
  return { rm, runtime }
}

describe('RuntimeManager lifecycle and health helpers', () => {
  test('status returns a public runtime copy and getActiveProjects filters running/starting only', () => {
    const { rm, runtime } = managerWithRuntime()
    rm.runtimes.set('stopped', { ...runtime, id: 'stopped', status: 'stopped' })
    rm.runtimes.set('starting', { ...runtime, id: 'starting', status: 'starting' })

    expect(rm.status('proj-1')).toMatchObject({
      id: 'proj-1',
      port: 37123,
      agentPort: 38123,
      status: 'running',
      url: 'http://localhost:37123',
    })
    expect(rm.status('missing')).toBeNull()
    expect(rm.getActiveProjects().sort()).toEqual(['proj-1', 'starting'])
  })

  test('getHealth reports missing runtimes and healthy Vite responses', async () => {
    const { rm } = managerWithRuntime()
    const missing = await rm.getHealth('missing')
    expect(missing.healthy).toBe(false)
    expect(missing.error).toContain('No runtime found')

    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      expect(String(input)).toBe('http://localhost:37123')
      expect(init?.method).toBe('HEAD')
      return new Response('', { status: 404 })
    }) as typeof fetch

    const health = await rm.getHealth('proj-1')
    expect(health.healthy).toBe(true)
    expect(rm.status('proj-1')?.lastHealthCheck?.healthy).toBe(true)
  })

  test('getHealth checks agent /health when Vite is not alive and records errors', async () => {
    const { rm, runtime } = managerWithRuntime()
    runtime.process.exitCode = 1
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      expect(String(input)).toBe('http://localhost:38123/health')
      expect(init?.method).toBe('GET')
      return new Response('ok', { status: 200 })
    }) as typeof fetch
    expect((await rm.getHealth('proj-1')).healthy).toBe(true)

    globalThis.fetch = (async () => { throw new Error('network down') }) as typeof fetch
    const failed = await rm.getHealth('proj-1')
    expect(failed.healthy).toBe(false)
    expect(failed.error).toBe('network down')
  })

  test('stop is idempotent, kills agent and Vite processes, releases ports, and deletes runtime', async () => {
    const { rm, runtime } = managerWithRuntime()

    await rm.stop('missing')
    await rm.stop('proj-1')

    expect(runtime.agentProcess.kill).toHaveBeenCalledWith('SIGTERM')
    expect(runtime.process.kill).toHaveBeenCalledWith('SIGTERM')
    expect(rm.status('proj-1')).toBeNull()
    expect(rm.usedPorts.has(37123)).toBe(false)
  })

  test('stopAll swallows individual stop failures and health-check timers can be started/stopped', async () => {
    const { rm } = managerWithRuntime()
    rm.runtimes.set('proj-2', {
      ...rm.runtimes.get('proj-1'),
      id: 'proj-2',
      port: 37124,
      process: null,
      agentProcess: null,
    })
    const originalStop = rm.stop.bind(rm)
    const stopMock = mock(async (projectId: string) => {
      if (projectId === 'proj-2') throw new Error('stop failed')
      return originalStop(projectId)
    })
    ;(rm as any).stop = stopMock

    await rm.stopAll()
    expect(stopMock).toHaveBeenCalled()

    rm.startHealthCheck('proj-1')
    expect(rm.healthCheckTimers.has('proj-1')).toBe(true)
    rm.stopHealthCheck('proj-1')
    expect(rm.healthCheckTimers.has('proj-1')).toBe(false)
  })
})
