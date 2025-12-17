/**
 * JSON Schema type to SQL type mapping with dialect-aware translation
 *
 * This module provides the core type mapping functionality for converting
 * Enhanced JSON Schema property definitions into SQL column types. It delegates
 * to SqlDialect implementations for database-specific type mappings.
 *
 * @module ddl/type-mapper
 */

import type { SqlDialect } from "./types"

/**
 * Maps a JSON Schema property to a SQL column type using dialect-specific rules
 *
 * This function extracts the JSON Schema type and optional format from a property
 * definition and delegates to the dialect's mapType() method for the actual
 * type translation. This abstraction allows different SQL databases to handle
 * types differently (e.g., PostgreSQL's UUID vs SQLite's TEXT).
 *
 * Type mapping examples:
 * - { type: "string" } → TEXT (both dialects)
 * - { type: "string", format: "uuid" } → UUID (pg) / TEXT (sqlite)
 * - { type: "string", format: "date-time" } → TIMESTAMPTZ (pg) / TEXT (sqlite)
 * - { type: "integer" } → INTEGER (both dialects)
 * - { type: "number" } → DOUBLE PRECISION (pg) / REAL (sqlite)
 * - { type: "boolean" } → BOOLEAN (pg) / INTEGER (sqlite)
 * - { type: "array" } → JSONB (pg) / TEXT (sqlite)
 *
 * Enum handling: Properties with an `enum` array are mapped to their base type.
 * CHECK constraints for enums are handled separately by the constraint-builder module.
 *
 * @param {any} prop - JSON Schema property definition (must have a `type` field)
 * @param {SqlDialect} dialect - SQL dialect for type mapping
 * @returns {string} SQL column type string (e.g., "TEXT", "UUID", "INTEGER")
 *
 * @example
 * ```ts
 * // String without format
 * const prop1 = { type: "string" }
 * mapPropertyType(prop1, pgDialect) // => "TEXT"
 *
 * // String with UUID format
 * const prop2 = { type: "string", format: "uuid" }
 * mapPropertyType(prop2, pgDialect) // => "UUID"
 * mapPropertyType(prop2, sqliteDialect) // => "TEXT"
 *
 * // Number type
 * const prop3 = { type: "number" }
 * mapPropertyType(prop3, pgDialect) // => "DOUBLE PRECISION"
 * mapPropertyType(prop3, sqliteDialect) // => "REAL"
 *
 * // Array type
 * const prop4 = { type: "array", items: { type: "string" } }
 * mapPropertyType(prop4, pgDialect) // => "JSONB"
 * mapPropertyType(prop4, sqliteDialect) // => "TEXT"
 *
 * // Enum (returns base type, constraint handled elsewhere)
 * const prop5 = { type: "string", enum: ["active", "inactive"] }
 * mapPropertyType(prop5, pgDialect) // => "TEXT"
 * ```
 */
export function mapPropertyType(prop: any, dialect: SqlDialect): string {
  // Extract type and format from property definition
  const jsonType = prop.type
  const format = prop.format

  // Delegate to dialect-specific type mapping
  // The dialect knows how to map JSON Schema types to SQL types
  // for its specific database (PostgreSQL, SQLite, etc.)
  return dialect.mapType(jsonType, format)
}
