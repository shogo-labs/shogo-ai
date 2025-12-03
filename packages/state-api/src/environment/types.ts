/**
 * Environment type definitions for MST dependency injection.
 *
 * Defines the structure passed to createStore(env) for runtime stores.
 * Schema entities and persistence services are injected via this environment,
 * enabling pluggable backends and isomorphic state management patterns.
 *
 * Related:
 * - Unit 1: IPersistenceService interface (pluggable persistence abstraction)
 * - Unit 4: CollectionPersistable mixin (uses getEnv<IEnvironment>(self))
 *
 * @see persistence-service-rev2.md for architecture details
 */

import type { IPersistenceService } from '../persistence/types'

/**
 * Environment structure for runtime MST stores.
 *
 * This environment is passed as the second parameter to MST's .create() method:
 * ```typescript
 * const env: IEnvironment = {
 *   services: { persistence: new FileSystemPersistence() },
 *   context: { schema: schemaEntity, location: './workspace' }
 * }
 * const store = RootStoreModel.create({}, env)
 * ```
 *
 * Accessed in mixins via MST's getEnv() function:
 * ```typescript
 * .actions(self => ({
 *   async saveAll() {
 *     const env = getEnv<IEnvironment>(self)
 *     await env.services.persistence.saveCollection(...)
 *   }
 * }))
 * ```
 *
 * Design Notes:
 * - Nested structure: services (injected dependencies) + context (metadata)
 * - Required persistence service: all runtime stores need persistence
 * - Optional location: enables workspace isolation, defaults to '.schemas'
 * - Future extensibility: new interfaces can extend IEnvironment
 */
export interface IEnvironment {
  /**
   * Service dependencies injected at store creation.
   *
   * These are the "pluggable backends" - swap implementations without
   * changing MST model code.
   */
  services: {
    /**
     * Persistence service for loading/saving collection data.
     *
     * Implementation can be:
     * - FileSystemPersistence (local JSON files)
     * - NullPersistence (in-memory, for testing)
     * - SQLitePersistence (future: local database)
     * - PostgresPersistence (future: remote database)
     * - S3Persistence (future: cloud storage)
     *
     * Required - all runtime stores need persistence capability.
     */
    persistence: IPersistenceService

    // Future services:
    // validator?: IValidatorService
    // eventBus?: IEventBusService
    // logger?: ILoggerService
  }

  /**
   * Contextual metadata about the runtime store.
   *
   * This is "where we are" - which schema, which workspace, etc.
   */
  context: {
    /**
     * Schema name identifier (stable string reference).
     *
     * Instead of holding a live MST entity reference to the schema,
     * we store just the name (e.g., "minimal-cms", "app-builder-project").
     *
     * **Why schemaName instead of schema entity:**
     * 1. Prevents stale entity references during React StrictMode double-rendering
     * 2. Decouples runtime store lifecycle from meta-store entity lifecycle
     * 3. Schema entities can be detached/replaced without breaking runtime stores
     * 4. Simpler to reason about - just a string, no MST tree coupling
     *
     * The actual schema entity can be looked up from the meta-store when needed,
     * but for persistence context we only need the name.
     *
     * Required - every runtime store is tied to a schema definition.
     */
    schemaName: string

    /**
     * Optional location identifier for workspace isolation.
     *
     * Generic primitive that means different things to different backends:
     * - FileSystemPersistence: file path ("./workspace-a", "/absolute/path")
     * - PostgresPersistence: database name or schema prefix
     * - S3Persistence: bucket prefix ("s3://bucket/workspace-a")
     *
     * If not provided, persistence service should use sensible default:
     * - FileSystemPersistence uses ".schemas"
     * - NullPersistence uses "default"
     *
     * **Why generic "location" not "workspace":**
     * "Workspace" is app-builder vocabulary. This is low-level infrastructure
     * that should work for any use case (not just app-builder).
     */
    location?: string
  }
}

/**
 * Type alias for schema entity (extracted from environment).
 *
 * This is a MST instance of the dynamically-generated Schema model from
 * the meta-store.
 *
 * At runtime, this will have properties like:
 * - id: string (UUID identifier)
 * - name: string (schema name, e.g., "app-builder-project")
 * - format: 'enhanced-json-schema' (always this value)
 * - createdAt: number (Unix timestamp)
 * - views: SchemaView[] (view definitions)
 * - toEnhancedJson(): EnhancedJsonSchema (conversion method)
 *
 * Typed as 'any' because the Schema model doesn't have a static export
 * (it's generated dynamically from ArkType definitions).
 *
 * Usage:
 * ```typescript
 * const schema: ISchemaEntity = env.context.schema
 * console.log(schema.name)  // TypeScript allows this (no IntelliSense though)
 * ```
 */
export type ISchemaEntity = any

// ============================================================================
// Meta-Store Environment
// ============================================================================

/**
 * Simplified environment for the meta-store itself.
 *
 * Unlike runtime stores (which have a schema context), the meta-store
 * IS the schema store - so it doesn't need context.schema.
 *
 * This is used for isomorphic schema loading where the meta-store
 * needs access to a persistence service to fetch schemas.
 */
export interface IMetaStoreEnvironment {
  services: {
    /** Persistence service for schema loading */
    persistence?: IPersistenceService
  }
}
