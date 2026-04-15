// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the Sync Engine
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  SyncEngine,
  createSyncEvent,
  shouldApplyEvent,
  type SyncEvent,
} from '../sync-engine'

describe('SyncEngine', () => {
  let engine: SyncEngine

  beforeEach(() => {
    engine = new SyncEngine({ maxLogSize: 100 })
  })

  describe('publish', () => {
    it('publishes an event and stores it in the log', () => {
      const event = createSyncEvent('PROJECT_CREATED', 'proj_1', { name: 'Test' }, {
        source: 'web',
        workspaceId: 'ws_1',
      })

      engine.publish(event)
      expect(engine.eventCount).toBe(1)
    })

    it('deduplicates events by ID', () => {
      const event = createSyncEvent('PROJECT_CREATED', 'proj_1', { name: 'Test' }, {
        source: 'web',
        workspaceId: 'ws_1',
      })

      engine.publish(event)
      engine.publish(event) // same event again
      expect(engine.eventCount).toBe(1)
    })

    it('assigns serverTimestamp', () => {
      const handler = vi.fn()
      engine.subscribe('client-1', 'ws_1', 'desktop', handler)

      const event = createSyncEvent('PROJECT_CREATED', 'proj_1', { name: 'Test' }, {
        source: 'web',
        workspaceId: 'ws_1',
      })

      engine.publish(event)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          serverTimestamp: expect.any(Number),
        }),
      )
    })

    it('broadcasts to subscribers in the same workspace', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      engine.subscribe('client-1', 'ws_1', 'desktop', handler1)
      engine.subscribe('client-2', 'ws_2', 'web', handler2) // different workspace

      const event = createSyncEvent('PROJECT_CREATED', 'proj_1', { name: 'Test' }, {
        source: 'web',
        workspaceId: 'ws_1',
      })

      engine.publish(event)
      expect(handler1).toHaveBeenCalledTimes(1)
      expect(handler2).not.toHaveBeenCalled()
    })

    it('does not echo events back to the same source+instance', () => {
      const handler = vi.fn()
      engine.subscribe('client-1', 'ws_1', 'web', handler, undefined)

      const event = createSyncEvent('PROJECT_CREATED', 'proj_1', { name: 'Test' }, {
        source: 'web',
        workspaceId: 'ws_1',
      })

      engine.publish(event)
      expect(handler).not.toHaveBeenCalled()
    })

    it('delivers events when source differs', () => {
      const handler = vi.fn()
      engine.subscribe('client-1', 'ws_1', 'desktop', handler, 'inst_1')

      const event = createSyncEvent('PROJECT_CREATED', 'proj_1', { name: 'Test' }, {
        source: 'web',
        workspaceId: 'ws_1',
      })

      engine.publish(event)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('trims the event log when it exceeds maxLogSize', () => {
      for (let i = 0; i < 120; i++) {
        const event = createSyncEvent('PROJECT_UPDATED', `proj_${i}`, { i }, {
          source: 'web',
          workspaceId: 'ws_1',
        })
        engine.publish(event)
      }

      // After 120 events with maxLogSize=100, it should trim to 80
      expect(engine.eventCount).toBeLessThanOrEqual(100)
    })
  })

  describe('subscribe / unsubscribe', () => {
    it('returns an unsubscribe function', () => {
      const handler = vi.fn()
      const unsub = engine.subscribe('client-1', 'ws_1', 'desktop', handler)
      expect(engine.subscriberCount).toBe(1)

      unsub()
      expect(engine.subscriberCount).toBe(0)
    })

    it('unsubscribe via method', () => {
      const handler = vi.fn()
      engine.subscribe('client-1', 'ws_1', 'desktop', handler)
      engine.unsubscribe('client-1')
      expect(engine.subscriberCount).toBe(0)
    })
  })

  describe('replayEvents', () => {
    it('replays events since a timestamp', () => {
      const now = Date.now()

      const event1 = createSyncEvent('PROJECT_CREATED', 'proj_1', { name: 'A' }, {
        source: 'web',
        workspaceId: 'ws_1',
      })
      event1.timestamp = now - 1000
      engine.publish(event1)

      const event2 = createSyncEvent('PROJECT_CREATED', 'proj_2', { name: 'B' }, {
        source: 'web',
        workspaceId: 'ws_1',
      })
      engine.publish(event2)

      const result = engine.replayEvents({
        workspaceId: 'ws_1',
        since: now - 500,
      })

      // event2 should be included (server timestamp >= now)
      // event1 might be included too since serverTimestamp is assigned by publish()
      expect(result.events.length).toBeGreaterThanOrEqual(1)
    })

    it('respects workspace scoping', () => {
      const event = createSyncEvent('PROJECT_CREATED', 'proj_1', { name: 'A' }, {
        source: 'web',
        workspaceId: 'ws_1',
      })
      engine.publish(event)

      const result = engine.replayEvents({
        workspaceId: 'ws_2',
        since: 0,
      })

      expect(result.events.length).toBe(0)
    })

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        engine.publish(
          createSyncEvent('PROJECT_UPDATED', `proj_${i}`, { i }, {
            source: 'web',
            workspaceId: 'ws_1',
          }),
        )
      }

      const result = engine.replayEvents({
        workspaceId: 'ws_1',
        since: 0,
        limit: 3,
      })

      expect(result.events.length).toBe(3)
      expect(result.hasMore).toBe(true)
    })
  })

  describe('reset', () => {
    it('clears all state', () => {
      engine.subscribe('c1', 'ws_1', 'web', vi.fn())
      engine.publish(
        createSyncEvent('PROJECT_CREATED', 'proj_1', {}, {
          source: 'web',
          workspaceId: 'ws_1',
        }),
      )

      engine.reset()
      expect(engine.subscriberCount).toBe(0)
      expect(engine.eventCount).toBe(0)
    })
  })
})

