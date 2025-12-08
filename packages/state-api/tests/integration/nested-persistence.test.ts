/**
 * Phase 8: Nested Folder Persistence Tests
 *
 * Tests for hierarchical folder structure where child entities
 * are nested under their parent's folder.
 *
 * ⚠️ SAFETY WARNING: ALL tests MUST provide an explicit `location` parameter
 * to avoid writing to the production `.schemas` directory.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rm, readdir, readFile } from 'fs/promises'
import path from 'path'
import {
  findParentReference,
  buildNestedCollectionPath,
  buildParentEntityPath,
  hasNestedChildren,
  sanitizeFilename
} from '../../src/persistence/helpers'
import { FileSystemPersistence } from '../../src/persistence/filesystem'
import type { PersistenceContext } from '../../src/persistence/types'

// ============================================================================
// Test Schema Definitions
// ============================================================================

/**
 * Schema with proper reference annotations for testing nested persistence.
 */
const testSchema = {
  $defs: {
    Initiative: {
      type: 'object',
      'x-persistence': {
        strategy: 'entity-per-file',
        displayKey: 'name'
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        name: { type: 'string' }
      },
      required: ['id', 'name']
    },
    BacklogItem: {
      type: 'object',
      'x-persistence': {
        strategy: 'entity-per-file',
        displayKey: 'title',
        nested: true
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        title: { type: 'string' },
        initiativeId: {
          type: 'string',
          'x-mst-type': 'reference',
          'x-reference-type': 'single',
          'x-arktype': 'Initiative'
        }
      },
      required: ['id', 'title', 'initiativeId']
    },
    IdeaNote: {
      type: 'object',
      'x-persistence': {
        strategy: 'array-per-partition',
        partitionKey: 'initiativeId',
        nested: true
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        content: { type: 'string' },
        initiativeId: {
          type: 'string',
          'x-mst-type': 'reference',
          'x-reference-type': 'single',
          'x-arktype': 'Initiative'
        }
      },
      required: ['id', 'content', 'initiativeId']
    }
  }
}

// ============================================================================
// Helper Function Tests
// ============================================================================

