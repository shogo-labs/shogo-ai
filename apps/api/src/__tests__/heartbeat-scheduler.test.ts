// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/lib/heartbeat-scheduler.ts — the production
 * HeartbeatScheduler that subclasses BaseHeartbeatScheduler and
 * implements the K8s/Knative-specific fetchDueAgents + triggerAgent.
 *
 * Strategy:
 *  - Mock `./prisma` so fetchDueAgents can run the $queryRaw
 *  - Mock `./knative-project-manager.getProjectPodUrl`
 *  - Mock `./runtime-token.deriveRuntimeToken`
 *  - Mock `./warm-pool-self-heal.evictOnSingleMissingAuth`
 *  - Mock global fetch
 *  - Mock OTel meter so counters are observable (we assert on `.add`)
 *  - Subclass HeartbeatScheduler to expose protected methods for direct
 *    test calls
 */

import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// ─── OTel counters mock ───────────────────────────────────────────────────

const triggeredAdd = mock((_: number) => {})
const failedAdd = mock((_: number) => {})
const skippedAdd = mock((_: number) => {})

const createCounterMock = mock((name: string) => {
  if (name === 'heartbeat_scheduler.triggered') return { add: triggeredAdd }
  if (name === 'heartbeat_scheduler.failed') return { add: failedAdd }
  if (name === 'heartbeat_scheduler.skipped_quiet') return { add: skippedAdd }
  return { add: () => {} }
})

const startActiveSpanMock = mock(async (_name: string, fn: any) =>
  fn({ end: () => {}, recordException: () => {}, setStatus: () => {} }),
)

mock.module('@opentelemetry/api', () => ({
  trace: { getTracer: () => ({ startActiveSpan: startActiveSpanMock }) },
  metrics: { getMeter: () => ({ createCounter: createCounterMock }) },
}))

// ─── prisma mock ──────────────────────────────────────────────────────────

const queryRawMock = mock(async (..._args: any[]): Promise<any[]> => [])
mock.module('../lib/prisma', () => ({
  prisma: { $queryRaw: queryRawMock },
}))

// ─── knative + runtime-token + self-heal mocks (dynamic-import targets) ──

const getProjectPodUrlMock = mock(async (_: string) => 'http://pod.local:8000')
mock.module('../lib/knative-project-manager', () => ({
  getProjectPodUrl: getProjectPodUrlMock,
}))

const deriveRuntimeTokenMock = mock((projectId: string) => `rt_v1_${projectId}_TOKEN`)
mock.module('../lib/runtime-token', () => ({
  deriveRuntimeToken: deriveRuntimeTokenMock,
}))

const evictMock = mock(async (..._args: any[]) => {})
mock.module('../lib/warm-pool-self-heal', () => ({
  evictOnSingleMissingAuth: evictMock,
}))

// ─── fetch mock ───────────────────────────────────────────────────────────

const fetchMock = mock(async (_url: string, _init?: any) => ({
  ok: true,
  status: 200,
  text: async () => '',
}))
;(globalThis as any).fetch = fetchMock

// Load AFTER mocks
const mod = await import('../lib/heartbeat-scheduler')
const { HeartbeatScheduler, getHeartbeatScheduler } = mod

// Subclass exposes protected methods.
class TestableScheduler extends HeartbeatScheduler {
  public async _fetchDueAgents() {
    return (this as any).fetchDueAgents()
  }
  public async _triggerAgent(projectId: string) {
    return (this as any).triggerAgent(projectId)
  }
  public _onQuietHoursSkip(agent: any) {
    return (this as any).onQuietHoursSkip(agent)
  }
  public _onTriggerSuccess(projectId: string) {
    return (this as any).onTriggerSuccess(projectId)
  }
  public _onTriggerFailure(projectId: string, err?: unknown) {
    return (this as any).onTriggerFailure(projectId, err)
  }
  public _runTick() {
    return (this as any).runTick()
  }
  public _breaker() {
    return (this as any).breaker
  }
}

// ─── lifecycle ────────────────────────────────────────────────────────────

