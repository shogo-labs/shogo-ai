/**
 * Phase 6 Integration Tests: Filter Passthrough
 *
 * Tests that filter parameters flow through the layers for partition pushdown:
 *   store.list({ filter })
 *     -> collection.loadAll(filter)
 *     -> persistence.loadCollection({ ...context, filter })
 *     -> FileSystemPersistence (partition pushdown optimization)
 *
 * These tests verify that partition-pushdown optimization works end-to-end,
 * not just at the persistence layer level.
 *
 * ⚠️ SAFETY WARNING: ALL tests MUST provide an explicit `location` parameter
 * to avoid writing to the production `.schemas` directory. NEVER test the
 * default location behavior by writing to `.schemas` - this can cause data loss!
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rm } from 'fs/promises'
import * as path from 'path'
import { types } from 'mobx-state-tree'
import { enhancedJsonSchemaToMST } from '../../src/schematic/enhanced-json-schema-to-mst'
import { CollectionPersistable } from '../../src/composition/persistable'
import { FileSystemPersistence } from '../../src/persistence/filesystem'
import { exists, readJson, writeJson } from '../../src/persistence/io'
import type { IEnvironment } from '../../src/environment/types'
import type { EnhancedJsonSchema } from '../../src/schematic/types'
import type { PersistenceContext } from '../../src/persistence/types'

describe('Phase 6: Filter Passthrough', () => {
  let tempDir: string
  let persistence: FileSystemPersistence

  beforeEach(() => {
    // Unique temp directory per test for parallel execution
    // NEVER use '.schemas' or any production path
    tempDir = `.test-schemas-${Date.now()}-${Math.random().toString(36).substring(7)}`
    persistence = new FileSystemPersistence()
  })

  afterEach(async () => {
    // Cleanup temp directory even if test fails
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  // Helper to create enhanceCollections callback that adds persistence mixin
  const enhanceCollections = (baseCollections: Record<string, any>) => {
    const enhanced: Record<string, any> = {}
    for (const [name, model] of Object.entries(baseCollections)) {
      enhanced[name] = types.compose(model, CollectionPersistable).named(name)
    }
    return enhanced
  }

  describe('6.1: loadAll(filter) passes filter to persistence service', () => {
    test('loadAll accepts optional filter parameter', async () => {
      // Given: Schema with flat strategy (filter applied in-memory)
      const schema: EnhancedJsonSchema = {
        $defs: {
          Task: {
            type: 'object',
            'x-original-name': 'Task',
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              title: { type: 'string' },
              status: { type: 'string' }
            },
            required: ['id', 'title', 'status']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }

      // Save some data
      const store1 = result.createStore(env)
      store1.taskCollection.add({ id: 't1', title: 'Task 1', status: 'open' })
      store1.taskCollection.add({ id: 't2', title: 'Task 2', status: 'closed' })
      store1.taskCollection.add({ id: 't3', title: 'Task 3', status: 'open' })
      await store1.taskCollection.saveAll()

      // When: Loading with filter
      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll({ status: 'open' })

      // Then: Only matching items should be in collection
      expect(store2.taskCollection.all().length).toBe(2)
      expect(store2.taskCollection.get('t1')).toBeDefined()
      expect(store2.taskCollection.get('t2')).toBeUndefined()
      expect(store2.taskCollection.get('t3')).toBeDefined()
    })

    test('loadAll without filter loads all items (backward compatible)', async () => {
      // Given: Stored data
      const schema: EnhancedJsonSchema = {
        $defs: {
          Task: {
            type: 'object',
            'x-original-name': 'Task',
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              title: { type: 'string' }
            },
            required: ['id', 'title']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }

      const store1 = result.createStore(env)
      store1.taskCollection.add({ id: 't1', title: 'Task 1' })
      store1.taskCollection.add({ id: 't2', title: 'Task 2' })
      await store1.taskCollection.saveAll()

      // When: Loading without filter
      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll()

      // Then: All items should be loaded
      expect(store2.taskCollection.all().length).toBe(2)
    })
  })

  describe('6.2: Partition pushdown optimization works end-to-end', () => {
    test('loadAll with filter on partitionKey loads only matching partition', async () => {
      // Given: Schema with array-per-partition strategy
      const schema: EnhancedJsonSchema = {
        $defs: {
          Task: {
            type: 'object',
            'x-original-name': 'Task',
            'x-persistence': {
              strategy: 'array-per-partition',
              partitionKey: 'projectId'
            },
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              title: { type: 'string' },
              projectId: { type: 'string' }
            },
            required: ['id', 'title', 'projectId']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }

      // Save partitioned data
      const store1 = result.createStore(env)
      store1.taskCollection.add({ id: 't1', title: 'Task A1', projectId: 'proj-A' })
      store1.taskCollection.add({ id: 't2', title: 'Task A2', projectId: 'proj-A' })
      store1.taskCollection.add({ id: 't3', title: 'Task B1', projectId: 'proj-B' })
      await store1.taskCollection.saveAll()

      // Verify partition files exist
      const modelDir = path.join(tempDir, 'test', 'data', 'Task')
      expect(await exists(path.join(modelDir, 'proj-A.json'))).toBe(true)
      expect(await exists(path.join(modelDir, 'proj-B.json'))).toBe(true)

      // When: Loading with filter on partitionKey
      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll({ projectId: 'proj-A' })

      // Then: Only tasks from proj-A partition should be loaded
      expect(store2.taskCollection.all().length).toBe(2)
      expect(store2.taskCollection.get('t1')?.projectId).toBe('proj-A')
      expect(store2.taskCollection.get('t2')?.projectId).toBe('proj-A')
      expect(store2.taskCollection.get('t3')).toBeUndefined()
    })

    test('filter on non-partition field loads all then filters', async () => {
      // Given: Schema with array-per-partition strategy
      const schema: EnhancedJsonSchema = {
        $defs: {
          Task: {
            type: 'object',
            'x-original-name': 'Task',
            'x-persistence': {
              strategy: 'array-per-partition',
              partitionKey: 'projectId'
            },
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              title: { type: 'string' },
              projectId: { type: 'string' },
              status: { type: 'string' }
            },
            required: ['id', 'title', 'projectId', 'status']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }

      // Save data across partitions
      const store1 = result.createStore(env)
      store1.taskCollection.add({ id: 't1', title: 'Task 1', projectId: 'proj-A', status: 'open' })
      store1.taskCollection.add({ id: 't2', title: 'Task 2', projectId: 'proj-B', status: 'closed' })
      store1.taskCollection.add({ id: 't3', title: 'Task 3', projectId: 'proj-A', status: 'closed' })
      await store1.taskCollection.saveAll()

      // When: Filter on non-partition field (status)
      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll({ status: 'closed' })

      // Then: Should find closed tasks from both partitions
      expect(store2.taskCollection.all().length).toBe(2)
      expect(store2.taskCollection.get('t2')?.status).toBe('closed')
      expect(store2.taskCollection.get('t3')?.status).toBe('closed')
    })

    test('combined partition and field filter works', async () => {
      // Given: Schema with array-per-partition strategy
      const schema: EnhancedJsonSchema = {
        $defs: {
          Task: {
            type: 'object',
            'x-original-name': 'Task',
            'x-persistence': {
              strategy: 'array-per-partition',
              partitionKey: 'projectId'
            },
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              title: { type: 'string' },
              projectId: { type: 'string' },
              status: { type: 'string' }
            },
            required: ['id', 'title', 'projectId', 'status']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }

      // Save data
      const store1 = result.createStore(env)
      store1.taskCollection.add({ id: 't1', title: 'Task 1', projectId: 'proj-A', status: 'open' })
      store1.taskCollection.add({ id: 't2', title: 'Task 2', projectId: 'proj-A', status: 'closed' })
      store1.taskCollection.add({ id: 't3', title: 'Task 3', projectId: 'proj-B', status: 'open' })
      await store1.taskCollection.saveAll()

      // When: Filter on both partition key AND other field
      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll({ projectId: 'proj-A', status: 'open' })

      // Then: Should load only proj-A partition, then filter by status
      expect(store2.taskCollection.all().length).toBe(1)
      expect(store2.taskCollection.get('t1')?.title).toBe('Task 1')
    })
  })

  describe('6.3: Entity-per-file with filter', () => {
    test('filter works with entity-per-file strategy (in-memory filter)', async () => {
      // Given: Schema with entity-per-file strategy
      const schema: EnhancedJsonSchema = {
        $defs: {
          Document: {
            type: 'object',
            'x-original-name': 'Document',
            'x-persistence': {
              strategy: 'entity-per-file'
            },
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              title: { type: 'string' },
              category: { type: 'string' }
            },
            required: ['id', 'title', 'category']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }

      // Save data
      const store1 = result.createStore(env)
      store1.documentCollection.add({ id: 'd1', title: 'Doc 1', category: 'tech' })
      store1.documentCollection.add({ id: 'd2', title: 'Doc 2', category: 'business' })
      store1.documentCollection.add({ id: 'd3', title: 'Doc 3', category: 'tech' })
      await store1.documentCollection.saveAll()

      // When: Loading with filter
      const store2 = result.createStore(env)
      await store2.documentCollection.loadAll({ category: 'tech' })

      // Then: Only matching documents should be loaded
      expect(store2.documentCollection.all().length).toBe(2)
      expect(store2.documentCollection.get('d1')?.category).toBe('tech')
      expect(store2.documentCollection.get('d3')?.category).toBe('tech')
    })
  })

  describe('6.4: Backward compatibility', () => {
    test('collections without persistenceConfig still work with filter', async () => {
      // Given: Schema without x-persistence (defaults to flat)
      const schema: EnhancedJsonSchema = {
        $defs: {
          Task: {
            type: 'object',
            'x-original-name': 'Task',
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              title: { type: 'string' },
              priority: { type: 'string' }
            },
            required: ['id', 'title', 'priority']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }

      // Save data using default flat strategy
      const store1 = result.createStore(env)
      store1.taskCollection.add({ id: 't1', title: 'Task 1', priority: 'high' })
      store1.taskCollection.add({ id: 't2', title: 'Task 2', priority: 'low' })
      await store1.taskCollection.saveAll()

      // When: Loading with filter
      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll({ priority: 'high' })

      // Then: Filter should work (in-memory)
      expect(store2.taskCollection.all().length).toBe(1)
      expect(store2.taskCollection.get('t1')?.priority).toBe('high')
    })
  })

  describe('6.5: Custom persistence service receives filter', () => {
    test('filter is passed through to persistence service', async () => {
      // Given: A mock persistence service that records the filter
      let capturedContext: PersistenceContext | null = null

      const mockPersistence = {
        async saveCollection(ctx: PersistenceContext, snapshot: any) {
          // Write to filesystem for this test
          await persistence.saveCollection(ctx, snapshot)
        },
        async loadCollection(ctx: PersistenceContext) {
          capturedContext = ctx
          return persistence.loadCollection(ctx)
        },
        async saveEntity() {},
        async loadEntity() { return null }
      }

      const schema: EnhancedJsonSchema = {
        $defs: {
          Task: {
            type: 'object',
            'x-original-name': 'Task',
            'x-persistence': {
              strategy: 'array-per-partition',
              partitionKey: 'projectId'
            },
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              title: { type: 'string' },
              projectId: { type: 'string' }
            },
            required: ['id', 'title', 'projectId']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })

      // Save with real persistence
      const saveEnv: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }
      const store1 = result.createStore(saveEnv)
      store1.taskCollection.add({ id: 't1', title: 'Task 1', projectId: 'proj-A' })
      await store1.taskCollection.saveAll()

      // Load with mock persistence to capture context
      const loadEnv: IEnvironment = {
        services: { persistence: mockPersistence as any },
        context: { schemaName: 'test', location: tempDir }
      }
      const store2 = result.createStore(loadEnv)
      await store2.taskCollection.loadAll({ projectId: 'proj-A', status: 'open' })

      // Then: Filter should be in the context
      expect(capturedContext).not.toBeNull()
      expect(capturedContext!.filter).toEqual({ projectId: 'proj-A', status: 'open' })
      expect(capturedContext!.persistenceConfig?.strategy).toBe('array-per-partition')
      expect(capturedContext!.persistenceConfig?.partitionKey).toBe('projectId')
    })
  })
})
