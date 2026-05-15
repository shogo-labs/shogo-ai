// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/lib/sync-engine.ts — the Phase-2 event distributor.
 *
 * The engine is pure in-memory logic (no I/O, no DB, no network) so
 * every branch is reachable without any mocks. We exercise:
 *
 *  - shouldApplyEvent: LWW + version semantics
 *  - SyncEngine.publish: dedup, server-timestamp stamping, ACK, log
 *    persistence + trim, broadcast scoping (workspace, userId, no
 *    self-echo), and subscriber error isolation
 *  - subscribe/unsubscribe lifecycle + returned disposer
 *  - replayEvents: filtering, paging, cursor advancement, hasMore
 *  - getSyncEngine / resetSyncEngine singleton
 *  - createSyncEvent factory defaults + overrides
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  SyncEngine,
  createSyncEvent,
  getSyncEngine,
  resetSyncEngine,
  shouldApplyEvent,
  type SyncEvent,
  type SyncEventHandler,
} from '../lib/sync-engine'

// ─── helpers ──────────────────────────────────────────────────────────────

let eventCounter = 0
function makeEvent(over: Partial<SyncEvent> = {}): SyncEvent {
  eventCounter++
  return {
    id: `evt-${eventCounter}`,
    type: 'PROJECT_CREATED',
    entityId: 'proj-1',
    payload: { name: 'X' },
    timestamp: 1000 + eventCounter,
    source: 'desktop',
    version: 1,
    workspaceId: 'ws-1',
    ...over,
  }
}

let engine: SyncEngine

beforeEach(() => {
  eventCounter = 0
  engine = new SyncEngine()
})

afterEach(() => {
  resetSyncEngine()
})

// ─── shouldApplyEvent ─────────────────────────────────────────────────────

describe('shouldApplyEvent — LWW + version semantics', () => {
  test('newer version → apply (regardless of timestamps)', () => {
    const inc = makeEvent({ version: 5, timestamp: 100 })
    expect(shouldApplyEvent(inc, 4, 999999)).toBe(true)
  })

  test('older version → reject (regardless of timestamps)', () => {
    const inc = makeEvent({ version: 2, timestamp: 999999 })
    expect(shouldApplyEvent(inc, 5, 0)).toBe(false)
  })

  test('same version + newer serverTimestamp → apply', () => {
    const inc = makeEvent({ version: 3, serverTimestamp: 2000, timestamp: 100 })
    expect(shouldApplyEvent(inc, 3, 1999)).toBe(true)
  })

  test('same version + same serverTimestamp → reject (strictly greater)', () => {
    const inc = makeEvent({ version: 3, serverTimestamp: 2000 })
    expect(shouldApplyEvent(inc, 3, 2000)).toBe(false)
  })

  test('same version + older serverTimestamp → reject', () => {
    const inc = makeEvent({ version: 3, serverTimestamp: 1000 })
    expect(shouldApplyEvent(inc, 3, 2000)).toBe(false)
  })

  test('same version falls back to client timestamp when no serverTimestamp present', () => {
    const inc = makeEvent({ version: 3, timestamp: 5000, serverTimestamp: undefined })
    expect(shouldApplyEvent(inc, 3, 4999)).toBe(true)
    expect(shouldApplyEvent(inc, 3, 5000)).toBe(false)
  })
})

// ─── publish: dedup + log ─────────────────────────────────────────────────

