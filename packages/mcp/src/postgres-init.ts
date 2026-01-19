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
  isS3Enabled,
} from "@shogo/state-api"
// Server-only module - import directly
import { S3SqliteManager } from "@shogo/state-api/persistence/s3-sqlite"
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

    // Initialize registry (creates system-migrations table for migration tracking)
    await globalRegistry!.initialize()

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

    // Initialize registry (creates system-migrations table for migration tracking)
    await globalRegistry!.initialize()

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

// ============================================================================
// Workspace-Specific Backend (S3-backed SQLite)
// ============================================================================

/**
 * Cache of workspace-specific backend registries.
 * Each workspace has its own SQLite database backed by S3.
 */
const workspaceRegistries: Map<string, IBackendRegistry> = new Map()

/**
 * Get a backend registry for a specific workspace.
 *
 * When S3 mode is enabled (SCHEMA_STORAGE=s3), each workspace gets its own
 * SQLite database that's synced to S3. This provides:
 * - Data isolation between workspaces
 * - Portable databases (stored in S3)
 * - Serverless-friendly architecture
 *
 * When S3 mode is disabled, returns the global registry (shared database).
 *
 * @param workspaceId - Unique workspace/project identifier
 * @returns Backend registry for the workspace
 *
 * @example
 * ```ts
 * const registry = await getWorkspaceBackendRegistry('project-123')
 * const executor = registry.resolve('my-schema', 'User', collection)
 * ```
 */
export async function getWorkspaceBackendRegistry(workspaceId: string): Promise<IBackendRegistry> {
  // If S3 mode is not enabled, use shared global registry
  if (!isS3Enabled()) {
    ensureRegistry()
    return globalRegistry!
  }

  // Return cached workspace registry if available
  const cached = workspaceRegistries.get(workspaceId)
  if (cached) {
    return cached
  }

  // Create new workspace-specific SQLite database
  console.log(`[postgres-init] Creating workspace-specific SQLite for '${workspaceId}'`)

  const db = await S3SqliteManager.getDatabase(workspaceId)
  const executor = new BunSqlExecutor(db as any)

  const sqliteBackend = new SqlBackend({
    dialect: "sqlite",
    executor,
  })

  // Create workspace-specific registry
  const registry = createBackendRegistry({
    default: "sqlite",
    backends: {
      memory: new MemoryBackend(),
      sqlite: sqliteBackend,
      postgres: sqliteBackend, // Alias for schema compatibility
    },
  })

  // Initialize registry (creates system-migrations table)
  await registry.initialize()

  // Cache the registry
  workspaceRegistries.set(workspaceId, registry)

  console.log(`[postgres-init] Workspace '${workspaceId}' SQLite backend ready`)
  return registry
}

/**
 * Sync a workspace's SQLite database to S3.
 * Call this after data changes to persist to S3.
 *
 * @param workspaceId - Workspace to sync
 * @param force - Sync even if database appears unchanged
 * @returns true if sync was performed
 */
export async function syncWorkspaceData(workspaceId: string, force = false): Promise<boolean> {
  if (!isS3Enabled()) {
    return false
  }

  return S3SqliteManager.sync(workspaceId, force)
}

/**
 * Mark a workspace's database as having unsaved changes.
 * Call this after any write operation.
 *
 * @param workspaceId - Workspace with changes
 */
export function markWorkspaceDirty(workspaceId: string): void {
  S3SqliteManager.markDirty(workspaceId)
}

/**
 * Close a workspace's database and sync to S3.
 * Call this when a workspace session ends.
 *
 * @param workspaceId - Workspace to close
 */
export async function closeWorkspace(workspaceId: string): Promise<void> {
  await S3SqliteManager.close(workspaceId, true)
  workspaceRegistries.delete(workspaceId)
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