describe('Phase 8: Nested Persistence Helpers', () => {
  describe('8.1: findParentReference', () => {
    test('finds single reference field from schema', () => {
      const result = findParentReference(
        testSchema.$defs.BacklogItem,
        testSchema.$defs
      )

      expect(result).not.toBeNull()
      expect(result!.field).toBe('initiativeId')
      expect(result!.targetModel).toBe('Initiative')
      expect(result!.parentDisplayKey).toBe('name')
    })

    test('returns null for non-nested model', () => {
      const result = findParentReference(
        testSchema.$defs.Initiative,
        testSchema.$defs
      )

      expect(result).toBeNull()
    })

    test('throws if nested:true but no single reference field', () => {
      const badModelDef = {
        type: 'object',
        'x-persistence': { strategy: 'entity-per-file', nested: true },
        properties: {
          id: { type: 'string' },
          name: { type: 'string' }
          // No reference field!
        }
      }

      expect(() => findParentReference(badModelDef, {})).toThrow(
        /no single reference field/
      )
    })

    test('throws if model has multiple single references', () => {
      const ambiguousModel = {
        type: 'object',
        'x-persistence': { strategy: 'entity-per-file', nested: true },
        properties: {
          id: { type: 'string' },
          parentA: {
            type: 'string',
            'x-mst-type': 'reference',
            'x-reference-type': 'single',
            'x-arktype': 'ParentA'
          },
          parentB: {
            type: 'string',
            'x-mst-type': 'reference',
            'x-reference-type': 'single',
            'x-arktype': 'ParentB'
          }
        }
      }

      expect(() => findParentReference(ambiguousModel, {
        ParentA: { 'x-persistence': { displayKey: 'name' } },
        ParentB: { 'x-persistence': { displayKey: 'name' } }
      })).toThrow(/multiple single references/)
    })

    test('throws if parent model missing displayKey', () => {
      const childModel = {
        type: 'object',
        'x-persistence': { strategy: 'entity-per-file', nested: true },
        properties: {
          id: { type: 'string' },
          parentId: {
            type: 'string',
            'x-mst-type': 'reference',
            'x-reference-type': 'single',
            'x-arktype': 'Parent'
          }
        }
      }

      const parentWithoutDisplayKey = {
        Parent: {
          'x-persistence': { strategy: 'flat' } // No displayKey!
        }
      }

      expect(() => findParentReference(childModel, parentWithoutDisplayKey)).toThrow(
        /must have x-persistence.displayKey/
      )
    })

    test('throws if parent model not found in defs', () => {
      const childModel = {
        type: 'object',
        'x-persistence': { strategy: 'entity-per-file', nested: true },
        properties: {
          id: { type: 'string' },
          parentId: {
            type: 'string',
            'x-mst-type': 'reference',
            'x-reference-type': 'single',
            'x-arktype': 'NonExistentParent'
          }
        }
      }

      expect(() => findParentReference(childModel, {})).toThrow(
        /not found in schema/
      )
    })
  })

  describe('8.2: buildNestedCollectionPath', () => {
    test('builds correct nested path', () => {
      const ctx: PersistenceContext = {
        schemaName: 'roadmap',
        modelName: 'BacklogItem',
        location: '.schemas',
        parentContext: {
          modelName: 'Initiative',
          displayKeyValue: 'auth-layer-v2'
        }
      }

      const result = buildNestedCollectionPath(ctx)

      expect(result).toBe('.schemas/roadmap/data/Initiative/auth-layer-v2/BacklogItem')
    })

    test('throws if parentContext is missing', () => {
      const ctx: PersistenceContext = {
        schemaName: 'roadmap',
        modelName: 'BacklogItem',
        location: '.schemas'
        // No parentContext!
      }

      expect(() => buildNestedCollectionPath(ctx)).toThrow(/requires parentContext/)
    })

    test('uses default location if not provided', () => {
      const ctx: PersistenceContext = {
        schemaName: 'roadmap',
        modelName: 'BacklogItem',
        // No location
        parentContext: {
          modelName: 'Initiative',
          displayKeyValue: 'auth-layer-v2'
        }
      }

      const result = buildNestedCollectionPath(ctx)

      expect(result).toBe('.schemas/roadmap/data/Initiative/auth-layer-v2/BacklogItem')
    })
  })

  describe('8.3: buildParentEntityPath', () => {
    test('builds path with lowercase model name', () => {
      const ctx: PersistenceContext = {
        schemaName: 'roadmap',
        modelName: 'Initiative',
        location: '.schemas'
      }

      const result = buildParentEntityPath(ctx, 'auth-layer-v2')

      expect(result).toBe('.schemas/roadmap/data/Initiative/auth-layer-v2/initiative.json')
    })
  })

  describe('8.4: hasNestedChildren', () => {
    test('returns true if model has nested children', () => {
      const result = hasNestedChildren('Initiative', testSchema.$defs)

      expect(result).toBe(true)
    })

    test('returns false if model has no nested children', () => {
      const result = hasNestedChildren('BacklogItem', testSchema.$defs)

      expect(result).toBe(false)
    })

    test('returns false if model not referenced', () => {
      const result = hasNestedChildren('NonExistent', testSchema.$defs)

      expect(result).toBe(false)
    })
  })
})

// ============================================================================
// FileSystemPersistence Nested Tests
// ============================================================================

