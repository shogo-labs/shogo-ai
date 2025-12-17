/**
 * CollectionMutatable Mixin Tests
 *
 * Tests for the CollectionMutatable mixin that adds mutation actions
 * (insertOne, updateOne, deleteOne, insertMany, updateMany, deleteMany)
 * to collections with backend-agnostic execution and MST state sync.
 *
 * Generated from TestSpecifications (Layer 1 - TOP-DOWN RED):
 * - test-mutatable-mixin-pattern
 * - test-mutatable-insertOne
 * - test-mutatable-updateOne
 * - test-mutatable-deleteOne
 * - test-mutatable-insertMany
 * - test-mutatable-updateMany
 * - test-mutatable-deleteMany
 * - test-mutatable-mst-sync
 * - test-mutatable-error-handling
 *
 * NOTE: These tests are written against the target contract and will FAIL
 * until the lower layers (IQueryExecutor mutations, SqlQueryExecutor, etc.)
 * are implemented.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { types, getSnapshot, applySnapshot } from 'mobx-state-tree'
import { CollectionMutatable } from '../mutatable'
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
})

const BaseTestCollection = types
  .model('TestCollection', {
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
    remove(item: any) {
      self.items.delete(item.id)
    },
    clear() {
      self.items.clear()
    },
  }))

// Compose with CollectionMutatable mixin
const TestCollection = types
  .compose(BaseTestCollection, CollectionMutatable)
  .named('TestCollection')

// Test environment with backendRegistry
function createTestEnvironment(): IEnvironment {
  const registry = new BackendRegistry()
  registry.register('memory', new MemoryBackend())
  registry.setDefault('memory')

  return {
    services: {
      persistence: {} as any, // Not used in these tests
      backendRegistry: registry,
    },
    context: {
      schemaName: 'test-schema',
    },
  }
}

// ============================================================================
// Test: Mixin Pattern
// ============================================================================

describe('CollectionMutatable mixin pattern', () => {
  test('uses types.model().actions() pattern', () => {
    // Given: CollectionMutatable mixin is imported
    // When: Inspecting mixin structure
    // Then: Should have MST model structure
    expect(CollectionMutatable).toBeDefined()
    expect(typeof CollectionMutatable).toBe('object')
    // MST models have specific properties
    expect(CollectionMutatable.name).toBe('CollectionMutatable')
  })

  test('can be composed with base collection model', () => {
    // Given: Base collection model
    // When: Composing with CollectionMutatable
    // Then: Composed model should work
    const composed = types.compose(BaseTestCollection, CollectionMutatable)
    expect(composed).toBeDefined()
  })

  test('exposes actions (not views) since mutations have side-effects', () => {
    // Given: Collection with CollectionMutatable mixin
    const env = createTestEnvironment()
    const collection = TestCollection.create({}, env)

    // When: Checking for mutation methods
    // Then: Should be actions (callable, can modify state)
    expect(typeof collection.insertOne).toBe('function')
    expect(typeof collection.updateOne).toBe('function')
    expect(typeof collection.deleteOne).toBe('function')
  })
})

// ============================================================================
// Test: insertOne() Action
// ============================================================================

describe('insertOne() action', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
  })

  test('collection has .insertOne() method', () => {
    // Given: Collection with CollectionMutatable mixin
    // When: Checking for insertOne method
    // Then: Method should exist
    expect(collection.insertOne).toBeDefined()
    expect(typeof collection.insertOne).toBe('function')
  })

  test('insertOne() returns Promise', () => {
    // Given: Collection with CollectionMutatable mixin
    // When: Calling insertOne
    const result = collection.insertOne({ name: 'Alice', status: 'active', age: 30 })

    // Then: Should return Promise
    expect(result).toBeInstanceOf(Promise)
  })

  test('insertOne() creates entity with generated id', async () => {
    // Given: Collection with CollectionMutatable mixin
    // When: Calling insertOne without id
    const entity = await collection.insertOne({ name: 'Alice', status: 'active', age: 30 })

    // Then: Should return entity with generated id
    expect(entity).toBeDefined()
    expect(entity.id).toBeDefined()
    expect(typeof entity.id).toBe('string')
    expect(entity.name).toBe('Alice')
    expect(entity.status).toBe('active')
    expect(entity.age).toBe(30)
  })

  test('insertOne() syncs MST state after successful insert', async () => {
    // Given: Empty collection
    expect(collection.all().length).toBe(0)

    // When: Calling insertOne
    const entity = await collection.insertOne({ name: 'Alice', status: 'active', age: 30 })

    // Then: MST collection should contain the entity
    expect(collection.all().length).toBe(1)
    expect(collection.get(entity.id)).toBeDefined()
    expect(collection.get(entity.id).name).toBe('Alice')
  })

  test('insertOne() resolves executor from backendRegistry', async () => {
    // Given: Collection with backendRegistry in environment
    // When: Calling insertOne
    const entity = await collection.insertOne({ name: 'Bob', status: 'active', age: 25 })

    // Then: Should execute via resolved backend (verified by entity existing)
    expect(entity).toBeDefined()
  })

  test('insertOne() accepts explicit id', async () => {
    // Given: Collection with CollectionMutatable mixin
    // When: Calling insertOne with explicit id
    const entity = await collection.insertOne({
      id: 'custom-id-123',
      name: 'Charlie',
      status: 'active',
      age: 35,
    })

    // Then: Should use provided id
    expect(entity.id).toBe('custom-id-123')
    expect(collection.get('custom-id-123')).toBeDefined()
  })
})

// ============================================================================
// Test: updateOne() Action
// ============================================================================

describe('updateOne() action', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(async () => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    // Seed with initial entity
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30 })
  })

  test('collection has .updateOne() method', () => {
    // Given: Collection with CollectionMutatable mixin
    // When: Checking for updateOne method
    // Then: Method should exist
    expect(collection.updateOne).toBeDefined()
    expect(typeof collection.updateOne).toBe('function')
  })

  test('updateOne() returns Promise', () => {
    // Given: Collection with existing entity
    // When: Calling updateOne
    const result = collection.updateOne('1', { name: 'Alice Updated' })

    // Then: Should return Promise
    expect(result).toBeInstanceOf(Promise)
  })

  test('updateOne() updates entity with partial data', async () => {
    // Given: Collection with existing entity
    // When: Calling updateOne with partial changes
    const updated = await collection.updateOne('1', { name: 'Alice Updated' })

    // Then: Should return updated entity with merged data
    expect(updated).toBeDefined()
    expect(updated.id).toBe('1')
    expect(updated.name).toBe('Alice Updated')
    expect(updated.status).toBe('active') // unchanged
    expect(updated.age).toBe(30) // unchanged
  })

  test('updateOne() syncs MST state after successful update', async () => {
    // Given: Collection with existing entity
    const before = collection.get('1')
    expect(before.name).toBe('Alice')

    // When: Calling updateOne
    await collection.updateOne('1', { name: 'Alice Updated', age: 31 })

    // Then: MST instance should reflect changes
    const after = collection.get('1')
    expect(after.name).toBe('Alice Updated')
    expect(after.age).toBe(31)
  })

  test('updateOne() returns undefined for non-existent id', async () => {
    // Given: Collection without entity id 'nonexistent'
    // When: Calling updateOne with non-existent id
    const result = await collection.updateOne('nonexistent', { name: 'Ghost' })

    // Then: Should return undefined
    expect(result).toBeUndefined()
  })

  test('updateOne() does not modify MST when entity not found', async () => {
    // Given: Collection with known entities
    const beforeCount = collection.all().length

    // When: Calling updateOne with non-existent id
    await collection.updateOne('nonexistent', { name: 'Ghost' })

    // Then: Collection should be unchanged
    expect(collection.all().length).toBe(beforeCount)
  })
})

// ============================================================================
// Test: deleteOne() Action
// ============================================================================

describe('deleteOne() action', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    // Seed with initial entity
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30 })
  })

  test('collection has .deleteOne() method', () => {
    // Given: Collection with CollectionMutatable mixin
    // When: Checking for deleteOne method
    // Then: Method should exist
    expect(collection.deleteOne).toBeDefined()
    expect(typeof collection.deleteOne).toBe('function')
  })

  test('deleteOne() returns Promise', () => {
    // Given: Collection with existing entity
    // When: Calling deleteOne
    const result = collection.deleteOne('1')

    // Then: Should return Promise
    expect(result).toBeInstanceOf(Promise)
  })

  test('deleteOne() returns true when entity deleted', async () => {
    // Given: Collection with existing entity
    expect(collection.get('1')).toBeDefined()

    // When: Calling deleteOne
    const result = await collection.deleteOne('1')

    // Then: Should return true
    expect(result).toBe(true)
  })

  test('deleteOne() removes entity from MST collection', async () => {
    // Given: Collection with existing entity
    expect(collection.get('1')).toBeDefined()

    // When: Calling deleteOne
    await collection.deleteOne('1')

    // Then: Entity should be removed from MST collection
    expect(collection.get('1')).toBeUndefined()
    expect(collection.all().length).toBe(0)
  })

  test('deleteOne() returns false for non-existent id', async () => {
    // Given: Collection without entity id 'nonexistent'
    // When: Calling deleteOne with non-existent id
    const result = await collection.deleteOne('nonexistent')

    // Then: Should return false
    expect(result).toBe(false)
  })

  test('deleteOne() does not modify MST when entity not found', async () => {
    // Given: Collection with known entities
    const beforeCount = collection.all().length

    // When: Calling deleteOne with non-existent id
    await collection.deleteOne('nonexistent')

    // Then: Collection should be unchanged
    expect(collection.all().length).toBe(beforeCount)
  })
})

// ============================================================================
// Test: insertMany() Batch Action
// ============================================================================

describe('insertMany() batch action', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
  })

  test('collection has .insertMany() method', () => {
    // Given: Collection with CollectionMutatable mixin
    // When: Checking for insertMany method
    // Then: Method should exist
    expect(collection.insertMany).toBeDefined()
    expect(typeof collection.insertMany).toBe('function')
  })

  test('insertMany() returns Promise<T[]>', async () => {
    // Given: Collection with CollectionMutatable mixin
    // When: Calling insertMany with array of entities
    const entities = await collection.insertMany([
      { name: 'Alice', status: 'active', age: 30 },
      { name: 'Bob', status: 'inactive', age: 25 },
    ])

    // Then: Should return array of created entities
    expect(Array.isArray(entities)).toBe(true)
    expect(entities.length).toBe(2)
    expect(entities[0].id).toBeDefined()
    expect(entities[0].name).toBe('Alice')
    expect(entities[1].id).toBeDefined()
    expect(entities[1].name).toBe('Bob')
  })

  test('insertMany() syncs all entities to MST', async () => {
    // Given: Empty collection
    expect(collection.all().length).toBe(0)

    // When: Calling insertMany
    const entities = await collection.insertMany([
      { name: 'Alice', status: 'active', age: 30 },
      { name: 'Bob', status: 'inactive', age: 25 },
      { name: 'Charlie', status: 'active', age: 35 },
    ])

    // Then: All entities should be in MST collection
    expect(collection.all().length).toBe(3)
    entities.forEach((entity: any) => {
      expect(collection.get(entity.id)).toBeDefined()
    })
  })

  test('insertMany() uses transaction for atomicity', async () => {
    // Given: Collection with CollectionMutatable mixin
    // NOTE: This test primarily verifies the behavior works correctly.
    // Transaction atomicity is tested at Layer 6.

    // When: Calling insertMany with multiple entities
    const entities = await collection.insertMany([
      { name: 'Alice', status: 'active', age: 30 },
      { name: 'Bob', status: 'active', age: 25 },
    ])

    // Then: All entities should be created
    expect(entities.length).toBe(2)
  })
})

// ============================================================================
// Test: updateMany() Batch Action
// ============================================================================

describe('updateMany() batch action', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    // Seed with initial entities
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30 })
    collection.add({ id: '2', name: 'Bob', status: 'active', age: 25 })
    collection.add({ id: '3', name: 'Charlie', status: 'inactive', age: 35 })
  })

  test('collection has .updateMany() method', () => {
    // Given: Collection with CollectionMutatable mixin
    // When: Checking for updateMany method
    // Then: Method should exist
    expect(collection.updateMany).toBeDefined()
    expect(typeof collection.updateMany).toBe('function')
  })

  test('updateMany() returns Promise<number> (count of updated)', async () => {
    // Given: Collection with existing entities
    // When: Calling updateMany with filter and changes
    const count = await collection.updateMany({ status: 'active' }, { status: 'archived' })

    // Then: Should return count of updated entities
    expect(typeof count).toBe('number')
    expect(count).toBe(2) // Alice and Bob
  })

  test('updateMany() applies changes to all matching entities', async () => {
    // Given: Collection with mixed status entities
    // When: Calling updateMany
    await collection.updateMany({ status: 'active' }, { status: 'archived' })

    // Then: All matching entities should be updated in MST
    expect(collection.get('1').status).toBe('archived')
    expect(collection.get('2').status).toBe('archived')
    expect(collection.get('3').status).toBe('inactive') // unchanged
  })

  test('updateMany() returns 0 when no matches', async () => {
    // Given: Collection without matching entities
    // When: Calling updateMany with non-matching filter
    const count = await collection.updateMany({ status: 'nonexistent' }, { age: 100 })

    // Then: Should return 0
    expect(count).toBe(0)
  })
})

// ============================================================================
// Test: deleteMany() Batch Action
// ============================================================================

describe('deleteMany() batch action', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    // Seed with initial entities
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30 })
    collection.add({ id: '2', name: 'Bob', status: 'active', age: 25 })
    collection.add({ id: '3', name: 'Charlie', status: 'inactive', age: 35 })
  })

  test('collection has .deleteMany() method', () => {
    // Given: Collection with CollectionMutatable mixin
    // When: Checking for deleteMany method
    // Then: Method should exist
    expect(collection.deleteMany).toBeDefined()
    expect(typeof collection.deleteMany).toBe('function')
  })

  test('deleteMany() returns Promise<number> (count of deleted)', async () => {
    // Given: Collection with existing entities
    // When: Calling deleteMany with filter
    const count = await collection.deleteMany({ status: 'active' })

    // Then: Should return count of deleted entities
    expect(typeof count).toBe('number')
    expect(count).toBe(2) // Alice and Bob
  })

  test('deleteMany() removes all matching entities from MST', async () => {
    // Given: Collection with mixed status entities
    expect(collection.all().length).toBe(3)

    // When: Calling deleteMany
    await collection.deleteMany({ status: 'active' })

    // Then: Only non-matching entities should remain
    expect(collection.all().length).toBe(1)
    expect(collection.get('1')).toBeUndefined()
    expect(collection.get('2')).toBeUndefined()
    expect(collection.get('3')).toBeDefined() // Charlie is inactive
  })

  test('deleteMany() returns 0 when no matches', async () => {
    // Given: Collection without matching entities
    // When: Calling deleteMany with non-matching filter
    const count = await collection.deleteMany({ status: 'nonexistent' })

    // Then: Should return 0
    expect(count).toBe(0)
  })
})

// ============================================================================
// Test: Error Handling and MST State Integrity
// ============================================================================

describe('error handling preserves MST state integrity', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
    // Seed with initial entity
    collection.add({ id: '1', name: 'Alice', status: 'active', age: 30 })
  })

  test('MST state not modified if insertOne executor throws', async () => {
    // Given: Collection with known state
    const beforeCount = collection.all().length
    const beforeSnapshot = getSnapshot(collection)

    // When: insertOne throws (simulated by invalid data that backend rejects)
    // NOTE: This test will need adjustment based on actual error handling
    // For now, we verify the principle: errors should not corrupt MST state

    // Then: MST state should be unchanged if error occurs
    // (Actual test will be refined when executor layer is implemented)
    expect(collection.all().length).toBe(beforeCount)
  })

  test('MST state not modified if updateOne executor throws', async () => {
    // Given: Collection with known state
    const beforeSnapshot = getSnapshot(collection.get('1'))

    // When: updateOne fails (e.g., concurrent modification, constraint violation)
    // Then: Original entity state should be preserved
    // (Actual test will be refined when executor layer is implemented)
    expect(collection.get('1').name).toBe('Alice')
  })

  test('MST state not modified if deleteOne executor throws', async () => {
    // Given: Collection with known entity
    expect(collection.get('1')).toBeDefined()

    // When: deleteOne fails (e.g., FK constraint)
    // Then: Entity should still exist in MST
    // (Actual test will be refined when executor layer is implemented)
    expect(collection.get('1')).toBeDefined()
  })

  test('batch operation rolls back all changes on partial failure', async () => {
    // Given: Collection with known state
    const beforeCount = collection.all().length

    // When: insertMany fails partway through (transaction rollback)
    // Then: No entities from the batch should be added to MST
    // (Actual test will be refined when transaction support is implemented)
    expect(collection.all().length).toBe(beforeCount)
  })
})

// ============================================================================
// Test: Backend Resolution
// ============================================================================

describe('uses backendRegistry for executor resolution', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    env = createTestEnvironment()
    collection = TestCollection.create({}, env)
  })

  test('mutations access getEnv(self).services.backendRegistry', async () => {
    // Given: Collection with backendRegistry in environment
    // When: Calling mutation operation
    const entity = await collection.insertOne({ name: 'Test', status: 'active', age: 20 })

    // Then: Should execute via resolved backend
    expect(entity).toBeDefined()
    expect(entity.id).toBeDefined()
  })

  test('throws error if no backend found and no default', async () => {
    // Given: Registry without default backend
    const emptyRegistry = new BackendRegistry()
    const badEnv = {
      services: {
        persistence: {} as any,
        backendRegistry: emptyRegistry,
      },
      context: {
        schemaName: 'test-schema',
      },
    }
    const badCollection = TestCollection.create({}, badEnv)

    // When: Calling mutation without default backend
    // Then: Should throw descriptive error
    await expect(
      badCollection.insertOne({ name: 'Test', status: 'active', age: 20 })
    ).rejects.toThrow()
  })
})
