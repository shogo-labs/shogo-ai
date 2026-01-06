/**
 * SQL dialect implementations for DDL generation
 *
 * This module provides concrete implementations of the SqlDialect interface
 * for PostgreSQL and SQLite databases. Each dialect handles type mapping
 * and identifier escaping according to database-specific conventions.
 *
 * @module ddl/dialect
 */

import type { SqlDialect } from "./types"

/**
 * PostgreSQL dialect implementation
 *
 * Supports advanced PostgreSQL types including UUID, TIMESTAMPTZ, and JSONB.
 * Uses double-quote identifier escaping with quote-doubling for embedded quotes.
 *
 * Type mappings:
 * - string + uuid → UUID
 * - string + date-time → TIMESTAMPTZ
 * - string (default) → TEXT
 * - integer → INTEGER
 * - number → DOUBLE PRECISION
 * - boolean → BOOLEAN
 * - array → JSONB
 * - object → JSONB
 *
 * @class PostgresDialect
 * @implements {SqlDialect}
 */
class PostgresDialect implements SqlDialect {
  readonly name = "postgresql"
  readonly supportsForeignKeys = true
  readonly supportsCheckConstraints = true

  // Migration capability properties
  readonly supportsAddColumn = true
  readonly supportsDropColumn = true
  readonly supportsAlterColumnType = true

  /**
   * PostgreSQL supports all ALTER TABLE operations directly.
   * No table recreation is ever needed.
   */
  requiresTableRecreation(operation: string): boolean {
    return false
  }

  /**
   * Maps JSON Schema types to PostgreSQL SQL types
   *
   * @param {string} jsonType - JSON Schema type ("string", "integer", "number", "boolean", "array")
   * @param {string} [format] - Optional JSON Schema format ("uuid", "date-time", etc.)
   * @returns {string} PostgreSQL type string
   *
   * @example
   * ```ts
   * mapType("string", "uuid") // => "UUID"
   * mapType("string", "date-time") // => "TIMESTAMPTZ"
   * mapType("number") // => "DOUBLE PRECISION"
   * ```
   */
  mapType(jsonType: string, format?: string): string {
    // Handle string types with format specifiers
    if (jsonType === "string") {
      if (format === "uuid") return "UUID"
      if (format === "date-time") return "TIMESTAMPTZ"
      return "TEXT"
    }

    // Handle numeric types
    if (jsonType === "integer") return "INTEGER"
    if (jsonType === "number") return "DOUBLE PRECISION"

    // Handle boolean
    if (jsonType === "boolean") return "BOOLEAN"

    // Handle arrays (stored as JSONB in PostgreSQL)
    if (jsonType === "array") return "JSONB"

    // Handle objects (stored as JSONB in PostgreSQL)
    if (jsonType === "object") return "JSONB"

    // Default fallback
    return "TEXT"
  }

  /**
   * Escapes SQL identifiers using double quotes with quote-doubling
   *
   * PostgreSQL identifier escaping rules:
   * - Wrap identifier in double quotes
   * - Double any embedded double quotes (escape mechanism)
   *
   * @param {string} name - Unescaped identifier name
   * @returns {string} Escaped identifier safe for use in PostgreSQL SQL
   *
   * @example
   * ```ts
   * escapeIdentifier("user_name") // => "user_name"
   * escapeIdentifier('table"name') // => "table""name"
   * ```
   */
  escapeIdentifier(name: string): string {
    // Replace any double quotes with doubled double quotes, then wrap in quotes
    return `"${name.replace(/"/g, '""')}"`
  }
}

/**
 * SQLite dialect implementation
 *
 * Uses SQLite's limited type system with TEXT/INTEGER/REAL fallbacks.
 * SQLite stores all data in one of five storage classes: NULL, INTEGER, REAL, TEXT, BLOB.
 *
 * Type mappings:
 * - string (all formats) → TEXT (SQLite has no native UUID or timestamp types)
 * - integer → INTEGER
 * - number → REAL
 * - boolean → INTEGER (0 = false, 1 = true)
 * - array → TEXT (stored as JSON string)
 * - object → TEXT (stored as JSON string)
 *
 * @class SqliteDialect
 * @implements {SqlDialect}
 */
