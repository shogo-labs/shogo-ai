/**
 * CollectionAuthorizable Mixin Integration Tests
 *
 * TDD RED phase: These tests are written BEFORE the implementation.
 * They should all FAIL initially, then pass after implementation.
 *
 * Tests verify:
 * 1. Mixin behavior (graceful degradation when auth not configured)
 * 2. Filter injection (auth filter applied BEFORE user filters)
 * 3. Real query execution (E2E with MemoryBackend)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { types, getEnv } from 'mobx-state-tree'
import { CollectionQueryable } from '../../composition/queryable'
import { MemoryBackend } from '../../query/backends/memory'
import { BackendRegistry } from '../../query/registry'
import type { IEnvironment } from '../../environment/types'
import { AuthorizationService, extractAllAuthorizationConfigs } from '../index'
import type { IAuthContext, AuthorizationConfig } from '../types'

// ============================================================================
// Test Schema - Models with and without x-authorization
// ============================================================================

const testSchema = {
  $defs: {
    Project: {
      type: 'object',
      'x-original-name': 'Project',
      'x-authorization': {
        scope: 'workspace',
        scopeField: 'workspaceId'
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        name: { type: 'string' },
        workspaceId: { type: 'string' }
      },
      required: ['id', 'name', 'workspaceId']
    },
    Task: {
      type: 'object',
      'x-original-name': 'Task',
      'x-authorization': {
        scope: 'project',
        scopeField: 'projectId'
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        title: { type: 'string' },
        projectId: { type: 'string' }
      },
      required: ['id', 'title', 'projectId']
    },
    // NO x-authorization - should be unprotected
    Tag: {
      type: 'object',
      'x-original-name': 'Tag',
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        name: { type: 'string' }
      },
      required: ['id', 'name']
    }
  }
}

// ============================================================================
// Test Data
// ============================================================================

const testData = {
  projects: [
    { id: 'proj-1', name: 'Project 1', workspaceId: 'ws-1' },
    { id: 'proj-2', name: 'Project 2', workspaceId: 'ws-1' },
    { id: 'proj-3', name: 'Project 3', workspaceId: 'ws-2' }
  ],
  tasks: [
    { id: 'task-1', title: 'Task 1', projectId: 'proj-1' },
    { id: 'task-2', title: 'Task 2', projectId: 'proj-2' },
    { id: 'task-3', title: 'Task 3', projectId: 'proj-3' }
  ],
  tags: [
    { id: 'tag-1', name: 'Important' },
    { id: 'tag-2', name: 'Urgent' }
  ]
}

// ============================================================================
// Test Auth Contexts
// ============================================================================

const testContexts = {
  alice: {
    // Has access to ws-1 (projects 1 & 2)
    userId: 'alice',
    authorizedScopes: {
      workspace: ['ws-1'],
      project: ['proj-1', 'proj-2']
    }
  } as IAuthContext,
  bob: {
    // Has access to ws-2 (project 3)
    userId: 'bob',
    authorizedScopes: {
      workspace: ['ws-2'],
      project: ['proj-3']
    }
  } as IAuthContext,
  charlie: {
    // No access to anything
    userId: 'charlie',
    authorizedScopes: {}
  } as IAuthContext
}

// ============================================================================
// Test Models
// ============================================================================

const ProjectModel = types.model('Project', {
  id: types.identifier,
  name: types.string,
  workspaceId: types.string
})

const TaskModel = types.model('Task', {
  id: types.identifier,
  title: types.string,
  projectId: types.string
})

const TagModel = types.model('Tag', {
  id: types.identifier,
  name: types.string
})

// ============================================================================
// Test Collection Factories
// ============================================================================

function createBaseCollection(ItemModel: any, modelName: string) {
  return types
    .model(`${modelName}Collection`, {
      items: types.map(ItemModel)
    })
    .views((self) => ({
      get modelName() {
        return modelName
      },
      all() {
        return Array.from(self.items.values())
      }
    }))
    .actions((self) => ({
      add(item: any) {
        self.items.put(item)
      },
      clear() {
        self.items.clear()
      }
    }))
}

// ============================================================================
// Environment Helpers
// ============================================================================

let originalNodeEnv: string | undefined
let originalTrustedMode: string | undefined

function saveEnv() {
  originalNodeEnv = process.env.NODE_ENV
  originalTrustedMode = process.env.SHOGO_TRUSTED_MODE
}

function restoreEnv() {
  if (originalNodeEnv !== undefined) {
    process.env.NODE_ENV = originalNodeEnv
  } else {
    delete process.env.NODE_ENV
  }
  if (originalTrustedMode !== undefined) {
    process.env.SHOGO_TRUSTED_MODE = originalTrustedMode
  } else {
    delete process.env.SHOGO_TRUSTED_MODE
  }
}

function createTestEnvironment(options: {
  authContext?: IAuthContext
  includeAuthService?: boolean
  includeAuthConfigs?: boolean
}): IEnvironment {
  const registry = new BackendRegistry()
  registry.register('memory', new MemoryBackend())
  registry.setDefault('memory')

  const services: IEnvironment['services'] = {
    persistence: {} as any,
    backendRegistry: registry
  }

  // Optionally add authorization service
  if (options.includeAuthService !== false) {
    services.authorization = new AuthorizationService()
  }

  // Pre-compute authorization config maps (following domain.ts pattern)
  const authorizationConfigMaps = options.includeAuthConfigs !== false
    ? Object.fromEntries(extractAllAuthorizationConfigs(testSchema.$defs))
    : undefined

  return {
    services,
    context: {
      schemaName: 'test-schema',
      authContext: options.authContext,
      authorizationConfigMaps
    }
  }
}

// ============================================================================
// Group 1: Mixin Behavior (Unit Tests)
// ============================================================================

describe('CollectionAuthorizable mixin behavior', () => {
  beforeEach(() => {
    saveEnv()
    process.env.NODE_ENV = 'development'
    delete process.env.SHOGO_TRUSTED_MODE
  })

  afterEach(() => {
    restoreEnv()
  })

  test('query() returns base query when no auth service configured', async () => {
    // Given: Collection without auth service in environment
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.alice,
      includeAuthService: false // No auth service
    })
    const collection = Collection.create({}, env)

    // Seed data
    testData.projects.forEach((p) => collection.add(p))

    // When: Querying
    const results = await collection.query().toArray()

    // Then: Should return all items (no filtering)
    expect(results.length).toBe(3)
  })

  test('query() returns base query when no auth context in environment', async () => {
    // Given: Collection with auth service but no authContext
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: undefined, // No auth context
      includeAuthService: true
    })
    const collection = Collection.create({}, env)

    // Seed data
    testData.projects.forEach((p) => collection.add(p))

    // When: Querying
    const results = await collection.query().toArray()

    // Then: Should return all items (no filtering)
    expect(results.length).toBe(3)
  })

  test('query() returns base query when model has no x-authorization', async () => {
    // Given: Tag collection (no x-authorization in schema)
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(TagModel, 'Tag')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('TagCollection')

    const env = createTestEnvironment({
      authContext: testContexts.alice,
      includeAuthService: true
    })
    const collection = Collection.create({}, env)

    // Seed data
    testData.tags.forEach((t) => collection.add(t))

    // When: Querying unprotected model
    const results = await collection.query().toArray()

    // Then: Should return all items (Tag has no x-authorization)
    expect(results.length).toBe(2)
  })

  test('query() applies scope filter when auth is fully configured', async () => {
    // Given: Project collection with full auth config (Alice can see ws-1)
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.alice, // workspace: ['ws-1']
      includeAuthService: true
    })
    const collection = Collection.create({}, env)

    // Seed data (3 projects: 2 in ws-1, 1 in ws-2)
    testData.projects.forEach((p) => collection.add(p))

    // When: Querying with Alice's context
    const results = await collection.query().toArray()

    // Then: Should only see ws-1 projects (proj-1, proj-2)
    expect(results.length).toBe(2)
    expect(results.map((r: any) => r.id).sort()).toEqual(['proj-1', 'proj-2'])
  })

  test('query() returns base query in trusted mode (filter is null)', async () => {
    // Given: Trusted mode enabled
    process.env.SHOGO_TRUSTED_MODE = 'true'

    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    // Charlie has no access, but trusted mode should bypass
    const env = createTestEnvironment({
      authContext: testContexts.charlie, // No scopes
      includeAuthService: true
    })
    const collection = Collection.create({}, env)

    // Seed data
    testData.projects.forEach((p) => collection.add(p))

    // When: Querying in trusted mode
    const results = await collection.query().toArray()

    // Then: Should return all items (trusted mode bypasses auth)
    expect(results.length).toBe(3)
  })
})

// ============================================================================
// Group 2: Filter Injection (Integration Tests)
// ============================================================================

describe('Authorization filter injection', () => {
  beforeEach(() => {
    saveEnv()
    process.env.NODE_ENV = 'development'
    delete process.env.SHOGO_TRUSTED_MODE
  })

  afterEach(() => {
    restoreEnv()
  })

  test('user .where() chains correctly after auth filter', async () => {
    // Given: Project collection with auth filter (Alice: ws-1)
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.alice // workspace: ['ws-1']
    })
    const collection = Collection.create({}, env)

    // Seed data: proj-1 (ws-1), proj-2 (ws-1), proj-3 (ws-2)
    testData.projects.forEach((p) => collection.add(p))

    // When: Adding user filter on top of auth filter
    const results = await collection
      .query()
      .where({ name: 'Project 1' })
      .toArray()

    // Then: Should apply BOTH filters (auth + user)
    // Auth: workspaceId in ['ws-1'] (proj-1, proj-2)
    // User: name = 'Project 1' (proj-1 only)
    expect(results.length).toBe(1)
    expect((results[0] as any).id).toBe('proj-1')
  })

  test('empty authorizedScopes returns empty results (secure default)', async () => {
    // Given: Charlie has no access to anything
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.charlie // authorizedScopes: {}
    })
    const collection = Collection.create({}, env)

    // Seed data
    testData.projects.forEach((p) => collection.add(p))

    // When: Charlie queries
    const results = await collection.query().toArray()

    // Then: Should return nothing (secure default)
    expect(results.length).toBe(0)
  })

  test('query with authorized access returns only authorized data', async () => {
    // Given: Bob has access to ws-2 only
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.bob // workspace: ['ws-2']
    })
    const collection = Collection.create({}, env)

    // Seed data: proj-1 (ws-1), proj-2 (ws-1), proj-3 (ws-2)
    testData.projects.forEach((p) => collection.add(p))

    // When: Bob queries
    const results = await collection.query().toArray()

    // Then: Should only see proj-3 (ws-2)
    expect(results.length).toBe(1)
    expect((results[0] as any).id).toBe('proj-3')
  })
})

// ============================================================================
// Group 3: Real Query Execution (E2E with MemoryBackend)
// ============================================================================

describe('Authorized queries with MemoryBackend', () => {
  beforeEach(() => {
    saveEnv()
    process.env.NODE_ENV = 'development'
    delete process.env.SHOGO_TRUSTED_MODE
  })

  afterEach(() => {
    restoreEnv()
  })

  test('authorized user sees only their projects', async () => {
    // Given: Full setup with Alice's auth context
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.alice // workspace: ['ws-1']
    })
    const collection = Collection.create({}, env)

    testData.projects.forEach((p) => collection.add(p))

    // When: Alice queries
    const results = await collection.query().toArray()

    // Then: Alice sees proj-1, proj-2 (both in ws-1)
    expect(results.length).toBe(2)
    const ids = results.map((r: any) => r.id).sort()
    expect(ids).toEqual(['proj-1', 'proj-2'])
  })

  test('unauthorized user sees nothing', async () => {
    // Given: Charlie has no access
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.charlie // No scopes
    })
    const collection = Collection.create({}, env)

    testData.projects.forEach((p) => collection.add(p))

    // When: Charlie queries
    const results = await collection.query().toArray()

    // Then: Charlie sees nothing
    expect(results.length).toBe(0)
  })

  test('trusted mode sees all data', async () => {
    // Given: Trusted mode + user with no access
    process.env.SHOGO_TRUSTED_MODE = 'true'

    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.charlie // No scopes, but trusted mode
    })
    const collection = Collection.create({}, env)

    testData.projects.forEach((p) => collection.add(p))

    // When: Querying in trusted mode
    const results = await collection.query().toArray()

    // Then: Sees all data despite having no scopes
    expect(results.length).toBe(3)
  })

  test('pagination works correctly with auth filter', async () => {
    // Given: Alice has access to ws-1 (2 projects)
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.alice // workspace: ['ws-1']
    })
    const collection = Collection.create({}, env)

    testData.projects.forEach((p) => collection.add(p))

    // When: Paginating with skip/take
    const page1 = await collection.query().orderBy('id', 'asc').take(1).toArray()
    const page2 = await collection.query().orderBy('id', 'asc').skip(1).take(1).toArray()

    // Then: Pagination applies AFTER auth filter
    expect(page1.length).toBe(1)
    expect((page1[0] as any).id).toBe('proj-1')
    expect(page2.length).toBe(1)
    expect((page2[0] as any).id).toBe('proj-2')
  })

  test('count() respects auth filter', async () => {
    // Given: Bob has access to ws-2 (1 project)
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.bob // workspace: ['ws-2']
    })
    const collection = Collection.create({}, env)

    testData.projects.forEach((p) => collection.add(p))

    // When: Counting
    const count = await collection.query().count()

    // Then: Count reflects authorized items only
    expect(count).toBe(1)
  })

  test('any() respects auth filter', async () => {
    // Given: Different auth contexts
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    // Bob has access to ws-2
    const envBob = createTestEnvironment({
      authContext: testContexts.bob
    })
    const collectionBob = Collection.create({}, envBob)
    testData.projects.forEach((p) => collectionBob.add(p))

    // Charlie has no access
    const envCharlie = createTestEnvironment({
      authContext: testContexts.charlie
    })
    const collectionCharlie = Collection.create({}, envCharlie)
    testData.projects.forEach((p) => collectionCharlie.add(p))

    // When: Checking any()
    const bobHasAny = await collectionBob.query().any()
    const charlieHasAny = await collectionCharlie.query().any()

    // Then: any() respects auth
    expect(bobHasAny).toBe(true)
    expect(charlieHasAny).toBe(false)
  })

  test('first() respects auth filter', async () => {
    // Given: Alice has access to ws-1
    const { CollectionAuthorizable } = await import('../../composition/authorizable')
    const BaseCollection = createBaseCollection(ProjectModel, 'Project')
    const Collection = types.compose(
      BaseCollection,
      CollectionQueryable,
      CollectionAuthorizable
    ).named('ProjectCollection')

    const env = createTestEnvironment({
      authContext: testContexts.alice // workspace: ['ws-1']
    })
    const collection = Collection.create({}, env)

    testData.projects.forEach((p) => collection.add(p))

    // When: Getting first ordered by id
    const first = await collection.query().orderBy('id', 'asc').first()

    // Then: First of authorized items
    expect(first).not.toBeNull()
    expect((first as any).id).toBe('proj-1')
  })
})
