/**
 * Phase 9: Multi-Level Nested Persistence Tests
 *
 * Tests for arbitrary-depth hierarchical nesting where entities can be
 * nested multiple levels deep (e.g., Organization → Department → Team → Employee).
 *
 * Also tests the _index.json convention for parent entities that have children.
 *
 * ⚠️ SAFETY WARNING: ALL tests MUST provide an explicit `location` parameter
 * to avoid writing to the production `.schemas` directory.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rm, readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import {
  findParentReference,
  findParentChain,
  buildNestedCollectionPath,
  buildMultiLevelNestedPath,
  buildParentEntityPath,
  hasNestedChildren,
  sanitizeFilename
} from '../../src/persistence/helpers'
import { FileSystemPersistence } from '../../src/persistence/filesystem'
import type { PersistenceContext, NestedParentChain } from '../../src/persistence/types'

// ============================================================================
// Test Schema: 4-Level Hierarchy
// Organization → Department → Team → Employee
// ============================================================================

const multiLevelSchema = {
  $defs: {
    // Level 1: Root (not nested)
    Organization: {
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

    // Level 2: Nested under Organization
    Department: {
      type: 'object',
      'x-persistence': {
        strategy: 'entity-per-file',
        displayKey: 'name',
        nested: true
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        name: { type: 'string' },
        organization: {
          type: 'string',
          'x-mst-type': 'reference',
          'x-reference-type': 'single',
          'x-arktype': 'Organization'
        }
      },
      required: ['id', 'name', 'organization']
    },

    // Level 3: Nested under Department
    Team: {
      type: 'object',
      'x-persistence': {
        strategy: 'entity-per-file',
        displayKey: 'name',
        nested: true
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        name: { type: 'string' },
        department: {
          type: 'string',
          'x-mst-type': 'reference',
          'x-reference-type': 'single',
          'x-arktype': 'Department'
        }
      },
      required: ['id', 'name', 'department']
    },

    // Level 4: Nested under Team (leaf level)
    Employee: {
      type: 'object',
      'x-persistence': {
        strategy: 'entity-per-file',
        displayKey: 'name',
        nested: true
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        name: { type: 'string' },
        team: {
          type: 'string',
          'x-mst-type': 'reference',
          'x-reference-type': 'single',
          'x-arktype': 'Team'
        }
      },
      required: ['id', 'name', 'team']
    }
  }
}

// Test location - isolated from production
const TEST_LOCATION = './test-output/multi-level-nested'

// ============================================================================
// 9.1: findParentChain Helper Tests
// ============================================================================

describe('Phase 9: Multi-Level Nested Persistence', () => {
  describe('9.1: findParentChain', () => {
    test('returns empty array for non-nested root model (Organization)', () => {
      const chain = findParentChain('Organization', multiLevelSchema.$defs)
      expect(chain).toEqual([])
    })

    test('returns single-element array for L2 model (Department)', () => {
      const chain = findParentChain('Department', multiLevelSchema.$defs)

      expect(chain).toHaveLength(1)
      expect(chain[0].field).toBe('organization')
      expect(chain[0].targetModel).toBe('Organization')
      expect(chain[0].parentDisplayKey).toBe('name')
    })

    test('returns two-element array for L3 model (Team)', () => {
      const chain = findParentChain('Team', multiLevelSchema.$defs)

      expect(chain).toHaveLength(2)
      // Immediate parent first
      expect(chain[0].field).toBe('department')
      expect(chain[0].targetModel).toBe('Department')
      // Then grandparent
      expect(chain[1].field).toBe('organization')
      expect(chain[1].targetModel).toBe('Organization')
    })

    test('returns three-element array for L4 model (Employee)', () => {
      const chain = findParentChain('Employee', multiLevelSchema.$defs)

      expect(chain).toHaveLength(3)
      // Immediate parent
      expect(chain[0].field).toBe('team')
      expect(chain[0].targetModel).toBe('Team')
      // Grandparent
      expect(chain[1].field).toBe('department')
      expect(chain[1].targetModel).toBe('Department')
      // Great-grandparent (root)
      expect(chain[2].field).toBe('organization')
      expect(chain[2].targetModel).toBe('Organization')
    })

    test('handles model that does not exist in schema', () => {
      const chain = findParentChain('NonExistent', multiLevelSchema.$defs)
      expect(chain).toEqual([])
    })

    test('protects against circular references', () => {
      // Schema with circular reference: A → B → A
      const circularSchema = {
        ModelA: {
          type: 'object',
          'x-persistence': { strategy: 'entity-per-file', displayKey: 'name', nested: true },
          properties: {
            id: { type: 'string', 'x-mst-type': 'identifier' },
            name: { type: 'string' },
            parent: {
              type: 'string',
              'x-mst-type': 'reference',
              'x-reference-type': 'single',
              'x-arktype': 'ModelB'
            }
          }
        },
        ModelB: {
          type: 'object',
          'x-persistence': { strategy: 'entity-per-file', displayKey: 'name', nested: true },
          properties: {
            id: { type: 'string', 'x-mst-type': 'identifier' },
            name: { type: 'string' },
            parent: {
              type: 'string',
              'x-mst-type': 'reference',
              'x-reference-type': 'single',
              'x-arktype': 'ModelA'
            }
          }
        }
      }

      // Should not infinite loop - terminates when cycle detected
      const chain = findParentChain('ModelA', circularSchema)
      // Returns chain until cycle, doesn't throw
      expect(chain.length).toBeLessThanOrEqual(10) // Max depth protection
    })
  })

  // ============================================================================
  // 9.2: buildMultiLevelNestedPath Helper Tests
  // ============================================================================

  describe('9.2: buildMultiLevelNestedPath', () => {
    test('builds L2 path: Organization/{name}/Department/', () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Department',
        location: TEST_LOCATION,
        parentChain: [
          { modelName: 'Organization', displayKeyValue: 'acme-corp', referenceField: 'organization' }
        ]
      }

      const result = buildMultiLevelNestedPath(ctx)
      expect(result).toBe(path.join(TEST_LOCATION, 'test/data/Organization/acme-corp/Department'))
    })

    test('builds L3 path: Organization/{name}/Department/{name}/Team/', () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Team',
        location: TEST_LOCATION,
        parentChain: [
          { modelName: 'Department', displayKeyValue: 'engineering', referenceField: 'department' },
          { modelName: 'Organization', displayKeyValue: 'acme-corp', referenceField: 'organization' }
        ]
      }

      const result = buildMultiLevelNestedPath(ctx)
      expect(result).toBe(
        path.join(TEST_LOCATION, 'test/data/Organization/acme-corp/Department/engineering/Team')
      )
    })

    test('builds L4 path: Organization/{name}/Department/{name}/Team/{name}/Employee/', () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Employee',
        location: TEST_LOCATION,
        parentChain: [
          { modelName: 'Team', displayKeyValue: 'platform', referenceField: 'team' },
          { modelName: 'Department', displayKeyValue: 'engineering', referenceField: 'department' },
          { modelName: 'Organization', displayKeyValue: 'acme-corp', referenceField: 'organization' }
        ]
      }

      const result = buildMultiLevelNestedPath(ctx)
      expect(result).toBe(
        path.join(
          TEST_LOCATION,
          'test/data/Organization/acme-corp/Department/engineering/Team/platform/Employee'
        )
      )
    })

    test('throws if parentChain is empty', () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Department',
        location: TEST_LOCATION,
        parentChain: []
      }

      expect(() => buildMultiLevelNestedPath(ctx)).toThrow('parentChain')
    })

    test('throws if parentChain is undefined', () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Department',
        location: TEST_LOCATION
      }

      expect(() => buildMultiLevelNestedPath(ctx)).toThrow('parentChain')
    })
  })

  // ============================================================================
  // 9.3: _index.json Convention Tests
  // ============================================================================

  describe('9.3: _index.json convention for parents with children', () => {
    test('hasNestedChildren returns true for Organization (has Department children)', () => {
      const result = hasNestedChildren('Organization', multiLevelSchema.$defs)
      expect(result).toBe(true)
    })

    test('hasNestedChildren returns true for Department (has Team children)', () => {
      const result = hasNestedChildren('Department', multiLevelSchema.$defs)
      expect(result).toBe(true)
    })

    test('hasNestedChildren returns true for Team (has Employee children)', () => {
      const result = hasNestedChildren('Team', multiLevelSchema.$defs)
      expect(result).toBe(true)
    })

    test('hasNestedChildren returns false for Employee (leaf, no children)', () => {
      const result = hasNestedChildren('Employee', multiLevelSchema.$defs)
      expect(result).toBe(false)
    })

    test('buildParentEntityPath uses _index.json for parent with children', () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Organization',
        location: TEST_LOCATION,
        schemaDefs: multiLevelSchema.$defs
      }

      // Organization has Department as children, so should use _index.json
      const result = buildParentEntityPath(ctx, 'acme-corp')
      expect(result).toContain('_index.json')
      expect(result).toBe(
        path.join(TEST_LOCATION, 'test/data/Organization/acme-corp/_index.json')
      )
    })

    test('buildParentEntityPath uses {name}.json for leaf entity', () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Employee',
        location: TEST_LOCATION,
        schemaDefs: multiLevelSchema.$defs
      }

      // Employee has no children, so should NOT use _index.json
      const result = buildParentEntityPath(ctx, 'alice')
      expect(result).not.toContain('_index.json')
      // Current behavior uses lowercase model name
      expect(result).toContain('alice')
    })
  })

  // ============================================================================
  // 9.4: Multi-Level Save Integration Tests
  // ============================================================================

  describe('9.4: FileSystemPersistence.saveCollection (multi-level)', () => {
    let persistence: FileSystemPersistence

    beforeEach(async () => {
      persistence = new FileSystemPersistence()
      // Clean test directory
      await rm(TEST_LOCATION, { recursive: true, force: true })
    })

    afterEach(async () => {
      await rm(TEST_LOCATION, { recursive: true, force: true })
    })

    test('saves L1 Organization with _index.json when it has children', async () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Organization',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' },
        schemaDefs: multiLevelSchema.$defs
      }

      const snapshot = {
        items: { 'org-1': { id: 'org-1', name: 'Acme Corp' } }
      }

      await persistence.saveCollection(ctx, snapshot)

      // Should create _index.json inside folder (because Organization has children)
      const indexPath = path.join(
        TEST_LOCATION,
        'test/data/Organization/Acme Corp/_index.json'
      )
      const content = await readFile(indexPath, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.id).toBe('org-1')
      expect(parsed.name).toBe('Acme Corp')
    })

    test('saves L2 Department under Organization folder', async () => {
      // First save the parent Organization
      const orgCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Organization',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' },
        schemaDefs: multiLevelSchema.$defs
      }
      await persistence.saveCollection(orgCtx, {
        items: { 'org-1': { id: 'org-1', name: 'Acme Corp' } }
      })

      // Now save Department
      const deptCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Department',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }

      const snapshot = {
        items: { 'dept-1': { id: 'dept-1', name: 'Engineering', organization: 'org-1' } }
      }

      await persistence.saveCollection(deptCtx, snapshot)

      // Department should be under Organization folder, with _index.json (has Team children)
      const deptPath = path.join(
        TEST_LOCATION,
        'test/data/Organization/Acme Corp/Department/Engineering/_index.json'
      )
      const content = await readFile(deptPath, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.id).toBe('dept-1')
      expect(parsed.name).toBe('Engineering')
    })

    test('saves L3 Team under Department folder', async () => {
      // Setup: Save Organization and Department first
      const orgCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Organization',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' },
        schemaDefs: multiLevelSchema.$defs
      }
      await persistence.saveCollection(orgCtx, {
        items: { 'org-1': { id: 'org-1', name: 'Acme Corp' } }
      })

      const deptCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Department',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }
      await persistence.saveCollection(deptCtx, {
        items: { 'dept-1': { id: 'dept-1', name: 'Engineering', organization: 'org-1' } }
      })

      // Now save Team
      const teamCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Team',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }

      const snapshot = {
        items: { 'team-1': { id: 'team-1', name: 'Platform', department: 'dept-1' } }
      }

      await persistence.saveCollection(teamCtx, snapshot)

      // Team should be under Department folder, with _index.json (has Employee children)
      const teamPath = path.join(
        TEST_LOCATION,
        'test/data/Organization/Acme Corp/Department/Engineering/Team/Platform/_index.json'
      )
      const content = await readFile(teamPath, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.id).toBe('team-1')
      expect(parsed.name).toBe('Platform')
    })

    test('saves L4 Employee under Team folder as leaf file', async () => {
      // Setup: Save full hierarchy
      const orgCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Organization',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' },
        schemaDefs: multiLevelSchema.$defs
      }
      await persistence.saveCollection(orgCtx, {
        items: { 'org-1': { id: 'org-1', name: 'Acme Corp' } }
      })

      const deptCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Department',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }
      await persistence.saveCollection(deptCtx, {
        items: { 'dept-1': { id: 'dept-1', name: 'Engineering', organization: 'org-1' } }
      })

      const teamCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Team',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }
      await persistence.saveCollection(teamCtx, {
        items: { 'team-1': { id: 'team-1', name: 'Platform', department: 'dept-1' } }
      })

      // Now save Employee (leaf)
      const empCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Employee',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }

      const snapshot = {
        items: { 'emp-1': { id: 'emp-1', name: 'Alice', team: 'team-1' } }
      }

      await persistence.saveCollection(empCtx, snapshot)

      // Employee is leaf - should be {name}.json, NOT _index.json
      const empPath = path.join(
        TEST_LOCATION,
        'test/data/Organization/Acme Corp/Department/Engineering/Team/Platform/Employee/Alice.json'
      )
      const content = await readFile(empPath, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.id).toBe('emp-1')
      expect(parsed.name).toBe('Alice')
    })
  })

  // ============================================================================
  // 9.5: Multi-Level Load Integration Tests
  // ============================================================================

  describe('9.5: FileSystemPersistence.loadCollection (multi-level)', () => {
    let persistence: FileSystemPersistence

    beforeEach(async () => {
      persistence = new FileSystemPersistence()
      await rm(TEST_LOCATION, { recursive: true, force: true })

      // Pre-populate test data
      await setupTestHierarchy(persistence)
    })

    afterEach(async () => {
      await rm(TEST_LOCATION, { recursive: true, force: true })
    })

    test('loads all L4 Employees across entire hierarchy', async () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Employee',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }

      const result = await persistence.loadCollection(ctx)

      // Should find both employees from different teams
      expect(Object.keys(result.items)).toHaveLength(2)
      expect(result.items['emp-1']).toBeDefined()
      expect(result.items['emp-2']).toBeDefined()
    })

    test('loads Employees filtered by immediate parent (team)', async () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Employee',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs,
        filter: { team: 'team-1' }
      }

      const result = await persistence.loadCollection(ctx)

      // Should only find Alice (team-1)
      expect(Object.keys(result.items)).toHaveLength(1)
      expect(result.items['emp-1']).toBeDefined()
      expect(result.items['emp-1'].name).toBe('Alice')
    })

    test('loads L3 Teams across hierarchy', async () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Team',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }

      const result = await persistence.loadCollection(ctx)

      expect(Object.keys(result.items)).toHaveLength(2)
      expect(result.items['team-1']).toBeDefined()
      expect(result.items['team-2']).toBeDefined()
    })

    test('loads Departments filtered by organization', async () => {
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Department',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs,
        filter: { organization: 'org-1' }
      }

      const result = await persistence.loadCollection(ctx)

      // Should find both departments under org-1
      expect(Object.keys(result.items)).toHaveLength(2)
    })
  })

  // ============================================================================
  // 9.6: Round-Trip Tests
  // ============================================================================

  describe('9.6: Round-trip save and load', () => {
    let persistence: FileSystemPersistence

    beforeEach(async () => {
      persistence = new FileSystemPersistence()
      await rm(TEST_LOCATION, { recursive: true, force: true })
    })

    afterEach(async () => {
      await rm(TEST_LOCATION, { recursive: true, force: true })
    })

    test('full 4-level hierarchy round-trips correctly', async () => {
      // Save
      await setupTestHierarchy(persistence)

      // Load and verify each level
      const orgCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Organization',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' },
        schemaDefs: multiLevelSchema.$defs
      }
      const orgs = await persistence.loadCollection(orgCtx)
      expect(Object.keys(orgs.items)).toHaveLength(1)
      expect(orgs.items['org-1'].name).toBe('Acme Corp')

      const deptCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Department',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }
      const depts = await persistence.loadCollection(deptCtx)
      expect(Object.keys(depts.items)).toHaveLength(2)

      const teamCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Team',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }
      const teams = await persistence.loadCollection(teamCtx)
      expect(Object.keys(teams.items)).toHaveLength(2)

      const empCtx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'Employee',
        location: TEST_LOCATION,
        persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
        schemaDefs: multiLevelSchema.$defs
      }
      const emps = await persistence.loadCollection(empCtx)
      expect(Object.keys(emps.items)).toHaveLength(2)
    })
  })

  // ============================================================================
  // 9.7: Backwards Compatibility Tests
  // ============================================================================

  describe('9.7: Backwards compatibility', () => {
    test('single-level nesting still works with legacy parentContext', async () => {
      // This tests that existing code using parentContext (not parentChain) still works
      const ctx: PersistenceContext = {
        schemaName: 'test',
        modelName: 'BacklogItem',
        location: TEST_LOCATION,
        parentContext: {
          modelName: 'Initiative',
          displayKeyValue: 'auth-layer-v2'
        }
      }

      const result = buildNestedCollectionPath(ctx)
      expect(result).toBe(
        path.join(TEST_LOCATION, 'test/data/Initiative/auth-layer-v2/BacklogItem')
      )
    })
  })
})

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Setup a complete test hierarchy for load tests.
 *
 * Structure:
 * - Organization: Acme Corp (org-1)
 *   - Department: Engineering (dept-1)
 *     - Team: Platform (team-1)
 *       - Employee: Alice (emp-1)
 *   - Department: Sales (dept-2)
 *     - Team: Enterprise (team-2)
 *       - Employee: Bob (emp-2)
 */
