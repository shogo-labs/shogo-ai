/**
 * Backend Registry
 *
 * Schema-driven backend resolution with cascade lookup and schema-aware wrapping.
 * Resolves which backend to use for a given schema/model using this cascade:
 * 1. Check model's x-persistence.backend property in meta-store
 * 2. If not set, check schema's x-persistence.backend property
 * 3. If not set, use registry's default backend
 * 4. If no default, throw descriptive error
 *
 * ## Schema-Aware Wrapping
 *
 * After resolving a backend, the registry wraps it with 
 * to provide schema-aware row normalization. This ensures database column names
 * (snake_case) are correctly mapped back to schema property names, even for
 * edge cases like consecutive capitals (HTTPSUrl, userID).
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

import type { IBackend, DDLGenerationOptions, DDLExecutionResult } from './backends/types'
import type { IQueryExecutor } from './executors/types'
import { MemoryQueryExecutor } from './executors/memory'
import { SqlQueryExecutor } from './executors/sql'
import { SqlBackend } from './backends/sql'
import { getMetaStore } from '../meta/bootstrap'
import { toSnakeCase } from '../ddl/utils'
import { deriveNamespace, qualifyTableName, type QualifyDialect } from '../ddl/namespace'
import type { DDLGenerationConfig } from '../ddl/types'

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
   * Resolve which backend to use for a schema/model and return configured executor.
   *
   * @param schemaName - Schema name
   * @param modelName - Model name within schema
   * @param collection - Optional collection reference (required for memory backends)
   * @param columnPropertyMap - Optional pre-computed column→property mapping (bypasses meta-store lookup)
   * @param propertyTypes - Optional pre-computed property→type mapping for dialect-specific conversions
   * @returns Query executor with data source bound
   * @throws Error if no backend found and no default set
   *
   * @remarks
   * Cascade resolution order:
   * 1. Model's x-persistence.backend property
   * 2. Schema's x-persistence.backend property
   * 3. Registry default backend
   * 4. Throw error if none found
   *
   * Column property map resolution:
   * 1. Use provided columnPropertyMap if given (from domain().createStore())
   * 2. Fall back to meta-store model.columnPropertyMap view
   * 3. Fall back to empty map (simple snake_case conversion)
   *
   * Property types resolution:
   * 1. Use provided propertyTypes if given (from domain().createStore())
   * 2. Fall back to meta-store model properties
   * 3. Fall back to empty map (no type conversions)
   *
   * Returns IQueryExecutor (not IBackend) with data source bound:
   * - Memory backends: collection reference bound
   * - SQL backends: tableName, dialect, propertyTypes bound
   */
  resolve<T = any>(schemaName: string, modelName: string, collection?: any, columnPropertyMap?: Record<string, string>, propertyTypes?: Record<string, string>): IQueryExecutor<T>

  /**
   * Set the default backend for fallback resolution.
   *
   * @param name - Backend identifier
   * @throws Error if backend not registered
   */
  setDefault(name: string): void

  /**
   * Execute DDL for a schema using resolved backend.
   *
   * @param schemaName - Schema name for backend resolution
   * @param schema - Enhanced JSON Schema to create tables from
   * @param options - DDL generation options (ifNotExists, etc.)
   * @returns Promise resolving to DDL execution result
   *
   * @remarks
   * Resolution order:
   * 1. Schema's x-persistence.backend property
   * 2. Registry default backend
   * 3. Error if no backend found
   *
   * Delegates to resolved backend's executeDDL method.
   */
  executeDDL(
    schemaName: string,
    schema: any,
    options?: DDLGenerationOptions
  ): Promise<DDLExecutionResult>
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

  resolve<T = any>(schemaName: string, modelName: string, collection?: any, providedColumnPropertyMap?: Record<string, string>, providedPropertyTypes?: Record<string, string>): IQueryExecutor<T> {
    // Access meta-store for schema/model lookup
    const metaStore = getMetaStore()
    const schema = metaStore.schemaCollection.all().find((s: any) => s.name === schemaName)

    let resolvedBackendName: string | undefined
    let model: any = undefined

    if (schema) {
      model = metaStore.modelCollection.all().find(
        (m: any) => m.schema === schema && m.name === modelName
      )

      // 1. Check model-level x-persistence.backend
      if (model && model.xPersistence) {
        const modelBackendName = (model.xPersistence as any).backend
        if (modelBackendName && typeof modelBackendName === 'string') {
          resolvedBackendName = modelBackendName
        }
      }

      // 2. Check schema-level x-persistence.backend
      if (!resolvedBackendName && schema.xPersistence) {
        const schemaBackendName = (schema.xPersistence as any).backend
        if (schemaBackendName && typeof schemaBackendName === 'string') {
          resolvedBackendName = schemaBackendName
        }
      }
    }

    // 3. Fall back to default backend
    if (!resolvedBackendName && this.defaultBackendName) {
      resolvedBackendName = this.defaultBackendName
    }

    // 4. Throw descriptive error if no backend found
    if (!resolvedBackendName) {
      throw new Error(
        `No backend found for schema "${schemaName}" model "${modelName}". ` +
        `Tried: model x-persistence.backend, schema x-persistence.backend, registry default. ` +
        `Solution: Either set a default backend via setDefault(), or configure x-persistence.backend ` +
        `in your schema (model-level x-persistence.backend).`
      )
    }

    // 5. Extract property metadata - cascade: provided → meta-store → empty
    // Property types resolution:
    // 1. Use provided propertyTypes (from domain().createStore() via env.context)
    // 2. Fall back to meta-store model properties
    // 3. Fall back to empty map (no type conversions)
    const propertyTypes = providedPropertyTypes ?? this.getPropertyTypes(model)
    // Column property map resolution cascade:
    // 1. Use provided map (from domain().createStore() via env.context)
    // 2. Fall back to meta-store model.columnPropertyMap view
    // 3. Fall back to empty map (simple snake_case conversion)
    const columnPropertyMap = providedColumnPropertyMap ?? model?.columnPropertyMap ?? {}

    // 6. Get the resolved backend instance
    const backend = this.get(resolvedBackendName)
    if (!backend) {
      throw new Error(`Backend "${resolvedBackendName}" not found in registry`)
    }

    // 7. Discriminate backend type via dialect property or createExecutor factory
    if (backend.dialect) {
      // SQL backend - has dialect property
      if (!backend.executor) {
        throw new Error(
          `SQL backend "${resolvedBackendName}" has dialect but missing executor. ` +
          `Provide executor: new SqlBackend({ dialect: '${backend.dialect}', executor: ... })`
        )
      }

      // Derive namespace from schema name for table isolation
      const namespace = deriveNamespace(schemaName)
      const baseTableName = toSnakeCase(modelName)

      // Determine dialect name for qualifyTableName
      const dialectName: QualifyDialect = backend.dialect === 'sqlite' ? 'sqlite' : 'postgresql'

      // Qualify table name with namespace
      const tableName = qualifyTableName(namespace, baseTableName, dialectName)

      return new SqlQueryExecutor<T>(
        tableName,
        backend as SqlBackend,  // Pass the SqlBackend instance
        backend.executor,
        columnPropertyMap,
        backend.dialect,
        propertyTypes
      )
    } else if (typeof backend.createExecutor === 'function') {
      // Remote backend with custom executor factory (e.g., MCPBackend)
      // Factory creates executor with schemaName, modelName, collection bound
      return backend.createExecutor?.<T>(schemaName, modelName, collection)
    } else {
      // Memory backend - no dialect property, no createExecutor factory
      if (!collection) {
        throw new Error(
          `Memory backend "${resolvedBackendName}" requires collection reference. ` +
          `Pass collection as third parameter to resolve().`
        )
      }

      return new MemoryQueryExecutor<T>(collection)
    }
  }

  /**
   * Extract property names from a meta-store model entity.
   *
   * @param model - Meta-store Model instance (may be undefined)
   * @returns Array of property names, empty if model not available
   *
   * @remarks
   * The model.properties view returns all top-level properties.
   * We extract just the names for building the column-property mapping.
   */
  private getPropertyNames(model: any): string[] {
    if (!model) return []

    try {
      // model.properties is a computed view from meta-store-model-enhancements
      const properties = model.properties
      if (Array.isArray(properties)) {
        return properties.map((p: any) => p.name).filter(Boolean)
      }
    } catch {
      // If properties view isn't available, return empty
      // This can happen during bootstrap before enhancements are applied
    }

    return []
  }

  /**
   * Extract property types from a meta-store model entity.
   *
   * @param model - Meta-store Model instance (may be undefined)
   * @returns Map of property name to type string
   *
   * @remarks
   * Extracts type information for dialect-specific conversions (e.g., boolean).
   * Returns types like 'string', 'number', 'boolean', 'array', 'object', etc.
   */
  private getPropertyTypes(model: any): Record<string, string> {
    if (!model) return {}

    try {
      const properties = model.properties
      if (Array.isArray(properties)) {
        const typeMap: Record<string, string> = {}
        for (const prop of properties) {
          if (prop.name && prop.type) {
            typeMap[prop.name] = prop.type
          }
        }
        return typeMap
      }
    } catch {
      // If properties view isn't available, return empty
    }

    return {}
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

  /**
   * Execute DDL for a schema using resolved backend.
   *
   * @param schemaName - Schema name (used for logging/error messages)
   * @param schema - Enhanced JSON Schema with x-persistence.backend
   * @param options - DDL generation options
   * @returns Promise resolving to DDL execution result
   *
   * @remarks
   * Backend resolution:
   * 1. Read schema's x-persistence.backend property
   * 2. Fall back to registry default backend
   * 3. Return error if no backend found
   *
   * Delegates to backend.executeDDL() for dialect-specific generation and execution.
   */
  async executeDDL(
    schemaName: string,
    schema: any,
    options?: DDLGenerationOptions
  ): Promise<DDLExecutionResult> {
    // 1. Resolve backend name from schema or default
    let resolvedBackendName: string | undefined

    // Check schema-level x-persistence.backend
    if (schema && schema['x-persistence']?.backend) {
      resolvedBackendName = schema['x-persistence'].backend
    }

    // Fall back to default backend
    if (!resolvedBackendName && this.defaultBackendName) {
      resolvedBackendName = this.defaultBackendName
    }

    // Error if no backend found
    if (!resolvedBackendName) {
      return {
        success: false,
        statements: [],
        executed: 0,
        error: `No backend found for schema "${schemaName}". ` +
          `Set x-persistence.backend in schema or configure a default backend.`
      }
    }

    // 2. Get the resolved backend instance
    const backend = this.get(resolvedBackendName)
    if (!backend) {
      return {
        success: false,
        statements: [],
        executed: 0,
        error: `Backend "${resolvedBackendName}" not found in registry`
      }
    }

    // 3. Check if backend supports executeDDL
    if (typeof backend.executeDDL !== 'function') {
      return {
        success: false,
        statements: [],
        executed: 0,
        error: `Backend "${resolvedBackendName}" does not support executeDDL()`
      }
    }

    // 4. Derive namespace from schema name for table isolation
    const namespace = deriveNamespace(schemaName)

    // 5. Delegate to backend's executeDDL with namespace
    return backend.executeDDL(schema, { ...options, namespace })
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
