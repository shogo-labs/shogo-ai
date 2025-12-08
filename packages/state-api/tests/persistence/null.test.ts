/**
 * Tests for NullPersistence implementation.
 *
 * These tests verify in-memory storage behavior, particularly workspace
 * isolation via composite cache keys.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { NullPersistence } from '../../src/persistence/null'
import type { PersistenceContext, EntityContext } from '../../src/persistence/types'

describe('NullPersistence', () => {
  let persistence: NullPersistence
  let ctx: PersistenceContext

  beforeEach(() => {
    persistence = new NullPersistence()
    ctx = {
      schemaName: 'test-schema',
      modelName: 'Task'
    }
  })

  test('saves and loads collection snapshot from memory', async () => {
    const snapshot = {
      items: {
        '1': { id: '1', title: 'Task 1' },
        '2': { id: '2', title: 'Task 2' }
      }
    }

    await persistence.saveCollection(ctx, snapshot)
    const loaded = await persistence.loadCollection(ctx)

    expect(loaded).toEqual(snapshot)
  })

  test('returns null when collection does not exist', async () => {
    const result = await persistence.loadCollection(ctx)
    expect(result).toBeNull()
  })

  test('isolates data by location in cache key', async () => {
    const ctx1 = { schemaName: 'test', modelName: 'Task', location: 'workspace1' }
    const ctx2 = { schemaName: 'test', modelName: 'Task', location: 'workspace2' }

    await persistence.saveCollection(ctx1, { items: { '1': { data: 'A' } } })
    await persistence.saveCollection(ctx2, { items: { '2': { data: 'B' } } })

    const loaded1 = await persistence.loadCollection(ctx1)
    const loaded2 = await persistence.loadCollection(ctx2)

    expect(loaded1).toEqual({ items: { '1': { data: 'A' } } })
    expect(loaded2).toEqual({ items: { '2': { data: 'B' } } })
  })

  test('isolates data by schemaName in cache key', async () => {
    const ctx1 = { ...ctx, schemaName: 'schema1' }
    const ctx2 = { ...ctx, schemaName: 'schema2' }

    await persistence.saveCollection(ctx1, { items: { '1': { data: 'X' } } })
    await persistence.saveCollection(ctx2, { items: { '2': { data: 'Y' } } })

    const loaded1 = await persistence.loadCollection(ctx1)
    const loaded2 = await persistence.loadCollection(ctx2)

    expect(loaded1).toEqual({ items: { '1': { data: 'X' } } })
    expect(loaded2).toEqual({ items: { '2': { data: 'Y' } } })
  })

  test('isolates data by modelName in cache key', async () => {
    const ctx1 = { ...ctx, modelName: 'Task' }
    const ctx2 = { ...ctx, modelName: 'User' }

    await persistence.saveCollection(ctx1, { items: { '1': { task: 'data' } } })
    await persistence.saveCollection(ctx2, { items: { '2': { user: 'data' } } })

    const loaded1 = await persistence.loadCollection(ctx1)
    const loaded2 = await persistence.loadCollection(ctx2)

    expect(loaded1).toEqual({ items: { '1': { task: 'data' } } })
    expect(loaded2).toEqual({ items: { '2': { user: 'data' } } })
  })

  test('clear removes all stored data', async () => {
    await persistence.saveCollection(ctx, { items: { '1': { data: 'test' } } })

    persistence.clear()

    const loaded = await persistence.loadCollection(ctx)
    expect(loaded).toBeNull()
  })

  test('saves and loads single entity from memory', async () => {
    const entityCtx: EntityContext = {
      ...ctx,
      entityId: '1'
    }
    const entitySnapshot = { id: '1', title: 'Task 1' }

    await persistence.saveEntity(entityCtx, entitySnapshot)
    const loaded = await persistence.loadEntity(entityCtx)

    expect(loaded).toEqual(entitySnapshot)
  })

  test('loadEntity returns null when collection does not exist', async () => {
    const entityCtx: EntityContext = {
      ...ctx,
      entityId: '1'
    }

    const loaded = await persistence.loadEntity(entityCtx)
    expect(loaded).toBeNull()
  })

  test('loadEntity returns null when entity does not exist in collection', async () => {
    await persistence.saveCollection(ctx, {
      items: {
        '1': { id: '1', title: 'Task 1' }
      }
    })

    const entityCtx: EntityContext = {
      ...ctx,
      entityId: '2'
    }

    const loaded = await persistence.loadEntity(entityCtx)
    expect(loaded).toBeNull()
  })

  test('saveEntity creates collection if missing', async () => {
    const entityCtx: EntityContext = {
      ...ctx,
      entityId: '1'
    }

    await persistence.saveEntity(entityCtx, { id: '1', title: 'New Task' })
    const collection = await persistence.loadCollection(ctx)

    expect(collection).toEqual({
      items: {
        '1': { id: '1', title: 'New Task' }
      }
    })
  })

  test('saveEntity updates existing entity in collection', async () => {
    await persistence.saveCollection(ctx, {
      items: {
        '1': { id: '1', title: 'Task 1' },
        '2': { id: '2', title: 'Task 2' }
      }
    })

    const entityCtx: EntityContext = {
      ...ctx,
      entityId: '1'
    }
    await persistence.saveEntity(entityCtx, { id: '1', title: 'Updated Task 1' })

    const collection = await persistence.loadCollection(ctx)
    expect(collection).toEqual({
      items: {
        '1': { id: '1', title: 'Updated Task 1' },
        '2': { id: '2', title: 'Task 2' }
      }
    })
  })

  test('uses "default" as location when not specified', async () => {
    const ctxWithLocation = { ...ctx, location: 'default' }
    const ctxWithoutLocation = { ...ctx }  // no location specified

    await persistence.saveCollection(ctxWithLocation, { items: { '1': { data: 'A' } } })

    // Should load the same data since both resolve to "default"
    const loaded = await persistence.loadCollection(ctxWithoutLocation)
    expect(loaded).toEqual({ items: { '1': { data: 'A' } } })
  })

  describe('Filter support (Phase 7)', () => {
    test('loadCollection applies filter when provided', async () => {
      // Given: Collection with mixed data
      await persistence.saveCollection(ctx, {
        items: {
          '1': { id: '1', title: 'Task 1', status: 'open' },
          '2': { id: '2', title: 'Task 2', status: 'closed' },
          '3': { id: '3', title: 'Task 3', status: 'open' }
        }
      })

      // When: Loading with filter
      const ctxWithFilter = { ...ctx, filter: { status: 'open' } }
      const loaded = await persistence.loadCollection(ctxWithFilter)

      // Then: Only matching items returned
      expect(loaded).toEqual({
        items: {
          '1': { id: '1', title: 'Task 1', status: 'open' },
          '3': { id: '3', title: 'Task 3', status: 'open' }
        }
      })
    })

    test('loadCollection without filter returns all items (backward compat)', async () => {
      // Given: Collection with data
      const snapshot = {
        items: {
          '1': { id: '1', status: 'open' },
          '2': { id: '2', status: 'closed' }
        }
      }
      await persistence.saveCollection(ctx, snapshot)

      // When: Loading without filter
      const loaded = await persistence.loadCollection(ctx)

      // Then: All items returned
      expect(loaded).toEqual(snapshot)
    })

    test('loadCollection with multi-field filter matches all conditions', async () => {
      // Given: Collection with data
      await persistence.saveCollection(ctx, {
        items: {
          '1': { id: '1', status: 'open', priority: 'high' },
          '2': { id: '2', status: 'open', priority: 'low' },
          '3': { id: '3', status: 'closed', priority: 'high' }
        }
      })

      // When: Loading with multi-field filter
      const ctxWithFilter = { ...ctx, filter: { status: 'open', priority: 'high' } }
      const loaded = await persistence.loadCollection(ctxWithFilter)

      // Then: Only items matching ALL conditions returned
      expect(loaded).toEqual({
        items: {
          '1': { id: '1', status: 'open', priority: 'high' }
        }
      })
    })

    test('loadCollection with filter returns null when collection does not exist', async () => {
      // When: Loading from non-existent collection with filter
      const ctxWithFilter = { ...ctx, filter: { status: 'open' } }
      const loaded = await persistence.loadCollection(ctxWithFilter)

      // Then: Returns null (not empty object)
      expect(loaded).toBeNull()
    })

    test('loadCollection with filter returns empty items when no matches', async () => {
      // Given: Collection with no matching data
      await persistence.saveCollection(ctx, {
        items: {
          '1': { id: '1', status: 'closed' },
          '2': { id: '2', status: 'closed' }
        }
      })

      // When: Loading with filter that matches nothing
      const ctxWithFilter = { ...ctx, filter: { status: 'open' } }
      const loaded = await persistence.loadCollection(ctxWithFilter)

      // Then: Returns empty items
      expect(loaded).toEqual({ items: {} })
    })
  })
})
