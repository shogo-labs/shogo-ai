/**
 * SQL string generation from DDL structures
 *
 * This module converts structured DDL definitions (DDLOutput, TableDef, etc.)
 * into executable SQL strings for PostgreSQL and SQLite dialects.
 *
 * Functions in this module handle:
 * - Column definitions with constraints
 * - CREATE TABLE statements with proper formatting
 * - Foreign key constraints (ALTER TABLE for PostgreSQL, inline comments for SQLite)
 * - Complete DDL generation in topologically sorted order
 *
 * @module ddl/sql-generator
 */

import type { ColumnDef, TableDef, ForeignKeyDef, DDLOutput, SqlDialect } from "./types"
import type { EnhancedJsonSchema } from "../schematic/types"
import { generateDDL } from "./index"

/**
 * Options for DDL generation
 */
export interface DDLGenerationOptions {
  /**
   * If true, generates CREATE TABLE IF NOT EXISTS instead of CREATE TABLE.
   * Useful for idempotent migrations that can be safely re-run.
   * @default false
   */
  ifNotExists?: boolean
}

/**
 * Convert a ColumnDef to a SQL column definition string
 *
 * Generates a properly formatted column definition with type, constraints,
 * and optional CHECK clauses. Handles identifier escaping and constraint ordering.
 *
 * @param {ColumnDef} column - Column definition to convert
 * @param {boolean} isPrimaryKey - Whether this column is the primary key
 * @param {SqlDialect} dialect - Target SQL dialect for type mapping and escaping
 * @returns {string} SQL column definition string
 *
 * @example
 * ```ts
 * const column: ColumnDef = {
 *   name: "email",
 *   type: "TEXT",
 *   nullable: false,
 *   checkConstraint: "email LIKE '%@%'"
 * }
 * columnDefToSQL(column, false, postgresDialect)
 * // => '"email" TEXT NOT NULL CHECK (email LIKE \'%@%\')'
 * ```
 */
export function columnDefToSQL(
  column: ColumnDef,
  isPrimaryKey: boolean,
  dialect: SqlDialect
): string {
  const parts: string[] = []

  // Column name (escaped)
  parts.push(dialect.escapeIdentifier(column.name))

  // SQL type
  parts.push(column.type)

  // PRIMARY KEY constraint
  if (isPrimaryKey) {
    parts.push("PRIMARY KEY")
  }
  // NOT NULL constraint (non-primary keys only)
  else if (!column.nullable) {
    parts.push("NOT NULL")
  }

  // CHECK constraint
  if (column.checkConstraint) {
    parts.push(`CHECK (${column.checkConstraint})`)
  }

  return parts.join(" ")
}

/**
 * Convert a TableDef to a CREATE TABLE SQL statement
 *
 * Generates a complete CREATE TABLE statement with proper formatting:
 * - Escaped table name
 * - Column definitions (2-space indentation)
 * - Primary key constraint (inline or composite)
 * - Proper semicolon termination
 *
 * Supports both single-column and composite primary keys for junction tables.
 *
 * @param {TableDef} table - Table definition to convert
 * @param {SqlDialect} dialect - Target SQL dialect
 * @param {DDLGenerationOptions} options - Optional generation options
 * @returns {string} CREATE TABLE SQL statement
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
 * tableDefToCreateTableSQL(table, postgresDialect)
 * // => 'CREATE TABLE "User" (\n  "id" UUID PRIMARY KEY,\n  "email" TEXT NOT NULL\n);'
 *
 * // With IF NOT EXISTS for idempotent migrations
 * tableDefToCreateTableSQL(table, postgresDialect, { ifNotExists: true })
 * // => 'CREATE TABLE IF NOT EXISTS "User" (\n  "id" UUID PRIMARY KEY,\n  "email" TEXT NOT NULL\n);'
 * ```
 */
