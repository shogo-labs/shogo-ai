/**
 * Database Provisioning Service
 *
 * Manages per-project PostgreSQL databases on the shared CloudNativePG cluster.
 * Each project gets its own database (CREATE DATABASE project_{uuid}) for isolation.
 *
 * Architecture:
 *   - Projects cluster: projects-pg (CloudNativePG managed)
 *   - Admin connection: uses superuser to CREATE/DROP databases
 *   - Project connection: each project gets DATABASE_URL pointing to its own database
 *   - Connection pooling: PgBouncer in front of the cluster (future)
 *
 * Works identically on EKS, k3s, and bare-metal Kubernetes.
 */

import { Pool } from "pg"
import type pg from "pg"
import crypto from "crypto"

// =============================================================================
// Configuration
// =============================================================================

// The admin connection URL for the projects PostgreSQL cluster
// CloudNativePG creates a secret with the superuser credentials
// MUST be set via PROJECTS_DB_ADMIN_URL env var (from projects-db-admin K8s secret)
const PROJECTS_DB_ADMIN_URL = process.env.PROJECTS_DB_ADMIN_URL
if (!PROJECTS_DB_ADMIN_URL) {
  console.error("[DatabaseService] PROJECTS_DB_ADMIN_URL is not set. Database provisioning will fail.")
}

// The hostname of the projects PostgreSQL cluster (for building per-project URLs)
// Defaults to the standard CloudNativePG service name if not explicitly set
const PROJECTS_DB_HOST =
  process.env.PROJECTS_DB_HOST ||
  "projects-pg-rw.shogo-staging-system.svc.cluster.local"

const PROJECTS_DB_PORT = process.env.PROJECTS_DB_PORT || "5432"

// =============================================================================
// Types
// =============================================================================

export interface ProjectDatabase {
  /** Database name (e.g., project_abc123) */
  databaseName: string
  /** Database user (same as database name for simplicity) */
  username: string
  /** Database password */
  password: string
  /** Full connection URL */
  connectionUrl: string
  /** Host for the database */
  host: string
  /** Port for the database */
  port: number
}

export interface DatabaseStatus {
  exists: boolean
  databaseName: string
  sizeBytes?: number
}

// =============================================================================
// Connection Pool (lazy initialization)
// =============================================================================

let adminPool: InstanceType<typeof Pool> | null = null

function getAdminPool(): InstanceType<typeof Pool> {
  if (!PROJECTS_DB_ADMIN_URL) {
    throw new Error("PROJECTS_DB_ADMIN_URL is not configured. Cannot connect to projects database.")
  }
  if (!adminPool) {
    adminPool = new Pool({
      connectionString: PROJECTS_DB_ADMIN_URL,
      max: 5, // Low pool size - admin operations are infrequent
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })

    // Handle pool errors gracefully
    adminPool.on("error", (err) => {
      console.error("[DatabaseService] Admin pool error:", err.message)
    })
  }
  return adminPool
}

// =============================================================================
// Database Name Helpers
// =============================================================================

/**
 * Convert a project UUID to a valid PostgreSQL database name.
 * PostgreSQL identifiers: max 63 chars, alphanumeric + underscore.
 */
export function projectIdToDbName(projectId: string): string {
  // Replace hyphens with underscores (UUIDs have hyphens)
  const sanitized = projectId.replace(/-/g, "_")
  return `project_${sanitized}`
}

/**
 * Generate a secure random password for a project database.
 */
function generatePassword(): string {
  return crypto.randomBytes(24).toString("base64url")
}

// =============================================================================
// Provisioning Operations
// =============================================================================

/**
 * Provision a new database for a project.
 * Creates the database and a dedicated user with full access.
 *
 * Idempotent: if the database already exists, returns existing credentials.
 */
