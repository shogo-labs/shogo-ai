/**
 * Phase 7 Integration Tests: data.load Filter Support
 *
 * Tests that the data.load MCP tool accepts a filter parameter
 * and passes it through to collection.loadAll() for partition pushdown.
 *
 * NOTE: These tests focus on the collection-level filter passthrough since
 * the MCP tool layer is harder to test in isolation. The critical behavior
 * is that loadAll(filter) is called with the filter parameter.
 *
 * ⚠️ SAFETY WARNING: ALL tests MUST provide an explicit `location` parameter
 * to avoid writing to the production `.schemas` directory.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rm } from 'fs/promises'
import * as path from 'path'
import { types } from 'mobx-state-tree'
import { enhancedJsonSchemaToMST } from '../../src/schematic/enhanced-json-schema-to-mst'
import { CollectionPersistable } from '../../src/composition/persistable'
import { FileSystemPersistence } from '../../src/persistence/filesystem'
import { exists } from '../../src/persistence/io'
import type { IEnvironment } from '../../src/environment/types'
import type { EnhancedJsonSchema } from '../../src/schematic/types'

describe('Phase 7: data.load Filter Support', () => {
  let tempDir: string
  let persistence: FileSystemPersistence

  beforeEach(() => {
    tempDir = `.test-schemas-${Date.now()}-${Math.random().toString(36).substring(7)}`
    persistence = new FileSystemPersistence()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  // Helper to create enhanceCollections callback
  const enhanceCollections = (baseCollections: Record<string, any>) => {
    const enhanced: Record<string, any> = {}
    for (const [name, model] of Object.entries(baseCollections)) {
      enhanced[name] = types.compose(model, CollectionPersistable).named(name)
    }
    return enhanced
  }

  describe('Collection-level filter passthrough (simulates data.load behavior)', () => {
    test('loadAll with filter loads only matching partition (array-per-partition)', async () => {
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
      store1.taskCollection.add({ id: 't1', title: 'A1', projectId: 'proj-A' })
      store1.taskCollection.add({ id: 't2', title: 'A2', projectId: 'proj-A' })
      store1.taskCollection.add({ id: 't3', title: 'B1', projectId: 'proj-B' })
      await store1.taskCollection.saveAll()

      // When: data.load equivalent - loadAll with filter on partitionKey
      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll({ projectId: 'proj-A' })

      // Then: Only matching partition loaded
      expect(store2.taskCollection.all().length).toBe(2)
      expect(store2.taskCollection.get('t1')).toBeDefined()
      expect(store2.taskCollection.get('t2')).toBeDefined()
      expect(store2.taskCollection.get('t3')).toBeUndefined()
    })

    test('loadAll without filter loads all data (backward compat)', async () => {
      // Given: Schema with partitioned data
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

      // Save data across partitions
      const store1 = result.createStore(env)
      store1.taskCollection.add({ id: 't1', title: 'A1', projectId: 'proj-A' })
      store1.taskCollection.add({ id: 't2', title: 'B1', projectId: 'proj-B' })
      await store1.taskCollection.saveAll()

      // When: loadAll without filter (data.load default behavior)
      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll()

      // Then: All data loaded
      expect(store2.taskCollection.all().length).toBe(2)
    })

    test('loadAll with filter on non-partition field filters in memory', async () => {
      // Given: Schema with flat strategy (filter always in-memory)
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

      // Save data
      const store1 = result.createStore(env)
      store1.taskCollection.add({ id: 't1', title: 'Task 1', status: 'open' })
      store1.taskCollection.add({ id: 't2', title: 'Task 2', status: 'closed' })
      store1.taskCollection.add({ id: 't3', title: 'Task 3', status: 'open' })
      await store1.taskCollection.saveAll()

      // When: loadAll with filter
      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll({ status: 'open' })

      // Then: Only matching items
      expect(store2.taskCollection.all().length).toBe(2)
      expect(store2.taskCollection.get('t1')?.status).toBe('open')
      expect(store2.taskCollection.get('t3')?.status).toBe('open')
    })
  })
})
