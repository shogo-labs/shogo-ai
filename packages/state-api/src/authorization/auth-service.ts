/**
 * Authorization Service Implementation (v2 - Subquery-Based)
 *
 * Provides opaque trust determination and subquery-based scope filter building.
 *
 * Key design decisions:
 * - Trust is determined ONLY from environment variables (opaque)
 * - No `trusted` flag in any interface or parameter
 * - v2: Subquery-based filters eliminate pre-computed scope IDs
 * - Cross-schema: Authorization queries studio-core.Member for all domains
 */

import type { IAuthContext, IAuthorizationService, AuthorizationConfig } from './types'

/**
 * Schema containing the membership model.
 * Hardcoded for internal domains - generalize later.
 */
export const MEMBERSHIP_SCHEMA = 'studio-core'

/**
 * Model name for membership records.
 * Hardcoded for internal domains - generalize later.
 */
export const MEMBERSHIP_MODEL = 'Member'

/**
 * Determine if running in trusted mode.
 *
 * OPAQUE IMPLEMENTATION - reads only environment variables:
 * - Browser: ALWAYS returns false (browsers never trusted)
 * - NODE_ENV=production: ALWAYS returns false (enforced)
 * - NODE_ENV=development/test: Reads SHOGO_TRUSTED_MODE
 *   - SHOGO_TRUSTED_MODE=true/1: Returns true (trusted, bypass auth)
 *   - Otherwise: Returns false (enforced)
 *
 * This function is intentionally kept simple and reads only from
 * the runtime environment. There is no way to pass a "trusted" flag
 * through any interface - trust must be established at process level.
 *
 * @returns true if in trusted mode (skip auth), false if enforced
 */
export function determineTrustedMode(): boolean {
  // Browser: ALWAYS enforces - no trusted mode in client
  if (typeof process === 'undefined' || !process.env) {
    return false
  }

  const nodeEnv = process.env.NODE_ENV

  // Production ALWAYS enforces - no exceptions
  if (nodeEnv === 'production') {
    return false
  }

  // Development/test: Check SHOGO_TRUSTED_MODE environment variable
  const trustedMode = process.env.SHOGO_TRUSTED_MODE
  return trustedMode === 'true' || trustedMode === '1'
}

/**
 * Authorization service implementation (v2).
 *
 * Stateless service that builds subquery-based filters based on
 * authorization context and schema-driven configuration.
 */
export class AuthorizationService implements IAuthorizationService {
  /**
   * Check if trusted mode is active (authorization bypass).
   *
   * Delegates to `determineTrustedMode()` which reads only from environment.
   */
  isTrusted(): boolean {
    return determineTrustedMode()
  }

  /**
   * Build a scope filter from auth context and config (v2 - subquery-based).
   *
   * In trusted mode, returns null (no filter applied).
   *
   * Otherwise, returns one of:
   * - Self-scoping: `{ [field]: userId }` - direct equality filter
   * - Direct scope: `{ [scopeField]: { $in: <subquery> } }` - membership subquery
   * - Cascade scope: `{ $or: [<direct subquery>, <cascade subquery>] }`
   *
   * @param authContext - Current auth context with userId
   * @param config - Authorization config from x-authorization annotation
   * @returns MongoDB-style filter object with subquery, or null if trusted mode
   */
  buildScopeFilter(
    authContext: IAuthContext,
    config: AuthorizationConfig
  ): Record<string, any> | null {
    // In trusted mode, no filter needed - bypass all authorization
    if (this.isTrusted()) {
      return null
    }

    const { userId } = authContext

    // Self-scoping models (Member, Notification, StarredProject)
    // Use direct equality filter - no subquery needed
    if (config.selfScoping) {
      return { [config.selfScoping.field]: userId }
    }

    // Scope-based models require scope and scopeField
    if (!config.scope || !config.scopeField) {
      // Invalid config - return impossible filter for safety
      return { _invalid: { $in: [] } }
    }

    // Build direct membership subquery
    const directFilter = {
      [config.scopeField]: {
        $in: {
          $query: {
            schema: MEMBERSHIP_SCHEMA,
            model: MEMBERSHIP_MODEL,
            filter: { userId, [config.scope]: { $ne: null } },
            field: config.scope
          }
        }
      }
    }

    // No cascade - return direct filter only
    if (!config.cascadeFrom) {
      return directFilter
    }

    // With cascade - $or of direct AND parent membership
    const cascadeFilter = {
      [config.cascadeFrom.foreignKey]: {
        $in: {
          $query: {
            schema: MEMBERSHIP_SCHEMA,
            model: MEMBERSHIP_MODEL,
            filter: { userId, [config.cascadeFrom.scope]: { $ne: null } },
            field: config.cascadeFrom.scope
          }
        }
      }
    }

    return { $or: [directFilter, cascadeFilter] }
  }
}

/**
 * Singleton instance for convenience.
 *
 * The AuthorizationService is stateless, so a single instance can be
 * safely shared across the application.
 */
export const authorizationService = new AuthorizationService()