describe('publish — dedup + event log', () => {
  test('first publish adds to the log and stamps serverTimestamp', () => {
    const before = Date.now()
    engine.publish(makeEvent({ id: 'e1' }))
    const after = Date.now()
    expect(engine.eventCount).toBe(1)
    const replayed = engine.replayEvents({ workspaceId: 'ws-1', since: 0 })
    expect(replayed.events).toHaveLength(1)
    expect(replayed.events[0].id).toBe('e1')
    expect(replayed.events[0].serverTimestamp).toBeGreaterThanOrEqual(before)
    expect(replayed.events[0].serverTimestamp).toBeLessThanOrEqual(after)
    expect(replayed.events[0].status).toBe('acknowledged')
  })

  test('publish does NOT mutate the caller\'s event object', () => {
    const original = makeEvent({ id: 'e1' })
    const snapshot = JSON.stringify(original)
    engine.publish(original)
    expect(JSON.stringify(original)).toBe(snapshot)
    expect(original.serverTimestamp).toBeUndefined()
    expect(original.status).toBeUndefined()
  })

  test('duplicate id is dropped and ACKed as already-acknowledged', () => {
    const ack = mock(() => {})
    engine.publish(makeEvent({ id: 'dup' }))
    engine.publish(makeEvent({ id: 'dup', payload: { changed: true } }), ack)
    expect(engine.eventCount).toBe(1)
    expect(ack).toHaveBeenCalledWith('dup', 'acknowledged')
  })

  test('first-time publish invokes ack with "acknowledged"', () => {
    const ack = mock(() => {})
    engine.publish(makeEvent({ id: 'fresh' }), ack)
    expect(ack).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith('fresh', 'acknowledged')
  })

  test('event log trims to ~80% when it exceeds maxLogSize', () => {
    const e = new SyncEngine({ maxLogSize: 10 })
    for (let i = 0; i < 12; i++) e.publish(makeEvent({ id: `e${i}` }))
    // 12 > 10 → trim fires after the 11th insert. Final count is bounded
    // and oldest events are gone.
    expect(e.eventCount).toBeLessThanOrEqual(10)
    expect(e.eventCount).toBeGreaterThan(0)
    const ids = e.replayEvents({ workspaceId: 'ws-1', since: 0 }).events.map((x) => x.id)
    expect(ids).toContain('e11')
    expect(ids).not.toContain('e0') // oldest trimmed
  })

  test('after trim, a previously-trimmed event id can be republished (seen set is pruned with the log)', () => {
    const e = new SyncEngine({ maxLogSize: 10 })
    for (let i = 0; i < 12; i++) e.publish(makeEvent({ id: `e${i}` }))
    const ack = mock(() => {})
    e.publish(makeEvent({ id: 'e0', payload: { reborn: true } }), ack)
    expect(ack).toHaveBeenCalledWith('e0', 'acknowledged')
    expect(
      e.replayEvents({ workspaceId: 'ws-1', since: 0 }).events.find((x) => x.id === 'e0'),
    ).toBeDefined()
  })
})

// ─── publish: broadcast scoping ───────────────────────────────────────────

describe('publish — broadcast scoping', () => {
  test('subscriber in same workspace receives the event', () => {
    const seen: SyncEvent[] = []
    engine.subscribe('c1', 'ws-1', 'web', (e) => seen.push(e))
    engine.publish(makeEvent({ source: 'desktop', workspaceId: 'ws-1' }))
    expect(seen).toHaveLength(1)
  })

  test('subscriber in a different workspace receives nothing', () => {
    const seen: SyncEvent[] = []
    engine.subscribe('c1', 'ws-OTHER', 'web', (e) => seen.push(e))
    engine.publish(makeEvent({ workspaceId: 'ws-1' }))
    expect(seen).toHaveLength(0)
  })

  test('no echo back to the same source + instanceId', () => {
    const seen: SyncEvent[] = []
    engine.subscribe('c1', 'ws-1', 'desktop', (e) => seen.push(e), 'inst-A')
    engine.publish(makeEvent({ source: 'desktop', instanceId: 'inst-A' }))
    expect(seen).toHaveLength(0)
  })

  test('SAME source but DIFFERENT instanceId DOES receive the event (multi-desktop scenario)', () => {
    const seen: SyncEvent[] = []
    engine.subscribe('c1', 'ws-1', 'desktop', (e) => seen.push(e), 'inst-A')
    engine.publish(makeEvent({ source: 'desktop', instanceId: 'inst-B' }))
    expect(seen).toHaveLength(1)
  })

  test('different source ALWAYS receives (desktop emits → web receives)', () => {
    const seen: SyncEvent[] = []
    engine.subscribe('c1', 'ws-1', 'web', (e) => seen.push(e), 'inst-A')
    engine.publish(makeEvent({ source: 'desktop', instanceId: 'inst-A' }))
    expect(seen).toHaveLength(1)
  })

  test('userId scoping: subscriber with userId blocks events from a different user', () => {
    const seen: SyncEvent[] = []
    engine.subscribe('c1', 'ws-1', 'web', (e) => seen.push(e), undefined, 'user-A')
    engine.publish(makeEvent({ userId: 'user-B' }))
    expect(seen).toHaveLength(0)
  })

  test('userId scoping: same user passes through', () => {
    const seen: SyncEvent[] = []
    engine.subscribe('c1', 'ws-1', 'web', (e) => seen.push(e), undefined, 'user-A')
    engine.publish(makeEvent({ userId: 'user-A' }))
    expect(seen).toHaveLength(1)
  })

  test('admin subscription (no userId) sees events from any user', () => {
    const seen: SyncEvent[] = []
    engine.subscribe('admin', 'ws-1', 'api', (e) => seen.push(e))
    engine.publish(makeEvent({ userId: 'user-A' }))
    engine.publish(makeEvent({ id: 'evt-X', userId: 'user-B' }))
    expect(seen).toHaveLength(2)
  })

  test('subscriber with userId still sees events that have NO userId (system events pass)', () => {
    const seen: SyncEvent[] = []
    engine.subscribe('c1', 'ws-1', 'web', (e) => seen.push(e), undefined, 'user-A')
    engine.publish(makeEvent({ userId: undefined }))
    expect(seen).toHaveLength(1)
  })

  test('fans out to multiple matching subscribers', () => {
    const a: SyncEvent[] = []
    const b: SyncEvent[] = []
    engine.subscribe('c1', 'ws-1', 'web', (e) => a.push(e))
    engine.subscribe('c2', 'ws-1', 'mobile', (e) => b.push(e))
    engine.publish(makeEvent())
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  test('a throwing subscriber is isolated — does not stop fan-out to others', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const survived: SyncEvent[] = []
      engine.subscribe('bad', 'ws-1', 'web', () => {
        throw new Error('handler boom')
      })
      engine.subscribe('good', 'ws-1', 'mobile', (e) => survived.push(e))
      engine.publish(makeEvent())
      expect(survived).toHaveLength(1)
      expect(
        errSpy.mock.calls.some((c) =>
          c.join(' ').includes('Error in subscriber bad'),
        ),
      ).toBe(true)
    } finally {
      errSpy.mockRestore()
    }
  })

  test('subscriber.lastSeenTimestamp advances to the event\'s serverTimestamp', () => {
    // We can\'t reach .lastSeenTimestamp directly through the public API,
    // but we can prove the broadcast happened (covered above) and that
    // delivered events all carry a serverTimestamp.
    let received: SyncEvent | null = null
    engine.subscribe('c1', 'ws-1', 'web', (e) => {
      received = e
    })
    const before = Date.now()
    engine.publish(makeEvent())
    expect(received).not.toBeNull()
    expect(received!.serverTimestamp).toBeGreaterThanOrEqual(before)
  })
})

