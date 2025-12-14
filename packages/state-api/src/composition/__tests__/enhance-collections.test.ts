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
