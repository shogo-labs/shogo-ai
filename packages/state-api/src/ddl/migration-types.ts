/**
 * Migration Type Definitions
 *
 * Core TypeScript types for the schema migration system.
 * These types support schema evolution through versioning, diff detection,
 * and ALTER TABLE generation.
 *
 * @module ddl/migration-types
 */

import type { ColumnDef } from "./types"

// ============================================================================
// Schema Diff Types
// ============================================================================

/**
 * Represents the difference between two schema versions.
 *
 * Used by compareSchemas() to detect what changed between schema versions.
 * Forms the basis for migration generation.
 *
 * @interface SchemaDiff
 * @property {string[]} addedModels - Models present in new schema but not old
 * @property {string[]} removedModels - Models present in old schema but not new
 * @property {ModelDiff[]} modifiedModels - Models that exist in both but have column changes
 * @property {boolean} hasChanges - True if any changes detected
 *
 * @example
 * ```ts
 * const diff: SchemaDiff = {
 *   addedModels: ["Comment"],
 *   removedModels: [],
 *   modifiedModels: [{
 *     modelName: "User",
 *     addedColumns: [{ name: "email", type: "TEXT", nullable: false }],
 *     removedColumns: [],
 *     modifiedColumns: []
 *   }],
 *   hasChanges: true
 * }
 * ```
 */
export interface SchemaDiff {
  /** Models present in new schema but not old */
  addedModels: string[]
  /** Full model definitions for added models (keyed by model name) */
  addedModelDefs: Record<string, any>
  /** Models present in old schema but not new */
  removedModels: string[]
  /** Models that exist in both but have column changes */
  modifiedModels: ModelDiff[]
  /** True if any changes detected */
  hasChanges: boolean
}

/**
 * Represents changes to a single model between schema versions.
 *
 * Captures column-level changes within a model: additions, removals, and modifications.
 *
 * @interface ModelDiff
 * @property {string} modelName - Name of the model that changed
 * @property {ColumnDef[]} addedColumns - Columns added to the model
 * @property {string[]} removedColumns - Column names removed from the model
 * @property {ColumnModification[]} modifiedColumns - Columns with type/constraint changes
 *
 * @example
 * ```ts
 * const modelDiff: ModelDiff = {
 *   modelName: "User",
 *   addedColumns: [{ name: "email", type: "TEXT", nullable: false }],
 *   removedColumns: ["legacy_field"],
 *   modifiedColumns: [{
 *     columnName: "status",
 *     oldDef: { name: "status", type: "TEXT", nullable: true },
 *     newDef: { name: "status", type: "TEXT", nullable: false },
 *     changeType: "nullability"
 *   }]
 * }
 * ```
 */
export interface ModelDiff {
  /** Name of the model that changed */
  modelName: string
  /** Columns added to the model */
  addedColumns: ColumnDef[]
  /** Column names removed from the model */
  removedColumns: string[]
  /** Columns with type/constraint changes */
  modifiedColumns: ColumnModification[]
}

/**
 * Represents a modification to an existing column.
 *
 * Captures both the old and new column definitions, plus what kind of change occurred.
 *
 * @interface ColumnModification
 * @property {string} columnName - Name of the column that changed
 * @property {ColumnDef} oldDef - Column definition in old schema
 * @property {ColumnDef} newDef - Column definition in new schema
 * @property {string} changeType - Type of change: "type", "nullability", "default", "constraint"
 *
 * @example
 * ```ts
 * const mod: ColumnModification = {
 *   columnName: "price",
 *   oldDef: { name: "price", type: "INTEGER", nullable: false },
 *   newDef: { name: "price", type: "REAL", nullable: false },
 *   changeType: "type"
 * }
 * ```
 */
export interface ColumnModification {
  /** Name of the column that changed */
  columnName: string
  /** Column definition in old schema */
  oldDef: ColumnDef
  /** Column definition in new schema */
  newDef: ColumnDef
  /** Type of change: "type", "nullability", "default", "constraint" */
  changeType: "type" | "nullability" | "default" | "constraint" | string
}

// ============================================================================
// Migration Operation Types
// ============================================================================

/**
 * Enum representing types of migration operations.
 *
 * Each operation type maps to specific SQL generation:
 * - CREATE_TABLE: Full CREATE TABLE statement for new models
 * - DROP_TABLE: DROP TABLE statement for removed models (destructive)
 * - ADD_COLUMN: ALTER TABLE ADD COLUMN statement
 * - DROP_COLUMN: ALTER TABLE DROP COLUMN statement (destructive)
 * - RECREATE_TABLE: 4-step pattern for SQLite (CREATE temp, INSERT, DROP, RENAME)
 *
 * @enum {string}
 */
