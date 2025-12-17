/**
 * CollectionQueryable Mixin Tests
 *
 * Tests for the CollectionQueryable mixin that adds .query() method
 * returning an IQueryable builder with chainable where/orderBy/skip/take
 * methods and async terminal operations (toArray/first/count/any).
 *
 * Generated from TestSpecifications:
 * - test-queryable-mixin-pattern
 * - test-queryable-query-view
 * - test-queryable-where
 * - test-queryable-orderby
 * - test-queryable-skip-take
 * - test-queryable-toarray
 * - test-queryable-first
 * - test-queryable-count-any
 * - test-queryable-backend-resolution
 * - test-queryable-immutable
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { types, getEnv } from 'mobx-state-tree'
import { CollectionQueryable } from '../queryable'
import { MemoryBackend } from '../../query/backends/memory'
import { BackendRegistry } from '../../query/registry'
import type { IEnvironment } from '../../environment/types'

// ============================================================================
// Test Setup
// ============================================================================

const TestItem = types.model('TestItem', {
  id: types.identifier,
  name: types.string,
  status: types.string,
  age: types.number,
  tags: types.array(types.string)
})

const BaseTestCollection = types.model('TestCollection', {
  items: types.map(TestItem)
}).views(self => ({
  get modelName() {
    return 'TestItem'
  },
  all() {
    return Array.from(self.items.values())
  }
})).actions(self => ({
  add(item: any) {
    self.items.put(item)
  },
  clear() {
    self.items.clear()
  }
}))

// Compose with CollectionQueryable mixin
const TestCollection = types.compose(
  BaseTestCollection,
  CollectionQueryable
).named('TestCollection')

// Test environment with backendRegistry
function createTestEnvironment(): IEnvironment {
  const registry = new BackendRegistry()
  registry.register('memory', new MemoryBackend())
  registry.setDefault('memory')

  return {
    services: {
      persistence: {} as any, // Not used in these tests
      backendRegistry: registry
    },
    context: {
      schemaName: 'test-schema'
    }
  }
}

// ============================================================================
// Test: Mixin Pattern
// ============================================================================

describe('CollectionQueryable mixin pattern', () => {
  test('uses types.model().views().actions() pattern', () => {
    // Given: CollectionQueryable mixin is imported
    // When: Inspecting mixin structure
    // Then: Should have MST model structure
    expect(CollectionQueryable).toBeDefined()
    expect(typeof CollectionQueryable).toBe('object')
    // MST models have specific properties
    expect(CollectionQueryable.name).toBe('CollectionQueryable')
  })

  test('can be composed with base collection model', () => {
    // Given: Base collection model
    // When: Composing with CollectionQueryable
    // Then: Composed model should work
    const composed = types.compose(BaseTestCollection, CollectionQueryable)
    expect(composed).toBeDefined()
  })
})

// ============================================================================
// Test: .query() View
// ============================================================================

describe('.query() view returns IQueryable builder', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
  })

  test('collection has .query() method', () => {
    // Given: Collection with CollectionQueryable mixin
    // When: Checking for query method
    // Then: Method should exist
    expect(collection.query).toBeDefined()
    expect(typeof collection.query).toBe('function')
  })

  test('.query() returns IQueryable builder instance', () => {
    // Given: Collection with CollectionQueryable mixin
    // When: Calling collection.query()
    const builder = collection.query()

    // Then: Should return builder with chainable methods
    expect(builder).toBeDefined()
    expect(builder.where).toBeDefined()
    expect(builder.orderBy).toBeDefined()
    expect(builder.skip).toBeDefined()
    expect(builder.take).toBeDefined()
    expect(builder.toArray).toBeDefined()
    expect(builder.first).toBeDefined()
    expect(builder.count).toBeDefined()
    expect(builder.any).toBeDefined()
  })

  test('.query() does not execute query immediately', () => {
    // Given: Collection with items
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30, tags: [] })

    // When: Calling .query() without terminal operation
    const builder = collection.query()

    // Then: No query executed (returns synchronously)
    expect(builder).toBeDefined()
    // Terminal operations return promises, but builder itself is sync
  })
})

// ============================================================================
// Test: where() Method
// ============================================================================

describe('where() method adds filter conditions', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30, tags: [] })
    collection.add({ id: '2', name: 'Bob', status: 'inactive', age: 25, tags: [] })
  })

  test('where() returns new IQueryable (immutable)', () => {
    // Given: IQueryable builder from collection.query()
    const builder1 = collection.query()

    // When: Calling .where({ status: 'active' })
    const builder2 = builder1.where({ status: 'active' })

    // Then: Should return new instance
    expect(builder2).toBeDefined()
    expect(builder2).not.toBe(builder1)
  })

  test('where() filter condition is stored', async () => {
    // Given: IQueryable builder
    // When: Calling .where({ status: 'active' }).toArray()
    const results = await collection.query()
      .where({ status: 'active' })
      .toArray()

    // Then: Should return only matching items
    expect(results.length).toBe(1)
    expect(results[0].name).toBe('Alice')
  })

  test('can chain multiple where() calls', async () => {
    // Given: IQueryable builder
    // When: Chaining multiple where calls
    const results = await collection.query()
      .where({ status: 'active' })
      .where({ age: { $gte: 25 } })
      .toArray()

    // Then: Both filters should apply
    expect(results.length).toBe(1)
    expect(results[0].name).toBe('Alice')
  })
})

// ============================================================================
// Test: orderBy() Method
// ============================================================================

describe('orderBy() method sets sort order', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    collection.add({ id: '1', name: 'Charlie', status: 'active', age: 35, tags: [] })
    collection.add({ id: '2', name: 'Alice', status: 'active', age: 30, tags: [] })
    collection.add({ id: '3', name: 'Bob', status: 'active', age: 25, tags: [] })
  })

  test('orderBy() returns new IQueryable', () => {
    // Given: IQueryable builder
    const builder1 = collection.query()

    // When: Calling .orderBy('name', 'asc')
    const builder2 = builder1.orderBy('name', 'asc')

    // Then: Should return new instance
    expect(builder2).not.toBe(builder1)
  })

  test('orderBy() ascending order', async () => {
    // Given: IQueryable builder
    // When: Calling .orderBy('name', 'asc')
    const results = await collection.query()
      .orderBy('name', 'asc')
      .toArray()

    // Then: Should be sorted ascending by name
    expect(results[0].name).toBe('Alice')
    expect(results[1].name).toBe('Bob')
    expect(results[2].name).toBe('Charlie')
  })

  test('orderBy() descending order', async () => {
    // Given: IQueryable builder
    // When: Calling .orderBy('age', 'desc')
    const results = await collection.query()
      .orderBy('age', 'desc')
      .toArray()

    // Then: Should be sorted descending by age
    expect(results[0].age).toBe(35)
    expect(results[1].age).toBe(30)
    expect(results[2].age).toBe(25)
  })

  test('supports multiple orderBy for multi-field sort', async () => {
    // Given: Items with same status but different ages
    collection.clear()
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30, tags: [] })
    collection.add({ id: '2', name: 'Bob', status: 'active', age: 25, tags: [] })
    collection.add({ id: '3', name: 'Charlie', status: 'inactive', age: 30, tags: [] })

    // When: Multiple orderBy calls
    const results = await collection.query()
      .orderBy('status', 'asc')
      .orderBy('age', 'desc')
      .toArray()

    // Then: Should sort by status first, then age
    expect(results[0].status).toBe('active')
    expect(results[0].age).toBe(30) // Alice
    expect(results[1].status).toBe('active')
    expect(results[1].age).toBe(25) // Bob
    expect(results[2].status).toBe('inactive') // Charlie
  })
})

// ============================================================================
// Test: skip() and take() Pagination
// ============================================================================

describe('skip() and take() for pagination', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    for (let i = 1; i <= 10; i++) {
      collection.add({
        id: `${i}`,
        name: `User ${i}`,
        status: 'active',
        age: 20 + i,
        tags: []
      })
    }
  })

  test('skip() returns new IQueryable', () => {
    // Given: IQueryable builder
    const builder1 = collection.query()

    // When: Calling .skip(10)
    const builder2 = builder1.skip(10)

    // Then: Should return new instance
    expect(builder2).not.toBe(builder1)
  })

  test('take() returns new IQueryable', () => {
    // Given: IQueryable builder
    const builder1 = collection.query()

    // When: Calling .take(5)
    const builder2 = builder1.take(5)

    // Then: Should return new instance
    expect(builder2).not.toBe(builder1)
  })

  test('skip() pagination', async () => {
    // Given: IQueryable builder
    // When: Calling .skip(5).toArray()
    const results = await collection.query()
      .skip(5)
      .toArray()

    // Then: Should skip first 5 items
    expect(results.length).toBe(5)
    expect(results[0].id).toBe('6')
  })

  test('take() pagination', async () => {
    // Given: IQueryable builder
    // When: Calling .take(3).toArray()
    const results = await collection.query()
      .take(3)
      .toArray()

    // Then: Should return only 3 items
    expect(results.length).toBe(3)
  })

  test('skip() and take() together', async () => {
    // Given: IQueryable builder
    // When: Calling .skip(3).take(2).toArray()
    const results = await collection.query()
      .skip(3)
      .take(2)
      .toArray()

    // Then: Should skip 3 and take 2
    expect(results.length).toBe(2)
    expect(results[0].id).toBe('4')
    expect(results[1].id).toBe('5')
  })
})

// ============================================================================
// Test: toArray() Terminal Operation
// ============================================================================

describe('toArray() terminal returns Promise<T[]>', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30, tags: [] })
    collection.add({ id: '2', name: 'Bob', status: 'inactive', age: 25, tags: [] })
  })

  test('toArray() returns Promise', () => {
    // Given: IQueryable with filter and pagination
    const result = collection.query().toArray()

    // Then: Should return Promise
    expect(result).toBeInstanceOf(Promise)
  })

  test('toArray() resolves to array', async () => {
    // Given: IQueryable with filter
    // When: Calling await query.toArray()
    const results = await collection.query()
      .where({ status: 'active' })
      .toArray()

    // Then: Should return array with matching items
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(1)
    expect(results[0].name).toBe('Alice')
  })

  test('toArray() respects skip/take if set', async () => {
    // Given: IQueryable with skip/take
    // When: Calling toArray()
    const results = await collection.query()
      .skip(1)
      .take(1)
      .toArray()

    // Then: Should apply pagination
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('2')
  })
})

// ============================================================================
// Test: first() Terminal Operation
// ============================================================================

describe('first() terminal returns Promise<T | undefined>', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30, tags: [] })
    collection.add({ id: '2', name: 'Bob', status: 'inactive', age: 25, tags: [] })
  })

  test('first() returns Promise', () => {
    // Given: IQueryable with filter
    const result = collection.query().first()

    // Then: Should return Promise
    expect(result).toBeInstanceOf(Promise)
  })

  test('first() returns first matching item', async () => {
    // Given: IQueryable with filter
    // When: Calling await query.first()
    const result = await collection.query()
      .where({ status: 'active' })
      .first()

    // Then: Should return single item
    expect(result).toBeDefined()
    expect(result.name).toBe('Alice')
  })

  test('first() returns undefined if no matches', async () => {
    // Given: IQueryable with non-matching filter
    // When: Calling await query.first()
    const result = await collection.query()
      .where({ status: 'archived' })
      .first()

    // Then: Should return undefined
    expect(result).toBeUndefined()
  })
})

// ============================================================================
// Test: count() and any() Terminal Operations
// ============================================================================

describe('count() and any() terminal operations', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30, tags: [] })
    collection.add({ id: '2', name: 'Bob', status: 'inactive', age: 25, tags: [] })
  })

  test('count() returns Promise<number>', async () => {
    // Given: IQueryable with filter
    // When: Calling count()
    const result = collection.query().count()

    // Then: Should return Promise
    expect(result).toBeInstanceOf(Promise)

    const count = await result
    expect(typeof count).toBe('number')
  })

  test('count() respects filter conditions', async () => {
    // Given: IQueryable with filter
    // When: Calling count()
    const count = await collection.query()
      .where({ status: 'active' })
      .count()

    // Then: Should return count of matching items
    expect(count).toBe(1)
  })

  test('any() returns Promise<boolean>', async () => {
    // Given: IQueryable with filter
    // When: Calling any()
    const result = collection.query().any()

    // Then: Should return Promise
    expect(result).toBeInstanceOf(Promise)

    const hasAny = await result
    expect(typeof hasAny).toBe('boolean')
  })

  test('any() returns true when matches exist', async () => {
    // Given: IQueryable with matching filter
    // When: Calling any()
    const hasAny = await collection.query()
      .where({ status: 'active' })
      .any()

    // Then: Should return true
    expect(hasAny).toBe(true)
  })

  test('any() returns false when no matches', async () => {
    // Given: IQueryable with non-matching filter
    // When: Calling any()
    const hasAny = await collection.query()
      .where({ status: 'archived' })
      .any()

    // Then: Should return false
    expect(hasAny).toBe(false)
  })
})

// ============================================================================
// Test: Backend Resolution
// ============================================================================

describe('uses backendRegistry for backend resolution', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30, tags: [] })
  })

  test('accesses getEnv(self).services.backendRegistry', async () => {
    // Given: Collection with CollectionQueryable
    // When: Executing query terminal operation
    const results = await collection.query().toArray()

    // Then: Should access backendRegistry and execute successfully
    expect(results).toBeDefined()
    expect(Array.isArray(results)).toBe(true)
  })

  test('resolves backend for schema/model', async () => {
    // Given: Environment with backendRegistry
    // When: Executing query
    const results = await collection.query()
      .where({ status: 'active' })
      .toArray()

    // Then: Should delegate execution to resolved backend (MemoryBackend)
    expect(results.length).toBe(1)
  })

  test('throws error if no backend found and no default', () => {
    // Given: Registry without default backend
    const emptyRegistry = new BackendRegistry()
    const badEnv = {
      services: {
        persistence: {} as any,
        backendRegistry: emptyRegistry
      },
      context: {
        schemaName: 'test-schema'
      }
    }
    const badCollection = TestCollection.create({}, badEnv)
    badCollection.add({ id: '1', name: 'Alice', status: 'active', age: 30, tags: [] })

    // When: Executing query without default backend
    // Then: Should throw descriptive error
    expect(async () => {
      await badCollection.query().toArray()
    }).toThrow()
  })
})

// ============================================================================
// Test: Query Builder Immutability
// ============================================================================

describe('query builder is immutable', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30, tags: [] })
    collection.add({ id: '2', name: 'Bob', status: 'inactive', age: 25, tags: [] })
  })

  test('each method returns NEW instance', () => {
    // Given: IQueryable builder instance
    const builder1 = collection.query()

    // When: Calling chainable methods
    const builder2 = builder1.where({ status: 'active' })
    const builder3 = builder2.orderBy('name', 'asc')
    const builder4 = builder3.skip(1)
    const builder5 = builder4.take(5)

    // Then: Each should be different instance
    expect(builder2).not.toBe(builder1)
    expect(builder3).not.toBe(builder2)
    expect(builder4).not.toBe(builder3)
    expect(builder5).not.toBe(builder4)
  })

  test('original builder unchanged', async () => {
    // Given: IQueryable builder
    const original = collection.query()

    // When: Creating modified builder
    const modified = original.where({ status: 'active' })

    // Then: Original should still return all items
    const originalResults = await original.toArray()
    const modifiedResults = await modified.toArray()

    expect(originalResults.length).toBe(2)
    expect(modifiedResults.length).toBe(1)
  })

  test('can branch from same builder', async () => {
    // Given: Base builder
    const base = collection.query()

    // When: Creating two branches
    const branch1 = base.where({ status: 'active' })
    const branch2 = base.where({ status: 'inactive' })

    // Then: Each branch should work independently
    const results1 = await branch1.toArray()
    const results2 = await branch2.toArray()

    expect(results1.length).toBe(1)
    expect(results1[0].name).toBe('Alice')
    expect(results2.length).toBe(1)
    expect(results2[0].name).toBe('Bob')
  })
})