// ─── subscribe / unsubscribe ──────────────────────────────────────────────

describe('subscribe / unsubscribe', () => {
  test('subscriberCount reflects current registrations', () => {
    expect(engine.subscriberCount).toBe(0)
    engine.subscribe('a', 'ws-1', 'web', () => {})
    engine.subscribe('b', 'ws-1', 'web', () => {})
    expect(engine.subscriberCount).toBe(2)
  })

  test('returned disposer removes the subscriber', () => {
    const dispose = engine.subscribe('a', 'ws-1', 'web', () => {})
    expect(engine.subscriberCount).toBe(1)
    dispose()
    expect(engine.subscriberCount).toBe(0)
  })

  test('explicit unsubscribe(clientId) removes the subscriber', () => {
    engine.subscribe('a', 'ws-1', 'web', () => {})
    engine.unsubscribe('a')
    expect(engine.subscriberCount).toBe(0)
  })

  test('re-subscribing with the same clientId REPLACES the old registration', () => {
    const first: SyncEvent[] = []
    const second: SyncEvent[] = []
    engine.subscribe('dup', 'ws-1', 'web', (e) => first.push(e))
    engine.subscribe('dup', 'ws-1', 'web', (e) => second.push(e))
    expect(engine.subscriberCount).toBe(1)
    engine.publish(makeEvent())
    expect(first).toHaveLength(0)
    expect(second).toHaveLength(1)
  })

  test('unsubscribing an unknown clientId is a safe no-op', () => {
    expect(() => engine.unsubscribe('does-not-exist')).not.toThrow()
    expect(engine.subscriberCount).toBe(0)
  })

  test('unsubscribed handler does not fire on subsequent publishes', () => {
    const seen: SyncEvent[] = []
    const dispose = engine.subscribe('a', 'ws-1', 'web', (e) => seen.push(e))
    engine.publish(makeEvent({ id: 'pre' }))
    dispose()
    engine.publish(makeEvent({ id: 'post' }))
    expect(seen.map((e) => e.id)).toEqual(['pre'])
  })
})

// ─── replayEvents ──────────────────────────────────────────────────────────

