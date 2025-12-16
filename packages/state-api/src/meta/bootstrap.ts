/**
 * Meta-Store Bootstrap
 *
 * Provides singleton meta-store and runtime store cache management.
 * The meta-store manages Schema/Model/Property entities (metadata).
 * Runtime stores are dynamically generated MST stores for actual data.
 */

import { createMetaStore } from "./meta-store"
import type { IEnvironment } from "../environment/types"

// Re-export runtime store cache functions for backward compatibility
// (tests and some code import these from bootstrap)
export {
  getRuntimeStore,
  cacheRuntimeStore,
  clearRuntimeStores,
  getCachedSchemaIds,
  removeRuntimeStore
} from "./runtime-store-cache"

// ============================================================================
// Meta-Store Singleton
// ============================================================================

/**
 * Singleton meta-store instance.
 * The meta-store itself is an MST store that manages schema metadata.
 */
let _metaStore: any = null

/**
 * Stored environment for the singleton meta-store.
 * Used to detect configuration changes and pass to createStore().
 */
let _metaStoreEnv: IEnvironment | undefined

/**
 * Gets or creates the singleton meta-store.
 * The meta-store manages Schema/Model/Property entities.
 *
 * First call with env sets the configuration.
 * Subsequent calls return the same instance (env is only used if store doesn't exist).
 *
 * For browser contexts where you need isolated instances, use createMetaStoreInstance() instead.
 *
 * **Environment-based injection (recommended):**
 * ```typescript
 * const metaStore = getMetaStore({
 *   services: {
 *     persistence: new FileSystemPersistence(),
 *     backendRegistry: createBackendRegistry({ default: 'memory', backends: { memory: new MemoryBackend() } })
 *   }
 * })
 * ```
 *
 * @param env - Optional environment with services (no context needed for meta-store)
 * @returns The meta-store instance
 */
export function getMetaStore(env?: IEnvironment) {
  // If env provided and different from current, reset to allow reconfiguration
  if (env && env !== _metaStoreEnv) {
    _metaStore = null
    _metaStoreEnv = env
  }

  if (!_metaStore) {
    const { createStore } = createMetaStore()
    _metaStore = createStore(_metaStoreEnv)
  }
  return _metaStore
}

/**
 * Creates a fresh meta-store instance with specific environment.
 *
 * Use this in browser contexts where you need an isolated meta-store
 * that isn't shared with other parts of the application.
 *
 * @param env - Optional environment with services (no context needed for meta-store)
 * @returns A new meta-store instance
 *
 * @example
 * // Browser: create meta-store with MCPPersistence
 * const metaStore = createMetaStoreInstance({
 *   services: {
 *     persistence: new MCPPersistence(mcpService),
 *     backendRegistry: createBackendRegistry({ default: 'memory', backends: { memory: new MemoryBackend() } })
 *   }
 * })
 *
 * @example
 * // Node.js: create meta-store with FileSystemPersistence
 * const metaStore = createMetaStoreInstance({
 *   services: {
 *     persistence: new FileSystemPersistence(),
 *     backendRegistry: createBackendRegistry({ default: 'memory', backends: { memory: new MemoryBackend() } })
 *   }
 * })
 */
export function createMetaStoreInstance(env?: IEnvironment) {
  const { createStore } = createMetaStore()
  return createStore(env)
}

/**
 * Resets the meta-store singleton.
 * Useful for testing to ensure clean state between tests.
 */
export function resetMetaStore() {
  _metaStore = null
  _metaStoreEnv = undefined
}