class SqliteDialect implements SqlDialect {
  readonly name = "sqlite"
  readonly supportsForeignKeys = true
  readonly supportsCheckConstraints = true

  // Migration capability properties
  // SQLite has limited ALTER TABLE support
  readonly supportsAddColumn = true  // SQLite supports ADD COLUMN
  readonly supportsDropColumn = false // SQLite doesn't support DROP COLUMN directly
  readonly supportsAlterColumnType = false // SQLite doesn't support ALTER COLUMN TYPE

  /**
   * SQLite has limited ALTER TABLE support.
   * Operations like DROP COLUMN, type changes, and constraint changes
   * require the 4-step table recreation pattern:
   * 1. CREATE TABLE temp_* with new schema
   * 2. INSERT INTO temp_* SELECT ... FROM original
   * 3. DROP TABLE original
   * 4. ALTER TABLE temp_* RENAME TO original
   */
  requiresTableRecreation(operation: string): boolean {
    // Operations that require table recreation in SQLite
    const recreationRequired = [
      "DROP_COLUMN",
      "RECREATE_TABLE",
    ]
    return recreationRequired.includes(operation)
  }

  /**
   * Maps JSON Schema types to SQLite SQL types
   *
   * @param {string} jsonType - JSON Schema type ("string", "integer", "number", "boolean", "array")
   * @param {string} [format] - Optional JSON Schema format (ignored - SQLite uses simple types)
   * @returns {string} SQLite type string
   *
   * @example
   * ```ts
   * mapType("string", "uuid") // => "TEXT" (no native UUID in SQLite)
   * mapType("boolean") // => "INTEGER" (0 or 1)
   * mapType("number") // => "REAL"
   * ```
   */
  mapType(jsonType: string, format?: string): string {
    // SQLite has limited type system - all strings map to TEXT
    if (jsonType === "string") return "TEXT"

    // Numeric types
    if (jsonType === "integer") return "INTEGER"
    if (jsonType === "number") return "REAL"

    // Boolean stored as INTEGER (0 = false, 1 = true)
    if (jsonType === "boolean") return "INTEGER"

    // Arrays stored as JSON TEXT
    if (jsonType === "array") return "TEXT"

    // Objects stored as JSON TEXT
    if (jsonType === "object") return "TEXT"

    // Default fallback
    return "TEXT"
  }

  /**
   * Escapes SQL identifiers using double quotes
   *
   * SQLite supports both double quotes and square brackets for identifiers.
   * We use double quotes for consistency with PostgreSQL.
   *
   * @param {string} name - Unescaped identifier name
   * @returns {string} Escaped identifier safe for use in SQLite SQL
   *
   * @example
   * ```ts
   * escapeIdentifier("table_name") // => "table_name"
   * escapeIdentifier("user") // => "user" (reserved word handling)
   * ```
   */
  escapeIdentifier(name: string): string {
    // SQLite uses double quotes for identifier escaping
    // Note: SQLite also accepts square brackets [name] but we use quotes for consistency
    return `"${name}"`
  }
}

/**
 * Factory function to create a PostgreSQL dialect instance
 *
 * @returns {SqlDialect} PostgreSQL dialect implementation
 *
 * @example
 * ```ts
 * const dialect = createPostgresDialect()
 * const sqlType = dialect.mapType("string", "uuid") // => "UUID"
 * ```
 */
export function createPostgresDialect(): SqlDialect {
  return new PostgresDialect()
}

/**
 * Factory function to create a SQLite dialect instance
 *
 * @returns {SqlDialect} SQLite dialect implementation
 *
 * @example
 * ```ts
 * const dialect = createSqliteDialect()
 * const sqlType = dialect.mapType("string", "uuid") // => "TEXT"
 * ```
 */
export function createSqliteDialect(): SqlDialect {
  return new SqliteDialect()
}
