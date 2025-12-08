/**
 * Tests for CollectionPersistable mixin (Unit 4: Persistable Mixin)
 *
 * These tests verify the persistence actions added to MST collections via composition.
 * Uses NullPersistence (in-memory) for testing - no file I/O, no risk to .schemas directory.
 *
 * Testing Strategy:
 * - Hand-crafted mock collections with modelName view (closure-based)
 * - Mock IEnvironment with NullPersistence
 * - No dependency on schema generation pipeline (tested in Unit 5)
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { types, getSnapshot } from 'mobx-state-tree'
import { CollectionPersistable } from '../../src/composition/persistable'
import { NullPersistence } from '../../src/persistence/null'
import type { IEnvironment } from '../../src/environment/types'

describe('CollectionPersistable Mixin (Unit 4)', () => {
  // Mock entity model for testing
  const Task = types.model('Task', {
    id: types.identifier,
    title: types.string,
    completed: types.boolean
  })

  /**
   * Create a mock collection with closure-based modelName view.
   * Simulates what Unit 5 will generate from schema.
   */
  function createMockCollection(modelName: string) {
    const BaseCollection = types.model({
      items: types.map(Task)
    })
    .views(self => ({
      // Closure captures modelName (NOT string manipulation)
      get modelName() {
        return modelName
      },
      get(id: string) {
        return self.items.get(id)
      },
      all() {
        return Array.from(self.items.values())
      }
    }))
    .actions(self => ({
      add(item: any) {
        self.items.put(item)
      },
      remove(id: string) {
        self.items.delete(id)
      },
      update(id: string, changes: Partial<{ title: string; completed: boolean }>) {
        const item = self.items.get(id)
        if (item) {
          Object.assign(item, changes)
        }
      }
    }))

    // Compose with persistable mixin
    return types.compose(BaseCollection, CollectionPersistable).named(`${modelName}Collection`)
  }

  /**
   * Create mock environment with NullPersistence.
   * Each test gets a fresh instance for isolation.
   */
  function createMockEnvironment(location?: string): IEnvironment {
    return {
      services: {
        persistence: new NullPersistence()
      },
      context: {
        schemaName: 'test-schema',  // Stable string reference (not entity)
        location
      }
    }
  }

  describe('persistenceContext View', () => {
    test('derives correct values from environment', () => {
      const TaskCollection = createMockCollection('Task')
      const env = createMockEnvironment('/workspace/test')
      const collection = TaskCollection.create({}, env)

      expect(collection.persistenceContext).toEqual({
        schemaName: 'test-schema',
        modelName: 'Task',
        location: '/workspace/test'
      })
    })

    test('handles missing location (undefined)', () => {
      const TaskCollection = createMockCollection('Task')
      const env = createMockEnvironment()  // No location
      const collection = TaskCollection.create({}, env)

      expect(collection.persistenceContext).toEqual({
        schemaName: 'test-schema',
        modelName: 'Task',
        location: undefined
      })
    })

    test('modelName comes from closure, not string manipulation', () => {
      const UserCollection = createMockCollection('User')
      const env = createMockEnvironment()
      const collection = UserCollection.create({}, env)

      // Verify closure-based modelName
      expect(collection.persistenceContext.modelName).toBe('User')
      expect(collection.modelName).toBe('User')
    })
  })

  describe('saveAll and loadAll', () => {
    test('round-trip successfully with data', async () => {
      const TaskCollection = createMockCollection('Task')
      const env = createMockEnvironment('/workspace/test')
      const collection = TaskCollection.create({}, env)

      // Add some data
      collection.add({ id: '1', title: 'Task 1', completed: false })
      collection.add({ id: '2', title: 'Task 2', completed: true })

      // Save
      await collection.saveAll()

      // Create new collection instance (simulates fresh load)
      const collection2 = TaskCollection.create({}, env)

      // Load
      await collection2.loadAll()

      // Verify
      expect(collection2.all().length).toBe(2)
      expect(collection2.get('1')?.title).toBe('Task 1')
      expect(collection2.get('1')?.completed).toBe(false)
      expect(collection2.get('2')?.title).toBe('Task 2')
      expect(collection2.get('2')?.completed).toBe(true)
    })

    test('loadAll handles missing collection gracefully', async () => {
      const TaskCollection = createMockCollection('Task')
      const env = createMockEnvironment('/workspace/test')
      const collection = TaskCollection.create({}, env)

      // Load without saving first
      await collection.loadAll()

      // Should remain empty, not throw
      expect(collection.all().length).toBe(0)
    })

    test('loadAll overwrites existing data', async () => {
      const TaskCollection = createMockCollection('Task')
      const env = createMockEnvironment('/workspace/test')

      // First collection: save data
      const collection1 = TaskCollection.create({}, env)
      collection1.add({ id: '1', title: 'Original', completed: false })
      await collection1.saveAll()

      // Second collection: different data, then load
      const collection2 = TaskCollection.create({}, env)
      collection2.add({ id: '99', title: 'Temporary', completed: true })
      expect(collection2.all().length).toBe(1)

      await collection2.loadAll()

      // Verify: loaded data replaces temporary data
      expect(collection2.all().length).toBe(1)
      expect(collection2.get('1')?.title).toBe('Original')
      expect(collection2.get('99')).toBeUndefined()
    })
  })

  describe('saveOne and loadById', () => {
    test('round-trip successfully with single entity', async () => {
      const TaskCollection = createMockCollection('Task')
      const env = createMockEnvironment('/workspace/test')
      const collection = TaskCollection.create({}, env)

      // Add and save single entity
      collection.add({ id: '1', title: 'Task 1', completed: false })
      await collection.saveOne('1')

      // Create new collection instance
      const collection2 = TaskCollection.create({}, env)

      // Load single entity
      const loaded = await collection2.loadById('1')

      // Verify
      expect(loaded).toBeDefined()
      expect(loaded?.title).toBe('Task 1')
      expect(loaded?.completed).toBe(false)
      expect(collection2.all().length).toBe(1)
    })

    test('loadById returns undefined when entity not found', async () => {
      const TaskCollection = createMockCollection('Task')
      const env = createMockEnvironment('/workspace/test')
      const collection = TaskCollection.create({}, env)

      const result = await collection.loadById('nonexistent')
      expect(result).toBeUndefined()
    })

    test('loadById adds entity to collection', async () => {
      const TaskCollection = createMockCollection('Task')
      const env = createMockEnvironment('/workspace/test')

      // Save entity
      const collection1 = TaskCollection.create({}, env)
      collection1.add({ id: '1', title: 'Task 1', completed: false })
      await collection1.saveOne('1')

      // Load into new collection
      const collection2 = TaskCollection.create({}, env)
      expect(collection2.all().length).toBe(0)

      await collection2.loadById('1')

      // Verify entity was added
      expect(collection2.all().length).toBe(1)
      expect(collection2.get('1')).toBeDefined()
    })

    test('saveOne throws when entity not in collection', async () => {
      const TaskCollection = createMockCollection('Task')
      const env = createMockEnvironment('/workspace/test')
      const collection = TaskCollection.create({}, env)

      await expect(collection.saveOne('nonexistent')).rejects.toThrow(
        'Entity nonexistent not found in collection'
      )
    })

    test('saveOne updates existing entity in persistence', async () => {
      const TaskCollection = createMockCollection('Task')
      const env = createMockEnvironment('/workspace/test')
      const collection = TaskCollection.create({}, env)

      // Save initial version
      collection.add({ id: '1', title: 'Original', completed: false })
      await collection.saveOne('1')

      // Modify and save again
      collection.update('1', { title: 'Updated', completed: true })
      await collection.saveOne('1')

      // Load in new instance
      const collection2 = TaskCollection.create({}, env)
      await collection2.loadById('1')

      expect(collection2.get('1')?.title).toBe('Updated')
      expect(collection2.get('1')?.completed).toBe(true)
    })
  })

  describe('Workspace Isolation', () => {
    test('different locations maintain separate data', async () => {
      const TaskCollection = createMockCollection('Task')

      // Two workspaces, same schema
      const env1 = createMockEnvironment('/workspace/A')
      const env2 = createMockEnvironment('/workspace/B')

      const collection1 = TaskCollection.create({}, env1)
      const collection2 = TaskCollection.create({}, env2)

      // Save different data to each
      collection1.add({ id: '1', title: 'Workspace A Task', completed: false })
      collection2.add({ id: '2', title: 'Workspace B Task', completed: true })

      await collection1.saveAll()
      await collection2.saveAll()

      // Verify isolation by loading in fresh instances
      const loadedA = TaskCollection.create({}, env1)
      const loadedB = TaskCollection.create({}, env2)

      await loadedA.loadAll()
      await loadedB.loadAll()

      expect(loadedA.all().length).toBe(1)
      expect(loadedA.get('1')?.title).toBe('Workspace A Task')
      expect(loadedA.get('2')).toBeUndefined()

      expect(loadedB.all().length).toBe(1)
      expect(loadedB.get('2')?.title).toBe('Workspace B Task')
      expect(loadedB.get('1')).toBeUndefined()
    })

    test('loadById respects workspace isolation', async () => {
      const TaskCollection = createMockCollection('Task')

      const env1 = createMockEnvironment('/workspace/A')
      const env2 = createMockEnvironment('/workspace/B')

      // Save same ID in different workspaces
      const collection1 = TaskCollection.create({}, env1)
      const collection2 = TaskCollection.create({}, env2)

      collection1.add({ id: 'shared-id', title: 'Workspace A Version', completed: false })
      collection2.add({ id: 'shared-id', title: 'Workspace B Version', completed: true })

      await collection1.saveOne('shared-id')
      await collection2.saveOne('shared-id')

      // Load in fresh instances
      const loadedA = TaskCollection.create({}, env1)
      const loadedB = TaskCollection.create({}, env2)

      const taskA = await loadedA.loadById('shared-id')
      const taskB = await loadedB.loadById('shared-id')

      expect(taskA?.title).toBe('Workspace A Version')
      expect(taskA?.completed).toBe(false)
      expect(taskB?.title).toBe('Workspace B Version')
      expect(taskB?.completed).toBe(true)
    })
  })

  describe('Model Name Isolation', () => {
    test('different modelNames maintain separate data', async () => {
      const TaskCollection = createMockCollection('Task')
      const ProjectCollection = createMockCollection('Project')

      const env = createMockEnvironment('/workspace/test')

      const tasks = TaskCollection.create({}, env)
      const projects = ProjectCollection.create({}, env)

      // Verify different modelNames
      expect(tasks.persistenceContext.modelName).toBe('Task')
      expect(projects.persistenceContext.modelName).toBe('Project')

      // Save data to each
      tasks.add({ id: '1', title: 'Task 1', completed: false })
      await tasks.saveAll()

      projects.add({ id: '1', title: 'Project 1', completed: true })
      await projects.saveAll()

      // Load in fresh instances
      const loadedTasks = TaskCollection.create({}, env)
      const loadedProjects = ProjectCollection.create({}, env)

      await loadedTasks.loadAll()
      await loadedProjects.loadAll()

      // Verify isolation
      expect(loadedTasks.get('1')?.title).toBe('Task 1')
      expect(loadedProjects.get('1')?.title).toBe('Project 1')
    })
  })
})
