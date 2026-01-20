/**
 * Authorization Service Implementation
 *
 * Provides opaque trust determination and scope filter building.
 *
 * Key design decisions:
 * - Trust is determined ONLY from environment variables (opaque)
 * - No `trusted` flag in any interface or parameter
 * - Domain-agnostic: scope names are used as keys into authorizedScopes
 * - Empty/missing scope returns `{ $in: [] }` (secure default - matches nothing)
 */

import type { IAuthContext, IAuthorizationService, AuthorizationConfig } from './types'

/**
 * Determine if running in trusted mode.
 *
 * OPAQUE IMPLEMENTATION - reads only environment variables:
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
 * Authorization service implementation.
 *
 * Stateless service that builds query filters based on authorization
 * context and schema-driven configuration.
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
   * Build a scope filter from auth context and config.
   *
   * In trusted mode, returns null (no filter applied).
   * Otherwise, builds a `{ [scopeField]: { $in: authorizedIds } }` filter.
   *
   * If the user has no authorized IDs for the scope, returns
   * `{ [scopeField]: { $in: [] } }` which matches nothing - this is
   * the secure default behavior.
   *
   * @param authContext - Current auth context with authorized scopes
   * @param config - Authorization config from x-authorization annotation
   * @returns MongoDB-style filter object, or null if trusted mode
   */
  buildScopeFilter(
    authContext: IAuthContext,
    config: AuthorizationConfig
  ): Record<string, any> | null {
    // In trusted mode, no filter needed - bypass all authorization
    if (this.isTrusted()) {
      return null
    }

    // Domain-agnostic lookup: use scope name as key into authorizedScopes map
    // Missing scope key or undefined authorizedScopes returns empty array
    const authorizedIds = authContext.authorizedScopes?.[config.scope] ?? []

    // Build $in filter on scopeField
    // Empty array means "match nothing" - secure default when user has no access
    return {
      [config.scopeField]: { $in: authorizedIds }
    }
  }
}

/**
 * Singleton instance for convenience.
 *
 * The AuthorizationService is stateless, so a single instance can be
 * safely shared across the application.
 */
export const authorizationService = new AuthorizationService()
