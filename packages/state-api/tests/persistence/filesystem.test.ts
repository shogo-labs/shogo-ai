/**
 * Tests for FileSystemPersistence implementation.
 *
 * These tests use real filesystem operations with temporary directories.
 * Each test creates a unique temp directory to allow parallel execution.
 *
 * ⚠️ SAFETY WARNING: ALL tests MUST provide an explicit `location` parameter
 * to avoid writing to the production `.schemas` directory. NEVER test the
 * default location behavior by writing to `.schemas` - this can cause data loss!
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rm } from 'fs/promises'
import { FileSystemPersistence } from '../../src/persistence/filesystem'
import { exists } from '../../src/persistence/io'
import type { PersistenceContext, EntityContext } from '../../src/persistence/types'

describe('FileSystemPersistence', () => {
  let tempDir: string
  let persistence: FileSystemPersistence
  let ctx: PersistenceContext

  beforeEach(() => {
    // Unique temp directory per test for parallel execution
    tempDir = `.test-schemas-${Date.now()}-${Math.random().toString(36).substring(7)}`
    persistence = new FileSystemPersistence()
    ctx = {
      schemaName: 'test-schema',
      modelName: 'Task',
      location: tempDir
    }
  })

  afterEach(async () => {
    // Cleanup temp directory even if test fails
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  test('saves and loads collection snapshot', async () => {
    const snapshot = {
      items: {
        '1': { id: '1', title: 'Task 1', completed: false },
        '2': { id: '2', title: 'Task 2', completed: true }
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

  test('creates directory structure automatically', async () => {
    const snapshot = { items: {} }
    await persistence.saveCollection(ctx, snapshot)

    const dirPath = `${tempDir}/test-schema/data`
    const dirExists = await exists(dirPath)
    expect(dirExists).toBe(true)
  })

  test('saves and loads single entity', async () => {
    const entityCtx: EntityContext = {
      ...ctx,
      entityId: '1'
    }
    const entitySnapshot = { id: '1', title: 'Task 1', completed: false }

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
    // Save collection with one entity
    await persistence.saveCollection(ctx, {
      items: {
        '1': { id: '1', title: 'Task 1' }
      }
    })

    // Try to load different entity
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
    // Create collection with two entities
    await persistence.saveCollection(ctx, {
      items: {
        '1': { id: '1', title: 'Task 1' },
        '2': { id: '2', title: 'Task 2' }
      }
    })

    // Update one entity
    const entityCtx: EntityContext = {
      ...ctx,
      entityId: '1'
    }
    await persistence.saveEntity(entityCtx, { id: '1', title: 'Updated Task 1' })

    // Verify update and that other entity is unchanged
    const collection = await persistence.loadCollection(ctx)
    expect(collection).toEqual({
      items: {
        '1': { id: '1', title: 'Updated Task 1' },
        '2': { id: '2', title: 'Task 2' }
      }
    })
  })

  test('handles multiple models in same schema', async () => {
    const taskCtx = { ...ctx, modelName: 'Task' }
    const userCtx = { ...ctx, modelName: 'User' }

    await persistence.saveCollection(taskCtx, { items: { '1': { id: '1', title: 'Task' } } })
    await persistence.saveCollection(userCtx, { items: { '2': { id: '2', name: 'User' } } })

    const tasks = await persistence.loadCollection(taskCtx)
    const users = await persistence.loadCollection(userCtx)

    expect(tasks).toEqual({ items: { '1': { id: '1', title: 'Task' } } })
    expect(users).toEqual({ items: { '2': { id: '2', name: 'User' } } })
  })
})
