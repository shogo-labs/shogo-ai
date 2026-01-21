/**
 * Tests for buildEnhanceCollections with CollectionQueryable support
 *
 * Generated from TestSpecification: test-queryable-enhance-collections
 *
 * Tests that buildEnhanceCollections properly composes CollectionQueryable
 * after CollectionPersistable and before user enhancements.
 */

import { describe, test, expect } from 'bun:test'
import { types } from 'mobx-state-tree'
import { buildEnhanceCollections } from '../enhance-collections'

describe('buildEnhanceCollections composes CollectionQueryable', () => {
  test('enableQueryable: true composes CollectionQueryable', () => {
    // Given: buildEnhanceCollections with enableQueryable: true
    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model({ id: types.identifier }))
    }).views(self => ({
      get modelName() { return 'Test' },
      all() { return Array.from(self.items.values()) }
    }))

    const enhance = buildEnhanceCollections(undefined, true, true)

    // When: Enhancing collection models
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Collection should have .query() method from CollectionQueryable
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.query).toBeDefined()
    expect(typeof instance.query).toBe('function')
  })

  test('enableQueryable: false does not compose CollectionQueryable', () => {
    // Given: buildEnhanceCollections with enableQueryable: false
    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model({ id: types.identifier }))
    })

    const enhance = buildEnhanceCollections(undefined, true, false)

    // When: Enhancing collection models
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Collection should NOT have .query() method
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.query).toBeUndefined()
  })

  test('CollectionQueryable composed after CollectionPersistable', () => {
    // Given: buildEnhanceCollections with both persistence and queryable
    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model({ id: types.identifier }))
    }).views(self => ({
      get modelName() { return 'Test' },
      all() { return Array.from(self.items.values()) },
      get persistenceContext() {
        return {
          schemaName: 'test',
          modelName: 'Test',
          location: '.',
          persistenceConfig: undefined,
          schemaDefs: undefined
        }
      }
    }))

    const enhance = buildEnhanceCollections(undefined, true, true)

    // When: Enhancing collection
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Should have both persistence and query methods
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.loadAll).toBeDefined() // From CollectionPersistable
    expect(instance.query).toBeDefined() // From CollectionQueryable
  })

  test('CollectionQueryable composed before user enhancements', () => {
    // Given: User enhancement function
    const userEnhance = (cols: Record<string, any>) => {
      const result: Record<string, any> = {}
      for (const [name, model] of Object.entries(cols)) {
        result[name] = model.views((self: any) => ({
          customMethod() { return 'user-defined' }
        }))
      }
      return result
    }

    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model({ id: types.identifier }))
    }).views(self => ({
      get modelName() { return 'Test' },
      all() { return Array.from(self.items.values()) }
    }))

    const enhance = buildEnhanceCollections(userEnhance, true, true)

    // When: Enhancing with user function
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Should have both query and custom methods
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.query).toBeDefined()
    expect(instance.customMethod).toBeDefined()
    expect(instance.customMethod()).toBe('user-defined')
  })

  test('enableQueryable defaults to true', () => {
    // Given: buildEnhanceCollections without explicit enableQueryable
    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model({ id: types.identifier }))
    }).views(self => ({
      get modelName() { return 'Test' },
      all() { return Array.from(self.items.values()) }
    }))

    const enhance = buildEnhanceCollections(undefined, true) // enableQueryable not specified

    // When: Enhancing collection
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Should have .query() method (default true)
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.query).toBeDefined()
  })
})

// ============================================================================
// Item 2: CollectionMutatable Auto-Composition Tests (Phase 2 Refinement)
// ============================================================================

