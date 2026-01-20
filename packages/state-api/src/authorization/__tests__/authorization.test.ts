/**
 * Schema-Driven Authorization PoC Tests
 *
 * 4 test scenario groups:
 * 1. Config extraction from x-authorization annotations
 * 2. Query scoping via buildScopeFilter (domain-agnostic)
 * 3. Empty access returns secure default (matches nothing)
 * 4. Trusted mode bypass via environment variables
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  extractAuthorizationConfig,
  extractAllAuthorizationConfigs
} from '../extract-config'
import {
  AuthorizationService,
  determineTrustedMode
} from '../auth-service'
import type { IAuthContext } from '../types'

// ============================================================================
// Test Schema with x-authorization
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
    // Model without authorization (for testing null handling)
    Tag: {
      type: 'object',
      'x-original-name': 'Tag',
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        name: { type: 'string' }
      },
      required: ['id', 'name']
    },
    // Custom scope to prove domain-agnostic behavior
    TenantResource: {
      type: 'object',
      'x-original-name': 'TenantResource',
      'x-authorization': {
        scope: 'tenant',
        scopeField: 'tenantId'
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        tenantId: { type: 'string' },
        data: { type: 'string' }
      }
    }
  }
}

// ============================================================================
// Test Helpers - Environment Management
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

// ============================================================================
// Group 1: Config Extraction Tests
// ============================================================================

describe('Authorization Config Extraction', () => {
  test('extracts scope="workspace" from Project model', () => {
    const config = extractAuthorizationConfig(testSchema.$defs.Project)

    expect(config).not.toBeNull()
    expect(config!.scope).toBe('workspace')
    expect(config!.scopeField).toBe('workspaceId')
  })

  test('extracts scope="project" from Task model', () => {
    const config = extractAuthorizationConfig(testSchema.$defs.Task)

    expect(config).not.toBeNull()
    expect(config!.scope).toBe('project')
    expect(config!.scopeField).toBe('projectId')
  })

  test('extracts custom scope="tenant" (domain-agnostic)', () => {
    const config = extractAuthorizationConfig(testSchema.$defs.TenantResource)

    expect(config).not.toBeNull()
    expect(config!.scope).toBe('tenant')
    expect(config!.scopeField).toBe('tenantId')
  })

  test('returns null for model without x-authorization', () => {
    const config = extractAuthorizationConfig(testSchema.$defs.Tag)

    expect(config).toBeNull()
  })

  test('returns null for null input', () => {
    expect(extractAuthorizationConfig(null)).toBeNull()
  })

  test('returns null for undefined input', () => {
    expect(extractAuthorizationConfig(undefined)).toBeNull()
  })

  test('returns null for empty object', () => {
    expect(extractAuthorizationConfig({})).toBeNull()
  })

  test('returns null for missing scope', () => {
    const invalidModel = {
      type: 'object',
      'x-authorization': {
        // scope missing
        scopeField: 'someField'
      }
    }

    expect(extractAuthorizationConfig(invalidModel)).toBeNull()
  })

  test('returns null for non-string scope', () => {
    const invalidModel = {
      type: 'object',
      'x-authorization': {
        scope: 123, // Not a string
        scopeField: 'someField'
      }
    }

    expect(extractAuthorizationConfig(invalidModel)).toBeNull()
  })

  test('returns null for missing scopeField', () => {
    const invalidModel = {
      type: 'object',
      'x-authorization': {
        scope: 'project'
        // scopeField missing
      }
    }

    expect(extractAuthorizationConfig(invalidModel)).toBeNull()
  })

  test('returns null for non-string scopeField', () => {
    const invalidModel = {
      type: 'object',
      'x-authorization': {
        scope: 'project',
        scopeField: ['projectId'] // Not a string
      }
    }

    expect(extractAuthorizationConfig(invalidModel)).toBeNull()
  })

  test('accepts any scope string (domain-agnostic, no validation)', () => {
    const customModel = {
      type: 'object',
      'x-authorization': {
        scope: 'custom-scope-xyz',
        scopeField: 'customId'
      }
    }

    const config = extractAuthorizationConfig(customModel)

    expect(config).not.toBeNull()
    expect(config!.scope).toBe('custom-scope-xyz')
    expect(config!.scopeField).toBe('customId')
  })
})

describe('extractAllAuthorizationConfigs', () => {
  test('returns map of configured models only', () => {
    const configs = extractAllAuthorizationConfigs(testSchema.$defs)

    expect(configs.size).toBe(3) // Project, Task, TenantResource
    expect(configs.has('Project')).toBe(true)
    expect(configs.has('Task')).toBe(true)
    expect(configs.has('TenantResource')).toBe(true)
    expect(configs.has('Tag')).toBe(false) // No x-authorization
  })

  test('returns correct config for each model', () => {
    const configs = extractAllAuthorizationConfigs(testSchema.$defs)

    expect(configs.get('Project')).toEqual({
      scope: 'workspace',
      scopeField: 'workspaceId'
    })
    expect(configs.get('Task')).toEqual({
      scope: 'project',
      scopeField: 'projectId'
    })
  })

  test('returns empty map for null input', () => {
    const configs = extractAllAuthorizationConfigs(null as any)
    expect(configs.size).toBe(0)
  })

  test('returns empty map for undefined input', () => {
    const configs = extractAllAuthorizationConfigs(undefined as any)
    expect(configs.size).toBe(0)
  })

  test('returns empty map for empty $defs', () => {
    const configs = extractAllAuthorizationConfigs({})
    expect(configs.size).toBe(0)
  })
})

// ============================================================================
// Group 2: Query Scoping Tests (domain-agnostic via authorizedScopes map)
// ============================================================================

describe('Query Scoping via buildScopeFilter', () => {
  let service: AuthorizationService

  beforeEach(() => {
    saveEnv()
    // Ensure enforcement mode for these tests
    process.env.NODE_ENV = 'development'
    delete process.env.SHOGO_TRUSTED_MODE
    service = new AuthorizationService()
  })

  afterEach(() => {
    restoreEnv()
  })

  test('builds $in filter for workspace scope', () => {
    const authContext: IAuthContext = {
      userId: 'user-1',
      authorizedScopes: {
        workspace: ['ws-1', 'ws-2']
      }
    }
    const config = extractAuthorizationConfig(testSchema.$defs.Project)!

    const filter = service.buildScopeFilter(authContext, config)

    expect(filter).toEqual({
      workspaceId: { $in: ['ws-1', 'ws-2'] }
    })
  })

  test('builds $in filter for project scope', () => {
    const authContext: IAuthContext = {
      userId: 'user-1',
      authorizedScopes: {
        project: ['proj-1', 'proj-2', 'proj-3']
      }
    }
    const config = extractAuthorizationConfig(testSchema.$defs.Task)!

    const filter = service.buildScopeFilter(authContext, config)

    expect(filter).toEqual({
      projectId: { $in: ['proj-1', 'proj-2', 'proj-3'] }
    })
  })

  test('builds $in filter for custom tenant scope (domain-agnostic)', () => {
    const authContext: IAuthContext = {
      userId: 'user-1',
      authorizedScopes: {
        tenant: ['tenant-abc', 'tenant-xyz']
      }
    }
    const config = extractAuthorizationConfig(testSchema.$defs.TenantResource)!

    const filter = service.buildScopeFilter(authContext, config)

    expect(filter).toEqual({
      tenantId: { $in: ['tenant-abc', 'tenant-xyz'] }
    })
  })

  test('uses scopeField from config for filter key', () => {
    const authContext: IAuthContext = {
      authorizedScopes: {
        project: ['p1']
      }
    }
    // Custom config with different scopeField
    const customConfig = { scope: 'project', scopeField: 'customProjectRef' }

    const filter = service.buildScopeFilter(authContext, customConfig)

    expect(filter).toEqual({
      customProjectRef: { $in: ['p1'] }
    })
  })

  test('single authorized ID produces single-element array', () => {
    const authContext: IAuthContext = {
      authorizedScopes: {
        workspace: ['ws-only']
      }
    }
    const config = extractAuthorizationConfig(testSchema.$defs.Project)!

    const filter = service.buildScopeFilter(authContext, config)

    expect(filter).toEqual({
      workspaceId: { $in: ['ws-only'] }
    })
  })
})

// ============================================================================
// Group 3: Empty Access Returns Secure Default
// ============================================================================

describe('Empty Access Returns Secure Default', () => {
  let service: AuthorizationService

  beforeEach(() => {
    saveEnv()
    process.env.NODE_ENV = 'development'
    delete process.env.SHOGO_TRUSTED_MODE
    service = new AuthorizationService()
  })

  afterEach(() => {
    restoreEnv()
  })

  test('empty array in authorizedScopes returns $in: [] (matches nothing)', () => {
    const authContext: IAuthContext = {
      userId: 'user-1',
      authorizedScopes: {
        workspace: [] // Empty array
      }
    }
    const config = extractAuthorizationConfig(testSchema.$defs.Project)!

    const filter = service.buildScopeFilter(authContext, config)

    // $in: [] matches nothing - secure default
    expect(filter).toEqual({
      workspaceId: { $in: [] }
    })
  })

  test('missing scope key in authorizedScopes returns $in: [] (secure default)', () => {
    const authContext: IAuthContext = {
      userId: 'user-1',
      authorizedScopes: {
        workspace: ['ws-1'] // Has workspace, but querying project
      }
    }
    const config = extractAuthorizationConfig(testSchema.$defs.Task)! // scope: 'project'

    const filter = service.buildScopeFilter(authContext, config)

    // project key doesn't exist in authorizedScopes → empty array
    expect(filter).toEqual({
      projectId: { $in: [] }
    })
  })

  test('undefined authorizedScopes returns $in: [] for any scope', () => {
    const authContext: IAuthContext = {
      userId: 'user-1'
      // authorizedScopes undefined
    }
    const config = extractAuthorizationConfig(testSchema.$defs.Task)!

    const filter = service.buildScopeFilter(authContext, config)

    expect(filter).toEqual({
      projectId: { $in: [] }
    })
  })

  test('completely empty context returns $in: [] for workspace scope', () => {
    const emptyContext: IAuthContext = {}
    const projectConfig = extractAuthorizationConfig(testSchema.$defs.Project)!

    expect(service.buildScopeFilter(emptyContext, projectConfig)).toEqual({
      workspaceId: { $in: [] }
    })
  })

  test('completely empty context returns $in: [] for project scope', () => {
    const emptyContext: IAuthContext = {}
    const taskConfig = extractAuthorizationConfig(testSchema.$defs.Task)!

    expect(service.buildScopeFilter(emptyContext, taskConfig)).toEqual({
      projectId: { $in: [] }
    })
  })

  test('completely empty context returns $in: [] for custom scope', () => {
    const emptyContext: IAuthContext = {}
    const tenantConfig = extractAuthorizationConfig(testSchema.$defs.TenantResource)!

    expect(service.buildScopeFilter(emptyContext, tenantConfig)).toEqual({
      tenantId: { $in: [] }
    })
  })
})

// ============================================================================
// Group 4: Trusted Mode Bypass
// ============================================================================

describe('Trusted Mode Bypass', () => {
  beforeEach(() => {
    saveEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  describe('determineTrustedMode()', () => {
    test('production mode ALWAYS returns false (enforced)', () => {
      process.env.NODE_ENV = 'production'
      delete process.env.SHOGO_TRUSTED_MODE

      expect(determineTrustedMode()).toBe(false)
    })

    test('production mode ignores SHOGO_TRUSTED_MODE=true', () => {
      process.env.NODE_ENV = 'production'
      process.env.SHOGO_TRUSTED_MODE = 'true' // Should be ignored!

      expect(determineTrustedMode()).toBe(false)
    })

    test('production mode ignores SHOGO_TRUSTED_MODE=1', () => {
      process.env.NODE_ENV = 'production'
      process.env.SHOGO_TRUSTED_MODE = '1' // Should be ignored!

      expect(determineTrustedMode()).toBe(false)
    })

    test('development mode with SHOGO_TRUSTED_MODE=true returns true', () => {
      process.env.NODE_ENV = 'development'
      process.env.SHOGO_TRUSTED_MODE = 'true'

      expect(determineTrustedMode()).toBe(true)
    })

    test('development mode with SHOGO_TRUSTED_MODE=1 returns true', () => {
      process.env.NODE_ENV = 'development'
      process.env.SHOGO_TRUSTED_MODE = '1'

      expect(determineTrustedMode()).toBe(true)
    })

    test('development mode without SHOGO_TRUSTED_MODE returns false (enforced)', () => {
      process.env.NODE_ENV = 'development'
      delete process.env.SHOGO_TRUSTED_MODE

      expect(determineTrustedMode()).toBe(false)
    })

    test('development mode with SHOGO_TRUSTED_MODE=false returns false', () => {
      process.env.NODE_ENV = 'development'
      process.env.SHOGO_TRUSTED_MODE = 'false'

      expect(determineTrustedMode()).toBe(false)
    })

    test('test mode respects SHOGO_TRUSTED_MODE=true', () => {
      process.env.NODE_ENV = 'test'
      process.env.SHOGO_TRUSTED_MODE = 'true'

      expect(determineTrustedMode()).toBe(true)
    })

    test('test mode without SHOGO_TRUSTED_MODE returns false', () => {
      process.env.NODE_ENV = 'test'
      delete process.env.SHOGO_TRUSTED_MODE

      expect(determineTrustedMode()).toBe(false)
    })

    test('undefined NODE_ENV respects SHOGO_TRUSTED_MODE=true', () => {
      delete process.env.NODE_ENV
      process.env.SHOGO_TRUSTED_MODE = 'true'

      expect(determineTrustedMode()).toBe(true)
    })
  })

  describe('AuthorizationService.isTrusted()', () => {
    test('delegates to determineTrustedMode()', () => {
      process.env.NODE_ENV = 'development'
      process.env.SHOGO_TRUSTED_MODE = 'true'

      const service = new AuthorizationService()
      expect(service.isTrusted()).toBe(true)
    })

    test('returns false when not in trusted mode', () => {
      process.env.NODE_ENV = 'development'
      delete process.env.SHOGO_TRUSTED_MODE

      const service = new AuthorizationService()
      expect(service.isTrusted()).toBe(false)
    })
  })

  describe('buildScopeFilter in trusted mode', () => {
    test('returns null in trusted mode (bypass authorization)', () => {
      process.env.NODE_ENV = 'development'
      process.env.SHOGO_TRUSTED_MODE = 'true'

      const service = new AuthorizationService()
      const authContext: IAuthContext = {
        userId: 'user-1',
        authorizedScopes: {
          project: ['proj-1']
        }
      }
      const config = extractAuthorizationConfig(testSchema.$defs.Task)!

      // In trusted mode, no filter is applied
      const filter = service.buildScopeFilter(authContext, config)
      expect(filter).toBeNull()
    })

    test('returns null even with empty context in trusted mode', () => {
      process.env.NODE_ENV = 'development'
      process.env.SHOGO_TRUSTED_MODE = 'true'

      const service = new AuthorizationService()
      const emptyContext: IAuthContext = {}
      const config = extractAuthorizationConfig(testSchema.$defs.Task)!

      const filter = service.buildScopeFilter(emptyContext, config)
      expect(filter).toBeNull()
    })

    test('enforces in production even with SHOGO_TRUSTED_MODE set', () => {
      process.env.NODE_ENV = 'production'
      process.env.SHOGO_TRUSTED_MODE = 'true'

      const service = new AuthorizationService()
      const authContext: IAuthContext = {
        userId: 'user-1',
        authorizedScopes: {
          project: ['proj-1']
        }
      }
      const config = extractAuthorizationConfig(testSchema.$defs.Task)!

      // Should NOT return null - production always enforces
      const filter = service.buildScopeFilter(authContext, config)
      expect(filter).not.toBeNull()
      expect(filter).toEqual({
        projectId: { $in: ['proj-1'] }
      })
    })
  })
})