export enum MigrationOperation {
  /** Create a new table */
  CREATE_TABLE = "CREATE_TABLE",
  /** Drop an existing table (destructive) */
  DROP_TABLE = "DROP_TABLE",
  /** Add a column to existing table */
  ADD_COLUMN = "ADD_COLUMN",
  /** Drop a column from existing table (destructive) */
  DROP_COLUMN = "DROP_COLUMN",
  /** Recreate table (SQLite workaround for unsupported ALTER operations) */
  RECREATE_TABLE = "RECREATE_TABLE",
}

/**
 * Describes a single migration operation to be executed.
 *
 * Contains all information needed to generate the SQL for one migration step.
 *
 * @interface MigrationOperationDef
 * @property {MigrationOperation} type - The type of operation
 * @property {string} tableName - Target table name
 * @property {ColumnDef} [column] - Column definition (for ADD_COLUMN)
 * @property {string} [columnName] - Column name (for DROP_COLUMN)
 * @property {ColumnDef[]} [columns] - All columns (for RECREATE_TABLE)
 */
export interface MigrationOperationDef {
  /** The type of operation */
  type: MigrationOperation
  /** Target table name */
  tableName: string
  /** Column definition (for ADD_COLUMN) */
  column?: ColumnDef
  /** Column name (for DROP_COLUMN) */
  columnName?: string
  /** All columns for table recreation (for RECREATE_TABLE) */
  columns?: ColumnDef[]
  /** Model definition (for CREATE_TABLE) */
  modelDef?: any
}

// ============================================================================
// Migration Output Types
// ============================================================================

/**
 * Complete output from migration generation.
 *
 * Contains everything needed to execute and record a migration:
 * - The diff that was detected
 * - Operations to perform
 * - Warnings about destructive changes
 *
 * @interface MigrationOutput
 * @property {number} version - Target schema version
 * @property {string} schemaName - Name of the schema being migrated
 * @property {SchemaDiff} diff - The detected schema changes
 * @property {MigrationOperationDef[]} operations - Operations to execute
 * @property {string[]} warnings - Warnings about destructive or risky operations
 *
 * @example
 * ```ts
 * const output: MigrationOutput = {
 *   version: 3,
 *   schemaName: "user-schema",
 *   diff: { ... },
 *   operations: [
 *     { type: MigrationOperation.ADD_COLUMN, tableName: "user", column: {...} }
 *   ],
 *   warnings: []
 * }
 * ```
 */
export interface MigrationOutput {
  /** Target schema version */
  version: number
  /** Name of the schema being migrated */
  schemaName: string
  /** The detected schema changes */
  diff: SchemaDiff
  /** Operations to execute */
  operations: MigrationOperationDef[]
  /** Warnings about destructive or risky operations */
  warnings: string[]
}

// ============================================================================
// Migration Tracking Types
// ============================================================================

/**
 * Record of an applied migration.
 *
 * Stored in the system-migrations schema to track which migrations
 * have been applied and prevent re-execution.
 *
 * @interface MigrationRecord
 * @property {string} id - Unique identifier for the migration record
 * @property {string} schemaName - Schema this migration was applied to
 * @property {number} version - Schema version after this migration
 * @property {string} checksum - Hash of schema content for drift detection
 * @property {number} appliedAt - Timestamp when migration was applied
 * @property {string[]} statements - SQL statements that were executed
 * @property {boolean} success - Whether migration completed successfully
 * @property {string} [errorMessage] - Error message if migration failed
 *
 * @example
 * ```ts
 * const record: MigrationRecord = {
 *   id: "mig-user-v3-1735570000",
 *   schemaName: "user-schema",
 *   version: 3,
 *   checksum: "sha256-abc123...",
 *   appliedAt: 1735570000000,
 *   statements: [
 *     "ALTER TABLE user ADD COLUMN email TEXT NOT NULL"
 *   ],
 *   success: true
 * }
 * ```
 */
export interface MigrationRecord {
  /** Unique identifier for the migration record */
  id: string
  /** Schema this migration was applied to */
  schemaName: string
  /** Schema version after this migration */
  version: number
  /** Hash of schema content for drift detection */
  checksum: string
  /** Timestamp when migration was applied (Unix ms) */
  appliedAt: number
  /** SQL statements that were executed */
  statements: string[]
  /** Whether migration completed successfully */
  success: boolean
  /** Error message if migration failed */
  errorMessage?: string
}
