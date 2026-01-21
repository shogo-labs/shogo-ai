/**
 * Authorization Types (v2 - Subquery-Based)
 *
 * Pure type definitions for schema-driven authorization.
 * NO runtime imports - interface contract only.
 *
 * Key design decisions:
 * - NO `trusted` flag in any interface - trust is determined opaquely via environment
 * - Domain-agnostic: `scope` is a string, not an enum
 * - v2: Subquery-based filtering eliminates pre-computed scope IDs
 * - Cross-schema: Authorization queries studio-core.Member for all domains
 */

/**
 * Configuration extracted from `x-authorization` schema annotation.
 *
 * Supports three authorization patterns:
 * 1. **Direct scope**: User must have membership for the scope
 * 2. **Cascade scope**: User has access via direct OR parent scope membership
 * 3. **Self-scoping**: Entity belongs to user directly (filter by userId field)
 *
 * @example Direct scope (Workspace)
 * {
 *   "Workspace": {
 *     "x-authorization": { "scope": "workspace", "scopeField": "id" }
 *   }
 * }
 *
 * @example Cascade scope (Project - accessible via project OR workspace membership)
 * {
 *   "Project": {
 *     "x-authorization": {
 *       "scope": "project",
 *       "scopeField": "id",
 *       "cascadeFrom": { "scope": "workspace", "foreignKey": "workspace" }
 *     }
 *   }
 * }
 *
 * @example Self-scoping (Member - belongs to user)
 * {
 *   "Member": {
 *     "x-authorization": { "selfScoping": { "field": "userId" } }
 *   }
 * }
 */
export interface AuthorizationConfig {
  /**
   * The scope type for this model.
   *
   * This is a string (not an enum) to remain domain-agnostic.
   * Common values: "workspace", "project", "user", "tenant", etc.
   *
   * For scope-based authorization, this determines which membership
   * field to query (e.g., scope: "workspace" queries Member.workspace).
   *
   * Optional when using selfScoping.
   */
  scope?: string

  /**
   * Field name on the entity containing the scope reference.
   *
   * Used to build the subquery filter: `{ [scopeField]: { $in: <subquery> } }`
   *
   * @example "id" for Workspace, "workspace" for BillingAccount
   *
   * Optional when using selfScoping.
   */
  scopeField?: string

  /**
   * Cascade authorization from a parent scope.
   *
   * When set, user has access if they have EITHER:
   * - Direct membership for the model's scope (e.g., project membership)
   * - Membership for the parent scope (e.g., workspace membership)
   *
   * This generates an $or filter with both subqueries.
   *
   * @example Project cascades from workspace
   * {
   *   cascadeFrom: {
   *     scope: "workspace",      // Parent scope type
   *     foreignKey: "workspace"  // Field on this model referencing parent
   *   }
   * }
   */
  cascadeFrom?: {
    /**
     * Parent scope type to cascade from.
     * @example "workspace" for Project
     */
    scope: string

    /**
     * Field on this model that references the parent scope.
     * @example "workspace" field on Project model
     */
    foreignKey: string
  }

  /**
   * Self-scoping: Entity belongs to the user directly.
   *
   * When set, authorization uses a simple equality filter on the
   * specified field instead of a membership subquery.
   *
   * Use for models like Member, Notification, StarredProject that
   * have a direct userId field.
   *
   * @example Member self-scopes by userId
   * { selfScoping: { field: "userId" } }
   */
  selfScoping?: {
    /**
     * Field on this model containing the user ID.
     * @example "userId"
     */
    field: string
  }
}

/**
 * Authorization context passed to authorization checks (v2).
 *
 * IMPORTANT: No `trusted` flag - trust is determined opaquely
 * via `determineTrustedMode()` from environment variables only.
 *
 * v2 CHANGE: Simplified to just userId. Scope resolution happens
 * at query time via subqueries against the membership model,
 * eliminating the need for pre-computed authorizedScopes.
 */
export interface IAuthContext {
  /**
   * Current user's ID.
   *
   * Required for authorization. The userId is used to build
   * subqueries against the membership model to determine access.
   */
  userId: string
}

/**
 * Authorization service interface (v2).
 *
 * Responsible for:
 * 1. Determining if trusted mode is active (from environment)
 * 2. Building subquery-based scope filters from auth context + config
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
   * Build a scope filter from auth context and authorization config (v2).
   *
   * v2 returns subquery-based filters that resolve membership at query time,
   * instead of pre-computed scope ID arrays.
   *
   * @param authContext - Current auth context with userId
   * @param config - Authorization config from x-authorization annotation
   * @returns MongoDB-style filter object with subquery, or null if trusted mode
   *
   * @example Direct scope (Workspace)
   * // Config: { scope: 'workspace', scopeField: 'id' }
   * // Context: { userId: 'user-123' }
   * // Returns: { id: { $in: { $query: { schema: 'studio-core', model: 'Member', filter: { userId: 'user-123', workspace: { $ne: null } }, field: 'workspace' } } } }
   *
   * @example Self-scoping (Member)
   * // Config: { selfScoping: { field: 'userId' } }
   * // Context: { userId: 'user-123' }
   * // Returns: { userId: 'user-123' }
   *
   * @example Cascade scope (Project)
   * // Config: { scope: 'project', scopeField: 'id', cascadeFrom: { scope: 'workspace', foreignKey: 'workspace' } }
   * // Returns: { $or: [<direct subquery>, <cascade subquery>] }
   */
  buildScopeFilter(
    authContext: IAuthContext,
    config: AuthorizationConfig
  ): Record<string, any> | null
}
