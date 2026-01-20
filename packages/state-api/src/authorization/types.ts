/**
 * Authorization Types
 *
 * Pure type definitions for schema-driven authorization.
 * NO runtime imports - interface contract only.
 *
 * Key design decisions:
 * - NO `trusted` flag in any interface - trust is determined opaquely via environment
 * - Domain-agnostic: `scope` is a string, not an enum
 * - `authorizedScopes` is a generic map, not hardcoded workspace/project fields
 */

/**
 * Configuration extracted from `x-authorization` schema annotation.
 *
 * @example
 * // In schema:
 * {
 *   "Task": {
 *     "x-authorization": { "scope": "project", "scopeField": "projectId" }
 *   }
 * }
 *
 * // Extracted as:
 * { scope: "project", scopeField: "projectId" }
 */
export interface AuthorizationConfig {
  /**
   * The scope type for this model.
   *
   * This is a string (not an enum) to remain domain-agnostic.
   * Common values: "workspace", "project", "user", "tenant", etc.
   * The scope name is used as a key into `IAuthContext.authorizedScopes`.
   */
  scope: string

  /**
   * Field name on the entity containing the scope reference.
   *
   * Used to build the query filter: `{ [scopeField]: { $in: authorizedIds } }`
   *
   * @example "projectId", "workspaceId", "tenantId"
   */
  scopeField: string
}

/**
 * Authorization context passed to authorization checks.
 *
 * IMPORTANT: No `trusted` flag - trust is determined opaquely
 * via `determineTrustedMode()` from environment variables only.
 *
 * This context should be built fresh per request from the user's
 * memberships/permissions at that moment in time.
 */
export interface IAuthContext {
  /**
   * Current user's ID (optional - may be anonymous/system request).
   */
  userId?: string

  /**
   * Generic scope authorization map.
   *
   * Keys are scope names (matching `AuthorizationConfig.scope`).
   * Values are arrays of authorized IDs for that scope.
   *
   * @example
   * {
   *   workspace: ['ws-1', 'ws-2'],
   *   project: ['proj-1', 'proj-2', 'proj-3']
   * }
   *
   * This is domain-agnostic - any scope type works.
   * Missing scope key is treated as empty array (no access).
   */
  authorizedScopes?: Record<string, string[]>
}

/**
 * Authorization service interface.
 *
 * Responsible for:
 * 1. Determining if trusted mode is active (from environment)
 * 2. Building scope filters from auth context + config
 */
export interface IAuthorizationService {
  /**
   * Check if trusted mode is active (authorization bypass).
   *
   * Trust is determined opaquely from environment variables:
   * - NODE_ENV=production: ALWAYS returns false (enforced)
   * - NODE_ENV=development/test + SHOGO_TRUSTED_MODE=true: returns true
   * - NODE_ENV=development/test + no flag: returns false (enforced)
   *
   * @returns true if in trusted mode (skip auth), false if enforced
   */
  isTrusted(): boolean

  /**
   * Build a scope filter from auth context and authorization config.
   *
   * @param authContext - Current auth context with authorized scopes
   * @param config - Authorization config from x-authorization annotation
   * @returns MongoDB-style filter object, or null if no filter needed (trusted mode)
   *
   * @example
   * // Config: { scope: 'project', scopeField: 'projectId' }
   * // Context: { authorizedScopes: { project: ['proj-1', 'proj-2'] } }
   * // Returns: { projectId: { $in: ['proj-1', 'proj-2'] } }
   *
   * // Empty/missing scope returns impossible filter:
   * // Returns: { projectId: { $in: [] } }  // Matches nothing
   */
  buildScopeFilter(
    authContext: IAuthContext,
    config: AuthorizationConfig
  ): Record<string, any> | null
}