export function tableDefToCreateTableSQL(
  table: TableDef,
  dialect: SqlDialect,
  options?: DDLGenerationOptions
): string {
  // Table name may already be qualified (e.g., "namespace"."table" for PostgreSQL or namespace__table for SQLite)
  // We need to escape it properly without double-escaping
  const escapedTable = escapeTableNameForDialect(table.name, dialect)
  const lines: string[] = []

  // Check if this is a composite primary key (junction table)
  const isCompositePK = table.primaryKey.includes(",")
  const pkColumns = isCompositePK
    ? table.primaryKey.split(",").map((col) => col.trim())
    : [table.primaryKey]

  // Generate column definitions
  for (const column of table.columns) {
    const isPK = !isCompositePK && column.name === table.primaryKey
    const columnSQL = columnDefToSQL(column, isPK, dialect)
    lines.push(`  ${columnSQL}`)
  }

  // Add composite PRIMARY KEY constraint if needed
  if (isCompositePK) {
    const escapedPKColumns = pkColumns.map((col) => dialect.escapeIdentifier(col)).join(", ")
    lines.push(`  PRIMARY KEY (${escapedPKColumns})`)
  }

  // Add inline FOREIGN KEY constraints for SQLite
  // (PostgreSQL uses ALTER TABLE statements instead)
  if (dialect.name === "sqlite" && table.foreignKeys.length > 0) {
    for (const fk of table.foreignKeys) {
      const escapedColumn = dialect.escapeIdentifier(fk.column)
      const escapedRefTable = escapeTableNameForDialect(fk.referencesTable, dialect)
      const escapedRefColumn = dialect.escapeIdentifier(fk.referencesColumn)
      lines.push(
        `  FOREIGN KEY (${escapedColumn}) REFERENCES ${escapedRefTable} (${escapedRefColumn}) ON DELETE ${fk.onDelete}`
      )
    }
  }

  // Join lines with commas and wrap in CREATE TABLE
  const columnLines = lines.join(",\n")
  const ifNotExists = options?.ifNotExists ? "IF NOT EXISTS " : ""
  return `CREATE TABLE ${ifNotExists}${escapedTable} (\n${columnLines}\n);`
}

/**
 * Escape a table name for the given dialect, handling qualified names properly.
 *
 * Qualified names (already containing namespace) should not be double-escaped:
 * - PostgreSQL: "namespace"."table" is already escaped, return as-is
 * - SQLite: namespace__table needs backtick escaping
 *
 * Non-qualified names use standard escaping.
 */
function escapeTableNameForDialect(tableName: string, dialect: SqlDialect): string {
  if (dialect.name === "postgresql") {
    // Check if already a qualified PostgreSQL name (starts with quote and contains ".")
    if (tableName.startsWith('"') && tableName.includes('"."')) {
      return tableName // Already escaped qualified name
    }
    // Standard escaping for simple names
    return dialect.escapeIdentifier(tableName)
  } else {
    // SQLite: qualified names use __ prefix, escape the whole thing
    return dialect.escapeIdentifier(tableName)
  }
}

/**
 * Convert a ForeignKeyDef to SQL constraint statement
 *
 * Generates dialect-specific foreign key constraint:
 * - **PostgreSQL**: ALTER TABLE statement with named constraint
 * - **SQLite**: Inline comment (SQLite requires FKs in CREATE TABLE)
 *
 * Handles identifier escaping and ON DELETE actions.
 *
 * @param {ForeignKeyDef} fk - Foreign key definition to convert
 * @param {SqlDialect} dialect - Target SQL dialect
 * @returns {string} ALTER TABLE statement (PostgreSQL) or comment (SQLite)
 *
 * @example
 * ```ts
 * const fk: ForeignKeyDef = {
 *   name: "fk_users_org_id",
 *   table: "users",
 *   column: "organization_id",
 *   referencesTable: "organizations",
 *   referencesColumn: "id",
 *   onDelete: "CASCADE"
 * }
 * foreignKeyDefToSQL(fk, postgresDialect)
 * // => 'ALTER TABLE "users" ADD CONSTRAINT "fk_users_org_id" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;'
 * ```
 */
export function foreignKeyDefToSQL(fk: ForeignKeyDef, dialect: SqlDialect): string {
  const escapedTable = escapeTableNameForDialect(fk.table, dialect)
  const escapedColumn = dialect.escapeIdentifier(fk.column)
  const escapedRefTable = escapeTableNameForDialect(fk.referencesTable, dialect)
  const escapedRefColumn = dialect.escapeIdentifier(fk.referencesColumn)
  const escapedConstraintName = dialect.escapeIdentifier(fk.name)

  if (dialect.name === "postgresql") {
    // PostgreSQL: ALTER TABLE with named constraint
    return (
      `ALTER TABLE ${escapedTable} ` +
      `ADD CONSTRAINT ${escapedConstraintName} ` +
      `FOREIGN KEY (${escapedColumn}) ` +
      `REFERENCES ${escapedRefTable} (${escapedRefColumn}) ` +
      `ON DELETE ${fk.onDelete};`
    )
  } else {
    // SQLite: Inline FK comment (FKs must be in CREATE TABLE for SQLite)
    return (
      `-- Note: SQLite foreign keys should be inline in CREATE TABLE\n` +
      `-- FOREIGN KEY (${escapedColumn}) REFERENCES ${escapedRefTable} (${escapedRefColumn}) ON DELETE ${fk.onDelete}`
    )
  }
}

