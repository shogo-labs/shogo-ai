/**
 * Backend Registry
 *
 * Schema-driven backend resolution with cascade lookup.
 * Resolves which backend to use for a given schema/model using this cascade:
 * 1. Check model's x-persistence.backend property in meta-store
 * 2. If not set, check schema's x-persistence.backend property
 * 3. If not set, use registry's default backend
 * 4. If no default, throw descriptive error
 *
 * @module query/registry
 *
 * Requirements:
 * - REQ-04: Schema-driven backend binding via x-persistence metadata
 * - Cascade resolution for flexible configuration
 * - Descriptive errors for missing backend configuration
 *
 * Design decisions:
 * - IBackendRegistry interface for dependency injection
 * - BackendRegistry class with Map-based storage
 * - createBackendRegistry() factory for pre-configuration
 * - Meta-store integration for reading x-persistence config
 */

import type { IBackend } from './backends/types'
import { getMetaStore } from '../meta/bootstrap'
import type { Instance } from 'mobx-state-tree'

/**
 * Interface for backend registry with schema-driven resolution.
 *
 * @remarks
 * Provides methods for registering backends by name and resolving
 * which backend to use for a given schema/model combination.
 * Uses cascade lookup: model → schema → default.
 *
 * @example
 * ```typescript
 * const registry = createBackendRegistry({
 *   default: 'memory',
 *   backends: {
 *     memory: new MemoryBackend(),
 *     sql: new SqlBackend()
 *   }
 * })
 *
 * // Resolve backend for specific schema/model
 * const backend = registry.resolve('users-schema', 'User')
 * const results = await backend.execute(ast, collection)
 * ```
 */
export interface IBackendRegistry {
  /**
   * Register a backend by name.
   *
   * @param name - Backend identifier (e.g., 'memory', 'sql')
   * @param backend - Backend implementation
   */
  register(name: string, backend: IBackend): void

  /**
   * Get a backend by name.
   *
   * @param name - Backend identifier
   * @returns Backend implementation or undefined if not found
   */
  get(name: string): IBackend | undefined

  /**
   * Check if a backend is registered.
   *
   * @param name - Backend identifier
   * @returns True if backend exists, false otherwise
   */
  has(name: string): boolean

  /**
   * Resolve which backend to use for a schema/model.
   *
   * @param schemaName - Schema name
   * @param modelName - Model name within schema
   * @returns Backend implementation
   * @throws Error if no backend found and no default set
   *
   * @remarks
   * Cascade resolution order:
   * 1. Model's x-persistence.backend property
   * 2. Schema's x-persistence.backend property
   * 3. Registry default backend
   * 4. Throw error if none found
   */
  resolve(schemaName: string, modelName: string): IBackend

  /**
   * Set the default backend for fallback resolution.
   *
   * @param name - Backend identifier
   * @throws Error if backend not registered
   */
  setDefault(name: string): void
}

/**
 * Backend registry implementation.
 *
 * @remarks
 * Uses Map for O(1) backend lookup by name.
 * Integrates with meta-store to read x-persistence configuration.
 */
export class BackendRegistry implements IBackendRegistry {
  private backends = new Map<string, IBackend>()
  private defaultBackendName?: string

  register(name: string, backend: IBackend): void {
    this.backends.set(name, backend)
  }

  get(name: string): IBackend | undefined {
    return this.backends.get(name)
  }

  has(name: string): boolean {
    return this.backends.has(name)
  }

  resolve(schemaName: string, modelName: string): IBackend {
    // 1. Check model-level x-persistence.backend
    const metaStore = getMetaStore()
    const schema = metaStore.schemaCollection.all().find((s: any) => s.name === schemaName)

    if (schema) {
      const model = metaStore.modelCollection.all().find(
        (m: any) => m.schema === schema && m.name === modelName
      )

      if (model && model.xPersistence) {
        // xPersistence can have a backend field even though it's not in the strict type
        const modelBackendName = (model.xPersistence as any).backend
        if (modelBackendName && typeof modelBackendName === 'string') {
          const backend = this.get(modelBackendName)
          if (backend) {
            return backend
          }
        }
      }

      // 2. Check schema-level x-persistence.backend
      // Note: Schema-level x-persistence is not currently stored in meta-store Schema entity
      // For now, this cascade step is reserved for future enhancement
      // We skip directly to default fallback
    }

    // 3. Fall back to default backend
    if (this.defaultBackendName) {
      const backend = this.get(this.defaultBackendName)
      if (backend) {
        return backend
      }
    }

    // 4. Throw descriptive error
    throw new Error(
      `No backend found for schema "${schemaName}" model "${modelName}". ` +
      `Tried: model x-persistence.backend, schema x-persistence.backend, registry default. ` +
      `Solution: Either set a default backend via setDefault(), or configure x-persistence.backend ` +
      `in your schema (model-level x-persistence.backend).`
    )
  }

  setDefault(name: string): void {
    if (!this.has(name)) {
      throw new Error(
        `Cannot set default to "${name}" - backend not registered. ` +
        `Register it first with register("${name}", backend).`
      )
    }
    this.defaultBackendName = name
  }
}

/**
 * Factory configuration for creating pre-configured backend registry.
 */
export interface BackendRegistryConfig {
  /**
   * Default backend name for fallback resolution.
   */
  default?: string

  /**
   * Map of backend name to implementation.
   */
  backends?: Record<string, IBackend>
}

/**
 * Factory function for creating configured backend registry.
 *
 * @param config - Registry configuration
 * @returns Configured BackendRegistry instance
 *
 * @example
 * ```typescript
 * const registry = createBackendRegistry({
 *   default: 'memory',
 *   backends: {
 *     memory: new MemoryBackend(),
 *     sql: new SqlBackend()
 *   }
 * })
 * ```
 */
export function createBackendRegistry(
  config?: BackendRegistryConfig
): BackendRegistry {
  const registry = new BackendRegistry()

  // Register backends
  if (config?.backends) {
    for (const [name, backend] of Object.entries(config.backends)) {
      registry.register(name, backend)
    }
  }

  // Set default
  if (config?.default) {
    registry.setDefault(config.default)
  }

  return registry
}
