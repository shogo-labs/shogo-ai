/**
 * Phase 5 Integration Tests: Persistence Config Wiring
 *
 * Tests that x-persistence schema configuration flows through all layers:
 *   Schema Definition (x-persistence)
 *     -> Collection closure (persistenceConfigMetadata view)
 *     -> CollectionPersistable.persistenceContext
 *     -> FileSystemPersistence (strategy dispatch)
 *
 * These tests verify the complete wiring, not just individual layer behavior.
 *
 * ⚠️ SAFETY WARNING: ALL tests MUST provide an explicit `location` parameter
 * to avoid writing to the production `.schemas` directory. NEVER test the
 * default location behavior by writing to `.schemas` - this can cause data loss!
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rm } from 'fs/promises'
import * as path from 'path'
import { scope } from 'arktype'
import { types } from 'mobx-state-tree'
import { enhancedJsonSchemaToMST } from '../../src/schematic/enhanced-json-schema-to-mst'
import { arkTypeToEnhancedJsonSchema } from '../../src/schematic/arktype-to-json-schema'
import { CollectionPersistable } from '../../src/composition/persistable'
import { FileSystemPersistence } from '../../src/persistence/filesystem'
import { exists, listFiles } from '../../src/persistence/io'
import type { IEnvironment } from '../../src/environment/types'
import type { EnhancedJsonSchema } from '../../src/schematic/types'

describe('Phase 5: Persistence Config Wiring', () => {
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

  describe('5.1: Collection has persistenceConfigMetadata view from schema', () => {
    test('entity-per-file strategy is captured in closure', () => {
      // Given: Schema with x-persistence extension
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
              title: { type: 'string' }
            },
            required: ['id', 'title']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })

      // When: Creating store
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }
      const store = result.createStore(env)

      // Then: Collection should have persistenceConfigMetadata view
      expect(store.documentCollection.persistenceConfigMetadata).toBeDefined()
      expect(store.documentCollection.persistenceConfigMetadata.strategy).toBe('entity-per-file')
    })

    test('array-per-partition strategy with partitionKey is captured', () => {
      // Given: Schema with partitioned persistence
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
      const store = result.createStore(env)

      // Then: Both strategy and partitionKey should be captured
      expect(store.taskCollection.persistenceConfigMetadata.strategy).toBe('array-per-partition')
      expect(store.taskCollection.persistenceConfigMetadata.partitionKey).toBe('projectId')
    })

    test('displayKey is captured from schema', () => {
      // Given: Schema with displayKey
      const schema: EnhancedJsonSchema = {
        $defs: {
          Document: {
            type: 'object',
            'x-original-name': 'Document',
            'x-persistence': {
              strategy: 'entity-per-file',
              displayKey: 'name'
            },
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              name: { type: 'string' }
            },
            required: ['id', 'name']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }
      const store = result.createStore(env)

      // Then: displayKey should be captured
      expect(store.documentCollection.persistenceConfigMetadata.displayKey).toBe('name')
    })
  })

  describe('5.2: persistenceContext includes persistenceConfig when x-persistence defined', () => {
    test('persistenceContext has complete persistenceConfig', () => {
      // Given: Schema with full x-persistence config
      const schema: EnhancedJsonSchema = {
        $defs: {
          Task: {
            type: 'object',
            'x-original-name': 'Task',
            'x-persistence': {
              strategy: 'array-per-partition',
              partitionKey: 'projectId',
              displayKey: 'title'
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
        context: { schemaName: 'my-schema', location: tempDir }
      }
      const store = result.createStore(env)

      // Then: persistenceContext should include full persistenceConfig
      const ctx = store.taskCollection.persistenceContext
      expect(ctx.schemaName).toBe('my-schema')
      expect(ctx.modelName).toBe('Task')
      expect(ctx.location).toBe(tempDir)
      expect(ctx.persistenceConfig).toBeDefined()
      expect(ctx.persistenceConfig.strategy).toBe('array-per-partition')
      expect(ctx.persistenceConfig.partitionKey).toBe('projectId')
      expect(ctx.persistenceConfig.displayKey).toBe('title')
    })
  })

  describe('5.3: persistenceContext defaults to flat when no x-persistence', () => {
    test('missing x-persistence defaults to flat strategy', () => {
      // Given: Schema WITHOUT x-persistence extension
      const TaskDomain = scope({
        Task: {
          id: 'string.uuid',
          title: 'string'
        }
      })

      const enhanced = arkTypeToEnhancedJsonSchema(TaskDomain)
      const result = enhancedJsonSchemaToMST(enhanced, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }
      const store = result.createStore(env)

      // Then: Should have default flat strategy
      const ctx = store.taskCollection.persistenceContext
      expect(ctx.persistenceConfig).toBeDefined()
      expect(ctx.persistenceConfig.strategy).toBe('flat')
    })

    test('multiple collections each get their own config', () => {
      // Given: Multi-entity schema where one has x-persistence and one doesn't
      const schema: EnhancedJsonSchema = {
        $defs: {
          Task: {
            type: 'object',
            'x-original-name': 'Task',
            'x-persistence': { strategy: 'entity-per-file' },
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              title: { type: 'string' }
            },
            required: ['id', 'title']
          },
          Project: {
            type: 'object',
            'x-original-name': 'Project',
            // NO x-persistence - should default to flat
            properties: {
              id: { type: 'string', 'x-mst-type': 'identifier' },
              name: { type: 'string' }
            },
            required: ['id', 'name']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }
      const store = result.createStore(env)

      // Then: Each collection has its own config
      expect(store.taskCollection.persistenceContext.persistenceConfig.strategy).toBe('entity-per-file')
      expect(store.projectCollection.persistenceContext.persistenceConfig.strategy).toBe('flat')
    })
  })

  describe('5.4: End-to-end entity-per-file via collection.saveAll()', () => {
    test('saveAll creates individual files when strategy is entity-per-file', async () => {
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
              title: { type: 'string' }
            },
            required: ['id', 'title']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'docs-schema', location: tempDir }
      }
      const store = result.createStore(env)

      // When: Adding multiple documents and saving
      store.documentCollection.add({ id: 'doc-1', title: 'First Document' })
      store.documentCollection.add({ id: 'doc-2', title: 'Second Document' })
      await store.documentCollection.saveAll()

      // Then: Should create individual files (entity-per-file pattern)
      const modelDir = path.join(tempDir, 'docs-schema', 'data', 'Document')
      expect(await exists(modelDir)).toBe(true)

      const files = await listFiles(modelDir)
      expect(files).toContain('doc-1.json')
      expect(files).toContain('doc-2.json')
    })

    test('saveAll with displayKey creates human-readable filenames', async () => {
      // Given: Schema with entity-per-file + displayKey
      const schema: EnhancedJsonSchema = {
        $defs: {
          Document: {
            type: 'object',
            'x-original-name': 'Document',
            'x-persistence': {
              strategy: 'entity-per-file',
              displayKey: 'title'
            },
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
        context: { schemaName: 'docs-schema', location: tempDir }
      }
      const store = result.createStore(env)

      // When: Adding documents with titles and saving
      store.documentCollection.add({ id: 'doc-1', title: 'Meeting Notes' })
      store.documentCollection.add({ id: 'doc-2', title: 'Project Plan' })
      await store.documentCollection.saveAll()

      // Then: Should create files named by title
      const modelDir = path.join(tempDir, 'docs-schema', 'data', 'Document')
      const files = await listFiles(modelDir)
      expect(files).toContain('Meeting Notes.json')
      expect(files).toContain('Project Plan.json')
    })

    test('loadAll reconstructs collection from individual files', async () => {
      // Given: Schema with entity-per-file, data saved
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
              title: { type: 'string' }
            },
            required: ['id', 'title']
          }
        }
      }

      const result = enhancedJsonSchemaToMST(schema, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'docs-schema', location: tempDir }
      }

      // Save data
      const store1 = result.createStore(env)
      store1.documentCollection.add({ id: 'doc-1', title: 'First' })
      store1.documentCollection.add({ id: 'doc-2', title: 'Second' })
      await store1.documentCollection.saveAll()

      // When: Loading in fresh store
      const store2 = result.createStore(env)
      await store2.documentCollection.loadAll()

      // Then: All documents should be loaded
      expect(store2.documentCollection.all().length).toBe(2)
      expect(store2.documentCollection.get('doc-1')?.title).toBe('First')
      expect(store2.documentCollection.get('doc-2')?.title).toBe('Second')
    })
  })

  describe('5.5: End-to-end array-per-partition via collection.saveAll()', () => {
    test('saveAll groups entities by partition key', async () => {
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
        context: { schemaName: 'task-schema', location: tempDir }
      }
      const store = result.createStore(env)

      // When: Adding tasks with different projects and saving
      store.taskCollection.add({ id: 't1', title: 'Task 1', projectId: 'proj-A' })
      store.taskCollection.add({ id: 't2', title: 'Task 2', projectId: 'proj-A' })
      store.taskCollection.add({ id: 't3', title: 'Task 3', projectId: 'proj-B' })
      await store.taskCollection.saveAll()

      // Then: Should create partition files
      const modelDir = path.join(tempDir, 'task-schema', 'data', 'Task')
      expect(await exists(modelDir)).toBe(true)

      const files = await listFiles(modelDir)
      expect(files).toContain('proj-A.json')
      expect(files).toContain('proj-B.json')
    })

    test('loadAll merges all partition files', async () => {
      // Given: Partitioned data saved
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
        context: { schemaName: 'task-schema', location: tempDir }
      }

      // Save partitioned data
      const store1 = result.createStore(env)
      store1.taskCollection.add({ id: 't1', title: 'Task 1', projectId: 'proj-A' })
      store1.taskCollection.add({ id: 't2', title: 'Task 2', projectId: 'proj-B' })
      await store1.taskCollection.saveAll()

      // When: Loading in fresh store
      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll()

      // Then: All tasks from all partitions should be merged
      expect(store2.taskCollection.all().length).toBe(2)
      expect(store2.taskCollection.get('t1')?.projectId).toBe('proj-A')
      expect(store2.taskCollection.get('t2')?.projectId).toBe('proj-B')
    })
  })

  describe('5.6: Backward compatibility', () => {
    test('existing flat strategy still works without x-persistence', async () => {
      // Given: Schema without x-persistence (like existing code)
      const TaskDomain = scope({
        Task: {
          id: 'string.uuid',
          title: 'string'
        }
      })

      const enhanced = arkTypeToEnhancedJsonSchema(TaskDomain)
      const result = enhancedJsonSchemaToMST(enhanced, { enhanceCollections })
      const env: IEnvironment = {
        services: { persistence },
        context: { schemaName: 'test', location: tempDir }
      }

      // When: Save and load (should use flat strategy)
      const store1 = result.createStore(env)
      store1.taskCollection.add({ id: '550e8400-e29b-41d4-a716-446655440000', title: 'Test Task' })
      await store1.taskCollection.saveAll()

      const store2 = result.createStore(env)
      await store2.taskCollection.loadAll()

      // Then: Round-trip works
      expect(store2.taskCollection.all().length).toBe(1)
      expect(store2.taskCollection.get('550e8400-e29b-41d4-a716-446655440000')?.title).toBe('Test Task')

      // And: Uses flat file structure (single file, not directory)
      const flatFilePath = path.join(tempDir, 'test', 'data', 'Task.json')
      expect(await exists(flatFilePath)).toBe(true)
    })
  })
})
