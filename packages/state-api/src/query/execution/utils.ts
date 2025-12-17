/**
 * SQL Execution Utility Functions
 *
 * Provides field name normalization between database and JavaScript conventions:
 * - snake_case (PostgreSQL/SQLite convention)
 * - camelCase (JavaScript/TypeScript/MST convention)
 *
 * Used by PostgresBackend to convert database result rows to MST-compatible format.
 *
 * ## Schema-Aware Normalization
 *
 * Generic snake_case → camelCase conversion is LOSSY for edge cases:
 * - `user_id` could be `userId` OR `userID` - can't know without schema
 * - `https_url` could be `httpsUrl` OR `HTTPSUrl` - can't know without schema
 *
 * The schema-aware functions (`createColumnPropertyMap`, `normalizeRowWithSchema`)
 * use the schema property names as the source of truth, ensuring correct round-trips.
 *
 * CRITICAL: These functions use the SAME `toSnakeCase` algorithm as the DDL generator
 * to ensure the mapping from property → column → property is lossless.
 */

// Import toSnakeCase from DDL utils - MUST use same algorithm as DDL generator
import { toSnakeCase } from "../../ddl/utils"

/**
 * Convert snake_case string to camelCase
 *
 * @example
 * snakeToCamel('created_at') // => 'createdAt'
 * snakeToCamel('user_id') // => 'userId'
 * snakeToCamel('name') // => 'name'
 * snakeToCamel('') // => ''
 */
export function snakeToCamel(str: string): string {
  if (!str) return str

  return str
    .split("_")
    .map((part, index) => {
      // First part stays lowercase, subsequent parts capitalize first letter
      if (index === 0) return part
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join("")
}

/**
 * Convert camelCase string to snake_case
 *
 * @example
 * camelToSnake('createdAt') // => 'created_at'
 * camelToSnake('userId') // => 'user_id'
 * camelToSnake('name') // => 'name'
 * camelToSnake('') // => ''
 */
export function camelToSnake(str: string): string {
  if (!str) return str

  return str
    .replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    .replace(/^_/, "") // Remove leading underscore if present
}

/**
 * Normalize a single database row by converting all keys from snake_case to camelCase
 *
 * Values are preserved unchanged. Original row is not mutated.
 *
 * @example
 * normalizeRow({ user_id: 1, created_at: '2024-01-01' })
 * // => { userId: 1, createdAt: '2024-01-01' }
 */
export function normalizeRow<T extends Record<string, unknown>>(
  row: T
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(row)) {
    const camelKey = snakeToCamel(key)
    normalized[camelKey] = value
  }

  return normalized
}

/**
 * Batch normalize an array of database rows
 *
 * Applies normalizeRow to each row in the array.
 *
 * @example
 * normalizeRows([
 *   { user_id: 1, created_at: '2024-01-01' },
 *   { user_id: 2, created_at: '2024-01-02' }
 * ])
 * // => [
 * //   { userId: 1, createdAt: '2024-01-01' },
 * //   { userId: 2, createdAt: '2024-01-02' }
 * // ]
 */
export function normalizeRows<T extends Record<string, unknown>>(
  rows: T[]
): Record<string, unknown>[] {
  return rows.map((row) => normalizeRow(row))
}

// ============================================================================
// Schema-Aware Normalization
// ============================================================================

/**
 * Type alias for column-to-property mapping
 */
export type ColumnPropertyMap = Record<string, string>

/**
 * Create a mapping from database column names to schema property names
 *
 * Uses the SAME `toSnakeCase` algorithm as the DDL generator to ensure
 * correct round-trip: property → DDL column → property
 *
 * @param propertyNames - Array of property names from the schema/model
 * @returns Mapping from snake_case column name to original property name
 *
 * @remarks
 * This is the key to fixing the schema-blind normalization issue.
 * By using the DDL's `toSnakeCase`, we ensure:
 * - `HTTPSUrl` → `https_url` → `HTTPSUrl` (not `httpsUrl`)
 * - `userID` → `user_id` → `userID` (not `userId`)
 * - `ID` → `id` → `ID` (not `id`)
 *
 * @example
 * const propertyNames = ['userId', 'HTTPSUrl', 'ID']
 * const map = createColumnPropertyMap(propertyNames)
 * // => { user_id: 'userId', https_url: 'HTTPSUrl', id: 'ID' }
 */
export function createColumnPropertyMap(
  propertyNames: string[]
): ColumnPropertyMap {
  const map: ColumnPropertyMap = {}

  for (const propName of propertyNames) {
    // Use DDL's toSnakeCase to get the column name
    const columnName = toSnakeCase(propName)
    map[columnName] = propName
  }

  return map
}

/**
 * Normalize a database row using schema-aware mapping
 *
 * Uses the column-to-property mapping to correctly convert column names
 * to their original property names. Falls back to generic snakeToCamel
 * for unmapped columns (e.g., database metadata columns).
 *
 * @param row - Database row with snake_case column names
 * @param columnPropertyMap - Mapping from column name to property name
 * @returns Normalized row with correct property names
 *
 * @remarks
 * This function fixes the data corruption issue where generic snakeToCamel
 * would return wrong property names for edge cases like consecutive capitals.
 *
 * @example
 * const map = { https_url: 'HTTPSUrl', user_id: 'userID' }
 * const row = { https_url: 'https://example.com', user_id: 'usr_123' }
 * normalizeRowWithSchema(row, map)
 * // => { HTTPSUrl: 'https://example.com', userID: 'usr_123' }
 */
export function normalizeRowWithSchema<T extends Record<string, unknown>>(
  row: T,
  columnPropertyMap: ColumnPropertyMap
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}

  for (const [column, value] of Object.entries(row)) {
    // Use schema mapping if available, otherwise fall back to generic conversion
    const propName = columnPropertyMap[column] ?? snakeToCamel(column)
    normalized[propName] = value
  }

  return normalized
}

