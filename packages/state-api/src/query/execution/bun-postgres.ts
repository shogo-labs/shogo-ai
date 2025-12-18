/**
 * BunPostgresExecutor - Database executor using Bun's native SQL driver for PostgreSQL
 *
 * This executor wraps Bun's built-in SQL support for PostgreSQL databases,
 * including Supabase and other PostgreSQL-compatible databases.
 *
 * Key Features:
 * - Native PostgreSQL $1, $2 placeholder support (no conversion needed)
 * - Connection pooling via Bun.sql's built-in pool
 * - Transaction support via sql.begin()
 * - TLS support for secure connections (Supabase, etc.)
 *
 * @example
 * ```ts
 * import { SQL } from "bun:sql"
 *
 * const executor = new BunPostgresExecutor(process.env.DATABASE_URL!, {
 *   max: 10,
 *   tls: true
 * })
 *
 * const users = await executor.execute([
 *   "SELECT * FROM users WHERE age > $1",
 *   [18]
 * ])
 * ```
 */

import type { ISqlExecutor, ITransactionExecutor, Row } from "./types"

// Use Bun's global SQL class for PostgreSQL connections
// Note: Bun.SQL is the constructor, Bun.sql is a pre-configured instance
const SQL = Bun.SQL

/**
 * Configuration options for BunPostgresExecutor
 */
export interface BunPostgresExecutorOptions {
  /**
   * Maximum number of connections in the pool
   * @default 10
   */
  max?: number

  /**
   * Maximum time in seconds to wait for connection to become available
   * @default 0 (no timeout)
   */
  idleTimeout?: number

  /**
   * Maximum time in seconds to wait when establishing a connection
   * @default 30
   */
  connectionTimeout?: number

  /**
   * Whether to use TLS/SSL for the connection
   * Set to true for Supabase and other cloud providers
   * @default false
   */
  tls?: boolean

  /**
   * Callback executed when a connection attempt completes
   */
  onconnect?: ((err: Error | null) => void) | undefined

  /**
   * Callback executed when a connection is closed
   */
  onclose?: ((err: Error | null) => void) | undefined
}

/**
 * SQL executor implementation using Bun's native SQL driver for PostgreSQL.
 *
 * Uses Bun.sql's connection pooling and native PostgreSQL wire protocol
 * for optimal performance.
 *
 * @example
 * ```ts
 * // Basic usage
 * const executor = new BunPostgresExecutor("postgresql://localhost:5432/mydb")
 *
 * // With Supabase (TLS required)
 * const executor = new BunPostgresExecutor(process.env.DATABASE_URL!, {
 *   tls: true,
 *   max: 10
 * })
 *
 * // Execute queries
 * const users = await executor.execute([
 *   "SELECT * FROM users WHERE id = $1",
 *   [42]
 * ])
 * ```
 */
// Type alias for the SQL instance type
type SQLInstance = InstanceType<typeof SQL>

export class BunPostgresExecutor implements ISqlExecutor {
  /**
   * The underlying Bun SQL connection pool
   */
  private readonly _connection: SQLInstance

  /**
   * Create a new BunPostgresExecutor
   *
   * @param connectionString - PostgreSQL connection URL (e.g., "postgresql://user:pass@host:port/db")
   * @param options - Optional connection pool configuration
   */
  constructor(connectionString: string, options?: BunPostgresExecutorOptions) {
    this._connection = new SQL({
      url: connectionString,
      max: options?.max ?? 10,
      idleTimeout: options?.idleTimeout,
      connectionTimeout: options?.connectionTimeout,
      tls: options?.tls,
      onconnect: options?.onconnect,
      onclose: options?.onclose,
    })
  }

  /**
   * Get the underlying SQL connection pool for advanced use cases
   */
  get connection(): SQLInstance {
    return this._connection
  }

  /**
   * Execute a parameterized SQL query.
   *
   * Uses PostgreSQL's native $1, $2, etc. placeholder syntax.
   * No placeholder conversion is needed (unlike SQLite).
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
   *   "SELECT * FROM users WHERE id = $1 AND status = $2",
   *   [42, "active"]
   * ])
   * ```
   */
  async execute(query: [sql: string, params: unknown[]]): Promise<Row[]> {
    const [sql, params] = query

    try {
      // Use sql.unsafe() for parameterized queries with $1, $2 placeholders
      // This is the Bun.sql way to execute parameterized queries
      const result = await this._connection.unsafe(sql, params as any[])

      // Bun.sql returns an array-like object, convert to plain array
      return Array.isArray(result) ? result : Array.from(result as any)
    } catch (error) {
      // Provide helpful error context
      throw new Error(
        `BunPostgresExecutor.execute failed: ${error instanceof Error ? error.message : String(error)}\nSQL: ${sql}\nParams: ${JSON.stringify(params)}`
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
   *   "CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)",
   *   "CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY, user_id INTEGER)"
   * ])
   * ```
   */
  async executeMany(statements: string[]): Promise<number> {
    let count = 0

    for (const statement of statements) {
      try {
        // DDL statements typically don't have parameters
        // Use unsafe with empty params array
        await this._connection.unsafe(statement, [])
        count++
      } catch (error) {
        throw new Error(
          `BunPostgresExecutor.executeMany failed on statement ${count + 1}: ${error instanceof Error ? error.message : String(error)}\nSQL: ${statement}`
        )
      }
    }

    return count
  }

  /**
   * Execute a callback within a database transaction.
   *
   * Uses Bun.sql's built-in transaction support via sql.begin().
   * If the callback throws, the transaction is automatically rolled back.
   *
   * @param callback - Async function receiving a transaction executor
   * @returns Promise resolving to the callback's return value
   *
   * @example
   * ```ts
   * const result = await executor.beginTransaction(async (tx) => {
   *   await tx.execute(["INSERT INTO users (name) VALUES ($1)", ["Alice"]])
   *   await tx.execute(["INSERT INTO logs (msg) VALUES ($1)", ["User created"]])
   *   return { success: true }
   * })
   * ```
   */
  async beginTransaction<T>(
    callback: (tx: ITransactionExecutor) => Promise<T>
  ): Promise<T> {
    return this._connection.begin(async (txSql) => {
      // Create transaction executor that uses the transaction-scoped SQL instance
      const txExecutor: ITransactionExecutor = {
        execute: async (query: [sql: string, params: unknown[]]): Promise<Row[]> => {
          const [sql, params] = query
          try {
            const result = await txSql.unsafe(sql, params as any[])
            return Array.isArray(result) ? result : Array.from(result as any)
          } catch (error) {
            throw new Error(
              `Transaction execute failed: ${error instanceof Error ? error.message : String(error)}\nSQL: ${sql}\nParams: ${JSON.stringify(params)}`
            )
          }
        }
      }

      // Execute the user's callback with the transaction executor
      return callback(txExecutor)
    })
  }

  /**
   * Gracefully close the connection pool.
   *
   * Should be called when shutting down the application to ensure
   * all connections are properly released.
   *
   * @example
   * ```ts
   * process.on('SIGTERM', async () => {
   *   await executor.close()
   *   process.exit(0)
   * })
   * ```
   */
  async close(): Promise<void> {
    // Bun.sql uses AsyncDisposable - call the dispose method
    await (this._connection as any)[Symbol.asyncDispose]?.()
  }
}
