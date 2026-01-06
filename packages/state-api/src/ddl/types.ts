/**
 * Core TypeScript interfaces for DDL generator
 *
 * This module defines the type system for generating SQL DDL statements from
 * Enhanced JSON Schema. It supports multiple SQL dialects (PostgreSQL, SQLite)
 * and provides structured output for tables, constraints, and foreign keys.
 *
 * @module ddl/types
 */

/**
 * Column definition for a database table
 *
 * Represents a single column with its type, constraints, and metadata.
 * Generated from Enhanced JSON Schema properties.
 *
 * @interface ColumnDef
 * @property {string} name - Column name (typically snake_case)
 * @property {string} type - SQL data type (e.g., "TEXT", "INTEGER", "UUID")
 * @property {boolean} nullable - Whether the column accepts NULL values
 * @property {string} [defaultValue] - Optional SQL default value expression
 * @property {string} [checkConstraint] - Optional CHECK constraint SQL clause
 *
 * @example
 * ```ts
 * const column: ColumnDef = {
 *   name: "email",
 *   type: "TEXT",
 *   nullable: false,
 *   checkConstraint: "email LIKE '%@%'"
 * }
 * ```
 */
export interface ColumnDef {
  /** Column name (typically snake_case) */
  name: string
  /** SQL data type (e.g., "TEXT", "INTEGER", "UUID") */
  type: string
  /** Whether the column accepts NULL values */
  nullable: boolean
  /** Optional SQL default value expression */
  defaultValue?: string
  /** Optional CHECK constraint SQL clause */
  checkConstraint?: string
}

/**
 * Foreign key constraint definition
 *
 * Represents a FOREIGN KEY constraint linking one table to another.
 * Generated from properties with x-reference-type: "single" in Enhanced JSON Schema.
 *
 * @interface ForeignKeyDef
 * @property {string} name - Constraint name (e.g., "fk_users_organization_id")
 * @property {string} table - Source table name
 * @property {string} column - Source column name (the FK column)
 * @property {string} referencesTable - Target table name (referenced table)
 * @property {string} referencesColumn - Target column name (typically "id")
 * @property {string} onDelete - ON DELETE action ("CASCADE", "SET NULL", "RESTRICT", etc.)
 *
 * @example
 * ```ts
 * const fk: ForeignKeyDef = {
 *   name: "fk_users_organization_id",
 *   table: "users",
 *   column: "organization_id",
 *   referencesTable: "organizations",
 *   referencesColumn: "id",
 *   onDelete: "CASCADE"
 * }
 * ```
 */
export interface ForeignKeyDef {
  /** Constraint name (e.g., "fk_users_organization_id") */
  name: string
  /** Source table name */
  table: string
  /** Source column name (the FK column) */
  column: string
  /** Target table name (referenced table) */
  referencesTable: string
  /** Target column name (typically "id") */
  referencesColumn: string
  /** ON DELETE action ("CASCADE", "SET NULL", "RESTRICT", etc.) */
  onDelete: string
}

/**
 * Table definition with columns and constraints
 *
 * Represents a complete CREATE TABLE statement structure.
 * Generated from Enhanced JSON Schema entity definitions.
 *
 * @interface TableDef
 * @property {string} name - Table name (1:1 mapping with model name, no pluralization)
 * @property {ColumnDef[]} columns - Array of column definitions
 * @property {string} primaryKey - Name of the primary key column (from x-mst-type: "identifier")
 * @property {ForeignKeyDef[]} foreignKeys - Array of foreign key constraints for this table
 *
 * @example
 * ```ts
 * const table: TableDef = {
 *   name: "User",
 *   columns: [
 *     { name: "id", type: "UUID", nullable: false },
 *     { name: "email", type: "TEXT", nullable: false }
 *   ],
 *   primaryKey: "id",
 *   foreignKeys: []
 * }
 * ```
 */
export interface TableDef {
  /** Table name (1:1 mapping with model name, no pluralization) */
  name: string
  /** Array of column definitions */
  columns: ColumnDef[]
  /** Name of the primary key column (from x-mst-type: "identifier") */
  primaryKey: string
  /** Array of foreign key constraints for this table */
  foreignKeys: ForeignKeyDef[]
}

/**
 * Complete DDL generation output
 *
 * Contains all SQL DDL structures needed to create a complete database schema.
 * Includes entity tables, junction tables (for many-to-many), foreign keys,
 * and execution order for proper dependency resolution.
 *
 * @interface DDLOutput
 * @property {TableDef[]} tables - Entity tables from Enhanced JSON Schema models
 * @property {ForeignKeyDef[]} foreignKeys - All foreign key constraints (for PostgreSQL ALTER TABLE)
 * @property {TableDef[]} junctionTables - Many-to-many junction tables (from x-reference-type: "array")
 * @property {string[]} executionOrder - Table names in topologically sorted order for creation
 *
 * @example
 * ```ts
 * const ddl: DDLOutput = {
 *   tables: [orgTable, userTable],
 *   foreignKeys: [fkUserOrg],
 *   junctionTables: [teamMembersTable],
 *   executionOrder: ["Organization", "User", "Team", "Team_members"]
 * }
 * ```
 */
export interface DDLOutput {
  /** Entity tables from Enhanced JSON Schema models */
  tables: TableDef[]
  /** All foreign key constraints (for PostgreSQL ALTER TABLE) */
  foreignKeys: ForeignKeyDef[]
  /** Many-to-many junction tables (from x-reference-type: "array") */
  junctionTables: TableDef[]
  /** Table names in topologically sorted order for creation */
  executionOrder: string[]
  /** Schema namespace (derived from schema name) - undefined for backward compatibility */
  namespace?: string
}

