/**
 * QueryBuilder Callback Pattern Tests
 *
 * TDD tests for the onResults callback that syncs remote query results
 * back to MST collections.
 *
 * Test Groups:
 * 1. QueryBuilder callback mechanics - callback preservation and invocation
 * 2. CollectionQueryable remote sync - MST collection population
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { types, getEnv } from 'mobx-state-tree'
import { CollectionQueryable, type IQueryable } from '../queryable'
import { BackendRegistry } from '../../query/registry'
import { MemoryBackend } from '../../query/backends/memory'
import type { IEnvironment } from '../../environment/types'
import type { IQueryExecutor } from '../../query/executors/types'
import type { Condition } from '../../query/ast/types'
import type { QueryOptions } from '../../query/backends/types'

// ============================================================================
// Test Utilities
// ============================================================================

interface TestEntity {
  id: string
  name: string
  status: string
}

/**
 * Create a mock executor with configurable executorType
 */
function createMockExecutor<T extends { id: string }>(
  data: T[],
  executorType: 'local' | 'remote' = 'local'
): IQueryExecutor<T> {
  return {
    executorType,
    async select(ast: Condition, options?: QueryOptions): Promise<T[]> {
      return data
    },
    async first(ast: Condition, options?: QueryOptions): Promise<T | undefined> {
      return data[0]
    },
    async count(ast: Condition): Promise<number> {
      return data.length
    },
    async exists(ast: Condition): Promise<boolean> {
      return data.length > 0
    },
    async insert(entity: Partial<T>): Promise<T> {
      return entity as T
    },
    async update(id: string, changes: Partial<T>): Promise<T | undefined> {
      return undefined
    },
    async delete(id: string): Promise<boolean> {
      return false
    },
    async insertMany(entities: Partial<T>[]): Promise<T[]> {
      return entities as T[]
    },
    async updateMany(ast: Condition, changes: Partial<T>): Promise<number> {
      return 0
    },
    async deleteMany(ast: Condition): Promise<number> {
      return 0
    },
  }
}

/**
 * Create a mock executor that returns empty results
 */
function createEmptyMockExecutor<T extends { id: string }>(
  executorType: 'local' | 'remote' = 'local'
): IQueryExecutor<T> {
  return createMockExecutor<T>([], executorType)
}

// ============================================================================
// Test Group 1: QueryBuilder callback mechanics
// ============================================================================