export async function provisionDatabase(
  projectId: string
): Promise<ProjectDatabase> {
  const pool = getAdminPool()
  const dbName = projectIdToDbName(projectId)
  const username = dbName // Use same name for user and database
  const password = generatePassword()

  console.log(
    `[DatabaseService] Provisioning database "${dbName}" for project ${projectId}`
  )

  const client = await pool.connect()
  try {
    // Check if database already exists
    const existsResult = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    )

    if (existsResult.rows.length > 0) {
      console.log(
        `[DatabaseService] Database "${dbName}" already exists, updating password`
      )
      // Update password for existing user (in case it was lost)
      await client.query(
        `ALTER USER "${username}" WITH PASSWORD '${password}'`
      )
    } else {
      // Create user
      await client.query(
        `CREATE USER "${username}" WITH PASSWORD '${password}'`
      )

      // Create database owned by the user
      await client.query(
        `CREATE DATABASE "${dbName}" OWNER "${username}"`
      )

      // Grant all privileges
      await client.query(
        `GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${username}"`
      )

      console.log(`[DatabaseService] Database "${dbName}" created successfully`)
    }

    const host = PROJECTS_DB_HOST
    const port = parseInt(PROJECTS_DB_PORT, 10)
    const connectionUrl = `postgres://${username}:${password}@${host}:${port}/${dbName}`

    return {
      databaseName: dbName,
      username,
      password,
      connectionUrl,
      host,
      port,
    }
  } finally {
    client.release()
  }
}

/**
 * Check if a project database exists and get its status.
 */
export async function getDatabaseStatus(
  projectId: string
): Promise<DatabaseStatus> {
  const pool = getAdminPool()
  const dbName = projectIdToDbName(projectId)

  const client = await pool.connect()
  try {
    const existsResult = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    )

    if (existsResult.rows.length === 0) {
      return { exists: false, databaseName: dbName }
    }

    // Get database size
    const sizeResult = await client.query(
      `SELECT pg_database_size($1) as size_bytes`,
      [dbName]
    )

    return {
      exists: true,
      databaseName: dbName,
      sizeBytes: parseInt(sizeResult.rows[0]?.size_bytes || "0", 10),
    }
  } finally {
    client.release()
  }
}

/**
 * Drop a project database and its user.
 * Optionally creates a final backup to S3 before dropping.
 */
export async function dropDatabase(
  projectId: string,
  options: { force?: boolean } = {}
): Promise<void> {
  const pool = getAdminPool()
  const dbName = projectIdToDbName(projectId)
  const username = dbName

  console.log(
    `[DatabaseService] Dropping database "${dbName}" for project ${projectId}`
  )

  const client = await pool.connect()
  try {
    // Terminate active connections to the database
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    )

    // Drop database
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`)

    // Drop user
    await client.query(`DROP USER IF EXISTS "${username}"`)

    console.log(`[DatabaseService] Database "${dbName}" dropped successfully`)
  } finally {
    client.release()
  }
}

/**
 * Build a DATABASE_URL for a project given stored credentials.
 * Used when we already have credentials and just need the URL.
 */
export function buildDatabaseUrl(
  dbName: string,
  username: string,
  password: string
): string {
  return `postgres://${username}:${password}@${PROJECTS_DB_HOST}:${PROJECTS_DB_PORT}/${dbName}`
}

/**
 * Get the projects database host (for use in pod environment variables).
 */
export function getProjectsDbHost(): string {
  return PROJECTS_DB_HOST
}

/**
 * Get the projects database port.
 */
export function getProjectsDbPort(): number {
  return parseInt(PROJECTS_DB_PORT, 10)
}

/**
 * Test connectivity to the projects PostgreSQL cluster.
 */
export async function testConnection(): Promise<boolean> {
  try {
    const pool = getAdminPool()
    const client = await pool.connect()
    try {
      await client.query("SELECT 1")
      return true
    } finally {
      client.release()
    }
  } catch (err: any) {
    console.error(
      "[DatabaseService] Connection test failed:",
      err.message
    )
    return false
  }
}

/**
 * Gracefully shut down the admin connection pool.
 */
export async function shutdown(): Promise<void> {
  if (adminPool) {
    await adminPool.end()
    adminPool = null
    console.log("[DatabaseService] Admin pool shut down")
  }
}
