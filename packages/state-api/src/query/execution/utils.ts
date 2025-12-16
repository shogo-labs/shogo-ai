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