beforeEach(() => {
  queryRawMock.mockReset()
  queryRawMock.mockImplementation(async () => [])
  getProjectPodUrlMock.mockReset()
  getProjectPodUrlMock.mockImplementation(async () => 'http://pod.local:8000')
  deriveRuntimeTokenMock.mockReset()
  deriveRuntimeTokenMock.mockImplementation((pid: string) => `rt_v1_${pid}_TOKEN`)
  evictMock.mockReset()
  evictMock.mockImplementation(async () => {})
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => ({
    ok: true, status: 200, text: async () => '',
  }))
  triggeredAdd.mockReset()
  failedAdd.mockReset()
  skippedAdd.mockReset()
  startActiveSpanMock.mockReset()
  startActiveSpanMock.mockImplementation(async (_name: string, fn: any) =>
    fn({ end: () => {}, recordException: () => {}, setStatus: () => {} }),
  )
})

// ─── constructor ─────────────────────────────────────────────────────────

describe('HeartbeatScheduler constructor', () => {
  test('passes the documented config to BaseHeartbeatScheduler', () => {
    const s = new TestableScheduler() as any
    expect(s.config.logPrefix).toBe('HeartbeatScheduler')
    expect(typeof s.config.pollIntervalMs).toBe('number')
    expect(typeof s.config.batchSize).toBe('number')
    expect(typeof s.config.triggerTimeoutMs).toBe('number')
    // Defaults from the env-parsed module constants:
    expect(s.config.pollIntervalMs).toBeGreaterThan(0)
    expect(s.config.batchSize).toBeGreaterThan(0)
    expect(s.config.triggerTimeoutMs).toBeGreaterThan(0)
  })
})

// ─── fetchDueAgents (SQL contract) ───────────────────────────────────────

describe('fetchDueAgents — SQL contract', () => {
  test('issues a $queryRaw call against agent_configs JOIN projects JOIN subscriptions', async () => {
    queryRawMock.mockImplementation(async () => [])
    const s = new TestableScheduler()
    await s._fetchDueAgents()
    expect(queryRawMock).toHaveBeenCalledTimes(1)
    // The first arg of $queryRaw (tagged template) is a TemplateStringsArray
    // holding the SQL fragments. We join those and look for invariants.
    const fragments = queryRawMock.mock.calls[0][0] as unknown as string[]
    const sql = (Array.isArray(fragments) ? fragments.join(' ') : String(fragments)).toLowerCase()
    expect(sql).toContain('agent_configs')
    expect(sql).toContain('projects')
    expect(sql).toContain('subscriptions')
    expect(sql).toContain('heartbeatenabled')
    expect(sql).toContain('nextheartbeatat')
  })

  test("SQL contains 'FOR UPDATE OF ac SKIP LOCKED' (concurrent-pod safety pin)", async () => {
    const s = new TestableScheduler()
    await s._fetchDueAgents()
    const fragments = queryRawMock.mock.calls[0][0] as unknown as string[]
    const sql = (Array.isArray(fragments) ? fragments.join(' ') : String(fragments)).toLowerCase()
    expect(sql).toContain('for update of ac skip locked')
  })

  test("SQL filters subscription status to 'active' OR 'trialing'", async () => {
    const s = new TestableScheduler()
    await s._fetchDueAgents()
    const fragments = queryRawMock.mock.calls[0][0] as unknown as string[]
    const sql = (Array.isArray(fragments) ? fragments.join(' ') : String(fragments)).toLowerCase()
    expect(sql).toContain('active')
    expect(sql).toContain('trialing')
  })

  test('ORDER BY nextHeartbeatAt ASC (fairness pin)', async () => {
    const s = new TestableScheduler()
    await s._fetchDueAgents()
    const fragments = queryRawMock.mock.calls[0][0] as unknown as string[]
    const sql = (Array.isArray(fragments) ? fragments.join(' ') : String(fragments)).toLowerCase()
    expect(sql).toMatch(/order by .*nextheartbeatat.* asc/)
  })

  test('forwards the result of $queryRaw verbatim', async () => {
    const rows = [
      { id: 'cfg-1', projectId: 'p1', heartbeatInterval: 60 },
      { id: 'cfg-2', projectId: 'p2', heartbeatInterval: 120 },
    ]
    queryRawMock.mockImplementation(async () => rows)
    const s = new TestableScheduler()
    const out = await s._fetchDueAgents()
    expect(out).toEqual(rows)
  })

  test('propagates DB errors (caller decides retry / circuit-break)', async () => {
    queryRawMock.mockImplementation(async () => {
      throw new Error('connection lost')
    })
    const s = new TestableScheduler()
    await expect(s._fetchDueAgents()).rejects.toThrow('connection lost')
  })
})

