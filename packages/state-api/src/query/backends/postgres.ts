/**
 * PostgreSQL Backend Implementation
 *
 * Wraps SqlBackend (compilation) + ISqlExecutor (execution) to provide
 * a unified IBackend interface for PostgreSQL database queries.
 *
 * @module query/backends/postgres
 *
 * Requirements:
 * - REQ-12: Postgres queryable implementation
 * - Implements IBackend interface
 * - Compiles queries via SqlBackend
 * - Executes via ISqlExecutor
 * - Normalizes results from snake_case to camelCase
 *
 * Design decisions:
 * - Dependency injection: ISqlExecutor passed to constructor
 * - Stateless: no internal caching or state accumulation
 * - Normalization: All result rows converted to camelCase for MST compatibility
 * - Operations: Supports select, count, exists via SqlBackend compilation methods
 */

import type { Condition } from '../ast/types'
import type { IBackend, BackendCapabilities, QueryOptions, QueryResult } from './types'
import type { ISqlExecutor } from '../execution/types'
import { SqlBackend } from './sql'
import { normalizeRows } from '../execution/utils'

// ============================================================================
// Extended Query Options
// ============================================================================

/**
 * Extended query options that include operation type.
 * Used internally to route to appropriate SqlBackend compilation method.
 */
interface ExtendedQueryOptions extends QueryOptions {
  /**
   * Operation type to perform.
   * - 'select': Standard query returning rows (default)
   * - 'count': COUNT(*) query returning count
   * - 'exists': EXISTS query returning boolean presence check
   */
  operation?: 'select' | 'count' | 'exists'
}

// ============================================================================
// PostgresBackend Class
// ============================================================================

/**
 * PostgreSQL query backend using SqlBackend + ISqlExecutor.
 *
 * @remarks
 * This backend provides a complete query execution pipeline:
 * 1. Compiles MongoDB-style queries to PostgreSQL SQL via SqlBackend
 * 2. Executes parameterized SQL via ISqlExecutor
 * 3. Normalizes result rows from snake_case to camelCase
 *
 * The backend is stateless and thread-safe. All state is passed via parameters.
 *
 * @example
 * ```typescript
 * import { Database } from 'bun:sqlite'
 * import { BunSqlExecutor } from '../execution/bun-sql'
 * import { PostgresBackend } from './postgres'
 * import { parseQuery } from '../ast'
 *
 * // Setup
 * const sql = Database.open('mydb.db')
 * const executor = new BunSqlExecutor(sql)
 * const backend = new PostgresBackend(executor)
 *
 * // Query
 * const ast = parseQuery({ status: 'active', age: { $gt: 18 } })
 * const result = await backend.execute(ast, 'users', {
 *   orderBy: { field: 'createdAt', direction: 'desc' },
 *   take: 10
 * })
 *
 * // result.items contains normalized rows with camelCase keys
 * ```
 */
export class PostgresBackend implements IBackend {
  private readonly sqlBackend: SqlBackend
  private readonly executor: ISqlExecutor

  /**
   * Declares the operators and features supported by this backend.
   * Inherits capabilities from SqlBackend.
   */
  readonly capabilities: BackendCapabilities

  /**
   * Create a new PostgresBackend instance.
   *
   * @param executor - SQL executor for running queries against database
   *
   * @remarks
   * The executor is the only dependency. All compilation logic comes from SqlBackend.
   * The backend maintains no internal state - it's safe to reuse across queries.
   */
  constructor(executor: ISqlExecutor) {
    this.executor = executor
    this.sqlBackend = new SqlBackend()
    this.capabilities = this.sqlBackend.capabilities
  }

  /**
   * Execute a query against a database collection.
   *
   * @param ast - Query AST (from parseQuery)
   * @param collection - Collection/table name to query
   * @param options - Optional query options (pagination, sorting, operation type)
   * @returns Promise resolving to query results with normalized rows
   *
   * @remarks
   * Pipeline:
   * 1. Route to appropriate SqlBackend compilation method based on operation type
   * 2. Execute compiled SQL via ISqlExecutor
   * 3. Normalize result rows from snake_case to camelCase
   * 4. Return QueryResult with normalized items
   *
   * @example
   * ```typescript
   * // Standard select query
   * const result = await backend.execute(ast, 'users')
   *
   * // Count query
   * const countResult = await backend.execute(ast, 'users', { operation: 'count' })
   *
   * // Exists query
   * const existsResult = await backend.execute(ast, 'users', { operation: 'exists' })
   * ```
   */
  async execute<T>(
    ast: Condition,
    collection: string | T[],
    options?: ExtendedQueryOptions
  ): Promise<QueryResult<T>> {
    // Collection parameter is string (table name) for SQL backends
    const tableName = typeof collection === 'string'
      ? collection
      : 'unknown_table'

    // Route to appropriate compilation method based on operation type
    const operation = options?.operation ?? 'select'
    let sql: string
    let params: unknown[]

    switch (operation) {
      case 'count':
        [sql, params] = this.sqlBackend.compileCount(ast, tableName)
        break

      case 'exists':
        [sql, params] = this.sqlBackend.compileExists(ast, tableName)
        break

      case 'select':
      default:
        // For select operations, SqlBackend.compileSelect returns WHERE clause with ORDER BY/LIMIT appended
        // We need to construct the full SELECT statement
        const [whereSql, whereParams] = this.sqlBackend.compileSelect(ast, tableName, options)

        // Handle empty WHERE clause (e.g., from parseQuery({}))
        // Empty AND generates "()" which is invalid SQL
        // The whereSql might be "()" or "() ORDER BY ..." or "() LIMIT ..."
        if (whereSql.trim().startsWith('()')) {
          // Remove the empty "()" and keep the rest (ORDER BY, LIMIT, etc.)
          const remainder = whereSql.substring(whereSql.indexOf('()') + 2).trim()
          if (remainder) {
            sql = `SELECT * FROM "${tableName}" ${remainder}`
          } else {
            sql = `SELECT * FROM "${tableName}"`
          }
        } else if (whereSql && whereSql.trim() !== '') {
          sql = `SELECT * FROM "${tableName}" WHERE ${whereSql}`
        } else {
          sql = `SELECT * FROM "${tableName}"`
        }
        params = whereParams
        break
    }

    // Execute SQL via executor
    const rows = await this.executor.execute([sql, params])

    // Normalize result rows from snake_case to camelCase
    const normalizedRows = normalizeRows(rows)

    // Return normalized results as QueryResult
    return {
      items: normalizedRows as T[],
    }
  }
}
