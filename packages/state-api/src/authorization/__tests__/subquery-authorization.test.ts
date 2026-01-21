/**
 * Subquery-Based Authorization Tests (v2)
 *
 * Tests for the evolved authorization system that uses subqueries
 * instead of pre-computed scope IDs.
 *
 * Key changes from v1:
 * - IAuthContext simplified to just { userId }
 * - buildScopeFilter() returns subquery-based filters
 * - Support for cascadeFrom (workspace → project access)
 * - Support for selfScoping (Member, Notification filter by userId)
 * - Cross-schema authorization via studio-core.Member
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  extractAuthorizationConfig,
  extractAllAuthorizationConfigs
} from '../extract-config'
import {
  AuthorizationService,
  determineTrustedMode,
  MEMBERSHIP_SCHEMA,
  MEMBERSHIP_MODEL
} from '../auth-service'
import type { IAuthContext, AuthorizationConfig } from '../types'

// ============================================================================
// Test Schemas with v2 x-authorization annotations
// ============================================================================

/**
 * Schema representing studio-core models with various authorization patterns
 */
const studioCoreSchema = {
  $defs: {
    // Direct workspace scope - user must be workspace member
    Workspace: {
      type: 'object',
      'x-original-name': 'Workspace',
      'x-authorization': {
        scope: 'workspace',
        scopeField: 'id'
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        name: { type: 'string' }
      },
      required: ['id', 'name']
    },

    // Cascade scope - user has access via project membership OR workspace membership
    Project: {
      type: 'object',
      'x-original-name': 'Project',
      'x-authorization': {
        scope: 'project',
        scopeField: 'id',
        cascadeFrom: {
          scope: 'workspace',
          foreignKey: 'workspace'
        }
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        name: { type: 'string' },
        workspace: { type: 'string' }
      },
      required: ['id', 'name', 'workspace']
    },

    // Self-scoping - filter by userId directly (no subquery needed)
    Member: {
      type: 'object',
      'x-original-name': 'Member',
      'x-authorization': {
        selfScoping: {
          field: 'userId'
        }
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        userId: { type: 'string' },
        workspace: { type: 'string' },
        project: { type: 'string' },
        role: { type: 'string' }
      },
      required: ['id', 'userId', 'role']
    },

    // Self-scoping - notifications belong to user
    Notification: {
      type: 'object',
      'x-original-name': 'Notification',
      'x-authorization': {
        selfScoping: {
          field: 'userId'
        }
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        userId: { type: 'string' },
        message: { type: 'string' }
      },
      required: ['id', 'userId', 'message']
    },

    // Workspace-scoped child entity
    BillingAccount: {
      type: 'object',
      'x-original-name': 'BillingAccount',
      'x-authorization': {
        scope: 'workspace',
        scopeField: 'workspace'
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        workspace: { type: 'string' },
        planType: { type: 'string' }
      },
      required: ['id', 'workspace']
    },

    // Model without authorization - unprotected
    AuditLog: {
      type: 'object',
      'x-original-name': 'AuditLog',
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        action: { type: 'string' }
      }
    }
  }
}

/**
 * Schema representing platform-features domain (cross-schema authorization)
 */