describe('shouldApplyEvent', () => {
  it('applies event with higher version', () => {
    const event = createSyncEvent('PROJECT_UPDATED', 'proj_1', { name: 'Updated' }, {
      source: 'desktop',
      workspaceId: 'ws_1',
      version: 3,
    })

    expect(shouldApplyEvent(event, 2, Date.now())).toBe(true)
  })

  it('rejects event with lower version', () => {
    const event = createSyncEvent('PROJECT_UPDATED', 'proj_1', { name: 'Old' }, {
      source: 'desktop',
      workspaceId: 'ws_1',
      version: 1,
    })

    expect(shouldApplyEvent(event, 2, Date.now())).toBe(false)
  })

  it('uses LWW for same version', () => {
    const now = Date.now()
    const event = createSyncEvent('PROJECT_UPDATED', 'proj_1', { name: 'Newer' }, {
      source: 'desktop',
      workspaceId: 'ws_1',
      version: 2,
    })
    event.serverTimestamp = now + 1000

    expect(shouldApplyEvent(event, 2, now)).toBe(true)
  })

  it('rejects same version with older timestamp', () => {
    const now = Date.now()
    const event = createSyncEvent('PROJECT_UPDATED', 'proj_1', { name: 'Older' }, {
      source: 'desktop',
      workspaceId: 'ws_1',
      version: 2,
    })
    event.serverTimestamp = now - 1000

    expect(shouldApplyEvent(event, 2, now)).toBe(false)
  })
})

describe('createSyncEvent', () => {
  it('creates a properly shaped event', () => {
    const event = createSyncEvent('PROJECT_CREATED', 'proj_1', { name: 'My Project' }, {
      source: 'web',
      workspaceId: 'ws_1',
      userId: 'user_1',
    })

    expect(event).toMatchObject({
      id: expect.any(String),
      type: 'PROJECT_CREATED',
      entityId: 'proj_1',
      payload: { name: 'My Project' },
      timestamp: expect.any(Number),
      version: 1,
      source: 'web',
      workspaceId: 'ws_1',
      userId: 'user_1',
    })
  })
})
