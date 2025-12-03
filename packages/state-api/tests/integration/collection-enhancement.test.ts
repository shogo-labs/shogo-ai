/**
 * Integration tests for Unit 5: Collection Enhancement with Persistence
 *
 * These tests verify that collections generated from schemas have:
 * - modelName view (closure-based)
 * - Persistence actions (loadAll, loadById, saveAll, saveOne)
 * - Correct persistenceContext derivation
 * - End-to-end save/load functionality
 */
import { describe, test, expect } from 'bun:test'
import { scope } from 'arktype'
import { enhancedJsonSchemaToMST } from '../../src/schematic/enhanced-json-schema-to-mst'
import { arkTypeToEnhancedJsonSchema } from '../../src/schematic/arktype-to-json-schema'
import { NullPersistence } from '../../src/persistence/null'
import { types } from 'mobx-state-tree'
import { CollectionPersistable } from '../../src/composition/persistable'
import type { IEnvironment } from '../../src/environment/types'

describe('Unit 5: Collection Enhancement Integration', () => {
  // Helper to create enhanceCollections callback
  const enhanceCollections = (baseCollections: Record<string, any>) => {
    const enhanced: Record<string, any> = {}
    for (const [name, model] of Object.entries(baseCollections)) {
      enhanced[name] = types.compose(model, CollectionPersistable).named(name)
    }
    return enhanced
  }

  test('generated collections have modelName view from closure', () => {
    // Given: Simple schema
    const TaskDomain = scope({
      Task: {
        id: 'string.uuid',
        title: 'string'
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(TaskDomain)
    const result = enhancedJsonSchemaToMST(enhanced, {
      enhanceCollections
    })

    // When: Creating store with environment
    const env: IEnvironment = {
      services: { persistence: new NullPersistence() },
      context: { schema: { name: 'test-schema' } as any }
    }
    const store = result.createStore(env)

    // Then: Collection has modelName view from closure (not string manipulation)
    expect(store.taskCollection.modelName).toBe('Task')
  })

  test('generated collections have persistence actions', () => {
    // Given: Simple schema
    const TaskDomain = scope({
      Task: {
        id: 'string.uuid',
        title: 'string'
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(TaskDomain)
    const result = enhancedJsonSchemaToMST(enhanced, {
      enhanceCollections
    })

    const env: IEnvironment = {
      services: { persistence: new NullPersistence() },
      context: { schema: { name: 'test-schema' } as any }
    }
    const store = result.createStore(env)

    // Then: Collection has persistence methods from CollectionPersistable mixin
    expect(typeof store.taskCollection.loadAll).toBe('function')
    expect(typeof store.taskCollection.loadById).toBe('function')
    expect(typeof store.taskCollection.saveAll).toBe('function')
    expect(typeof store.taskCollection.saveOne).toBe('function')
    expect(typeof store.taskCollection.persistenceContext).toBe('object')
  })

  test('persistenceContext derives correctly from environment', () => {
    // Given: Schema with environment
    const TaskDomain = scope({
      Task: {
        id: 'string.uuid',
        title: 'string'
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(TaskDomain)
    const result = enhancedJsonSchemaToMST(enhanced, {
      enhanceCollections
    })

    const env: IEnvironment = {
      services: { persistence: new NullPersistence() },
      context: {
        schema: { name: 'project-schema' } as any,
        location: '/workspace/test'
      }
    }
    const store = result.createStore(env)

    // Then: Persistence context is derived correctly
    expect(store.taskCollection.persistenceContext).toEqual({
      schemaName: 'project-schema',
      modelName: 'Task',
      location: '/workspace/test'
    })
  })

  test('round-trip save and load works with generated collections', async () => {
    // Given: Schema and data
    const TaskDomain = scope({
      Task: {
        id: 'string.uuid',
        title: 'string',
        completed: 'boolean'
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(TaskDomain)
    const result = enhancedJsonSchemaToMST(enhanced, {
      enhanceCollections
    })

    const persistence = new NullPersistence()
    const env: IEnvironment = {
      services: { persistence },
      context: { schema: { name: 'test' } as any }
    }

    // When: Create, add data, save
    const store1 = result.createStore(env)
    store1.taskCollection.add({
      id: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Test Task',
      completed: false
    })
    await store1.taskCollection.saveAll()

    // Then: Load in fresh store
    const store2 = result.createStore(env)
    await store2.taskCollection.loadAll()

    expect(store2.taskCollection.all().length).toBe(1)
    expect(store2.taskCollection.get('550e8400-e29b-41d4-a716-446655440000')?.title).toBe('Test Task')
  })

  test('multiple collections maintain separate persistence', async () => {
    // Given: Multi-entity schema
    const Domain = scope({
      Task: {
        id: 'string.uuid',
        title: 'string'
      },
      Project: {
        id: 'string.uuid',
        name: 'string'
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(Domain)
    const result = enhancedJsonSchemaToMST(enhanced, {
      enhanceCollections
    })

    const env: IEnvironment = {
      services: { persistence: new NullPersistence() },
      context: { schema: { name: 'test' } as any }
    }

    // When: Save different data to each collection
    const store = result.createStore(env)
    store.taskCollection.add({ id: '550e8400-e29b-41d4-a716-446655440000', title: 'Task 1' })
    store.projectCollection.add({ id: '550e8400-e29b-41d4-a716-446655440001', name: 'Project 1' })

    await store.taskCollection.saveAll()
    await store.projectCollection.saveAll()

    // Then: Load in fresh store and verify isolation
    const store2 = result.createStore(env)
    await store2.taskCollection.loadAll()
    await store2.projectCollection.loadAll()

    expect(store2.taskCollection.get('550e8400-e29b-41d4-a716-446655440000')?.title).toBe('Task 1')
    expect(store2.projectCollection.get('550e8400-e29b-41d4-a716-446655440001')?.name).toBe('Project 1')
    expect(store2.taskCollection.all().length).toBe(1)
    expect(store2.projectCollection.all().length).toBe(1)
  })

  test('workspace isolation works with enhanced collections', async () => {
    // Given: Same schema, different workspaces
    const TaskDomain = scope({
      Task: {
        id: 'string.uuid',
        title: 'string'
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(TaskDomain)
    const result = enhancedJsonSchemaToMST(enhanced, {
      enhanceCollections
    })

    const persistence = new NullPersistence()
    const envA: IEnvironment = {
      services: { persistence },
      context: {
        schema: { name: 'test' } as any,
        location: '/workspace/A'
      }
    }
    const envB: IEnvironment = {
      services: { persistence },
      context: {
        schema: { name: 'test' } as any,
        location: '/workspace/B'
      }
    }

    // When: Save different data to each workspace
    const storeA = result.createStore(envA)
    const storeB = result.createStore(envB)

    storeA.taskCollection.add({ id: '550e8400-e29b-41d4-a716-446655440000', title: 'Workspace A Task' })
    storeB.taskCollection.add({ id: '550e8400-e29b-41d4-a716-446655440001', title: 'Workspace B Task' })

    await storeA.taskCollection.saveAll()
    await storeB.taskCollection.saveAll()

    // Then: Load in fresh stores and verify isolation
    const loadedA = result.createStore(envA)
    const loadedB = result.createStore(envB)

    await loadedA.taskCollection.loadAll()
    await loadedB.taskCollection.loadAll()

    expect(loadedA.taskCollection.all().length).toBe(1)
    expect(loadedA.taskCollection.get('550e8400-e29b-41d4-a716-446655440000')?.title).toBe('Workspace A Task')

    expect(loadedB.taskCollection.all().length).toBe(1)
    expect(loadedB.taskCollection.get('550e8400-e29b-41d4-a716-446655440001')?.title).toBe('Workspace B Task')
  })
})
