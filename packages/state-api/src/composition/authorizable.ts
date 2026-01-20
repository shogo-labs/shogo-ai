/**
 * CollectionAuthorizable Mixin
 *
 * Adds authorization layer to collection queries by wrapping the query()
 * method from CollectionQueryable with scope-based access filters.
 *
 * @module composition/authorizable
 *
 * Design:
 * - Must be composed AFTER CollectionQueryable (depends on query() method)
 * - Reads authorization config from env.context.authorizationConfigMaps
 * - Reads auth context from env.context.authContext
 * - Reads auth service from env.services.authorization
 * - Applies scope filter BEFORE returning query builder (query-level injection)
 *
 * Graceful Degradation:
 * - No auth service → return base query (no filtering)
 * - No auth context → return base query (no filtering)
 * - Model has no x-authorization → return base query (model is unprotected)
 * - Trusted mode → return base query (bypass authorization)
 *
 * Usage:
 * ```typescript
 * const MyCollection = types.compose(
 *   BaseCollection,
 *   CollectionQueryable,
 *   CollectionAuthorizable  // Must come AFTER CollectionQueryable
 * ).named('MyCollection')
 *
 * // With authorization:
 * const env = {
 *   services: { authorization: new AuthorizationService() },
 *   context: {
 *     authContext: { userId: 'u1', authorizedScopes: { workspace: ['ws-1'] } },
 *     authorizationConfigMaps: { Project: { scope: 'workspace', scopeField: 'workspaceId' } }
 *   }
 * }
 * const collection = MyCollection.create({}, env)
 * const results = await collection.query().toArray()  // Auto-filtered by workspace
 * ```
 */

import { types, getEnv } from 'mobx-state-tree'
import type { IEnvironment } from '../environment/types'
import type { IQueryable } from './queryable'

/**
 * CollectionAuthorizable mixin model.
 *
 * Wraps the query() method from CollectionQueryable to apply authorization
 * filters based on the current auth context and schema's x-authorization config.
 */
export const CollectionAuthorizable = types
  .model('CollectionAuthorizable', {})
  .views((self) => {
    // Capture reference to original query method from CollectionQueryable
    // This is set up during composition - CollectionQueryable must be composed first
    const originalQuery = (self as any).query?.bind(self)

    return {
      /**
       * Returns an IQueryable builder with authorization filter pre-applied.
       *
       * The authorization filter is applied BEFORE any user filters,
       * ensuring query-level access control (data never loads if unauthorized).
       *
       * @returns IQueryable builder with scope filter applied (if configured)
       */
      query<T>(): IQueryable<T> {
        // Safety check: CollectionQueryable must be composed first
        if (!originalQuery) {
          throw new Error(
            'CollectionAuthorizable requires CollectionQueryable to be composed first. ' +
            'Ensure composition order: CollectionQueryable → CollectionAuthorizable'
          )
        }

        // Get base query from CollectionQueryable
        const baseQuery: IQueryable<T> = originalQuery()

        // Get environment
        const env = getEnv<IEnvironment>(self)

        // Graceful degradation: No auth service configured
        const authService = env.services?.authorization
        if (!authService) {
          return baseQuery
        }

        // Graceful degradation: No auth context in environment
        const authContext = env.context?.authContext
        if (!authContext) {
          return baseQuery
        }

        // Get model name from collection (set by enhanced-json-schema-to-mst.ts)
        const modelName = (self as any).modelName
        if (!modelName) {
          return baseQuery
        }

        // Get authorization config from pre-computed maps
        // Models without x-authorization are unprotected
        const authConfig = env.context?.authorizationConfigMaps?.[modelName]
        if (!authConfig) {
          return baseQuery  // Model is unprotected
        }

        // Build scope filter using authorization service
        // Returns null in trusted mode (bypass authorization)
        const scopeFilter = authService.buildScopeFilter(authContext, authConfig)

        if (!scopeFilter) {
          return baseQuery  // Trusted mode - no filter
        }

        // Apply authorization filter FIRST, then return builder for user chaining
        // This ensures auth filter is applied BEFORE any user filters
        return baseQuery.where(scopeFilter)
      }
    }
  })