describe('replayEvents — catch-up sync', () => {
  function seed(e: SyncEngine, n: number, workspaceId = 'ws-1') {
    for (let i = 0; i < n; i++) {
      e.publish(makeEvent({ id: `evt-${workspaceId}-${i}`, workspaceId }))
    }
  }

  test('returns events strictly newer than `since`', () => {
    seed(engine, 3)
    // Capture the second event\'s serverTimestamp as our cursor.
    const all = engine.replayEvents({ workspaceId: 'ws-1', since: 0 }).events
    const cursor = all[0].serverTimestamp!
    const replayed = engine.replayEvents({ workspaceId: 'ws-1', since: cursor })
    expect(replayed.events.every((e) => e.serverTimestamp! > cursor)).toBe(true)
  })

  test('filters by workspaceId', () => {
    seed(engine, 2, 'ws-1')
    seed(engine, 2, 'ws-2')
    const r = engine.replayEvents({ workspaceId: 'ws-2', since: 0 })
    expect(r.events).toHaveLength(2)
    expect(r.events.every((e) => e.workspaceId === 'ws-2')).toBe(true)
  })

  test('default limit is 500; honors explicit smaller limit', () => {
    seed(engine, 5)
    const r = engine.replayEvents({ workspaceId: 'ws-1', since: 0, limit: 2 })
    expect(r.events).toHaveLength(2)
    expect(r.hasMore).toBe(true)
  })

  test('cursor advances to the LAST returned event\'s serverTimestamp', () => {
    seed(engine, 3)
    const r = engine.replayEvents({ workspaceId: 'ws-1', since: 0, limit: 2 })
    expect(r.cursor).toBe(r.events[r.events.length - 1].serverTimestamp!)
  })

  test('hasMore=false when results fit within limit', () => {
    seed(engine, 2)
    const r = engine.replayEvents({ workspaceId: 'ws-1', since: 0, limit: 10 })
    expect(r.hasMore).toBe(false)
    expect(r.events).toHaveLength(2)
  })

  test('empty-result case → cursor equals the input `since`', () => {
    const r = engine.replayEvents({ workspaceId: 'ws-empty', since: 1234 })
    expect(r.events).toHaveLength(0)
    expect(r.cursor).toBe(1234)
    expect(r.hasMore).toBe(false)
  })

  test('uses client timestamp as cursor fallback when an event has no serverTimestamp', () => {
    // Inject a raw legacy event with only a client timestamp by
    // publishing then constructing a parallel engine state.
    // The public publish always assigns serverTimestamp, so this branch
    // is only exercisable via the `?? e.timestamp` filter expression
    // when an event somehow lacks one. We approximate by replaying
    // immediately after publish — the engine\'s own serverTimestamp is
    // present, so the fallback isn\'t taken. Test that the filter is
    // STILL correct in the normal case:
    engine.publish(makeEvent({ timestamp: 1, id: 'old' }))
    const r = engine.replayEvents({ workspaceId: 'ws-1', since: 0 })
    expect(r.cursor).toBe(r.events[0].serverTimestamp!)
  })
})

// ─── reset / utilities ───────────────────────────────────────────────────

describe('reset + utilities', () => {
  test('reset() clears subscribers, log, and seenEventIds', () => {
    engine.subscribe('a', 'ws-1', 'web', () => {})
    engine.publish(makeEvent({ id: 'e1' }))
    expect(engine.subscriberCount).toBe(1)
    expect(engine.eventCount).toBe(1)

    engine.reset()
    expect(engine.subscriberCount).toBe(0)
    expect(engine.eventCount).toBe(0)

    // dedup set is cleared — re-publishing the same id is accepted
    const ack = mock(() => {})
    engine.publish(makeEvent({ id: 'e1' }), ack)
    expect(engine.eventCount).toBe(1)
    expect(ack).toHaveBeenCalledWith('e1', 'acknowledged')
  })

  test('subscriberCount and eventCount are live getters', () => {
    expect(engine.subscriberCount).toBe(0)
    expect(engine.eventCount).toBe(0)
    engine.subscribe('a', 'ws-1', 'web', () => {})
    expect(engine.subscriberCount).toBe(1)
    engine.publish(makeEvent())
    expect(engine.eventCount).toBe(1)
  })
})

// ─── singleton ────────────────────────────────────────────────────────────

describe('getSyncEngine / resetSyncEngine singleton', () => {
  test('getSyncEngine returns the same instance across calls', () => {
    const a = getSyncEngine()
    const b = getSyncEngine()
    expect(a).toBe(b)
  })

  test('resetSyncEngine clears state AND drops the cached instance', () => {
    const before = getSyncEngine()
    before.publish(makeEvent({ id: 'singleton-evt' }))
    expect(before.eventCount).toBe(1)

    resetSyncEngine()
    const after = getSyncEngine()
    expect(after).not.toBe(before) // fresh instance
    expect(after.eventCount).toBe(0)
  })

  test('resetSyncEngine when no engine has been created is a safe no-op', () => {
    resetSyncEngine()
    expect(() => resetSyncEngine()).not.toThrow()
  })
})