/**
 * Batch normalize database rows using schema-aware mapping
 *
 * @param rows - Array of database rows with snake_case column names
 * @param columnPropertyMap - Mapping from column name to property name
 * @returns Array of normalized rows with correct property names
 *
 * @example
 * const map = { id: 'ID', user_id: 'userID' }
 * const rows = [
 *   { id: '1', user_id: 'usr_1' },
 *   { id: '2', user_id: 'usr_2' }
 * ]
 * normalizeRowsWithSchema(rows, map)
 * // => [{ ID: '1', userID: 'usr_1' }, { ID: '2', userID: 'usr_2' }]
 */
export function normalizeRowsWithSchema<T extends Record<string, unknown>>(
  rows: T[],
  columnPropertyMap: ColumnPropertyMap
): Record<string, unknown>[] {
  return rows.map((row) => normalizeRowWithSchema(row, columnPropertyMap))
}

// ============================================================================
// Type-Aware Normalization (Dialect-Specific)
// ============================================================================

/**
 * Property type map for dialect-specific conversions
 */
export type PropertyTypeMap = Record<string, string>

/**
 * SQL dialect type for type conversion
 */
export type SqlDialect = 'pg' | 'sqlite'

/**
 * Normalize a database row with schema-aware column mapping AND type conversions.
 *
 * Handles dialect-specific type conversions:
 * - SQLite: INTEGER (0/1) → boolean (false/true)
 * - PostgreSQL: boolean → boolean (passthrough)
 *
 * @param row - Database row with snake_case column names
 * @param columnPropertyMap - Mapping from column name to property name
 * @param dialect - SQL dialect ('pg' or 'sqlite')
 * @param propertyTypes - Map of property name to type ('boolean', 'string', 'number', etc.)
 * @returns Normalized row with correct property names and type conversions
 *
 * @example
 * ```typescript
 * const row = { is_active: 1, user_id: 'alice' }
 * const columnMap = { is_active: 'isActive', user_id: 'userId' }
 * const types = { isActive: 'boolean', userId: 'string' }
 *
 * normalizeRowWithTypes(row, columnMap, 'sqlite', types)
 * // => { isActive: true, userId: 'alice' }
 * ```
 */