describe('buildEnhanceCollections composes CollectionMutatable', () => {
  test('enableMutatable: true composes CollectionMutatable', () => {
    // Given: buildEnhanceCollections with enableMutatable: true
    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model('TestItem', { id: types.identifier, name: types.string }))
    }).views(self => ({
      get modelName() { return 'TestItem' },
      all() { return Array.from(self.items.values()) },
      get(id: string) { return self.items.get(id) }
    })).actions(self => ({
      add(item: any) { self.items.put(item); return self.items.get(item.id) },
      remove(item: any) { self.items.delete(item.id) },
      clear() { self.items.clear() }
    }))

    const enhance = buildEnhanceCollections(undefined, true, true, true)

    // When: Enhancing collection models
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Collection should have mutation methods from CollectionMutatable
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.insertOne).toBeDefined()
    expect(typeof instance.insertOne).toBe('function')
    expect(instance.updateOne).toBeDefined()
    expect(typeof instance.updateOne).toBe('function')
    expect(instance.deleteOne).toBeDefined()
    expect(typeof instance.deleteOne).toBe('function')
  })

  test('enableMutatable: false does not compose CollectionMutatable', () => {
    // Given: buildEnhanceCollections with enableMutatable: false
    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model({ id: types.identifier }))
    })

    const enhance = buildEnhanceCollections(undefined, true, true, true, false)

    // When: Enhancing collection models
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Collection should NOT have mutation methods
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.insertOne).toBeUndefined()
    expect(instance.updateOne).toBeUndefined()
    expect(instance.deleteOne).toBeUndefined()
  })

  test('CollectionMutatable composed after CollectionQueryable', () => {
    // Given: buildEnhanceCollections with queryable and mutatable
    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model('TestItem', { id: types.identifier, name: types.string }))
    }).views(self => ({
      get modelName() { return 'TestItem' },
      all() { return Array.from(self.items.values()) },
      get(id: string) { return self.items.get(id) }
    })).actions(self => ({
      add(item: any) { self.items.put(item); return self.items.get(item.id) },
      remove(item: any) { self.items.delete(item.id) },
      clear() { self.items.clear() }
    }))

    const enhance = buildEnhanceCollections(undefined, true, true, true)

    // When: Enhancing collection
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Should have both query and mutation methods
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.query).toBeDefined() // From CollectionQueryable
    expect(instance.insertOne).toBeDefined() // From CollectionMutatable
    expect(instance.updateOne).toBeDefined() // From CollectionMutatable
    expect(instance.deleteOne).toBeDefined() // From CollectionMutatable
  })

  test('Composition order: Persistable → Queryable → Mutatable → User', () => {
    // Given: User enhancement function
    const userEnhance = (cols: Record<string, any>) => {
      const result: Record<string, any> = {}
      for (const [name, model] of Object.entries(cols)) {
        result[name] = model.views((self: any) => ({
          customView() { return 'user-defined' }
        }))
      }
      return result
    }

    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model('TestItem', { id: types.identifier, name: types.string }))
    }).views(self => ({
      get modelName() { return 'TestItem' },
      all() { return Array.from(self.items.values()) },
      get(id: string) { return self.items.get(id) }
    })).actions(self => ({
      add(item: any) { self.items.put(item); return self.items.get(item.id) },
      remove(item: any) { self.items.delete(item.id) },
      clear() { self.items.clear() }
    }))

    const enhance = buildEnhanceCollections(userEnhance, true, true, true)

    // When: Enhancing with all options
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Should have all methods in correct order
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.loadAll).toBeDefined() // From CollectionPersistable
    expect(instance.query).toBeDefined() // From CollectionQueryable
    expect(instance.insertOne).toBeDefined() // From CollectionMutatable
    expect(instance.customView).toBeDefined() // From user enhancement
    expect(instance.customView()).toBe('user-defined')
  })

  test('enableMutatable defaults to true', () => {
    // Given: buildEnhanceCollections without explicit enableMutatable
    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model('TestItem', { id: types.identifier, name: types.string }))
    }).views(self => ({
      get modelName() { return 'TestItem' },
      all() { return Array.from(self.items.values()) },
      get(id: string) { return self.items.get(id) }
    })).actions(self => ({
      add(item: any) { self.items.put(item); return self.items.get(item.id) },
      remove(item: any) { self.items.delete(item.id) },
      clear() { self.items.clear() }
    }))

    // enableMutatable not specified (defaults to true)
    const enhance = buildEnhanceCollections(undefined, true, true)

    // When: Enhancing collection
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Should have mutation methods (default true)
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.insertOne).toBeDefined()
    expect(instance.updateOne).toBeDefined()
    expect(instance.deleteOne).toBeDefined()
  })

  test('batch mutation methods available when mutatable enabled', () => {
    // Given: buildEnhanceCollections with mutatable
    const BaseCollection = types.model('TestCollection', {
      items: types.map(types.model('TestItem', { id: types.identifier, name: types.string }))
    }).views(self => ({
      get modelName() { return 'TestItem' },
      all() { return Array.from(self.items.values()) },
      get(id: string) { return self.items.get(id) }
    })).actions(self => ({
      add(item: any) { self.items.put(item); return self.items.get(item.id) },
      remove(item: any) { self.items.delete(item.id) },
      clear() { self.items.clear() }
    }))

    const enhance = buildEnhanceCollections(undefined, true, true, true)

    // When: Enhancing collection
    const enhanced = enhance!({ TestCollection: BaseCollection })

    // Then: Should have batch mutation methods
    const instance = enhanced.TestCollection.create({}, {
      services: {
        persistence: {} as any,
        backendRegistry: {} as any
      },
      context: { schemaName: 'test' }
    })
    expect(instance.insertMany).toBeDefined()
    expect(typeof instance.insertMany).toBe('function')
    expect(instance.updateMany).toBeDefined()
    expect(typeof instance.updateMany).toBe('function')
    expect(instance.deleteMany).toBeDefined()
    expect(typeof instance.deleteMany).toBe('function')
  })
})