// ─── triggerAgent — happy path ──────────────────────────────────────────

describe('triggerAgent — happy path', () => {
  test('POSTs to <podUrl>/agent/heartbeat/trigger with the runtime token header', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, text: async () => '',
    }))
    const s = new TestableScheduler()
    await s._triggerAgent('proj-X')

    expect(getProjectPodUrlMock).toHaveBeenCalledWith('proj-X')
    expect(deriveRuntimeTokenMock).toHaveBeenCalledWith('proj-X')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://pod.local:8000/agent/heartbeat/trigger')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers['x-runtime-token']).toBe('rt_v1_proj-X_TOKEN')
    expect(init.signal).toBeDefined() // AbortSignal.timeout
  })

  test('happy path clears the circuit-breaker failure record and increments triggered counter', async () => {
    const s = new TestableScheduler()
    const breaker = s._breaker()
    const clearSpy = spyOn(breaker, 'clearFailure')
    await s._triggerAgent('proj-1')
    expect(clearSpy).toHaveBeenCalledWith('proj-1')
    expect(triggeredAdd).toHaveBeenCalledWith(1)
    expect(failedAdd).not.toHaveBeenCalled()
    expect(evictMock).not.toHaveBeenCalled()
  })

  test('happy path logs a "Triggered heartbeat for <projectId>" line', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const s = new TestableScheduler()
      await s._triggerAgent('proj-log')
      const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(out).toContain('[HeartbeatScheduler] Triggered heartbeat for proj-log')
    } finally {
      logSpy.mockRestore()
    }
  })
})

// ─── triggerAgent — failure paths ────────────────────────────────────────

describe('triggerAgent — non-2xx response', () => {
  test('records breaker failure + increments failed counter + invokes evictOnSingleMissingAuth', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 401,
      text: async () => 'missing-auth-token',
    }))
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = new TestableScheduler()
      const breaker = s._breaker()
      const recordSpy = spyOn(breaker, 'recordFailure')

      await s._triggerAgent('proj-401')

      expect(recordSpy).toHaveBeenCalledWith('proj-401')
      expect(failedAdd).toHaveBeenCalledWith(1)
      expect(evictMock).toHaveBeenCalledWith('proj-401', 401, 'missing-auth-token')
      expect(triggeredAdd).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  test('catch handler does NOT rethrow (heartbeat tick must stay alive across one bad pod)', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false, status: 500, text: async () => 'oops',
    }))
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = new TestableScheduler()
      await expect(s._triggerAgent('proj-500')).resolves.toBeUndefined()
    } finally {
      errSpy.mockRestore()
    }
  })

  test('non-2xx body that fails to .text() is reported as "unknown"', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('body stream broken')
      },
    }))
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = new TestableScheduler()
      await s._triggerAgent('proj-broken-body')
      expect(evictMock).toHaveBeenCalledWith('proj-broken-body', 500, 'unknown')
      const out = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(out).toContain('HTTP 500: unknown')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('logs "Failed to trigger <projectId>" with the error message', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false, status: 503, text: async () => 'service unavailable',
    }))
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = new TestableScheduler()
      await s._triggerAgent('proj-503')
      const out = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(out).toContain('[HeartbeatScheduler] Failed to trigger proj-503')
      expect(out).toContain('HTTP 503')
      expect(out).toContain('service unavailable')
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('triggerAgent — thrown errors', () => {
  test('getProjectPodUrl throwing → failure path runs, no fetch, no evict', async () => {
    getProjectPodUrlMock.mockImplementation(async () => {
      throw new Error('pod resolution failed')
    })
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = new TestableScheduler()
      await s._triggerAgent('proj-pod-err')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(failedAdd).toHaveBeenCalledWith(1)
      expect(evictMock).not.toHaveBeenCalled() // never reached the HTTP step
    } finally {
      errSpy.mockRestore()
    }
  })

  test('fetch throwing (e.g. AbortSignal timeout) → failure path runs', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('timed out')
    })
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = new TestableScheduler()
      const breaker = s._breaker()
      const recordSpy = spyOn(breaker, 'recordFailure')
      await s._triggerAgent('proj-fetch-err')
      expect(recordSpy).toHaveBeenCalledWith('proj-fetch-err')
      expect(failedAdd).toHaveBeenCalledWith(1)
      expect(evictMock).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  test('deriveRuntimeToken throwing → failure path runs, no fetch', async () => {
    deriveRuntimeTokenMock.mockImplementation(() => {
      throw new Error('no signing key')
    })
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = new TestableScheduler()
      await s._triggerAgent('proj-token-err')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(failedAdd).toHaveBeenCalledWith(1)
    } finally {
      errSpy.mockRestore()
    }
  })
})

