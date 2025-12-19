/**
 * Runtime Store Cache
 *
 * Centralized cache for runtime MST stores created from schemas.
 * Separated from bootstrap to avoid circular dependency between:
 * - bootstrap.ts (imports createMetaStore from meta-store.ts)
 * - meta-store.ts (needs cache functions)
 *
 * This module breaks the cycle by providing cache functions
 * that both bootstrap.ts and meta-store.ts can import.
 */

/**
 * Cache of runtime MST stores, keyed by schema ID and optional location.
 * Each runtime store contains collections for actual data (userCollection, etc.)
 *
 * Cache Key Format (Unit 3 - Workspace-Aware Caching):
 * - Without location: `schemaId`
 * - With location: `${location}::${schemaId}`
 *
 * This allows multiple workspaces to have separate runtime stores for the same
 * schema, preventing data corruption when different workspaces share schemas.
 *
 * Example keys:
 * - "abc-123-456" (no location, backward compatible)
 * - "/workspace/project::abc-123-456" (filesystem location)
 * - "s3://bucket/prefix::abc-123-456" (S3 location)
 */
const _runtimeStores = new Map<string, any>()

/**
 * Builds cache key from schema ID and optional location.
 *
 * Uses double colon `::` as separator to prevent collisions.
 * Empty strings and undefined are treated as "no location".
 *
 * @private
 * @param schemaId - UUID of the schema
 * @param location - Optional workspace/storage location
 * @returns Cache key string
 */
function buildCacheKey(schemaId: string, location?: string): string {
  const normalizedLocation = location || undefined
  return normalizedLocation ? `${normalizedLocation}::${schemaId}` : schemaId
}

/**
 * Gets a runtime store from the cache by schema ID and optional location.
 *
 * Unit 3 Update: Added location parameter for workspace-aware caching.
 * This fixes the bug where multiple workspaces shared the same cached store,
 * causing data corruption.
 *
 * @param schemaId - UUID of the schema
 * @param location - Optional workspace/storage location (e.g., '/workspace/project', 's3://bucket/prefix')
 * @returns The cached runtime store, or undefined if not found
 *
 * @example
 * // Get default (no-location) store
 * const store = getRuntimeStore('schema-123')
 *
 * // Get workspace-specific store
 * const store = getRuntimeStore('schema-123', '/workspace/project')
 */
export function getRuntimeStore(schemaId: string, location?: string) {
  const key = buildCacheKey(schemaId, location)
  return _runtimeStores.get(key)
}

/**
 * Caches a runtime store by schema ID and optional location.
 *
 * Unit 3 Update: Added location parameter for workspace-aware caching.
 * Previously, all workspaces shared the same cached store for a given schema,
 * causing data corruption. Now each (schema, location) tuple gets its own cache entry.
 *
 * @param schemaId - UUID of the schema
 * @param store - The MST runtime store instance
 * @param location - Optional workspace/storage location
 *
 * @example
 * // Cache default (no-location) store
 * cacheRuntimeStore('schema-123', store)
 *
 * // Cache workspace-specific store
 * cacheRuntimeStore('schema-123', store, '/workspace/project')
 */
export function cacheRuntimeStore(schemaId: string, store: any, location?: string) {
  const key = buildCacheKey(schemaId, location)
  _runtimeStores.set(key, store)
}

/**
 * Clears all cached runtime stores.
 * Useful for testing or session cleanup.
 */
export function clearRuntimeStores() {
  _runtimeStores.clear()
}

/**
 * Gets all cached schema IDs.
 *
 * @returns Array of schema IDs currently in cache
 */
export function getCachedSchemaIds(): string[] {
  return Array.from(_runtimeStores.keys())
}

/**
 * Removes a specific runtime store from the cache.
 *
 * Unit 3 Update: Added location parameter for workspace-aware removal.
 *
 * @param schemaId - UUID of the schema to remove
 * @param location - Optional workspace/storage location
 * @returns True if the store was removed, false if it wasn't in cache
 *
 * @example
 * // Remove default (no-location) store
 * removeRuntimeStore('schema-123')
 *
 * // Remove workspace-specific store
 * removeRuntimeStore('schema-123', '/workspace/project')
 */
export function removeRuntimeStore(schemaId: string, location?: string): boolean {
  const key = buildCacheKey(schemaId, location)
  return _runtimeStores.delete(key)
}

/**
 * Removes ALL runtime stores for a given schema ID across all workspaces.
 *
 * This is used during schema hot-reload to ensure no stale stores remain
 * regardless of which workspace they were created in.
 *
 * @param schemaId - UUID of the schema to remove all stores for
 * @returns Number of stores removed
 *
 * @example
 * // Remove all stores for a schema (across all workspaces)
 * const count = removeRuntimeStoresForSchema('schema-123')
 * console.log(`Removed ${count} cached stores`)
 */
export function removeRuntimeStoresForSchema(schemaId: string): number {
  let removedCount = 0
  for (const key of _runtimeStores.keys()) {
    // Key format: "location::schemaId" or just "schemaId"
    if (key === schemaId || key.endsWith(`::${schemaId}`)) {
      _runtimeStores.delete(key)
      removedCount++
    }
  }
  return removedCount
}