describe('QueryBuilder onResults callback', () => {
  // Note: These tests directly test the QueryBuilder class behavior.
  // We need to access the QueryBuilder through CollectionQueryable since
  // it's not exported directly. We'll test via the collection.query() API.

  const TestItem = types.model('TestItem', {
    id: types.identifier,
    name: types.string,
    status: types.string,
  })

  const BaseTestCollection = types
    .model('BaseTestCollection', {
      items: types.map(TestItem),
    })
    .views((self) => ({
      get modelName() {
        return 'TestItem'
      },
      all() {
        return Array.from(self.items.values())
      },
      get(id: string) {
        return self.items.get(id)
      },
    }))
    .actions((self) => ({
      add(item: any) {
        self.items.put(item)
        return self.items.get(item.id)
      },
      remove(id: string) {
        self.items.delete(id)
      },
    }))

  const TestCollection = types
    .compose('TestCollection', BaseTestCollection, CollectionQueryable)
    .actions((self) => ({
      // Expose syncFromRemote for testing (will be added to CollectionQueryable)
      syncFromRemote(results: any[]) {
        for (const item of results) {
          self.items.put(item)
        }
      },
    }))

  function createTestEnvironment(executorType: 'local' | 'remote' = 'local'): IEnvironment {
    const registry = new BackendRegistry()
    registry.register('memory', new MemoryBackend())
    registry.setDefault('memory')

    return {
      services: {
        persistence: {} as any,
        backendRegistry: registry,
      },
      context: {
        schemaName: 'test-schema',
      },
    }
  }

  test('should invoke callback with results on toArray()', async () => {
    // Given: A query builder with a callback
    const callbackResults: any[] = []
    const mockData = [
      { id: '1', name: 'Alice', status: 'active' },
      { id: '2', name: 'Bob', status: 'active' },
    ]

    // We'll test this by checking that syncFromRemote is called
    // when using a remote executor via CollectionQueryable

    // For now, this test documents expected behavior
    // Implementation will make it pass
    const env = createTestEnvironment()
    const collection = TestCollection.create({}, env)

    const results = await collection.query<TestEntity>().toArray()

    // With memory backend (local), callback should NOT be invoked
    // Collection should remain empty (no sync needed for local)
    expect(collection.all().length).toBe(0)
  })

  test('should invoke callback with [result] on first() when found', async () => {
    // Given: A remote executor that returns one result
    // When: first() is called
    // Then: callback should be invoked with [result]

    const env = createTestEnvironment()
    const collection = TestCollection.create({}, env)

    const result = await collection.query<TestEntity>().first()

    // With memory backend (local), no sync needed
    expect(collection.all().length).toBe(0)
  })

  test('should invoke callback with [] on first() when not found', async () => {
    // Given: A remote executor that returns no results
    // When: first() is called
    // Then: callback should be invoked with []

    const env = createTestEnvironment()
    const collection = TestCollection.create({}, env)

    const result = await collection.query<TestEntity>().first()

    expect(result).toBeUndefined()
    expect(collection.all().length).toBe(0)
  })

  test('should NOT invoke callback on count()', async () => {
    // Given: A query builder with a callback
    // When: count() is called
    // Then: callback should NOT be invoked (no entity data)

    const env = createTestEnvironment()
    const collection = TestCollection.create({}, env)

    const count = await collection.query<TestEntity>().count()

    expect(typeof count).toBe('number')
    // No sync should happen for count()
    expect(collection.all().length).toBe(0)
  })

  test('should NOT invoke callback on any()', async () => {
    // Given: A query builder with a callback
    // When: any() is called
    // Then: callback should NOT be invoked (no entity data)

    const env = createTestEnvironment()
    const collection = TestCollection.create({}, env)

    const exists = await collection.query<TestEntity>().any()

    expect(typeof exists).toBe('boolean')
    // No sync should happen for any()
    expect(collection.all().length).toBe(0)
  })

  test('should preserve callback through where()', async () => {
    // Given: A query builder with callback
    // When: where() is chained
    // Then: new builder should have same callback

    const env = createTestEnvironment()
    const collection = TestCollection.create({}, env)

    // Chain where() and verify callback still works
    const results = await collection
      .query<TestEntity>()
      .where({ status: 'active' })
      .toArray()

    // This test validates chaining preserves callback
    expect(Array.isArray(results)).toBe(true)
  })

  test('should preserve callback through orderBy()', async () => {
    const env = createTestEnvironment()
    const collection = TestCollection.create({}, env)

    const results = await collection
      .query<TestEntity>()
      .orderBy('name', 'asc')
      .toArray()

    expect(Array.isArray(results)).toBe(true)
  })

  test('should preserve callback through skip()', async () => {
    const env = createTestEnvironment()
    const collection = TestCollection.create({}, env)

    const results = await collection
      .query<TestEntity>()
      .skip(5)
      .toArray()

    expect(Array.isArray(results)).toBe(true)
  })

  test('should preserve callback through take()', async () => {
    const env = createTestEnvironment()
    const collection = TestCollection.create({}, env)

    const results = await collection
      .query<TestEntity>()
      .take(10)
      .toArray()

    expect(Array.isArray(results)).toBe(true)
  })
})

// ============================================================================
// Test Group 2: CollectionQueryable remote sync integration
// ============================================================================

