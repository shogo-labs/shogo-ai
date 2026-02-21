import { describe, test, expect, beforeEach } from 'bun:test'
import { DynamicAppManager, getByPointer } from '../dynamic-app-manager'
import type { DynamicAppMessage } from '../dynamic-app-types'

describe('DynamicAppManager', () => {
  let manager: DynamicAppManager

  beforeEach(() => {
    manager = new DynamicAppManager()
  })

  describe('createSurface', () => {
    test('creates a new surface', () => {
      const result = manager.createSurface('test-surface', 'Test Title')
      expect(result.ok).toBe(true)
      expect(manager.listSurfaces()).toEqual(['test-surface'])
    })

    test('rejects duplicate surface IDs', () => {
      manager.createSurface('dup')
      const result = manager.createSurface('dup')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('already exists')
    })

    test('broadcasts createSurface message to SSE clients', () => {
      const messages: DynamicAppMessage[] = []
      manager.addClient((msg) => messages.push(msg))

      manager.createSurface('s1', 'Title')

      expect(messages).toHaveLength(1)
      expect(messages[0]).toEqual({
        type: 'createSurface',
        surfaceId: 's1',
        title: 'Title',
        theme: undefined,
      })
    })
  })

  describe('updateComponents', () => {
    test('adds components to a surface', () => {
      manager.createSurface('s1')
      const result = manager.updateComponents('s1', [
        { id: 'root', component: 'Column', children: ['text1'] },
        { id: 'text1', component: 'Text', text: 'Hello' },
      ])
      expect(result.ok).toBe(true)

      const surface = manager.getSurface('s1')!
      expect(surface.components.size).toBe(2)
      expect(surface.components.get('root')?.component).toBe('Column')
    })

    test('upserts existing components', () => {
      manager.createSurface('s1')
      manager.updateComponents('s1', [
        { id: 'text1', component: 'Text', text: 'Hello' },
      ])
      manager.updateComponents('s1', [
        { id: 'text1', component: 'Text', text: 'Updated' },
      ])

      const surface = manager.getSurface('s1')!
      expect(surface.components.get('text1')?.text).toBe('Updated')
    })

    test('rejects updates to non-existent surface', () => {
      const result = manager.updateComponents('missing', [])
      expect(result.ok).toBe(false)
    })
  })

  describe('updateData', () => {
    test('sets root data model', () => {
      manager.createSurface('s1')
      const result = manager.updateData('s1', '/', { flights: [{ id: 1, price: 299 }] })
      expect(result.ok).toBe(true)

      const surface = manager.getSurface('s1')!
      expect(surface.dataModel).toEqual({ flights: [{ id: 1, price: 299 }] })
    })

    test('sets nested data via JSON Pointer', () => {
      manager.createSurface('s1')
      manager.updateData('s1', '/', { user: { name: 'Alice' } })
      manager.updateData('s1', '/user/name', 'Bob')

      const surface = manager.getSurface('s1')!
      expect((surface.dataModel as any).user.name).toBe('Bob')
    })

    test('creates intermediate paths', () => {
      manager.createSurface('s1')
      manager.updateData('s1', '/a/b/c', 'deep')

      const surface = manager.getSurface('s1')!
      expect((surface.dataModel as any).a.b.c).toBe('deep')
    })
  })

  describe('deleteSurface', () => {
    test('removes a surface', () => {
      manager.createSurface('s1')
      const result = manager.deleteSurface('s1')
      expect(result.ok).toBe(true)
      expect(manager.listSurfaces()).toEqual([])
    })

    test('rejects deleting non-existent surface', () => {
      const result = manager.deleteSurface('missing')
      expect(result.ok).toBe(false)
    })
  })

  describe('SSE client management', () => {
    test('supports multiple clients', () => {
      const msgs1: DynamicAppMessage[] = []
      const msgs2: DynamicAppMessage[] = []

      manager.addClient((msg) => msgs1.push(msg))
      manager.addClient((msg) => msgs2.push(msg))

      manager.createSurface('s1')

      expect(msgs1).toHaveLength(1)
      expect(msgs2).toHaveLength(1)
    })

    test('unsubscribes cleanly', () => {
      const msgs: DynamicAppMessage[] = []
      const unsub = manager.addClient((msg) => msgs.push(msg))

      manager.createSurface('s1')
      expect(msgs).toHaveLength(1)

      unsub()
      manager.createSurface('s2')
      expect(msgs).toHaveLength(1)
    })

    test('removes failing clients', () => {
      let shouldFail = false
      manager.addClient(() => {
        if (shouldFail) throw new Error('disconnected')
      })

      manager.createSurface('s1')
      shouldFail = true
      manager.createSurface('s2')
      // Should not throw
    })
  })

  describe('action handling', () => {
    test('delivers action to waiting tool', async () => {
      const waitPromise = manager.waitForAction('s1', 'book')

      manager.deliverAction({
        surfaceId: 's1',
        name: 'book',
        context: { flightId: 'FL123' },
        timestamp: new Date().toISOString(),
      })

      const event = await waitPromise
      expect(event).not.toBeNull()
      expect(event!.name).toBe('book')
      expect(event!.context).toEqual({ flightId: 'FL123' })
    })

    test('queues actions when no waiter exists', async () => {
      manager.deliverAction({
        surfaceId: 's1',
        name: 'click',
        context: {},
        timestamp: new Date().toISOString(),
      })

      const event = await manager.waitForAction('s1', 'click')
      expect(event).not.toBeNull()
      expect(event!.name).toBe('click')
    })

    test('times out when no action received', async () => {
      const event = await manager.waitForAction('s1', 'missing', 100)
      expect(event).toBeNull()
    })

    test('matches by surfaceId filter', async () => {
      manager.deliverAction({
        surfaceId: 's2',
        name: 'click',
        context: {},
        timestamp: new Date().toISOString(),
      })

      const event = await manager.waitForAction('s1', undefined, 100)
      expect(event).toBeNull()
    })
  })

  describe('getState', () => {
    test('returns full state snapshot', () => {
      manager.createSurface('s1', 'Dashboard')
      manager.updateComponents('s1', [
        { id: 'root', component: 'Column', children: ['t'] },
        { id: 't', component: 'Text', text: 'Hello' },
      ])
      manager.updateData('s1', '/', { count: 42 })

      const state = manager.getState()
      expect(Object.keys(state.surfaces)).toEqual(['s1'])

      const s1 = state.surfaces.s1 as any
      expect(s1.title).toBe('Dashboard')
      expect(Object.keys(s1.components)).toHaveLength(2)
      expect(s1.dataModel).toEqual({ count: 42 })
    })
  })
})

describe('getByPointer', () => {
  test('resolves root path as empty traversal', () => {
    const obj = { a: 1 }
    expect(getByPointer(obj, '/a')).toBe(1)
  })

  test('resolves nested paths', () => {
    const obj = { user: { name: 'Alice', scores: [10, 20, 30] } }
    expect(getByPointer(obj, '/user/name')).toBe('Alice')
    expect(getByPointer(obj, '/user/scores/1')).toBe(20)
  })

  test('returns undefined for missing paths', () => {
    expect(getByPointer({}, '/missing/path')).toBeUndefined()
  })
})
