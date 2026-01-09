/**
 * MCP Server Postgres Initialization
 *
 * Manages singleton PostgreSQL connection pool and backend registry for the MCP server.
 * Initializes from DATABASE_URL environment variable at server startup.
 *
 * Usage:
 * ```ts
 * // At server startup
 * await initializePostgresBackend()
 *
 * // In tools that need backend registry
 * const registry = getGlobalBackendRegistry()
 * const executor = registry.resolve(schemaName, modelName, collection)
 * ```
 *
 * @module mcp/postgres-init
 */

import {
  createBackendRegistry,
  type IBackendRegistry,
  SqlBackend,
  MemoryBackend,
} from "@shogo/state-api"
// Server-only executors - import directly to avoid browser bundle issues
import {
  BunPostgresExecutor,
  type BunPostgresExecutorOptions,
} from "@shogo/state-api/query/execution/bun-postgres"
import { BunSqlExecutor } from "@shogo/state-api/query/execution/bun-sql"
import { Database } from "bun:sqlite"
import { mkdirSync, existsSync } from "node:fs"
import { dirname } from "node:path"

// ============================================================================
// Singleton State
// ============================================================================

/**
 * Singleton PostgreSQL executor instance.
 * Created from DATABASE_URL at server startup.
 */
let postgresExecutor: BunPostgresExecutor | null = null

/**
 * Singleton SQLite executor instance.
 * Created when DATABASE_URL is not set (local development fallback).
 */
let sqliteExecutor: BunSqlExecutor | null = null

/**
 * Singleton SQLite database instance.
 * Stored separately for cleanup on shutdown.
 */
let sqliteDatabase: Database | null = null

/**
 * Singleton backend registry.
 * Always includes memory backend, optionally includes postgres or sqlite backend.
 */
let globalRegistry: IBackendRegistry | null = null

/**
 * Track whether postgres was successfully initialized.
 */
let postgresInitialized = false

/**
 * Track whether sqlite was successfully initialized.
 */
let sqliteInitialized = false

// ============================================================================
// Initialization Functions
// ============================================================================

/**
 * Initialize PostgreSQL backend from DATABASE_URL environment variable.
 *
 * Should be called at MCP server startup. Safe to call multiple times -
 * will only initialize once.
 *
 * @returns true if postgres was initialized, false if DATABASE_URL not set
 *
 * @example
 * ```ts
 * // At server startup
 * if (await initializePostgresBackend()) {
 *   console.log('PostgreSQL backend available')
 * } else {
 *   console.log('Running with memory backend only')
 * }
 * ```
 */
export async function initializePostgresBackend(): Promise<boolean> {
  // Already initialized
  if (postgresInitialized && postgresExecutor) {
    return true
  }

  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    // No PostgreSQL - fall back to SQLite
    console.log(
      "[postgres-init] DATABASE_URL not set - falling back to SQLite backend."
    )
    await initializeSqliteBackend()
    return false
  }

  try {
    // Detect Supabase and configure TLS accordingly
    const isSupabase = databaseUrl.includes("supabase.co") || databaseUrl.includes("supabase.com")

    const options: BunPostgresExecutorOptions = {
      max: 10, // Connection pool size
      tls: isSupabase, // Enable TLS for Supabase
      idleTimeout: 30,
      connectionTimeout: 30,
    }

    // Create executor
    postgresExecutor = new BunPostgresExecutor(databaseUrl, options)

    // Create SqlBackend with executor
    const sqlBackend = new SqlBackend({
      dialect: "pg",
      executor: postgresExecutor,
    })

    // Ensure registry exists and register postgres backend
    ensureRegistry()
    globalRegistry!.register("postgres", sqlBackend)

    // Set postgres as default so schemas work before meta-store ingestion
    // (e.g., during seed-init when schemas haven't been loaded via schema.load yet)
    globalRegistry!.setDefault("postgres")

    postgresInitialized = true
    console.log("[postgres-init] PostgreSQL backend initialized successfully")

    return true
  } catch (error) {
    console.error(
      "[postgres-init] Failed to initialize PostgreSQL backend:",
      error instanceof Error ? error.message : String(error)
    )
    // Fall back to SQLite on PostgreSQL failure
    console.log("[postgres-init] Falling back to SQLite backend.")
    await initializeSqliteBackend()
    return false
  }
}

/**
 * Initialize SQLite backend as fallback for local development.
 *
 * Uses SQLITE_URL environment variable if set, otherwise defaults to :memory:.
 * SQLite is registered as "sqlite" and set as the default backend.
 *
 * @returns true if sqlite was initialized, false otherwise
 */
