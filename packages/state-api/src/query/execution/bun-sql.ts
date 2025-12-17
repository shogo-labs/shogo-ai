/**
 * BunSqlExecutor - Database executor using Bun.sql native driver
 *
 * This executor wraps Bun's built-in SQL support, converting parameterized
 * SQL queries into tagged template literals for execution.
 *
 * Key Pattern: Parameterized SQL → Tagged Template Conversion
 * -------------------------------------------------------------
 * Input:  ["SELECT * FROM users WHERE id = $1", [42]]
 * Process: sql.split(/\$\d+/) → ["SELECT * FROM users WHERE id = ", ""]
 * Output:  sql(["SELECT * FROM users WHERE id = ", ""], 42)
 *
 * This allows the query layer to work with standard parameterized SQL
 * while leveraging Bun.sql's tagged template syntax for actual execution.
 */

import type { SQL } from "bun:sql"
import type { ISqlExecutor, Row } from "./types"

/**
 * SQL executor implementation using Bun.sql native driver.
 *
 * Converts parameterized SQL queries with positional placeholders ($1, $2, etc.)
 * into Bun.sql tagged template invocations.
 *
 * @example
 * ```ts
 * import { Database } from "bun:sqlite"
 *
 * const db = new Database("my.db")
 * const executor = new BunSqlExecutor(db as unknown as SQL)
 *
 * const users = await executor.execute([
 *   "SELECT * FROM users WHERE age > $1",
 *   [18]
 * ])
 * ```
 */
export class BunSqlExecutor implements ISqlExecutor {
  /**
   * The underlying Bun.sql connection
   */
  private readonly _connection: SQL

  /**
   * Create a new BunSqlExecutor
   *
   * @param connection - Bun.sql connection instance (Database or SQL type)
   */
  constructor(connection: SQL) {
    this._connection = connection
  }

  /**
   * Get the underlying SQL connection for advanced use cases
   */
  get connection(): SQL {
    return this._connection
  }

  /**
   * Execute a parameterized SQL query.
   *
   * Converts standard parameterized SQL ($1, $2, etc.) into Bun.sql's
   * tagged template format.
   *
   * Algorithm:
   * 1. Split SQL string on placeholder pattern (/\$\d+/)
   * 2. Use resulting parts as template literal strings
   * 3. Pass params as template literal values
   * 4. Invoke sql(parts, ...params) using tagged template syntax
   *
   * Edge Cases Handled:
   * - Empty params: ["SELECT * FROM users", []] → simple query
   * - Trailing placeholder: "VALUES ($1)" → parts = ["VALUES (", ")"]
   * - Consecutive placeholders: "$1 AND $2" → parts = ["", " AND ", ""]
   * - Non-sequential placeholders: "$2 OR $1" (param order matters)
   *
   * @param query - Tuple of [sql, params]
   * @returns Promise resolving to array of result rows
   */
  async execute(query: [sql: string, params: unknown[]]): Promise<Row[]> {
    const [sql, params] = query

    try {
      // Convert PostgreSQL-style placeholders ($1, $2) to SQLite-style (?, ?)
      // This is needed because bun:sqlite uses ? placeholders
      let sqliteQuery = sql
      let sortedParams = [...params]

      if (params.length > 0) {
        // Check if SQL uses PostgreSQL-style placeholders ($1, $2)
        const placeholderMap: Array<{ placeholder: string; index: number }> = []
        const placeholderRegex = /\$(\d+)/g
        let match
        while ((match = placeholderRegex.exec(sql)) !== null) {
          const paramIndex = parseInt(match[1], 10) - 1 // Convert $1 to index 0
          placeholderMap.push({ placeholder: match[0], index: paramIndex })
        }

        if (placeholderMap.length > 0) {
          // PostgreSQL-style found - convert to SQLite style
          sqliteQuery = sql.replace(/\$\d+/g, "?")
          sortedParams = placeholderMap.map(p => params[p.index])
        }
        // else: Already using ? placeholders (SQLite dialect), no conversion needed
      }

      // Use Database.query() to prepare statement and execute
      // Cast to any because SQL type from bun:sql doesn't expose query method
      const db = this._connection as any
      const statement = db.query(sqliteQuery)
      const result = statement.all(...sortedParams)

      // Handle different return types
      if (Array.isArray(result)) {
        return result
      }

      // For non-SELECT queries (INSERT, UPDATE, DELETE), return empty array
      // The caller can check affectedRows if needed in the future
      return []
    } catch (error) {
      // Provide helpful error context
      throw new Error(
        `BunSqlExecutor.execute failed: ${error instanceof Error ? error.message : String(error)}\nSQL: ${sql}\nParams: ${JSON.stringify(params)}`
      )
    }
  }

  /**
   * Execute multiple SQL statements in order (typically DDL).
   *
   * Useful for schema migrations where multiple CREATE TABLE statements
   * need to be executed sequentially.
   *
   * @param statements - Array of SQL statements to execute
   * @returns Promise resolving to count of executed statements
   *
   * @example
   * ```ts
   * await executor.executeMany([
   *   "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
   *   "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER)"
   * ])
   * ```
   */
  async executeMany(statements: string[]): Promise<number> {
    let count = 0

    for (const statement of statements) {
      try {
        // DDL statements typically don't have parameters
        // Use the connection's run/exec method directly
        ;(this._connection as any).run(statement)
        count++
      } catch (error) {
        throw new Error(
          `BunSqlExecutor.executeMany failed on statement ${count + 1}: ${error instanceof Error ? error.message : String(error)}\nSQL: ${statement}`
        )
      }
    }

    return count
  }
}
