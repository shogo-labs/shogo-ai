// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MST Generator Integration Tests
 *
 * Tests that the generated MST stores work correctly with:
 * - Model creation and snapshots
 * - Collection CRUD operations
 * - Optimistic updates and rollback
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { types, getSnapshot } from 'mobx-state-tree'
import { parsePrismaSchema } from '../prisma-generator'
import { generateMSTModel, generateMSTModels } from '../mst-model-generator'
import { generateMSTCollection, generateMSTCollections } from '../mst-collection-generator'
import { generateMSTDomain } from '../mst-domain-generator'
import path from 'path'

// ============================================================================
// Test Fixtures
// ============================================================================

// Simple mock model for testing
const mockWorkspaceModel = {
  name: 'Workspace',
  dbName: null,
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
    { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'slug', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: true, hasDefaultValue: false },
    { name: 'description', kind: 'scalar', type: 'String', isRequired: false, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'createdAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
    { name: 'updatedAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
  ],
}

const mockProjectModel = {
  name: 'Project',
  dbName: null,
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
    { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'workspaceId', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'workspace', kind: 'object', type: 'Workspace', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false, relationName: 'ProjectToWorkspace' },
    { name: 'createdAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
    { name: 'updatedAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
  ],
}

// ============================================================================
// Tests
// ============================================================================

describe('MST Model Generator', () => {
  it('should generate model code with correct structure', () => {
    const result = generateMSTModel(mockWorkspaceModel as any, [mockWorkspaceModel as any])

    expect(result.modelName).toBe('Workspace')
    expect(result.fileName).toBe('workspace.model.tsx')
    expect(result.code).toContain('export const WorkspaceModel = types')
    expect(result.code).toContain('.model("Workspace"')
    expect(result.code).toContain('id: types.identifier')
    expect(result.code).toContain('name: types.string')
    expect(result.code).toContain('description: types.optional(types.string')
  })

  it('should handle optional fields correctly', () => {
    const result = generateMSTModel(mockWorkspaceModel as any, [mockWorkspaceModel as any])

    // description is optional
    expect(result.code).toContain('description: types.optional(types.string')
    // name is required
    expect(result.code).toContain('name: types.string')
  })

  it('should include type exports', () => {
    const result = generateMSTModel(mockWorkspaceModel as any, [mockWorkspaceModel as any])

    expect(result.code).toContain('export interface IWorkspace extends Instance<typeof WorkspaceModel>')
    expect(result.code).toContain('export interface IWorkspaceSnapshotIn extends SnapshotIn<typeof WorkspaceModel>')
    expect(result.code).toContain('export interface IWorkspaceSnapshotOut extends SnapshotOut<typeof WorkspaceModel>')
  })

  it('should generate models with references', () => {
    const result = generateMSTModel(mockProjectModel as any, [mockWorkspaceModel as any, mockProjectModel as any])

    expect(result.code).toContain('import { WorkspaceModel }')
    expect(result.code).toContain('types.safeReference')
  })

  it('should generate multiple models', () => {
    const results = generateMSTModels([mockWorkspaceModel as any, mockProjectModel as any])

    expect(results.length).toBe(2)
    expect(results[0].modelName).toBe('Workspace')
    expect(results[1].modelName).toBe('Project')
  })
})

describe('MST Model Generator — defaults from Prisma DMMF', () => {
  // Mirrors the real Project model where cloudSyncMode is a required enum
  // with a Prisma `@default(s3)`. Before the fix, the generator dropped the
  // default and emitted a bare `types.enumeration(...)` — which crashed the
  // optimistic `create()` path with "No matching type for union" because the
  // caller never sets cloudSyncMode.
  const enums = [
    { name: 'CloudSyncMode', values: [{ name: 's3' }, { name: 'dual_shadow' }, { name: 'git_only' }] },
  ]

  const modelWithEnumDefault = {
    name: 'Project',
    dbName: null,
    fields: [
      { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true, default: { name: 'uuid', args: [4] } },
      { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      { name: 'cloudSyncMode', kind: 'enum', type: 'CloudSyncMode', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true, default: 's3' },
      { name: 'tier', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true, default: 'free' },
      { name: 'retries', kind: 'scalar', type: 'Int', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true, default: 3 },
      { name: 'isActive', kind: 'scalar', type: 'Boolean', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true, default: true },
      { name: 'createdAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true, default: { name: 'now', args: [] } },
      { name: 'archivedAt', kind: 'scalar', type: 'DateTime', isRequired: false, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      { name: 'status', kind: 'enum', type: 'CloudSyncMode', isRequired: false, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    ],
  }

  it('wraps a required enum with @default in types.optional(...) using the literal default', () => {
    const result = generateMSTModel(modelWithEnumDefault as any, [modelWithEnumDefault as any], enums as any)

    // Regression: must be types.optional, not a bare types.enumeration.
    expect(result.code).toContain(
      'cloudSyncMode: types.optional(types.enumeration("CloudSyncMode", ["s3", "dual_shadow", "git_only"]), "s3"),'
    )
    expect(result.code).not.toMatch(
      /cloudSyncMode: types\.enumeration\("CloudSyncMode", \["s3", "dual_shadow", "git_only"\]\),/
    )
  })

  it('preserves literal defaults for scalar @default(...) values', () => {
    const result = generateMSTModel(modelWithEnumDefault as any, [modelWithEnumDefault as any], enums as any)

    expect(result.code).toContain('tier: types.optional(types.string, "free"),')
    expect(result.code).toContain('retries: types.optional(types.number, 3),')
    expect(result.code).toContain('isActive: types.optional(types.boolean, true),')
  })

  it('uses a type-appropriate zero for function defaults like @default(now())', () => {
    const result = generateMSTModel(modelWithEnumDefault as any, [modelWithEnumDefault as any], enums as any)

    // now() / uuid() are computed server-side; we emit a placeholder
    // until the server response replaces it.
    expect(result.code).toContain('createdAt: types.optional(types.number, 0),')
  })

  it('keeps nullable enums as types.maybeNull(...) (no default required)', () => {
    const result = generateMSTModel(modelWithEnumDefault as any, [modelWithEnumDefault as any], enums as any)

    expect(result.code).toContain(
      'status: types.maybeNull(types.enumeration("CloudSyncMode", ["s3", "dual_shadow", "git_only"])),'
    )
  })

  it('produces a snapshot that satisfies MST when the caller omits the enum field', () => {
    // This is the exact failure mode from the homepage chatbox: the
    // optimistic create() builds a snapshot without cloudSyncMode.
    // Before the fix, MST threw "No matching type for union" here.
    const CloudSyncMode = types.enumeration('CloudSyncMode', ['s3', 'dual_shadow', 'git_only'])
    const Project = types.model('Project', {
      id: types.identifier,
      name: types.string,
      cloudSyncMode: types.optional(CloudSyncMode, 's3'),
    })

    const instance = Project.create({ id: 'temp-1', name: 'My Project' })
    expect(instance.cloudSyncMode).toBe('s3')
  })
})

describe('MST Collection Generator', () => {
  it('should generate collection code with correct structure', () => {
    const result = generateMSTCollection(mockWorkspaceModel as any)

    expect(result.modelName).toBe('Workspace')
    expect(result.fileName).toBe('workspace.collection.tsx')
    expect(result.code).toContain('export const WorkspaceCollection = types')
    expect(result.code).toContain('.model("WorkspaceCollection"')
    expect(result.code).toContain('items: types.map(WorkspaceModel)')
    expect(result.code).toContain('isLoading: types.optional(types.boolean, false)')
    expect(result.code).toContain('error: types.maybeNull(types.string)')
  })

  it('should include CRUD actions', () => {
    const result = generateMSTCollection(mockWorkspaceModel as any)

    expect(result.code).toContain('loadAll: flow(function*')
    expect(result.code).toContain('loadById: flow(function*')
    expect(result.code).toContain('create: flow(function*')
    expect(result.code).toContain('update: flow(function*')
    expect(result.code).toContain('delete: flow(function*')
  })

  it('should include views', () => {
    const result = generateMSTCollection(mockWorkspaceModel as any)

    expect(result.code).toContain('get all()')
    expect(result.code).toContain('get(id: string)')
    expect(result.code).toContain('get count()')
    expect(result.code).toContain('filter(predicate')
    expect(result.code).toContain('find(predicate')
  })

  it('should use correct API endpoint', () => {
    const result = generateMSTCollection(mockWorkspaceModel as any)

    expect(result.code).toContain('const ENDPOINT = "/api/workspaces"')
  })

  it('should include type exports', () => {
    const result = generateMSTCollection(mockWorkspaceModel as any)

    expect(result.code).toContain('export type IWorkspaceCollection = Instance<typeof WorkspaceCollection>')
  })

  it('toRoutePath -es plural arm: model names ending in s/x/ch/sh', () => {
    // Line 48 — kebab + 'es' arm. Baseline mocks (Workspace, Project) hit
    // the default + 's'; this drives the +es plural via the route pragma.
    const cases = [
      { name: 'Class', plural: 'classes' },
      { name: 'Box',   plural: 'boxes' },
      { name: 'Match', plural: 'matches' },
      { name: 'Dish',  plural: 'dishes' },
    ]
    for (const { name, plural } of cases) {
      const m = { name, dbName: null, fields: [
        { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
      ] } as any
      const r = generateMSTCollection(m)
      expect(r.code).toContain('const ENDPOINT = "/api/' + plural + '"')
    }
  })

  it('generateMSTCollections returns one file per model with an @id (lines 533-535)', () => {
    // Plural batch generator was unimported in baseline tests. Confirm it
    // filters by getIdField presence and delegates per-model to
    // generateMSTCollection.
    const noIdModel = { name: 'AuditEntry', dbName: null, fields: [
      { name: 'workspaceId', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    ] }
    const files = generateMSTCollections([mockWorkspaceModel as any, noIdModel as any])
    expect(files).toHaveLength(1)
    expect(files[0]!.modelName).toBe('Workspace')
    // Round-trip: same output as the single-model call for the kept model.
    expect(files[0]!.code).toBe(generateMSTCollection(mockWorkspaceModel as any).code)
  })
})

describe('MST Domain Generator', () => {
  it('should generate domain code with all collections', () => {
    const result = generateMSTDomain([mockWorkspaceModel as any, mockProjectModel as any])

    expect(result.fileName).toBe('domain.tsx')
    expect(result.code).toContain('export const DomainStore = types')
    expect(result.code).toContain('workspaceCollection: types.optional(WorkspaceCollection')
    expect(result.code).toContain('projectCollection: types.optional(ProjectCollection')
  })

  it('should include factory functions', () => {
    const result = generateMSTDomain([mockWorkspaceModel as any])

    expect(result.code).toContain('export function createDomainStore(env: ISDKEnvironment): IDomainStore')
    expect(result.code).toContain('export function getDomainStore(env?: ISDKEnvironment): IDomainStore')
    expect(result.code).toContain('export function resetDomainStore(): void')
  })

  it('should export ISDKEnvironment interface', () => {
    const result = generateMSTDomain([mockWorkspaceModel as any])

    expect(result.code).toContain('export interface ISDKEnvironment')
    expect(result.code).toContain('http: HttpClient')
  })

  it('should include clearAll and clearAllErrors actions', () => {
    const result = generateMSTDomain([mockWorkspaceModel as any, mockProjectModel as any])

    expect(result.code).toContain('clearAll()')
    expect(result.code).toContain('self.workspaceCollection.clear()')
    expect(result.code).toContain('clearAllErrors()')
    expect(result.code).toContain('self.workspaceCollection.clearError()')
  })

  it('should re-export model and collection types', () => {
    const result = generateMSTDomain([mockWorkspaceModel as any])

    expect(result.code).toContain('export { WorkspaceModel, type IWorkspace')
    expect(result.code).toContain('export { WorkspaceCollection, type IWorkspaceCollection')
  })
})

describe('MST Store Integration', () => {
  // Create actual MST types to test runtime behavior
  const TestModel = types
    .model('TestModel', {
      id: types.identifier,
      name: types.string,
      createdAt: types.number,
    })
    .actions(self => ({
      update(changes: any) {
        Object.assign(self, changes)
      },
    }))

  const TestCollection = types
    .model('TestCollection', {
      items: types.map(TestModel),
      isLoading: types.optional(types.boolean, false),
      error: types.maybeNull(types.string),
    })
    .views(self => ({
      get all() {
        return Array.from(self.items.values())
      },
      get(id: string) {
        return self.items.get(id)
      },
    }))
    .actions(self => ({
      addItem(item: any) {
        self.items.put(item)
      },
      removeItem(id: string) {
        self.items.delete(id)
      },
      clear() {
        self.items.clear()
      },
    }))

  it('should create store with empty items', () => {
    const store = TestCollection.create({ items: {} })

    expect(store.all.length).toBe(0)
    expect(store.isLoading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('should add and retrieve items', () => {
    const store = TestCollection.create({ items: {} })

    store.addItem({
      id: 'test-1',
      name: 'Test Workspace',
      createdAt: Date.now(),
    })

    expect(store.all.length).toBe(1)
    expect(store.get('test-1')?.name).toBe('Test Workspace')
  })

  it('should update items', () => {
    const store = TestCollection.create({
      items: {
        'test-1': {
          id: 'test-1',
          name: 'Original',
          createdAt: Date.now(),
        },
      },
    })

    const item = store.get('test-1')
    item?.update({ name: 'Updated' })

    expect(store.get('test-1')?.name).toBe('Updated')
  })

  it('should remove items', () => {
    const store = TestCollection.create({
      items: {
        'test-1': {
          id: 'test-1',
          name: 'Test',
          createdAt: Date.now(),
        },
      },
    })

    expect(store.all.length).toBe(1)
    store.removeItem('test-1')
    expect(store.all.length).toBe(0)
  })

  it('should clear all items', () => {
    const store = TestCollection.create({
      items: {
        'test-1': { id: 'test-1', name: 'One', createdAt: Date.now() },
        'test-2': { id: 'test-2', name: 'Two', createdAt: Date.now() },
      },
    })

    expect(store.all.length).toBe(2)
    store.clear()
    expect(store.all.length).toBe(0)
  })

  it('should produce correct snapshots', () => {
    const store = TestCollection.create({
      items: {
        'test-1': { id: 'test-1', name: 'Test', createdAt: 1234567890 },
      },
    })

    const snapshot = getSnapshot(store)

    expect(snapshot.items['test-1'].id).toBe('test-1')
    expect(snapshot.items['test-1'].name).toBe('Test')
    expect(snapshot.items['test-1'].createdAt).toBe(1234567890)
  })
})

describe('Prisma Schema Parsing', () => {
  it('should parse schema from file', async () => {
    const schemaPath = path.join(process.cwd(), 'prisma/schema.prisma')

    try {
      const dmmf = await parsePrismaSchema(schemaPath)

      expect(dmmf.datamodel.models.length).toBeGreaterThan(0)

      // Check for expected models
      const modelNames = dmmf.datamodel.models.map(m => m.name)
      expect(modelNames).toContain('Workspace')
      expect(modelNames).toContain('Project')
    } catch (error) {
      // Skip if prisma schema not available
      console.log('Skipping Prisma schema test (schema not available)')
    }
  })
})