export async function initializeSqliteBackend(): Promise<boolean> {
  // Already initialized
  if (sqliteInitialized && sqliteExecutor) {
    return true
  }

  try {
    // Use SQLITE_URL env var, or default to in-memory
    const sqliteUrl = process.env.SQLITE_URL || ":memory:"

    // Parse sqlite:// URL format or use path directly
    let dbPath = sqliteUrl
    if (sqliteUrl.startsWith("sqlite://")) {
      dbPath = sqliteUrl.replace("sqlite://", "")
    }

    // Create SQLite database
    sqliteDatabase = new Database(dbPath)

    // Create executor wrapping the database
    sqliteExecutor = new BunSqlExecutor(sqliteDatabase as any)

    // Create SqlBackend with SQLite dialect
    const sqliteBackend = new SqlBackend({
      dialect: "sqlite",
      executor: sqliteExecutor,
    })

    // Ensure registry exists and register sqlite backend
    ensureRegistry()
    globalRegistry!.register("sqlite", sqliteBackend)

    // Also register as "postgres" alias so schemas with x-persistence.backend: "postgres" work
    // This enables seamless local development without changing schema files
    globalRegistry!.register("postgres", sqliteBackend)

    // Set sqlite as the default when postgres isn't available
    // This ensures schemas without x-persistence.backend still work
    globalRegistry!.setDefault("sqlite")

    sqliteInitialized = true
    const mode = dbPath === ":memory:" ? "in-memory" : `file: ${dbPath}`
    console.log(`[postgres-init] SQLite backend initialized (${mode})`)

    return true
  } catch (error) {
    console.error(
      "[postgres-init] Failed to initialize SQLite backend:",
      error instanceof Error ? error.message : String(error)
    )
    // Last resort: ensure registry exists with memory backend
    ensureRegistry()
    return false
  }
}

/**
 * Ensure the global backend registry exists.
 * Creates with memory backend as default if not yet created.
 */
function ensureRegistry(): void {
  if (!globalRegistry) {
    globalRegistry = createBackendRegistry({
      default: "memory",
      backends: {
        memory: new MemoryBackend(),
      },
    })
  }
}

// ============================================================================
// Accessor Functions
// ============================================================================

/**
 * Get the global backend registry singleton.
 *
 * Always returns a registry instance. If postgres was initialized,
 * the registry includes both 'memory' and 'postgres' backends.
 * Otherwise, only 'memory' is available.
 *
 * @returns Global IBackendRegistry instance
 *
 * @example
 * ```ts
 * const registry = getGlobalBackendRegistry()
 *
 * // Resolve backend for a schema/model
 * const executor = registry.resolve('my-schema', 'User', collection)
 * ```
 */
export function getGlobalBackendRegistry(): IBackendRegistry {
  ensureRegistry()
  return globalRegistry!
}

/**
 * Get the PostgreSQL executor instance.
 *
 * @returns BunPostgresExecutor if initialized, undefined otherwise
 *
 * @example
 * ```ts
 * const executor = getPostgresExecutor()
 * if (executor) {
 *   // Execute DDL or raw SQL
 *   await executor.executeMany(ddlStatements)
 * }
 * ```
 */
export function getPostgresExecutor(): BunPostgresExecutor | undefined {
  return postgresExecutor ?? undefined
}

/**
 * Check if PostgreSQL backend is available.
 *
 * @returns true if postgres was successfully initialized
 */
export function isPostgresAvailable(): boolean {
  return postgresInitialized && postgresExecutor !== null
}

// ============================================================================
// Shutdown Functions
// ============================================================================

/**
 * Check if SQLite backend is available.
 *
 * @returns true if sqlite was successfully initialized
 */
export function isSqliteAvailable(): boolean {
  return sqliteInitialized && sqliteExecutor !== null
}

/**
 * Gracefully shutdown database connections (PostgreSQL and/or SQLite).
 *
 * Should be called during server shutdown to ensure connections are released.
 *
 * @example
 * ```ts
 * process.on('SIGTERM', async () => {
 *   await shutdownPostgres()
 *   process.exit(0)
 * })
 * ```
 */
export async function shutdownPostgres(): Promise<void> {
  // Shutdown PostgreSQL if initialized
  if (postgresExecutor) {
    try {
      await postgresExecutor.close()
      console.log("[postgres-init] PostgreSQL connection pool closed")
    } catch (error) {
      console.error(
        "[postgres-init] Error closing PostgreSQL connection:",
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      postgresExecutor = null
      postgresInitialized = false
    }
  }

  // Shutdown SQLite if initialized
  if (sqliteDatabase) {
    try {
      sqliteDatabase.close()
      console.log("[postgres-init] SQLite database closed")
    } catch (error) {
      console.error(
        "[postgres-init] Error closing SQLite database:",
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      sqliteDatabase = null
      sqliteExecutor = null
      sqliteInitialized = false
    }
  }
}

// ============================================================================
// Testing Utilities
// ============================================================================

/**
 * Reset module state for testing purposes.
 * NOT for production use.
 *
 * @internal
 */
export function __resetForTesting(): void {
  postgresExecutor = null
  sqliteExecutor = null
  sqliteDatabase = null
  globalRegistry = null
  postgresInitialized = false
  sqliteInitialized = false
}
