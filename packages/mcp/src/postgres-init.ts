/**
 * MCP Server Postgres Initialization
 *
 * Manages singleton PostgreSQL connection pool and backend registry for the MCP server.
 * Initializes from DATABASE_URL environment variable at server startup.
 *
 * Usage:
 * ```ts
 * // At server startup
 * initializePostgresBackend()
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
// Server-only executor - import directly to avoid browser bundle issues
import {
  BunPostgresExecutor,
  type BunPostgresExecutorOptions,
} from "@shogo/state-api/query/execution/bun-postgres"

// ============================================================================
// Singleton State
// ============================================================================

/**
 * Singleton PostgreSQL executor instance.
 * Created from DATABASE_URL at server startup.
 */
let postgresExecutor: BunPostgresExecutor | null = null

/**
 * Singleton backend registry.
 * Always includes memory backend, optionally includes postgres backend.
 */
let globalRegistry: IBackendRegistry | null = null

/**
 * Track whether postgres was successfully initialized.
 */
let postgresInitialized = false

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
 * if (initializePostgresBackend()) {
 *   console.log('PostgreSQL backend available')
 * } else {
 *   console.log('Running with memory backend only')
 * }
 * ```
 */
export function initializePostgresBackend(): boolean {
  // Already initialized
  if (postgresInitialized && postgresExecutor) {
    return true
  }

  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    console.warn(
      "[postgres-init] DATABASE_URL not set - PostgreSQL backend unavailable. " +
      "Domain schemas will use memory backend only."
    )
    // Ensure registry exists even without postgres
    ensureRegistry()
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

    postgresInitialized = true
    console.log("[postgres-init] PostgreSQL backend initialized successfully")

    return true
  } catch (error) {
    console.error(
      "[postgres-init] Failed to initialize PostgreSQL backend:",
      error instanceof Error ? error.message : String(error)
    )
    // Ensure registry exists for memory-only fallback
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
 * Gracefully shutdown the PostgreSQL connection pool.
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
  globalRegistry = null
  postgresInitialized = false
}