export function normalizeRowWithTypes<T extends Record<string, unknown>>(
  row: T,
  columnPropertyMap: ColumnPropertyMap,
  dialect: SqlDialect,
  propertyTypes: PropertyTypeMap
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}

  for (const [column, value] of Object.entries(row)) {
    // Map column name to property name
    const propName = columnPropertyMap[column] ?? snakeToCamel(column)

    // Apply type conversion if needed
    const propType = propertyTypes[propName]

    if (propType === 'boolean' && dialect === 'sqlite' && value !== null && value !== undefined) {
      // SQLite stores boolean as INTEGER (0/1)
      // Only convert if value is actually 0 or 1 (not null/undefined)
      normalized[propName] = value === 1 || value === true
    } else if (value === null) {
      // Convert SQL NULL to undefined for MST compatibility
      // MST expects undefined for missing optional fields, not null
      normalized[propName] = undefined
    } else {
      // All other values pass through
      normalized[propName] = value
    }
  }

  return normalized
}

/**
 * Batch normalize database rows with type conversions.
 *
 * @param rows - Array of database rows
 * @param columnPropertyMap - Mapping from column name to property name
 * @param dialect - SQL dialect
 * @param propertyTypes - Map of property types
 * @returns Array of normalized rows with type conversions
 */
export function normalizeRowsWithTypes<T extends Record<string, unknown>>(
  rows: T[],
  columnPropertyMap: ColumnPropertyMap,
  dialect: SqlDialect,
  propertyTypes: PropertyTypeMap
): Record<string, unknown>[] {
  return rows.map((row) =>
    normalizeRowWithTypes(row, columnPropertyMap, dialect, propertyTypes)
  )
}

// ============================================================================
// Mutation SQL Generation Utilities
// ============================================================================

/**
 * Type alias for property-to-column mapping (inverse of ColumnPropertyMap)
 */
export type PropertyColumnMap = Record<string, string>

/**
 * Create a mapping from schema property names to database column names
 *
 * This is the inverse of createColumnPropertyMap - maps property → column
 * for use in INSERT/UPDATE statements.
 *
 * @param propertyNames - Array of property names from the schema/model
 * @returns Mapping from camelCase property name to snake_case column name
 *
 * @example
 * const propertyNames = ['userId', 'HTTPSUrl', 'ID']
 * const map = createPropertyColumnMap(propertyNames)
 * // => { userId: 'user_id', HTTPSUrl: 'https_url', ID: 'id' }
 */
export function createPropertyColumnMap(
  propertyNames: string[]
): PropertyColumnMap {
  const map: PropertyColumnMap = {}

  for (const propName of propertyNames) {
    // Use DDL's toSnakeCase to get the column name
    const columnName = toSnakeCase(propName)
    map[propName] = columnName
  }

  return map
}

/**
 * Convert a camelCase entity to snake_case columns for database operations.
 *
 * @param entity - Entity object with camelCase property names
 * @param propertyColumnMap - Optional explicit property-to-column mapping
 * @returns Object with snake_case column names and preserved values
 *
 * @remarks
 * - Undefined values are excluded from the result (database NULL vs not present)
 * - Null values are preserved (will become database NULL)
 * - Uses toSnakeCase by default, or explicit mapping if provided
 *
 * @example
 * ```typescript
 * entityToColumns({ userName: 'alice', createdAt: '2024-01-01' })
 * // => { user_name: 'alice', created_at: '2024-01-01' }
 *
 * entityToColumns({ HTTPSUrl: 'https://...' }, { HTTPSUrl: 'https_url' })
 * // => { https_url: 'https://...' }
 * ```
 */
export function entityToColumns<T extends Record<string, unknown>>(
  entity: T,
  propertyColumnMap?: PropertyColumnMap
): Record<string, unknown> {
  const columns: Record<string, unknown> = {}

  for (const [propName, value] of Object.entries(entity)) {
    // Skip undefined values (not present in INSERT/UPDATE)
    if (value === undefined) continue

    // Get column name from mapping or generate via toSnakeCase
    const columnName = propertyColumnMap?.[propName] ?? toSnakeCase(propName)
    columns[columnName] = value
  }

  return columns
}