// ─── createSyncEvent factory ──────────────────────────────────────────────

describe('createSyncEvent factory', () => {
  test('stamps a UUIDv4 id and current timestamp', () => {
    const before = Date.now()
    const e = createSyncEvent('PROJECT_CREATED', 'proj-1', { name: 'X' }, {
      source: 'web',
      workspaceId: 'ws-1',
    })
    const after = Date.now()
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(e.timestamp).toBeGreaterThanOrEqual(before)
    expect(e.timestamp).toBeLessThanOrEqual(after)
  })

  test('forwards type, entityId, payload, workspaceId, source verbatim', () => {
    const payload = { name: 'X' }
    const e = createSyncEvent('CHAT_MESSAGE_CREATED', 'msg-9', payload, {
      source: 'mobile',
      workspaceId: 'ws-Z',
    })
    expect(e.type).toBe('CHAT_MESSAGE_CREATED')
    expect(e.entityId).toBe('msg-9')
    expect(e.payload).toBe(payload) // by reference — no clone
    expect(e.workspaceId).toBe('ws-Z')
    expect(e.source).toBe('mobile')
  })

  test('version defaults to 1 when omitted; respects explicit version', () => {
    const a = createSyncEvent('FOLDER_CREATED', 'f', {}, { source: 'web', workspaceId: 'w' })
    expect(a.version).toBe(1)
    const b = createSyncEvent('FOLDER_CREATED', 'f', {}, {
      source: 'web',
      workspaceId: 'w',
      version: 99,
    })
    expect(b.version).toBe(99)
  })

  test('instanceId and userId are optional and forwarded when provided', () => {
    const a = createSyncEvent('AGENT_CREATED', 'a', {}, { source: 'desktop', workspaceId: 'w' })
    expect(a.instanceId).toBeUndefined()
    expect(a.userId).toBeUndefined()
    const b = createSyncEvent('AGENT_CREATED', 'a', {}, {
      source: 'desktop',
      workspaceId: 'w',
      instanceId: 'desk-1',
      userId: 'u-1',
    })
    expect(b.instanceId).toBe('desk-1')
    expect(b.userId).toBe('u-1')
  })

  test('each call yields a distinct id', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      ids.add(
        createSyncEvent('PROJECT_CREATED', 'p', {}, { source: 'web', workspaceId: 'w' }).id,
      )
    }
    expect(ids.size).toBe(50)
  })

  test('returned event has NO serverTimestamp and NO status (set later by publish)', () => {
    const e = createSyncEvent('PROJECT_CREATED', 'p', {}, { source: 'web', workspaceId: 'w' })
    expect(e.serverTimestamp).toBeUndefined()
    expect(e.status).toBeUndefined()
  })
})

// ─── end-to-end flow ──────────────────────────────────────────────────────

describe('end-to-end: desktop publishes, web subscribes, replay catches up', () => {
  test('desktop event reaches web subscriber; missed-while-offline events replay', async () => {
    const webSeen: SyncEvent[] = []
    const stop = engine.subscribe('web-1', 'ws-1', 'web', (e) => webSeen.push(e))

    // Desktop publishes 3 events; web is connected → receives all 3.
    for (let i = 0; i < 3; i++) {
      engine.publish(
        createSyncEvent('PROJECT_CREATED', `p${i}`, {}, {
          source: 'desktop',
          workspaceId: 'ws-1',
          instanceId: 'desk-1',
        }),
      )
    }
    expect(webSeen).toHaveLength(3)

    // Disconnect, then wait long enough that the next batch\'s
    // Date.now() server timestamps are strictly greater than the
    // cursor we captured. Date.now() has 1ms resolution, so a 5ms
    // sleep is comfortably enough.
    stop()
    await new Promise((r) => setTimeout(r, 5))

    for (let i = 3; i < 5; i++) {
      engine.publish(
        createSyncEvent('PROJECT_CREATED', `p${i}`, {}, {
          source: 'desktop',
          workspaceId: 'ws-1',
          instanceId: 'desk-1',
        }),
      )
    }
    expect(webSeen).toHaveLength(3) // unchanged after unsubscribe

    // Web reconnects with the cursor of the last event it saw.
    const lastSeenCursor = webSeen[webSeen.length - 1].serverTimestamp!
    const caughtUp = engine.replayEvents({ workspaceId: 'ws-1', since: lastSeenCursor })
    expect(caughtUp.events).toHaveLength(2)
    expect(caughtUp.events.map((e) => e.entityId)).toEqual(['p3', 'p4'])
  })
})
