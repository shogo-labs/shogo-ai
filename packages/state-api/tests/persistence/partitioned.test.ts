/**
 * Tests for Partitioned Persistence implementation.
 *
 * These tests verify the partitioned persistence functionality including
 * entity-per-file, array-per-partition, and display key strategies.
 *
 * ⚠️ SAFETY WARNING: ALL tests MUST provide an explicit `location` parameter
 * to avoid writing to the production `.schemas` directory. NEVER test the
 * default location behavior by writing to `.schemas` - this can cause data loss!
 *
 * Safety patterns enforced:
 * 1. Unique temp directory per test (timestamp + random suffix)
 * 2. ALL contexts MUST include explicit `location: tempDir`
 * 3. Cleanup in afterEach with rm(tempDir, { recursive: true, force: true })
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rm } from 'fs/promises'
import { FileSystemPersistence } from '../../src/persistence/filesystem'
import { exists, readJson, writeJson, ensureDir } from '../../src/persistence/io'
import { extractPersistenceConfig } from '../../src/persistence/helpers'
import type { PersistenceContext, EntityContext, PersistenceConfig } from '../../src/persistence/types'

// Extended context type for partitioned persistence
type PartitionedContext = PersistenceContext & {
  persistenceConfig?: PersistenceConfig
}

type PartitionedEntityContext = EntityContext & {
  persistenceConfig?: PersistenceConfig
}

describe('Partitioned Persistence', () => {
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

  describe('extractPersistenceConfig', () => {
    test('parses x-persistence extension with entity-per-file strategy', () => {
      const modelDef = {
        type: 'object',
        'x-persistence': {
          strategy: 'entity-per-file'
        },
        properties: {
          id: { type: 'string', 'x-mst-type': 'identifier' }
        }
      }

      const config = extractPersistenceConfig(modelDef)

      expect(config).toEqual({
        strategy: 'entity-per-file',
        partitionKey: undefined,
        displayKey: undefined
      })
    })

    test('parses x-persistence with partitionKey and displayKey', () => {
      const modelDef = {
        type: 'object',
        'x-persistence': {
          strategy: 'array-per-partition',
          partitionKey: 'projectId',
          displayKey: 'name'
        },
        properties: {
          id: { type: 'string' },
          projectId: { type: 'string' },
          name: { type: 'string' }
        }
      }

      const config = extractPersistenceConfig(modelDef)

      expect(config).toEqual({
        strategy: 'array-per-partition',
        partitionKey: 'projectId',
        displayKey: 'name'
      })
    })

    test('defaults to flat strategy when no x-persistence extension', () => {
      const modelDef = {
        type: 'object',
        properties: {
          id: { type: 'string', 'x-mst-type': 'identifier' }
        }
      }

      const config = extractPersistenceConfig(modelDef)

      expect(config.strategy).toBe('flat')
    })

    test('returns flat strategy for null/undefined input', () => {
      expect(extractPersistenceConfig(null).strategy).toBe('flat')
      expect(extractPersistenceConfig(undefined).strategy).toBe('flat')
    })
  })

  describe('entity-per-file strategy', () => {
    test('saveCollection creates individual files per entity', async () => {
      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: { strategy: 'entity-per-file' }
      }

      const snapshot = {
        items: {
          'doc-1': { id: 'doc-1', title: 'Document 1', content: 'Content 1' },
          'doc-2': { id: 'doc-2', title: 'Document 2', content: 'Content 2' }
        }
      }

      await persistence.saveCollection(ctx, snapshot)

      // Individual files should exist, not single collection file
      expect(await exists(`${tempDir}/test-schema/data/Document/doc-1.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Document/doc-2.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Document.json`)).toBe(false)

      // Verify file contents
      const doc1 = await readJson(`${tempDir}/test-schema/data/Document/doc-1.json`)
      expect(doc1).toEqual({ id: 'doc-1', title: 'Document 1', content: 'Content 1' })
    })

    test('loadCollection assembles entities from individual files', async () => {
      // Setup: Create individual entity files
      await ensureDir(`${tempDir}/test-schema/data/Document`)
      await writeJson(`${tempDir}/test-schema/data/Document/doc-1.json`, {
        id: 'doc-1',
        title: 'Document 1'
      })
      await writeJson(`${tempDir}/test-schema/data/Document/doc-2.json`, {
        id: 'doc-2',
        title: 'Document 2'
      })

      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: { strategy: 'entity-per-file' }
      }

      const result = await persistence.loadCollection(ctx)

      expect(result).toEqual({
        items: {
          'doc-1': { id: 'doc-1', title: 'Document 1' },
          'doc-2': { id: 'doc-2', title: 'Document 2' }
        }
      })
    })

    test('loadCollection returns null when directory does not exist', async () => {
      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'NonExistent',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: { strategy: 'entity-per-file' }
      }

      const result = await persistence.loadCollection(ctx)

      expect(result).toBeNull()
    })

    test('saveEntity updates only target file without read-modify-write on collection', async () => {
      // Setup: Create existing entity files
      await ensureDir(`${tempDir}/test-schema/data/Document`)
      await writeJson(`${tempDir}/test-schema/data/Document/doc-1.json`, {
        id: 'doc-1',
        title: 'Original Title'
      })
      await writeJson(`${tempDir}/test-schema/data/Document/doc-2.json`, {
        id: 'doc-2',
        title: 'Untouched'
      })

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        entityId: 'doc-1',
        persistenceConfig: { strategy: 'entity-per-file' }
      }

      await persistence.saveEntity(ctx, { id: 'doc-1', title: 'Updated Title' })

      // Only doc-1 should be updated
      const doc1 = await readJson(`${tempDir}/test-schema/data/Document/doc-1.json`)
      const doc2 = await readJson(`${tempDir}/test-schema/data/Document/doc-2.json`)

      expect(doc1.title).toBe('Updated Title')
      expect(doc2.title).toBe('Untouched')
    })

    test('saveEntity creates new file for new entity', async () => {
      await ensureDir(`${tempDir}/test-schema/data/Document`)

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        entityId: 'doc-new',
        persistenceConfig: { strategy: 'entity-per-file' }
      }

      await persistence.saveEntity(ctx, { id: 'doc-new', title: 'New Document' })

      expect(await exists(`${tempDir}/test-schema/data/Document/doc-new.json`)).toBe(true)
      const doc = await readJson(`${tempDir}/test-schema/data/Document/doc-new.json`)
      expect(doc).toEqual({ id: 'doc-new', title: 'New Document' })
    })

    test('loadEntity loads from individual file', async () => {
      await ensureDir(`${tempDir}/test-schema/data/Document`)
      await writeJson(`${tempDir}/test-schema/data/Document/doc-1.json`, {
        id: 'doc-1',
        title: 'Document 1'
      })

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        entityId: 'doc-1',
        persistenceConfig: { strategy: 'entity-per-file' }
      }

      const result = await persistence.loadEntity(ctx)

      expect(result).toEqual({ id: 'doc-1', title: 'Document 1' })
    })

    test('loadEntity returns null when entity file does not exist', async () => {
      await ensureDir(`${tempDir}/test-schema/data/Document`)

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        entityId: 'nonexistent',
        persistenceConfig: { strategy: 'entity-per-file' }
      }

      const result = await persistence.loadEntity(ctx)

      expect(result).toBeNull()
    })
  })

  describe('flat strategy (backward compatibility)', () => {
    test('saveCollection uses single file (current behavior)', async () => {
      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Task',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: { strategy: 'flat' }
      }

      const snapshot = {
        items: {
          '1': { id: '1', title: 'Task 1' },
          '2': { id: '2', title: 'Task 2' }
        }
      }

      await persistence.saveCollection(ctx, snapshot)

      // Single file should exist, not directory
      expect(await exists(`${tempDir}/test-schema/data/Task.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Task/`)).toBe(false)

      const loaded = await readJson(`${tempDir}/test-schema/data/Task.json`)
      expect(loaded).toEqual(snapshot)
    })

    test('loadCollection reads from single file (current behavior)', async () => {
      // Setup: Create single collection file
      await ensureDir(`${tempDir}/test-schema/data`)
      await writeJson(`${tempDir}/test-schema/data/Task.json`, {
        items: {
          '1': { id: '1', title: 'Task 1' }
        }
      })

      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Task',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: { strategy: 'flat' }
      }

      const result = await persistence.loadCollection(ctx)

      expect(result).toEqual({
        items: {
          '1': { id: '1', title: 'Task 1' }
        }
      })
    })

    test('works without persistenceConfig (defaults to flat)', async () => {
      const ctx: PersistenceContext = {
        schemaName: 'test-schema',
        modelName: 'Task',
        location: tempDir // REQUIRED - never omit this
        // No persistenceConfig - should default to flat
      }

      const snapshot = {
        items: {
          '1': { id: '1', title: 'Task 1' }
        }
      }

      await persistence.saveCollection(ctx, snapshot)

      // Should use single file (backward compatible)
      expect(await exists(`${tempDir}/test-schema/data/Task.json`)).toBe(true)

      const loaded = await persistence.loadCollection(ctx)
      expect(loaded).toEqual(snapshot)
    })
  })

  // ============================================================================
  // Phase 2: Array-per-Partition Strategy
  // ============================================================================

  describe('array-per-partition strategy', () => {
    test('saveCollection groups entities by partitionKey value', async () => {
      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Task',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: {
          strategy: 'array-per-partition',
          partitionKey: 'projectId'
        }
      }

      const snapshot = {
        items: {
          't1': { id: 't1', projectId: 'p1', title: 'Task A' },
          't2': { id: 't2', projectId: 'p1', title: 'Task B' },
          't3': { id: 't3', projectId: 'p2', title: 'Task C' },
          't4': { id: 't4', projectId: 'p2', title: 'Task D' }
        }
      }

      await persistence.saveCollection(ctx, snapshot)

      // Should create partition files, not single flat file
      expect(await exists(`${tempDir}/test-schema/data/Task/p1.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Task/p2.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Task.json`)).toBe(false)

      // Verify partition contents
      const p1 = await readJson(`${tempDir}/test-schema/data/Task/p1.json`)
      const p2 = await readJson(`${tempDir}/test-schema/data/Task/p2.json`)

      expect(Object.keys(p1.items).sort()).toEqual(['t1', 't2'])
      expect(Object.keys(p2.items).sort()).toEqual(['t3', 't4'])
      expect(p1.items.t1.title).toBe('Task A')
      expect(p2.items.t3.title).toBe('Task C')
    })

    test('loadCollection merges all partition files', async () => {
      // Setup: Create partition files
      await ensureDir(`${tempDir}/test-schema/data/Task`)
      await writeJson(`${tempDir}/test-schema/data/Task/p1.json`, {
        items: {
          't1': { id: 't1', projectId: 'p1', title: 'Task A' },
          't2': { id: 't2', projectId: 'p1', title: 'Task B' }
        }
      })
      await writeJson(`${tempDir}/test-schema/data/Task/p2.json`, {
        items: {
          't3': { id: 't3', projectId: 'p2', title: 'Task C' }
        }
      })

      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Task',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: {
          strategy: 'array-per-partition',
          partitionKey: 'projectId'
        }
      }

      const result = await persistence.loadCollection(ctx)

      // All entities from all partitions merged
      expect(Object.keys(result.items).sort()).toEqual(['t1', 't2', 't3'])
      expect(result.items.t1.title).toBe('Task A')
      expect(result.items.t2.title).toBe('Task B')
      expect(result.items.t3.title).toBe('Task C')
    })

    test('loadCollection returns empty items when no partitions exist', async () => {
      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'NonExistent',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: {
          strategy: 'array-per-partition',
          partitionKey: 'projectId'
        }
      }

      const result = await persistence.loadCollection(ctx)

      // Empty collection, not null - the model exists, just has no data yet
      expect(result).toEqual({ items: {} })
    })

    test('saveEntity updates correct partition file only', async () => {
      // Setup: Create existing partition files
      await ensureDir(`${tempDir}/test-schema/data/Task`)
      await writeJson(`${tempDir}/test-schema/data/Task/p1.json`, {
        items: {
          't1': { id: 't1', projectId: 'p1', title: 'Original' },
          't2': { id: 't2', projectId: 'p1', title: 'Untouched' }
        }
      })
      await writeJson(`${tempDir}/test-schema/data/Task/p2.json`, {
        items: {
          't3': { id: 't3', projectId: 'p2', title: 'Also Untouched' }
        }
      })

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Task',
        location: tempDir, // REQUIRED - never omit this
        entityId: 't1',
        persistenceConfig: {
          strategy: 'array-per-partition',
          partitionKey: 'projectId'
        }
      }

      // Update entity - need to provide partition key value in snapshot
      await persistence.saveEntity(ctx, { id: 't1', projectId: 'p1', title: 'Updated' })

      // Only p1 partition should have the update
      const p1 = await readJson(`${tempDir}/test-schema/data/Task/p1.json`)
      const p2 = await readJson(`${tempDir}/test-schema/data/Task/p2.json`)

      expect(p1.items.t1.title).toBe('Updated')
      expect(p1.items.t2.title).toBe('Untouched')
      expect(p2.items.t3.title).toBe('Also Untouched')
    })

    test('saveEntity creates new partition file if needed', async () => {
      // Setup: Create one partition
      await ensureDir(`${tempDir}/test-schema/data/Task`)
      await writeJson(`${tempDir}/test-schema/data/Task/p1.json`, {
        items: {
          't1': { id: 't1', projectId: 'p1', title: 'Existing' }
        }
      })

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Task',
        location: tempDir, // REQUIRED - never omit this
        entityId: 't2',
        persistenceConfig: {
          strategy: 'array-per-partition',
          partitionKey: 'projectId'
        }
      }

      // Add entity to new partition
      await persistence.saveEntity(ctx, { id: 't2', projectId: 'p2', title: 'New Partition' })

      // Both partitions should exist
      expect(await exists(`${tempDir}/test-schema/data/Task/p1.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Task/p2.json`)).toBe(true)

      const p2 = await readJson(`${tempDir}/test-schema/data/Task/p2.json`)
      expect(p2.items.t2.title).toBe('New Partition')
    })

    test('loadEntity finds entity across partitions', async () => {
      // Setup: Create partition files
      await ensureDir(`${tempDir}/test-schema/data/Task`)
      await writeJson(`${tempDir}/test-schema/data/Task/p1.json`, {
        items: {
          't1': { id: 't1', projectId: 'p1', title: 'Task A' }
        }
      })
      await writeJson(`${tempDir}/test-schema/data/Task/p2.json`, {
        items: {
          't2': { id: 't2', projectId: 'p2', title: 'Task B' }
        }
      })

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Task',
        location: tempDir, // REQUIRED - never omit this
        entityId: 't2',
        persistenceConfig: {
          strategy: 'array-per-partition',
          partitionKey: 'projectId'
        }
      }

      const result = await persistence.loadEntity(ctx)

      expect(result).toEqual({ id: 't2', projectId: 'p2', title: 'Task B' })
    })

    test('loadEntity returns undefined when entity not found in any partition', async () => {
      // Setup: Create partition without the entity we're looking for
      await ensureDir(`${tempDir}/test-schema/data/Task`)
      await writeJson(`${tempDir}/test-schema/data/Task/p1.json`, {
        items: {
          't1': { id: 't1', projectId: 'p1', title: 'Task A' }
        }
      })

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Task',
        location: tempDir, // REQUIRED - never omit this
        entityId: 'nonexistent',
        persistenceConfig: {
          strategy: 'array-per-partition',
          partitionKey: 'projectId'
        }
      }

      const result = await persistence.loadEntity(ctx)

      expect(result).toBeUndefined()
    })
  })

  // ============================================================================
  // Phase 3: Display Key Support (entity-per-file only)
  // ============================================================================

  describe('display key support (entity-per-file)', () => {
    test('saveCollection uses displayKey for filenames instead of id', async () => {
      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        }
      }

      const snapshot = {
        items: {
          'doc-1': { id: 'doc-1', name: 'Requirements', content: 'Content 1' },
          'doc-2': { id: 'doc-2', name: 'Architecture', content: 'Content 2' }
        }
      }

      await persistence.saveCollection(ctx, snapshot)

      // Files should be named by displayKey value, not id
      expect(await exists(`${tempDir}/test-schema/data/Document/Requirements.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Document/Architecture.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Document/doc-1.json`)).toBe(false)
      expect(await exists(`${tempDir}/test-schema/data/Document/doc-2.json`)).toBe(false)
    })

    test('displayKey is sanitized for filesystem safety', async () => {
      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        }
      }

      const snapshot = {
        items: {
          'doc-1': { id: 'doc-1', name: 'My Document/With Slashes', content: 'Content 1' },
          'doc-2': { id: 'doc-2', name: 'File: Special <chars>?', content: 'Content 2' },
          'doc-3': { id: 'doc-3', name: '  Spaces  Around  ', content: 'Content 3' }
        }
      }

      await persistence.saveCollection(ctx, snapshot)

      // Files should exist with sanitized names (slashes, colons, etc replaced)
      // Exact sanitization rules: replace unsafe chars with underscore, trim spaces
      expect(await exists(`${tempDir}/test-schema/data/Document/My Document_With Slashes.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Document/File_ Special _chars__.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Document/Spaces  Around.json`)).toBe(true)
    })

    test('saveCollection throws error for duplicate displayKey values', async () => {
      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        }
      }

      // Two entities with same displayKey value
      const snapshot = {
        items: {
          'doc-1': { id: 'doc-1', name: 'README', content: 'First README' },
          'doc-2': { id: 'doc-2', name: 'README', content: 'Second README' }
        }
      }

      // Should throw validation error for duplicate displayKey
      await expect(persistence.saveCollection(ctx, snapshot)).rejects.toThrow(
        /duplicate displayKey/i
      )
    })

    test('loadCollection maps displayKey filenames back to correct entity ids', async () => {
      // Setup: Create files with displayKey names
      await ensureDir(`${tempDir}/test-schema/data/Document`)
      await writeJson(`${tempDir}/test-schema/data/Document/Requirements.json`, {
        id: 'doc-1',
        name: 'Requirements',
        content: 'Content 1'
      })
      await writeJson(`${tempDir}/test-schema/data/Document/Architecture.json`, {
        id: 'doc-2',
        name: 'Architecture',
        content: 'Content 2'
      })

      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        }
      }

      const result = await persistence.loadCollection(ctx)

      // Should reconstruct correct entity IDs from file content, not filename
      expect(result.items['doc-1']).toEqual({
        id: 'doc-1',
        name: 'Requirements',
        content: 'Content 1'
      })
      expect(result.items['doc-2']).toEqual({
        id: 'doc-2',
        name: 'Architecture',
        content: 'Content 2'
      })
    })

    test('saveEntity with displayKey creates file with display name', async () => {
      await ensureDir(`${tempDir}/test-schema/data/Document`)

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        entityId: 'doc-new',
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        }
      }

      await persistence.saveEntity(ctx, { id: 'doc-new', name: 'New Document', content: 'Hello' })

      expect(await exists(`${tempDir}/test-schema/data/Document/New Document.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Document/doc-new.json`)).toBe(false)
    })

    test('loadEntity with displayKey finds entity by id from file contents', async () => {
      // Setup: Create file with displayKey name
      await ensureDir(`${tempDir}/test-schema/data/Document`)
      await writeJson(`${tempDir}/test-schema/data/Document/Requirements.json`, {
        id: 'doc-1',
        name: 'Requirements',
        content: 'Content 1'
      })

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        entityId: 'doc-1', // Looking for entity by ID, not filename
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        }
      }

      const result = await persistence.loadEntity(ctx)

      expect(result).toEqual({
        id: 'doc-1',
        name: 'Requirements',
        content: 'Content 1'
      })
    })

    test('displayKey falls back to id when display value is missing or empty', async () => {
      const ctx: PartitionedContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        }
      }

      const snapshot = {
        items: {
          'doc-1': { id: 'doc-1', content: 'No name field' }, // Missing displayKey field
          'doc-2': { id: 'doc-2', name: '', content: 'Empty name' }, // Empty displayKey
          'doc-3': { id: 'doc-3', name: 'Valid', content: 'Has name' }
        }
      }

      await persistence.saveCollection(ctx, snapshot)

      // Missing/empty displayKey falls back to entity id
      expect(await exists(`${tempDir}/test-schema/data/Document/doc-1.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Document/doc-2.json`)).toBe(true)
      expect(await exists(`${tempDir}/test-schema/data/Document/Valid.json`)).toBe(true)
    })

    test('saveEntity throws if displayKey conflicts with existing different entity', async () => {
      // Setup: Create existing file with displayKey name
      await ensureDir(`${tempDir}/test-schema/data/Document`)
      await writeJson(`${tempDir}/test-schema/data/Document/README.json`, {
        id: 'doc-1',
        name: 'README',
        content: 'Existing'
      })

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        entityId: 'doc-2', // Different entity
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        }
      }

      // Trying to save different entity with same displayKey should fail
      await expect(
        persistence.saveEntity(ctx, { id: 'doc-2', name: 'README', content: 'Conflict' })
      ).rejects.toThrow(/displayKey.*conflict|already exists/i)
    })

    test('saveEntity allows updating same entity with same displayKey', async () => {
      // Setup: Create existing file
      await ensureDir(`${tempDir}/test-schema/data/Document`)
      await writeJson(`${tempDir}/test-schema/data/Document/README.json`, {
        id: 'doc-1',
        name: 'README',
        content: 'Original'
      })

      const ctx: PartitionedEntityContext = {
        schemaName: 'test-schema',
        modelName: 'Document',
        location: tempDir, // REQUIRED - never omit this
        entityId: 'doc-1', // Same entity
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        }
      }

      // Updating same entity with same displayKey should work
      await persistence.saveEntity(ctx, { id: 'doc-1', name: 'README', content: 'Updated' })

      const result = await readJson(`${tempDir}/test-schema/data/Document/README.json`)
      expect(result.content).toBe('Updated')
    })
  })
})
