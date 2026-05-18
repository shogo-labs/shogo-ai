// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `LocalHeartbeatScheduler` branch coverage:
 *
 *   - the `fetchDueAgents()` "missing table" silent no-op,
 *   - `triggerAgent()` runtime-not-running -> start path,
 *   - `triggerAgent()` start-failure path,
 *   - `triggerAgent()` no-port-after-start path,
 *   - `triggerAgent()` non-2xx upstream response path,
 *   - `getLocalHeartbeatScheduler()` singleton + `startLocalHeartbeatScheduler()`.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const prismaCalls: any = { findMany: [] as any[] }
const findManyResult = { value: [] as any[], throws: null as any }

mock.module('../lib/prisma', () =>
  withPrismaExports({
    prisma: {
      agentConfig: {
        findMany: async (args: any) => {
          prismaCalls.findMany.push(args)
          if (findManyResult.throws) throw findManyResult.throws
          return findManyResult.value
        },
      },
    },
  }),
)

mock.module('../lib/runtime-token', () => ({
  deriveRuntimeToken: (projectId: string) => `tok-${projectId}`,
}))

let LocalHeartbeatScheduler: any
let getLocalHeartbeatScheduler: any
let startLocalHeartbeatScheduler: any

beforeEach(async () => {
  prismaCalls.findMany = []
  findManyResult.value = []
  findManyResult.throws = null
  const mod = await import('../lib/local-heartbeat-scheduler')
  LocalHeartbeatScheduler = mod.LocalHeartbeatScheduler
  getLocalHeartbeatScheduler = mod.getLocalHeartbeatScheduler
  startLocalHeartbeatScheduler = mod.startLocalHeartbeatScheduler
})

afterEach(() => {
  delete (globalThis as any).fetch
})

describe('fetchDueAgents()', () => {
  test('forwards to prisma.agentConfig.findMany with the expected shape', async () => {
    findManyResult.value = [{ id: 'a', projectId: 'p' }]
    const s = new LocalHeartbeatScheduler()
    const out = await (s as any).fetchDueAgents()
    expect(out).toEqual([{ id: 'a', projectId: 'p' }])
    expect(prismaCalls.findMany).toHaveLength(1)
    expect(prismaCalls.findMany[0]).toMatchObject({
      where: { heartbeatEnabled: true },
    })
  })

  test('returns [] silently when the agent_configs table does not exist', async () => {
    findManyResult.throws = new Error('no such table: agent_configs')
    const logSpy = mock(() => {})
    const orig = console.log
    console.log = logSpy as any
    try {
      const s = new LocalHeartbeatScheduler()
      const out1 = await (s as any).fetchDueAgents()
      const out2 = await (s as any).fetchDueAgents()
      expect(out1).toEqual([])
      expect(out2).toEqual([])
      // Only one log for the "table not present yet" message.
      const matched = (logSpy.mock.calls as any[][]).filter((c) =>
        String(c[0]).includes('agent_configs table not present yet'),
      )
      expect(matched).toHaveLength(1)
    } finally {
      console.log = orig
    }
  })

  test('rethrows unrelated database errors', async () => {
    findManyResult.throws = new Error('connection refused')
    const s = new LocalHeartbeatScheduler()
    await expect((s as any).fetchDueAgents()).rejects.toThrow(/connection refused/)
  })
})

describe('triggerAgent()', () => {
  function makeRuntimeProvider(opts: {
    status?: any
    start?: any
    startThrows?: Error
  }) {
    return {
      status: () => opts.status ?? null,
      start: async () => {
        if (opts.startThrows) throw opts.startThrows
        return opts.start ?? null
      },
    }
  }

  test('happy path forwards a POST to the runtime with the runtime token', async () => {
    const fetched: any[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      fetched.push({ url: String(url), init })
      return new Response('ok', { status: 200 })
    }) as any
    const s = new LocalHeartbeatScheduler()
    await s.start(makeRuntimeProvider({ status: { agentPort: 4321 } }))
    s.stop()
    await (s as any).triggerAgent('proj-1')
    expect(fetched[0].url).toBe('http://localhost:4321/agent/heartbeat/trigger')
    expect(fetched[0].init.headers['x-runtime-token']).toBe('tok-proj-1')
    const stats = s.getStats()
    expect(stats.totalTriggered).toBe(1)
  })

  test('starts the runtime when none is already running', async () => {
    let started = false
    const provider = {
      status: () => null,
      start: async () => {
        started = true
        return { agentPort: 4444 }
      },
    }
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as any
    const s = new LocalHeartbeatScheduler()
    await s.start(provider)
    s.stop()
    await (s as any).triggerAgent('proj-x')
    expect(started).toBe(true)
  })

  test('returns early when start() throws', async () => {
    const provider = {
      status: () => null,
      start: async () => {
        throw new Error('boom')
      },
    }
    globalThis.fetch = (async () => {
      throw new Error('should not be called')
    }) as any
    const s = new LocalHeartbeatScheduler()
    await s.start(provider)
    s.stop()
    await (s as any).triggerAgent('p')
    expect(s.getStats().totalTriggered).toBe(0)
  })

  test('returns early when start() yields no agentPort', async () => {
    const provider = {
      status: () => null,
      start: async () => ({}),
    }
    globalThis.fetch = (async () => {
      throw new Error('should not be called')
    }) as any
    const s = new LocalHeartbeatScheduler()
    await s.start(provider)
    s.stop()
    await (s as any).triggerAgent('p')
    expect(s.getStats().totalTriggered).toBe(0)
  })

  test('records failure when runtime returns non-2xx', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 500 })) as any
    const s = new LocalHeartbeatScheduler()
    await s.start(makeRuntimeProvider({ status: { agentPort: 9 } }))
    s.stop()
    await (s as any).triggerAgent('proj-1')
    expect(s.getStats().totalFailed).toBe(1)
  })

  test('records failure when fetch throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network')
    }) as any
    const s = new LocalHeartbeatScheduler()
    await s.start(makeRuntimeProvider({ status: { agentPort: 9 } }))
    s.stop()
    await (s as any).triggerAgent('proj-1')
    expect(s.getStats().totalFailed).toBe(1)
  })
})

describe('singleton helpers', () => {
  test('getLocalHeartbeatScheduler returns the same instance', () => {
    const a = getLocalHeartbeatScheduler()
    const b = getLocalHeartbeatScheduler()
    expect(a).toBe(b)
  })

  test('startLocalHeartbeatScheduler returns the running singleton', async () => {
    const s = await startLocalHeartbeatScheduler()
    s.stop()
    expect(s).toBeInstanceOf(LocalHeartbeatScheduler)
  })
})