describe('Phase 8: Nested FileSystemPersistence', () => {
  let tempDir: string
  let persistence: FileSystemPersistence

  beforeEach(() => {
    tempDir = `.test-schemas-nested-${Date.now()}-${Math.random().toString(36).substring(7)}`
    persistence = new FileSystemPersistence()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('8.5: saveCollection with nested strategy', () => {
    test('creates child files under parent folder', async () => {
      // First save a parent entity
      await persistence.saveEntity({
        schemaName: 'test',
        modelName: 'Initiative',
        location: tempDir,
        entityId: 'init-1',
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        }
      }, { id: 'init-1', name: 'Auth Layer' })

      // Save nested children
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'BacklogItem',
        location: tempDir,
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'title',
          nested: true
        },
        schemaDefs: testSchema.$defs
      }

      await persistence.saveCollection(ctx, {
        items: {
          'bl-1': { id: 'bl-1', title: 'JWT Setup', initiativeId: 'init-1' },
          'bl-2': { id: 'bl-2', title: 'OAuth Flow', initiativeId: 'init-1' }
        }
      })

      // Verify nested structure
      const childDir = path.join(tempDir, 'test', 'data', 'Initiative', 'Auth Layer', 'BacklogItem')
      const files = await readdir(childDir)

      expect(files).toContain('JWT Setup.json')
      expect(files).toContain('OAuth Flow.json')
    })

    test('groups children by different parents', async () => {
      // Save two parent initiatives
      await persistence.saveEntity({
        schemaName: 'test',
        modelName: 'Initiative',
        location: tempDir,
        entityId: 'init-1',
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' }
      }, { id: 'init-1', name: 'Auth Layer' })

      await persistence.saveEntity({
        schemaName: 'test',
        modelName: 'Initiative',
        location: tempDir,
        entityId: 'init-2',
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' }
      }, { id: 'init-2', name: 'Cache Layer' })

      // Save children referencing different parents
      await persistence.saveCollection({
        schemaName: 'test',
        modelName: 'BacklogItem',
        location: tempDir,
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'title',
          nested: true
        },
        schemaDefs: testSchema.$defs
      }, {
        items: {
          'bl-1': { id: 'bl-1', title: 'JWT Setup', initiativeId: 'init-1' },
          'bl-2': { id: 'bl-2', title: 'Redis Setup', initiativeId: 'init-2' }
        }
      })

      // Verify each parent has correct children
      const authChildren = await readdir(
        path.join(tempDir, 'test', 'data', 'Initiative', 'Auth Layer', 'BacklogItem')
      )
      const cacheChildren = await readdir(
        path.join(tempDir, 'test', 'data', 'Initiative', 'Cache Layer', 'BacklogItem')
      )

      expect(authChildren).toContain('JWT Setup.json')
      expect(authChildren).not.toContain('Redis Setup.json')

      expect(cacheChildren).toContain('Redis Setup.json')
      expect(cacheChildren).not.toContain('JWT Setup.json')
    })
  })

  describe('8.6: loadCollection with nested strategy', () => {
    test('loads all children across parent folders', async () => {
      // Setup: Save parents and children
      await persistence.saveEntity({
        schemaName: 'test',
        modelName: 'Initiative',
        location: tempDir,
        entityId: 'init-1',
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' }
      }, { id: 'init-1', name: 'Auth Layer' })

      await persistence.saveEntity({
        schemaName: 'test',
        modelName: 'Initiative',
        location: tempDir,
        entityId: 'init-2',
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' }
      }, { id: 'init-2', name: 'Cache Layer' })

      await persistence.saveCollection({
        schemaName: 'test',
        modelName: 'BacklogItem',
        location: tempDir,
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'title',
          nested: true
        },
        schemaDefs: testSchema.$defs
      }, {
        items: {
          'bl-1': { id: 'bl-1', title: 'JWT Setup', initiativeId: 'init-1' },
          'bl-2': { id: 'bl-2', title: 'Redis Setup', initiativeId: 'init-2' }
        }
      })

      // Load all children without filter
      const result = await persistence.loadCollection({
        schemaName: 'test',
        modelName: 'BacklogItem',
        location: tempDir,
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'title',
          nested: true
        },
        schemaDefs: testSchema.$defs
      })

      expect(Object.keys(result.items)).toHaveLength(2)
      expect(result.items['bl-1']).toBeDefined()
      expect(result.items['bl-2']).toBeDefined()
    })

    test('filter pushdown loads only matching parent folder', async () => {
      // Setup as above
      await persistence.saveEntity({
        schemaName: 'test',
        modelName: 'Initiative',
        location: tempDir,
        entityId: 'init-1',
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' }
      }, { id: 'init-1', name: 'Auth Layer' })

      await persistence.saveEntity({
        schemaName: 'test',
        modelName: 'Initiative',
        location: tempDir,
        entityId: 'init-2',
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' }
      }, { id: 'init-2', name: 'Cache Layer' })

      await persistence.saveCollection({
        schemaName: 'test',
        modelName: 'BacklogItem',
        location: tempDir,
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'title',
          nested: true
        },
        schemaDefs: testSchema.$defs
      }, {
        items: {
          'bl-1': { id: 'bl-1', title: 'JWT Setup', initiativeId: 'init-1' },
          'bl-2': { id: 'bl-2', title: 'Redis Setup', initiativeId: 'init-2' }
        }
      })

      // Load with filter on parent ID
      const result = await persistence.loadCollection({
        schemaName: 'test',
        modelName: 'BacklogItem',
        location: tempDir,
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'title',
          nested: true
        },
        schemaDefs: testSchema.$defs,
        filter: { initiativeId: 'init-1' }
      })

      expect(Object.keys(result.items)).toHaveLength(1)
      expect(result.items['bl-1']).toBeDefined()
      expect(result.items['bl-2']).toBeUndefined()
    })
  })

  describe('8.7: Parent entity storage', () => {
    test('parent with nested children stores in folder with lowercase filename', async () => {
      // Save parent that has nested children
      await persistence.saveEntity({
        schemaName: 'test',
        modelName: 'Initiative',
        location: tempDir,
        entityId: 'init-1',
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'name'
        },
        schemaDefs: testSchema.$defs // Allows checking for nested children
      }, { id: 'init-1', name: 'Auth Layer' })

      // Should create folder structure with lowercase model name
      const parentFile = path.join(
        tempDir, 'test', 'data', 'Initiative', 'Auth Layer', 'initiative.json'
      )

      const content = JSON.parse(await readFile(parentFile, 'utf-8'))
      expect(content.id).toBe('init-1')
      expect(content.name).toBe('Auth Layer')
    })
  })

  describe('8.8: Array-per-partition with nested', () => {
    test('stores partition file under parent folder', async () => {
      // Save parent
      await persistence.saveEntity({
        schemaName: 'test',
        modelName: 'Initiative',
        location: tempDir,
        entityId: 'init-1',
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' }
      }, { id: 'init-1', name: 'Auth Layer' })

      // Save nested array-per-partition items
      await persistence.saveCollection({
        schemaName: 'test',
        modelName: 'IdeaNote',
        location: tempDir,
        persistenceConfig: {
          strategy: 'array-per-partition',
          partitionKey: 'initiativeId',
          nested: true
        },
        schemaDefs: testSchema.$defs
      }, {
        items: {
          'note-1': { id: 'note-1', content: 'Idea A', initiativeId: 'init-1' },
          'note-2': { id: 'note-2', content: 'Idea B', initiativeId: 'init-1' }
        }
      })

      // Should create _items.json under parent folder
      const itemsFile = path.join(
        tempDir, 'test', 'data', 'Initiative', 'Auth Layer', 'IdeaNote', '_items.json'
      )

      const content = JSON.parse(await readFile(itemsFile, 'utf-8'))
      expect(Object.keys(content.items)).toHaveLength(2)
    })
  })

  describe('8.9: Error cases', () => {
    test('throws if child has no parent reference value', async () => {
      await expect(persistence.saveCollection({
        schemaName: 'test',
        modelName: 'BacklogItem',
        location: tempDir,
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'title',
          nested: true
        },
        schemaDefs: testSchema.$defs
      }, {
        items: {
          'bl-1': { id: 'bl-1', title: 'JWT Setup' } // Missing initiativeId!
        }
      })).rejects.toThrow(/missing parent reference/)
    })
  })

  describe('8.10: Round-trip', () => {
    test('full save/load preserves nested structure', async () => {
      // Save parent
      await persistence.saveEntity({
        schemaName: 'test',
        modelName: 'Initiative',
        location: tempDir,
        entityId: 'init-1',
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' }
      }, { id: 'init-1', name: 'Auth Layer' })

      // Save children
      const originalItems = {
        'bl-1': { id: 'bl-1', title: 'JWT Setup', initiativeId: 'init-1' },
        'bl-2': { id: 'bl-2', title: 'OAuth Flow', initiativeId: 'init-1' }
      }

      await persistence.saveCollection({
        schemaName: 'test',
        modelName: 'BacklogItem',
        location: tempDir,
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'title',
          nested: true
        },
        schemaDefs: testSchema.$defs
      }, { items: originalItems })

      // Load back
      const loaded = await persistence.loadCollection({
        schemaName: 'test',
        modelName: 'BacklogItem',
        location: tempDir,
        persistenceConfig: {
          strategy: 'entity-per-file',
          displayKey: 'title',
          nested: true
        },
        schemaDefs: testSchema.$defs
      })

      expect(loaded.items['bl-1']).toEqual(originalItems['bl-1'])
      expect(loaded.items['bl-2']).toEqual(originalItems['bl-2'])
    })
  })
})