const platformFeaturesSchema = {
  $defs: {
    // Cross-schema: references studio-core.Project, authorized via studio-core.Member
    FeatureSession: {
      type: 'object',
      'x-original-name': 'FeatureSession',
      'x-authorization': {
        scope: 'project',
        scopeField: 'project'
      },
      properties: {
        id: { type: 'string', 'x-mst-type': 'identifier' },
        project: { type: 'string' },  // Loose ref to studio-core.Project
        status: { type: 'string' }
      },
      required: ['id', 'project', 'status']
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
// Group 1: IAuthContext v2 - Simplified to just userId
// ============================================================================

describe('IAuthContext v2 - Simplified', () => {
  test('IAuthContext requires only userId', () => {
    // v2: No more authorizedScopes - just userId
    const authContext: IAuthContext = {
      userId: 'user-123'
    }

    expect(authContext.userId).toBe('user-123')
    // authorizedScopes should no longer be part of the interface
    expect((authContext as any).authorizedScopes).toBeUndefined()
  })

  test('IAuthContext userId is required (not optional)', () => {
    // TypeScript will enforce this at compile time
    // This test documents the expected behavior
    const authContext: IAuthContext = {
      userId: 'user-456'
    }

    expect(authContext.userId).toBeDefined()
    expect(typeof authContext.userId).toBe('string')
  })
})

// ============================================================================
// Group 2: AuthorizationConfig v2 - Extended with cascadeFrom, selfScoping
// ============================================================================

describe('AuthorizationConfig v2 - Extended', () => {
  describe('extractAuthorizationConfig with cascadeFrom', () => {
    test('extracts cascadeFrom for Project model', () => {
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Project)

      expect(config).not.toBeNull()
      expect(config!.scope).toBe('project')
      expect(config!.scopeField).toBe('id')
      expect(config!.cascadeFrom).toEqual({
        scope: 'workspace',
        foreignKey: 'workspace'
      })
    })

    test('cascadeFrom is undefined for non-cascading models', () => {
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Workspace)

      expect(config).not.toBeNull()
      expect(config!.scope).toBe('workspace')
      expect(config!.cascadeFrom).toBeUndefined()
    })
  })

  describe('extractAuthorizationConfig with selfScoping', () => {
    test('extracts selfScoping for Member model', () => {
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Member)

      expect(config).not.toBeNull()
      expect(config!.selfScoping).toEqual({
        field: 'userId'
      })
      // Self-scoping models don't need scope/scopeField
      expect(config!.scope).toBeUndefined()
      expect(config!.scopeField).toBeUndefined()
    })

    test('extracts selfScoping for Notification model', () => {
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Notification)

      expect(config).not.toBeNull()
      expect(config!.selfScoping).toEqual({
        field: 'userId'
      })
    })

    test('selfScoping is undefined for scope-based models', () => {
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Workspace)

      expect(config).not.toBeNull()
      expect(config!.selfScoping).toBeUndefined()
    })
  })

  describe('extractAllAuthorizationConfigs v2', () => {
    test('extracts all config types from studio-core schema', () => {
      const configs = extractAllAuthorizationConfigs(studioCoreSchema.$defs)

      // 5 models with x-authorization (AuditLog has none)
      expect(configs.size).toBe(5)
      expect(configs.has('Workspace')).toBe(true)
      expect(configs.has('Project')).toBe(true)
      expect(configs.has('Member')).toBe(true)
      expect(configs.has('Notification')).toBe(true)
      expect(configs.has('BillingAccount')).toBe(true)
      expect(configs.has('AuditLog')).toBe(false)
    })

    test('correctly categorizes config types', () => {
      const configs = extractAllAuthorizationConfigs(studioCoreSchema.$defs)

      // Direct scope
      const workspaceConfig = configs.get('Workspace')!
      expect(workspaceConfig.scope).toBe('workspace')
      expect(workspaceConfig.cascadeFrom).toBeUndefined()
      expect(workspaceConfig.selfScoping).toBeUndefined()

      // Cascade scope
      const projectConfig = configs.get('Project')!
      expect(projectConfig.scope).toBe('project')
      expect(projectConfig.cascadeFrom).toBeDefined()

      // Self-scoping
      const memberConfig = configs.get('Member')!
      expect(memberConfig.selfScoping).toBeDefined()
    })
  })
})

// ============================================================================
// Group 3: buildScopeFilter v2 - Subquery-based filters
// ============================================================================