async function setupTestHierarchy(persistence: FileSystemPersistence): Promise<void> {
  // L1: Organization
  await persistence.saveCollection(
    {
      schemaName: 'test',
      modelName: 'Organization',
      location: TEST_LOCATION,
      persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name' },
      schemaDefs: multiLevelSchema.$defs
    },
    { items: { 'org-1': { id: 'org-1', name: 'Acme Corp' } } }
  )

  // L2: Departments
  await persistence.saveCollection(
    {
      schemaName: 'test',
      modelName: 'Department',
      location: TEST_LOCATION,
      persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
      schemaDefs: multiLevelSchema.$defs
    },
    {
      items: {
        'dept-1': { id: 'dept-1', name: 'Engineering', organization: 'org-1' },
        'dept-2': { id: 'dept-2', name: 'Sales', organization: 'org-1' }
      }
    }
  )

  // L3: Teams
  await persistence.saveCollection(
    {
      schemaName: 'test',
      modelName: 'Team',
      location: TEST_LOCATION,
      persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
      schemaDefs: multiLevelSchema.$defs
    },
    {
      items: {
        'team-1': { id: 'team-1', name: 'Platform', department: 'dept-1' },
        'team-2': { id: 'team-2', name: 'Enterprise', department: 'dept-2' }
      }
    }
  )

  // L4: Employees
  await persistence.saveCollection(
    {
      schemaName: 'test',
      modelName: 'Employee',
      location: TEST_LOCATION,
      persistenceConfig: { strategy: 'entity-per-file', displayKey: 'name', nested: true },
      schemaDefs: multiLevelSchema.$defs
    },
    {
      items: {
        'emp-1': { id: 'emp-1', name: 'Alice', team: 'team-1' },
        'emp-2': { id: 'emp-2', name: 'Bob', team: 'team-2' }
      }
    }
  )
}
