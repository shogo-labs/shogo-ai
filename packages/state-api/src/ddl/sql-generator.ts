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
 * ```
 */
export function tableDefToCreateTableSQL(table: TableDef, dialect: SqlDialect): string {
  const escapedTable = dialect.escapeIdentifier(table.name)
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

  // Join lines with commas and wrap in CREATE TABLE
  const columnLines = lines.join(",\n")
  return `CREATE TABLE ${escapedTable} (\n${columnLines}\n);`
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
  const escapedTable = dialect.escapeIdentifier(fk.table)
  const escapedColumn = dialect.escapeIdentifier(fk.column)
  const escapedRefTable = dialect.escapeIdentifier(fk.referencesTable)
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
 * ```
 */
export function ddlOutputToSQL(ddl: DDLOutput, dialect: SqlDialect): string[] {
  const statements: string[] = []

  // 1. Create entity tables in dependency order
  for (const tableName of ddl.executionOrder) {
    const table = ddl.tables.find((t) => t.name === tableName)
    if (table) {
      statements.push(tableDefToCreateTableSQL(table, dialect))
    }
  }

  // 2. Create junction tables (after all entity tables)
  for (const junctionTable of ddl.junctionTables) {
    statements.push(tableDefToCreateTableSQL(junctionTable, dialect))
  }

  // 3. Add foreign key constraints (PostgreSQL only - SQLite uses inline)
  if (dialect.name === "postgresql") {
    for (const fk of ddl.foreignKeys) {
      statements.push(foreignKeyDefToSQL(fk, dialect))
    }
  } else {
    // SQLite: Add FK comments after junction tables
    for (const fk of ddl.foreignKeys) {
      statements.push(foreignKeyDefToSQL(fk, dialect))
    }
  }

  return statements
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
 * ```
 */
export function generateSQL(schema: EnhancedJsonSchema, dialect: SqlDialect): string[] {
  const ddl = generateDDL(schema, dialect)
  return ddlOutputToSQL(ddl, dialect)
}
