/**
 * Query Execution Module
 *
 * This module provides database execution capabilities for the query layer.
 *
 * Exports:
 * - ISqlExecutor: Database-agnostic SQL executor interface
 * - SqlExecutorConfig: Connection configuration type
 * - BunSqlExecutor: Bun.sql implementation of ISqlExecutor (SQLite)
 * - BunPostgresExecutor: Bun.sql implementation of ISqlExecutor (PostgreSQL)
 * - Utility functions: Field name conversion (snake_case ↔ camelCase)
 */

// Type exports
export type { ISqlExecutor, SqlExecutorConfig, Row } from "./types"

// Implementation exports
export { BunSqlExecutor } from "./bun-sql"
export { BunPostgresExecutor } from "./bun-postgres"
export type { BunPostgresExecutorOptions } from "./bun-postgres"

// Utility exports
export { snakeToCamel, camelToSnake, normalizeRow, normalizeRows } from "./utils"
