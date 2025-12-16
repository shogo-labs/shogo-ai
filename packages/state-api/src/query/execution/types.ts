/**
 * Database execution abstraction types
 *
 * These types provide a database-agnostic interface for SQL execution.
 * No Bun.sql or database-specific types should be present in this module.
 */

/**
 * Generic row type representing a database query result row.
 * Database-agnostic: can represent Postgres, SQLite, or any other database row.
 */
export type Row = Record<string, unknown>

/**
 * SQL executor configuration for database connections.
 */
export interface SqlExecutorConfig {
  /**
   * Database connection string (e.g., "postgresql://user:pass@host:port/db")
   */
  connectionString: string

  /**
   * Optional connection pool size
   */
  poolSize?: number
}

/**
 * Database executor interface for executing parameterized SQL queries.
 *
 * This interface is database-agnostic and can be implemented by any database driver
 * (Bun.sql, node-postgres, Turso, etc.).
 */
export interface ISqlExecutor {
  /**
   * Execute a parameterized SQL query.
   *
   * @param query - Tuple of [sql, params] where:
   *   - sql: SQL string with positional placeholders ($1, $2, etc.)
   *   - params: Array of parameter values to bind to placeholders
   *
   * @returns Promise resolving to array of result rows
   *
   * @example
   * ```ts
   * const rows = await executor.execute([
   *   "SELECT * FROM users WHERE id = $1",
   *   [42]
   * ])
   * ```
   */
  execute(query: [sql: string, params: unknown[]]): Promise<Row[]>
}