/**
 * Build an INSERT SQL statement.
 *
 * @param tableName - Name of the table to insert into
 * @param columns - Array of column names
 * @param dialect - SQL dialect ('pg' or 'sqlite')
 * @returns INSERT SQL string with placeholders
 *
 * @example
 * ```typescript
 * buildInsertSQL('users', ['id', 'name'], 'pg')
 * // => 'INSERT INTO "users" ("id", "name") VALUES ($1, $2) RETURNING *'
 *
 * buildInsertSQL('users', ['id', 'name'], 'sqlite')
 * // => 'INSERT INTO "users" ("id", "name") VALUES (?, ?)'
 * ```
 */
export function buildInsertSQL(
  tableName: string,
  columns: string[],
  dialect: SqlDialect
): string {
  // Quote identifiers
  const quotedTable = `"${tableName}"`
  const quotedColumns = columns.map((col) => `"${col}"`).join(", ")

  // Generate placeholders based on dialect
  const placeholders = columns
    .map((_, i) => (dialect === "pg" ? `$${i + 1}` : "?"))
    .join(", ")

  // PostgreSQL supports RETURNING, SQLite doesn't in older versions
  const returning = dialect === "pg" ? " RETURNING *" : ""

  return `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders})${returning}`
}

/**
 * Build an UPDATE SQL statement.
 *
 * @param tableName - Name of the table to update
 * @param setColumns - Array of column names for SET clause
 * @param whereColumn - Column name for WHERE clause
 * @param dialect - SQL dialect ('pg' or 'sqlite')
 * @returns UPDATE SQL string with placeholders
 *
 * @remarks
 * Placeholder order: SET columns first ($1, $2, ...), then WHERE column (last placeholder)
 *
 * @example
 * ```typescript
 * buildUpdateSQL('users', ['name', 'status'], 'id', 'pg')
 * // => 'UPDATE "users" SET "name" = $1, "status" = $2 WHERE "id" = $3 RETURNING *'
 * ```
 */
export function buildUpdateSQL(
  tableName: string,
  setColumns: string[],
  whereColumn: string,
  dialect: SqlDialect
): string {
  // Quote table name
  const quotedTable = `"${tableName}"`

  // Generate SET clause with placeholders
  const setClauses = setColumns
    .map((col, i) => {
      const placeholder = dialect === "pg" ? `$${i + 1}` : "?"
      return `"${col}" = ${placeholder}`
    })
    .join(", ")

  // WHERE clause uses next placeholder index
  const whereIndex = setColumns.length + 1
  const wherePlaceholder = dialect === "pg" ? `$${whereIndex}` : "?"
  const whereClause = `WHERE "${whereColumn}" = ${wherePlaceholder}`

  // PostgreSQL supports RETURNING
  const returning = dialect === "pg" ? " RETURNING *" : ""

  return `UPDATE ${quotedTable} SET ${setClauses} ${whereClause}${returning}`
}

/**
 * Build a DELETE SQL statement.
 *
 * @param tableName - Name of the table to delete from
 * @param whereColumn - Column name for WHERE clause
 * @param dialect - SQL dialect ('pg' or 'sqlite')
 * @returns DELETE SQL string with placeholder
 *
 * @example
 * ```typescript
 * buildDeleteSQL('users', 'id', 'pg')
 * // => 'DELETE FROM "users" WHERE "id" = $1'
 *
 * buildDeleteSQL('sessions', 'token', 'sqlite')
 * // => 'DELETE FROM "sessions" WHERE "token" = ?'
 * ```
 */
export function buildDeleteSQL(
  tableName: string,
  whereColumn: string,
  dialect: SqlDialect
): string {
  // Quote identifiers
  const quotedTable = `"${tableName}"`
  const placeholder = dialect === "pg" ? "$1" : "?"

  return `DELETE FROM ${quotedTable} WHERE "${whereColumn}" = ${placeholder}`
}