describe('buildScopeFilter v2 - Subquery Filters', () => {
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

  describe('Direct scope (Workspace)', () => {
    test('returns subquery filter for workspace-scoped model', () => {
      const authContext: IAuthContext = { userId: 'user-123' }
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Workspace)!

      const filter = service.buildScopeFilter(authContext, config)

      expect(filter).toEqual({
        id: {
          $in: {
            $query: {
              schema: MEMBERSHIP_SCHEMA,
              model: MEMBERSHIP_MODEL,
              filter: { userId: 'user-123', workspace: { $ne: null } },
              field: 'workspace'
            }
          }
        }
      })
    })

    test('returns subquery filter for BillingAccount (workspace-scoped child)', () => {
      const authContext: IAuthContext = { userId: 'user-456' }
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.BillingAccount)!

      const filter = service.buildScopeFilter(authContext, config)

      expect(filter).toEqual({
        workspace: {
          $in: {
            $query: {
              schema: MEMBERSHIP_SCHEMA,
              model: MEMBERSHIP_MODEL,
              filter: { userId: 'user-456', workspace: { $ne: null } },
              field: 'workspace'
            }
          }
        }
      })
    })
  })

  describe('Cascade scope (Project)', () => {
    test('returns $or filter with direct AND cascade subqueries', () => {
      const authContext: IAuthContext = { userId: 'user-789' }
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Project)!

      const filter = service.buildScopeFilter(authContext, config)

      expect(filter).toEqual({
        $or: [
          // Direct project membership
          {
            id: {
              $in: {
                $query: {
                  schema: MEMBERSHIP_SCHEMA,
                  model: MEMBERSHIP_MODEL,
                  filter: { userId: 'user-789', project: { $ne: null } },
                  field: 'project'
                }
              }
            }
          },
          // Cascade via workspace membership
          {
            workspace: {
              $in: {
                $query: {
                  schema: MEMBERSHIP_SCHEMA,
                  model: MEMBERSHIP_MODEL,
                  filter: { userId: 'user-789', workspace: { $ne: null } },
                  field: 'workspace'
                }
              }
            }
          }
        ]
      })
    })
  })

  describe('Self-scoping (Member, Notification)', () => {
    test('returns direct userId filter for Member (no subquery)', () => {
      const authContext: IAuthContext = { userId: 'user-self' }
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Member)!

      const filter = service.buildScopeFilter(authContext, config)

      // Self-scoping uses direct equality, not subquery
      expect(filter).toEqual({
        userId: 'user-self'
      })
    })

    test('returns direct userId filter for Notification', () => {
      const authContext: IAuthContext = { userId: 'user-notif' }
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Notification)!

      const filter = service.buildScopeFilter(authContext, config)

      expect(filter).toEqual({
        userId: 'user-notif'
      })
    })
  })

  describe('Cross-schema (FeatureSession)', () => {
    test('returns subquery referencing studio-core.Member', () => {
      const authContext: IAuthContext = { userId: 'user-feat' }
      const config = extractAuthorizationConfig(platformFeaturesSchema.$defs.FeatureSession)!

      const filter = service.buildScopeFilter(authContext, config)

      // Cross-schema: FeatureSession is in platform-features,
      // but authorization subquery references studio-core.Member
      expect(filter).toEqual({
        project: {
          $in: {
            $query: {
              schema: MEMBERSHIP_SCHEMA,  // 'studio-core'
              model: MEMBERSHIP_MODEL,    // 'Member'
              filter: { userId: 'user-feat', project: { $ne: null } },
              field: 'project'
            }
          }
        }
      })
    })
  })

  describe('Trusted mode bypass', () => {
    test('returns null in trusted mode', () => {
      process.env.SHOGO_TRUSTED_MODE = 'true'

      const authContext: IAuthContext = { userId: 'user-trusted' }
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Workspace)!

      const filter = service.buildScopeFilter(authContext, config)

      expect(filter).toBeNull()
    })

    test('enforces in production even with SHOGO_TRUSTED_MODE', () => {
      process.env.NODE_ENV = 'production'
      process.env.SHOGO_TRUSTED_MODE = 'true'

      const authContext: IAuthContext = { userId: 'user-prod' }
      const config = extractAuthorizationConfig(studioCoreSchema.$defs.Workspace)!

      const filter = service.buildScopeFilter(authContext, config)

      // Should NOT be null - production always enforces
      expect(filter).not.toBeNull()
      expect(filter).toHaveProperty('id.$in.$query')
    })
  })
})

// ============================================================================
// Group 4: Constants exported for cross-schema reference
// ============================================================================

describe('Membership Schema Constants', () => {
  test('MEMBERSHIP_SCHEMA is studio-core', () => {
    expect(MEMBERSHIP_SCHEMA).toBe('studio-core')
  })

  test('MEMBERSHIP_MODEL is Member', () => {
    expect(MEMBERSHIP_MODEL).toBe('Member')
  })
})