/**
 * Convert complete DDLOutput to array of SQL statements
 *
 * Orchestrates full DDL generation in proper execution order:
 * 1. Entity tables (in dependency order from executionOrder)
 * 2. Junction tables
 * 3. Foreign key constraints (ALTER TABLE statements)
 *
 * Returns statements that can be executed sequentially to build the schema.
 *
 * @param {DDLOutput} ddl - Complete DDL output structure
 * @param {SqlDialect} dialect - Target SQL dialect
 * @param {DDLGenerationOptions} options - Optional generation options
 * @returns {string[]} Array of SQL statements in execution order
 *
 * @example
 * ```ts
 * const ddl: DDLOutput = {
 *   tables: [orgTable, userTable],
 *   junctionTables: [teamMembersTable],
 *   foreignKeys: [fkUserOrg],
 *   executionOrder: ["Organization", "User", "Team_members"]
 * }
 * const statements = ddlOutputToSQL(ddl, postgresDialect)
 * // => [
 * //   'CREATE TABLE "Organization" (...);',
 * //   'CREATE TABLE "User" (...);',
 * //   'CREATE TABLE "Team_members" (...);',
 * //   'ALTER TABLE "User" ADD CONSTRAINT ... ;'
 * // ]
 *
 * // With IF NOT EXISTS for idempotent execution
 * const statements = ddlOutputToSQL(ddl, postgresDialect, { ifNotExists: true })
 * // => ['CREATE TABLE IF NOT EXISTS "Organization" (...);', ...]
 * ```
 */
export function ddlOutputToSQL(
  ddl: DDLOutput,
  dialect: SqlDialect,
  options?: DDLGenerationOptions
): string[] {
  const statements: string[] = []

  // 0. Create schema namespace for PostgreSQL if provided
  if (dialect.name === "postgresql" && ddl.namespace) {
    const ifNotExists = options?.ifNotExists ? "IF NOT EXISTS " : ""
    statements.push(`CREATE SCHEMA ${ifNotExists}"${ddl.namespace.replace(/"/g, '""')}";`)
  }

  // 1. Create entity tables in dependency order
  for (const tableName of ddl.executionOrder) {
    const table = ddl.tables.find((t) => t.name === tableName)
    if (table) {
      statements.push(tableDefToCreateTableSQL(table, dialect, options))
    }
  }

  // 2. Create junction tables (after all entity tables)
  for (const junctionTable of ddl.junctionTables) {
    statements.push(tableDefToCreateTableSQL(junctionTable, dialect, options))
  }

  // 3. Add foreign key constraints (PostgreSQL only)
  // SQLite FKs are defined inline in CREATE TABLE - no separate statements needed
  if (dialect.name === "postgresql") {
    for (const fk of ddl.foreignKeys) {
      statements.push(foreignKeyDefToSQL(fk, dialect))
    }
  }
  // SQLite: FKs already included inline in CREATE TABLE above

  return statements
}

/**
 * Options for generating SQL with namespace support.
 */
export interface GenerateSQLOptions extends DDLGenerationOptions {
  /** SQL namespace for table isolation (derived from schema name) */
  namespace?: string
}

/**
 * Convenience function to generate SQL from Enhanced JSON Schema
 *
 * One-step API that combines generateDDL() and ddlOutputToSQL():
 * 1. Converts Enhanced JSON Schema to DDLOutput
 * 2. Converts DDLOutput to executable SQL strings
 *
 * This is the simplest way to get SQL from a schema.
 *
 * @param {EnhancedJsonSchema} schema - Enhanced JSON Schema to convert
 * @param {SqlDialect} dialect - Target SQL dialect
 * @param {GenerateSQLOptions} options - Optional generation options (ifNotExists, namespace)
 * @returns {string[]} Array of SQL statements ready for execution
 *
 * @example
 * ```ts
 * const schema = { properties: { User: { type: 'object', properties: {} } } }
 * const postgres = createPostgresDialect()
 * const sql = generateSQL(schema, postgres)
 * // Execute statements in order
 * for (const statement of sql) {
 *   await db.execute(statement)
 * }
 *
 * // With IF NOT EXISTS for idempotent execution
 * const sql = generateSQL(schema, postgres, { ifNotExists: true })
 *
 * // With namespace for table isolation
 * const sql = generateSQL(schema, postgres, { ifNotExists: true, namespace: 'my_app' })
 * ```
 */
export function generateSQL(
  schema: EnhancedJsonSchema,
  dialect: SqlDialect,
  options?: GenerateSQLOptions
): string[] {
  // Pass namespace to generateDDL if provided
  const ddl = generateDDL(schema, dialect, { namespace: options?.namespace })
  return ddlOutputToSQL(ddl, dialect, options)
}