// ─── counter overrides ──────────────────────────────────────────────────

describe('counter overrides', () => {
  test('onQuietHoursSkip increments the skipped_quiet counter', () => {
    const s = new TestableScheduler()
    s._onQuietHoursSkip({ projectId: 'p1' } as any)
    expect(skippedAdd).toHaveBeenCalledWith(1)
  })

  test('onTriggerSuccess increments the triggered counter (and calls super first)', () => {
    const s = new TestableScheduler() as any
    const beforeTotal = s.totalTriggered ?? 0
    s._onTriggerSuccess('p1')
    expect(s.totalTriggered).toBe(beforeTotal + 1) // super.onTriggerSuccess()
    expect(triggeredAdd).toHaveBeenCalledWith(1)
  })

  test('onTriggerFailure increments the failed counter (and calls super first)', () => {
    const s = new TestableScheduler() as any
    const beforeTotal = s.totalFailed ?? 0
    s._onTriggerFailure('p1', new Error('x'))
    expect(s.totalFailed).toBe(beforeTotal + 1)
    expect(failedAdd).toHaveBeenCalledWith(1)
  })
})

// ─── runTick ─────────────────────────────────────────────────────────────

describe('runTick — OTel span wrap', () => {
  test('wraps the batch in an OTel span named "heartbeat_scheduler.tick"', async () => {
    const s = new TestableScheduler()
    await s._runTick()
    expect(startActiveSpanMock).toHaveBeenCalledTimes(1)
    expect(startActiveSpanMock.mock.calls[0][0]).toBe('heartbeat_scheduler.tick')
  })

  test('span.end() runs even when the batch throws (finally pin)', async () => {
    const endSpy = mock(() => {})
    startActiveSpanMock.mockImplementation(async (_name: string, fn: any) => {
      const span = { end: endSpy, recordException: () => {}, setStatus: () => {} }
      try {
        return await fn(span)
      } catch (err) {
        // bubble — test expects it
        throw err
      }
    })
    const s = new TestableScheduler() as any
    // Force processBatch to throw by making fetchDueAgents reject.
    queryRawMock.mockImplementation(async () => {
      throw new Error('db dropped')
    })
    await expect(s._runTick()).rejects.toThrow('db dropped')
    expect(endSpy).toHaveBeenCalledTimes(1)
  })
})

// ─── singleton ───────────────────────────────────────────────────────────

describe('getHeartbeatScheduler singleton', () => {
  test('returns the same instance across repeated calls', () => {
    const a = getHeartbeatScheduler()
    const b = getHeartbeatScheduler()
    expect(a).toBe(b)
    expect(a).toBeInstanceOf(HeartbeatScheduler)
  })
})