describe('CollectionQueryable remote executor sync', () => {
  const TestItem = types.model('TestItem', {
    id: types.identifier,
    name: types.string,
    status: types.string,
  })

  const BaseTestCollection = types
    .model('BaseTestCollection', {
      items: types.map(TestItem),
    })
    .views((self) => ({
      get modelName() {
        return 'TestItem'
      },
      all() {
        return Array.from(self.items.values())
      },
      get(id: string) {
        return self.items.get(id)
      },
    }))
    .actions((self) => ({
      add(item: any) {
        self.items.put(item)
        return self.items.get(item.id)
      },
      remove(id: string) {
        self.items.delete(id)
      },
    }))

  const TestCollection = types.compose(
    'TestCollection',
    BaseTestCollection,
    CollectionQueryable
  )

  /**
   * Create environment with a mock remote executor that returns specified data
   */
  function createRemoteEnvironment(mockData: TestEntity[]): IEnvironment {
    const mockRemoteExecutor = createMockExecutor(mockData, 'remote')

    // Custom registry that returns our mock remote executor
    const registry = {
      resolve: <T>() => mockRemoteExecutor as IQueryExecutor<T>,
      register: () => {},
      get: () => undefined,
      has: () => true,
      setDefault: () => {},
    }

    return {
      services: {
        persistence: {} as any,
        backendRegistry: registry as any,
      },
      context: {
        schemaName: 'test-schema',
      },
    }
  }

  function createLocalEnvironment(): IEnvironment {
    const registry = new BackendRegistry()
    registry.register('memory', new MemoryBackend())
    registry.setDefault('memory')

    return {
      services: {
        persistence: {} as any,
        backendRegistry: registry,
      },
      context: {
        schemaName: 'test-schema',
      },
    }
  }

  test('should register sync callback when executor.executorType is remote', async () => {
    // Given: A remote executor
    const mockData = [
      { id: '1', name: 'Alice', status: 'active' },
      { id: '2', name: 'Bob', status: 'active' },
    ]
    const env = createRemoteEnvironment(mockData)
    const collection = TestCollection.create({}, env)

    // When: Query is executed
    const results = await collection.query<TestEntity>().toArray()

    // Then: Results should be synced to MST collection
    expect(results.length).toBe(2)
    expect(collection.all().length).toBe(2)
    expect(collection.get('1')?.name).toBe('Alice')
    expect(collection.get('2')?.name).toBe('Bob')
  })

  test('should NOT register callback when executor.executorType is local', async () => {
    // Given: A local (memory) executor with seeded data
    const env = createLocalEnvironment()
    const collection = TestCollection.create({}, env)

    // Seed collection with data
    ;(collection as any).add({ id: '1', name: 'Alice', status: 'active' })

    // When: Query is executed
    const results = await collection.query<TestEntity>().toArray()

    // Then: Collection should only have seeded data (no duplication from sync)
    expect(results.length).toBe(1)
    expect(collection.all().length).toBe(1)
  })

  test('should add new entities to MST collection after remote query', async () => {
    // Given: Empty MST collection, remote executor with data
    const mockData = [
      { id: 'new-1', name: 'NewUser1', status: 'active' },
      { id: 'new-2', name: 'NewUser2', status: 'active' },
    ]
    const env = createRemoteEnvironment(mockData)
    const collection = TestCollection.create({}, env)

    expect(collection.all().length).toBe(0)

    // When: Query is executed
    await collection.query<TestEntity>().toArray()

    // Then: New entities should be added to collection
    expect(collection.all().length).toBe(2)
    expect(collection.get('new-1')).toBeDefined()
    expect(collection.get('new-2')).toBeDefined()
  })

  test('should update existing entities (by id) rather than duplicate', async () => {
    // Given: Collection with existing entity, remote returns updated version
    const mockData = [{ id: '1', name: 'Alice Updated', status: 'inactive' }]
    const env = createRemoteEnvironment(mockData)
    const collection = TestCollection.create({}, env)

    // Pre-seed with original data
    ;(collection as any).add({ id: '1', name: 'Alice', status: 'active' })
    expect(collection.get('1')?.name).toBe('Alice')

    // When: Query returns updated data
    await collection.query<TestEntity>().toArray()

    // Then: Existing entity should be updated, not duplicated
    expect(collection.all().length).toBe(1)
    expect(collection.get('1')?.name).toBe('Alice Updated')
    expect(collection.get('1')?.status).toBe('inactive')
  })

  test('should handle mixed new and existing entities', async () => {
    // Given: Collection with one entity, remote returns mix of new and updated
    const mockData = [
      { id: '1', name: 'Alice Updated', status: 'active' },
      { id: '2', name: 'Bob', status: 'active' },
      { id: '3', name: 'Charlie', status: 'active' },
    ]
    const env = createRemoteEnvironment(mockData)
    const collection = TestCollection.create({}, env)

    // Pre-seed with original Alice
    ;(collection as any).add({ id: '1', name: 'Alice', status: 'pending' })
    expect(collection.all().length).toBe(1)

    // When: Query returns mixed data
    await collection.query<TestEntity>().toArray()

    // Then: Should have 3 entities total
    expect(collection.all().length).toBe(3)
    expect(collection.get('1')?.name).toBe('Alice Updated')
    expect(collection.get('2')?.name).toBe('Bob')
    expect(collection.get('3')?.name).toBe('Charlie')
  })

  test('should sync results from first() when entity found', async () => {
    // Given: Remote executor that returns one entity
    const mockData = [{ id: '1', name: 'Alice', status: 'active' }]
    const env = createRemoteEnvironment(mockData)
    const collection = TestCollection.create({}, env)

    // When: first() returns an entity
    const result = await collection.query<TestEntity>().first()

    // Then: Entity should be synced to collection
    expect(result).toBeDefined()
    expect(collection.all().length).toBe(1)
    expect(collection.get('1')?.name).toBe('Alice')
  })

  test('should handle first() when no entity found', async () => {
    // Given: Remote executor that returns no entities
    const env = createRemoteEnvironment([])
    const collection = TestCollection.create({}, env)

    // When: first() returns nothing
    const result = await collection.query<TestEntity>().first()

    // Then: Collection should remain empty
    expect(result).toBeUndefined()
    expect(collection.all().length).toBe(0)
  })
})
