/**
 * Persistence Type Definitions
 *
 * Pure type definitions for the persistence layer.
 * This file contains NO runtime imports, making it safe to import
 * from both server (Node.js) and client (browser) contexts.
 *
 * @example Server usage:
 * import type { IPersistenceService } from './types'
 *
 * @example Client usage:
 * import type { IPersistenceService } from '../../../src/persistence/types'
 */

/**
 * Configuration for how a model's data should be persisted.
 * Specified via `x-persistence` extension in schema definitions.
 *
 * Strategies:
 * - "flat": Single JSON file per model (current default, backward compatible)
 * - "entity-per-file": One JSON file per entity, named by id
 * - "array-per-partition": One JSON file per partition key value, containing grouped entities
 */
export type PersistenceStrategy = 'flat' | 'entity-per-file' | 'array-per-partition'

export type PersistenceConfig = {
  /** How to organize files on disk */
  strategy: PersistenceStrategy

  /**
   * Field to partition by (for array-per-partition strategy).
   * Entities with the same partition key value are stored together.
   */
  partitionKey?: string

  /**
   * Field to use for human-readable filenames instead of entity id.
   * Value will be sanitized for filesystem safety.
   */
  displayKey?: string

  /**
   * When true, entities are nested under their parent's folder.
   * Parent relationship is inferred from the first x-reference-type: "single" field.
   *
   * Requires:
   * - Model must have exactly one single reference field (x-reference-type: "single")
   * - Parent model must use entity-per-file strategy with displayKey
   *
   * Creates structure: {Parent}/{parentDisplayKey}/{ChildModel}/{childFile}.json
   */
  nested?: boolean
}

/**
 * Generic persistence interface for runtime store data.
 *
 * This interface abstracts persistence operations, allowing pluggable backends
 * (filesystem, SQLite, Postgres, S3, MCP, etc.) without changing MST code.
 *
 * NOTE: This interface does NOT handle schema persistence - that remains in
 * the meta-layer (schema-io.ts). This is purely for runtime store entity data.
 */
export interface IPersistenceService {
  /**
   * Save an entire collection snapshot to persistence.
   *
   * @param context - Persistence context (schema, model, location)
   * @param snapshot - MST collection snapshot (typically { items: { [id]: entity } })
   * @throws Error if write fails (permission denied, disk full, etc.)
   */
  saveCollection(context: PersistenceContext, snapshot: any): Promise<void>

  /**
   * Load an entire collection snapshot from persistence.
   *
   * @param context - Persistence context (schema, model, location)
   * @returns Collection snapshot or null if not found
   * @throws Error if read fails (permission denied, invalid JSON, etc.)
   */
  loadCollection(context: PersistenceContext): Promise<any | null>

  /**
   * Save a single entity within a collection.
   *
   * ⚠️ WARNING: NOT SAFE for concurrent writes to the same collection.
   * Implementation typically uses read-modify-write pattern which can lose
   * data if multiple writes happen simultaneously. Use saveAll() for batch
   * updates or implement queueing in future units.
   *
   * @param context - Entity context (schema, model, location, entityId)
   * @param snapshot - Entity snapshot
   * @throws Error if write fails
   */
  saveEntity(context: EntityContext, snapshot: any): Promise<void>

  /**
   * Load a single entity from a collection.
   *
   * @param context - Entity context (schema, model, location, entityId)
   * @returns Entity snapshot or null if collection or entity not found
   * @throws Error if read fails
   */
  loadEntity(context: EntityContext): Promise<any | null>

  // === Schema operations (optional - for isomorphic support) ===

  /**
   * Load a schema definition from persistence.
   *
   * Used for isomorphic schema loading - allows browser to fetch schema
   * via MCP while server loads from filesystem.
   *
   * @param name - Schema name
   * @param location - Optional location override (workspace path, etc.)
   * @returns Schema metadata + enhanced JSON schema, or null if not found
   */
  loadSchema?(name: string, location?: string): Promise<{
    metadata: { name: string; id?: string; views?: Record<string, any> }
    enhanced: any
  } | null>

  /**
   * List available schemas.
   *
   * @param location - Optional location to search
   * @returns Array of schema names
   */
  listSchemas?(location?: string): Promise<string[]>
}

/**
 * Context for persistence operations.
 *
 * Uses generic "location" primitive rather than app-specific vocabulary
 * like "workspace". Location can be:
 * - File path (FileSystemPersistence): "./data" or "/absolute/path"
 * - Database name (PostgresPersistence): "production_db"
 * - Bucket prefix (S3Persistence): "s3://bucket/prefix"
 * - Etc.
 */
/**
 * Context for nested persistence - provides parent information for path building.
 */
export type NestedParentContext = {
  /** Parent model name (e.g., "Initiative") */
  modelName: string
  /** Parent's displayKey value, sanitized for filesystem (e.g., "auth-layer-v2") */
  displayKeyValue: string
}

export type PersistenceContext = {
  /** Schema name (folder name in filesystem, table prefix in database, etc.) */
  schemaName: string

  /**
   * Model name (NOT collection name - no "Collection" suffix).
   * Example: "Task" not "TaskCollection"
   */
  modelName: string

  /**
   * Generic location identifier.
   * If not provided, implementation should use a sensible default.
   */
  location?: string

  /**
   * Optional persistence configuration from schema's x-persistence extension.
   * If not provided, implementation should default to 'flat' strategy.
   */
  persistenceConfig?: PersistenceConfig

  /**
   * Optional filter to apply when loading collection.
   * Simple key-value equality filter (e.g., { status: 'active', projectId: 'p1' }).
   * When filter includes partitionKey, implementation may optimize by loading
   * only the matching partition(s).
   */
  filter?: Record<string, any>

  /**
   * Parent context for nested persistence.
   * When saving nested entities, this provides parent information for path building.
   * Populated at save time by looking up the parent entity.
   */
  parentContext?: NestedParentContext

  /**
   * Schema definitions ($defs) for reference introspection.
   * Used by nested persistence to discover parent relationship from schema.
   */
  schemaDefs?: Record<string, any>
}

/**
 * Extended context for single-entity operations.
 */
export type EntityContext = PersistenceContext & {
  /** Entity identifier (typically matches entity's id field) */
  entityId: string
}