/**
 * Configuration for DDL generation
 *
 * Controls namespace isolation and other DDL generation options.
 *
 * @interface DDLGenerationConfig
 * @property {string} [namespace] - SQL namespace for table isolation. When provided:
 *   - PostgreSQL: Creates tables in "namespace"."table" format with CREATE SCHEMA
 *   - SQLite: Prefixes tables as namespace__table
 *   - When undefined, tables are created without namespace (backward compatible)
 *
 * @example
 * ```ts
 * // Generate DDL with namespace isolation
 * const config: DDLGenerationConfig = { namespace: "inventory" }
 * const ddl = generateDDL(schema, dialect, config)
 * // PostgreSQL: CREATE TABLE "inventory"."user" ...
 * // SQLite: CREATE TABLE inventory__user ...
 *
 * // Backward compatible - no namespace
 * const ddl = generateDDL(schema, dialect)
 * // PostgreSQL: CREATE TABLE "user" ...
 * ```
 */
export interface DDLGenerationConfig {
  /**
   * SQL namespace for table isolation.
   * - PostgreSQL: Creates database schema with CREATE SCHEMA IF NOT EXISTS
   * - SQLite: Prefixes all table names with namespace__
   * - When undefined, no namespace is applied (backward compatible)
   */
  namespace?: string
}

/**
 * SQL dialect abstraction
 *
 * Defines dialect-specific behaviors for different SQL databases.
 * Implementations handle type mapping, identifier escaping, and feature support.
 *
 * @interface SqlDialect
 * @property {string} name - Dialect name ("postgresql", "sqlite", etc.)
 * @property {function} escapeIdentifier - Escapes SQL identifiers (table/column names) for safe use
 * @property {function} mapType - Maps JSON Schema types to SQL types with optional format handling
 * @property {boolean} supportsForeignKeys - Whether dialect supports FOREIGN KEY constraints
 * @property {boolean} supportsCheckConstraints - Whether dialect supports CHECK constraints
 * @property {boolean} supportsAddColumn - Whether dialect supports ALTER TABLE ADD COLUMN
 * @property {boolean} supportsDropColumn - Whether dialect supports ALTER TABLE DROP COLUMN
 * @property {boolean} supportsAlterColumnType - Whether dialect supports ALTER COLUMN TYPE
 * @property {function} requiresTableRecreation - Checks if an operation requires table recreation
 *
 * @example
 * ```ts
 * const postgres: SqlDialect = {
 *   name: "postgresql",
 *   escapeIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
 *   mapType: (type, format) => {
 *     if (type === "string" && format === "uuid") return "UUID"
 *     if (type === "string") return "TEXT"
 *     return "TEXT"
 *   },
 *   supportsForeignKeys: true,
 *   supportsCheckConstraints: true,
 *   supportsAddColumn: true,
 *   supportsDropColumn: true,
 *   supportsAlterColumnType: true,
 *   requiresTableRecreation: (op) => false
 * }
 * ```
 */
export interface SqlDialect {
  /** Dialect name ("postgresql", "sqlite", etc.) */
  name: string

  /**
   * Escapes SQL identifiers (table/column names) for safe use
   *
   * @param {string} name - Unescaped identifier name
   * @returns {string} Escaped identifier safe for use in SQL
   *
   * @example
   * ```ts
   * escapeIdentifier("user_name") // => "user_name"
   * escapeIdentifier("user") // => "user" (reserved word handling)
   * ```
   */
  escapeIdentifier(name: string): string

  /**
   * Maps JSON Schema types to SQL types with optional format handling
   *
   * @param {string} jsonType - JSON Schema type ("string", "integer", "number", "boolean", "array")
   * @param {string} [format] - Optional JSON Schema format ("uuid", "date-time", etc.)
   * @returns {string} SQL type string for the dialect
   *
   * @example
   * ```ts
   * mapType("string", "uuid") // PostgreSQL: "UUID", SQLite: "TEXT"
   * mapType("integer") // Both: "INTEGER"
   * mapType("number") // PostgreSQL: "DOUBLE PRECISION", SQLite: "REAL"
   * ```
   */
  mapType(jsonType: string, format?: string): string

  /** Whether dialect supports FOREIGN KEY constraints */
  supportsForeignKeys: boolean

  /** Whether dialect supports CHECK constraints */
  supportsCheckConstraints: boolean

  // ============================================================================
  // Migration Capability Properties
  // ============================================================================

  /** Whether dialect supports ALTER TABLE ADD COLUMN */
  supportsAddColumn: boolean

  /** Whether dialect supports ALTER TABLE DROP COLUMN directly */
  supportsDropColumn: boolean

  /** Whether dialect supports ALTER COLUMN TYPE directly */
  supportsAlterColumnType: boolean

  /**
   * Checks if a migration operation requires table recreation.
   *
   * SQLite doesn't support many ALTER TABLE operations directly.
   * For unsupported operations, the table must be recreated using
   * the 4-step pattern: CREATE temp, INSERT, DROP, RENAME.
   *
   * @param {string} operation - Migration operation type
   * @returns {boolean} True if operation requires table recreation
   *
   * @example
   * ```ts
   * // PostgreSQL: supports direct ALTER TABLE
   * postgres.requiresTableRecreation("DROP_COLUMN") // => false
   *
   * // SQLite: requires recreation for DROP COLUMN
   * sqlite.requiresTableRecreation("DROP_COLUMN") // => true
   * ```
   */
  requiresTableRecreation(operation: string): boolean
}
