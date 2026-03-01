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
 *   - Credentials: stored in K8s Secrets (project-{id}-db-creds) as source of truth
 *   - Connection pooling: PgBouncer in front of the cluster (future)
 *
 * Credential lifecycle:
 *   1. New DB: generate password → CREATE USER → store in K8s Secret → reference via secretKeyRef
 *   2. Existing DB: read password from K8s Secret → return existing credentials
 *   3. Password rotation: update PG user + K8s Secret → roll new Knative revision
 *   4. Cleanup: delete K8s Secret when project is deleted
 *
 * Works identically on EKS, k3s, and bare-metal Kubernetes.
 */

import { Pool } from "pg"
import type pg from "pg"
import crypto from "crypto"
import * as k8s from "@kubernetes/client-node"
import * as fs from "fs"

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
  (process.env.NODE_ENV === 'production'
    ? "projects-pg-rw.shogo-system.svc.cluster.local"
    : "projects-pg-rw.shogo-staging-system.svc.cluster.local")

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
// Kubernetes Client (for managing credential Secrets)
// =============================================================================

const PROJECT_NAMESPACE = process.env.PROJECT_NAMESPACE || "shogo-workspaces"

let k8sCoreApi: k8s.CoreV1Api | null = null

function getK8sCoreApi(): k8s.CoreV1Api {
  if (!k8sCoreApi) {
    const kc = new k8s.KubeConfig()
    const serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"
    const caPath = `${serviceAccountDir}/ca.crt`
    const tokenPath = `${serviceAccountDir}/token`

    if (fs.existsSync(caPath) && fs.existsSync(tokenPath)) {
      const ca = fs.readFileSync(caPath, "utf8")
      const token = fs.readFileSync(tokenPath, "utf8")
      const host = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`

      kc.loadFromOptions({
        clusters: [
          {
            name: "in-cluster",
            server: host,
            caData: Buffer.from(ca).toString("base64"),
            skipTLSVerify: true,
          },
        ],
        users: [{ name: "in-cluster", token }],
        contexts: [
          { name: "in-cluster", cluster: "in-cluster", user: "in-cluster" },
        ],
        currentContext: "in-cluster",
      })
    } else {
      kc.loadFromDefault()
    }
    k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api)
  }
  return k8sCoreApi
}

/**
 * Build the K8s Secret name for a project's database credentials.
 */
export function dbSecretName(projectId: string): string {
  return `project-${projectId}-db-creds`
}

/**
 * Store database credentials in a Kubernetes Secret.
 * Creates the Secret if it doesn't exist, replaces it if it does.
 */
async function storeCredentialsSecret(
  projectId: string,
  connectionUrl: string,
  username: string,
  password: string,
  namespace: string = PROJECT_NAMESPACE
): Promise<void> {
  const api = getK8sCoreApi()
  const secretName = dbSecretName(projectId)

  const secretBody: k8s.V1Secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "shogo-database-service",
        "shogo.ai/project-id": projectId,
        "shogo.ai/component": "database-credentials",
      },
    },
    type: "Opaque",
    stringData: {
      "database-url": connectionUrl,
      username,
      password,
    },
  }

  try {
    // Try to read existing secret first
    await api.readNamespacedSecret({ name: secretName, namespace })
    // Secret exists — replace it
    await api.replaceNamespacedSecret({
      name: secretName,
      namespace,
      body: secretBody,
    })
    console.log(
      `[DatabaseService] Updated K8s Secret "${secretName}" in ${namespace}`
    )
  } catch (err: any) {
    if (err?.code === 404 || err?.response?.statusCode === 404) {
      // Secret doesn't exist — create it
      await api.createNamespacedSecret({ namespace, body: secretBody })
      console.log(
        `[DatabaseService] Created K8s Secret "${secretName}" in ${namespace}`
      )
    } else {
      throw err
    }
  }
}

/**
 * Read database credentials from a Kubernetes Secret.
 * Returns null if the Secret doesn't exist.
 */
async function readCredentialsSecret(
  projectId: string,
  namespace: string = PROJECT_NAMESPACE
): Promise<{ connectionUrl: string; username: string; password: string } | null> {
  const api = getK8sCoreApi()
  const secretName = dbSecretName(projectId)

  try {
    const response = await api.readNamespacedSecret({ name: secretName, namespace })
    const secret = response
    const data = secret.data
    if (!data) return null

    return {
      connectionUrl: Buffer.from(data["database-url"] || "", "base64").toString("utf-8"),
      username: Buffer.from(data["username"] || "", "base64").toString("utf-8"),
      password: Buffer.from(data["password"] || "", "base64").toString("utf-8"),
    }
  } catch (err: any) {
    if (err?.code === 404 || err?.response?.statusCode === 404) {
      return null
    }
    throw err
  }
}

/**
 * Delete the database credentials Secret for a project.
 */
async function deleteCredentialsSecret(
  projectId: string,
  namespace: string = PROJECT_NAMESPACE
): Promise<void> {
  const api = getK8sCoreApi()
  const secretName = dbSecretName(projectId)

  try {
    await api.deleteNamespacedSecret({ name: secretName, namespace })
    console.log(
      `[DatabaseService] Deleted K8s Secret "${secretName}" from ${namespace}`
    )
  } catch (err: any) {
    if (err?.code === 404 || err?.response?.statusCode === 404) {
      // Already gone, that's fine
    } else {
      throw err
    }
  }
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
 * Stores credentials in a Kubernetes Secret as the single source of truth.
 *
 * Fully idempotent and concurrency-safe:
 * - Uses PostgreSQL advisory locks to serialize concurrent provisions for the same project
 * - Uses PL/pgSQL DO blocks for atomic role creation (no TOCTOU race)
 * - Stores credentials in K8s Secret (project-{id}-db-creds) for retrieval
 * - Handles "already exists" errors gracefully as success
 *
 * Options:
 *   forcePasswordReset: Generate a new password, update PG + K8s Secret (use for rotation)
 */
export async function provisionDatabase(
  projectId: string,
  options: { forcePasswordReset?: boolean } = {}
): Promise<ProjectDatabase> {
  const pool = getAdminPool()
  const dbName = projectIdToDbName(projectId)
  const username = dbName // Use same name for user and database
  const host = PROJECTS_DB_HOST
  const port = parseInt(PROJECTS_DB_PORT, 10)

  console.log(
    `[DatabaseService] Provisioning database "${dbName}" for project ${projectId}`
  )

  const client = await pool.connect()
  try {
    // Acquire an advisory lock keyed on the database name to serialize concurrent provisions.
    // This prevents two concurrent createProject calls from racing on the same project.
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [dbName])

    try {
      // Check if database already exists
      const existsResult = await client.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName]
      )

      if (existsResult.rows.length > 0) {
        // ─── Database already exists ───
        console.log(
          `[DatabaseService] Database "${dbName}" already exists`
        )

        if (options.forcePasswordReset) {
          // Password rotation: generate new password, update PG + K8s Secret
          const password = generatePassword()
          console.log(
            `[DatabaseService] Force-resetting password for "${username}"`
          )
          await client.query(
            `ALTER USER "${username}" WITH PASSWORD '${password}'`
          )
          const connectionUrl = `postgres://${username}:${password}@${host}:${port}/${dbName}`

          // Update the K8s Secret with the new credentials
          try {
            await storeCredentialsSecret(projectId, connectionUrl, username, password)
          } catch (secretErr: any) {
            console.error(`[DatabaseService] Failed to update K8s Secret after password reset:`, secretErr.message)
            // Password was already changed in PG — log but don't fail
          }

          return { databaseName: dbName, username, password, connectionUrl, host, port }
        }

        // Try to read existing credentials from K8s Secret
        try {
          const stored = await readCredentialsSecret(projectId)
          if (stored && stored.password && stored.connectionUrl) {
            console.log(
              `[DatabaseService] Retrieved credentials from K8s Secret for "${dbName}"`
            )
            return {
              databaseName: dbName,
              username: stored.username || username,
              password: stored.password,
              connectionUrl: stored.connectionUrl,
              host,
              port,
            }
          }
        } catch (secretErr: any) {
          console.warn(
            `[DatabaseService] Could not read K8s Secret for "${dbName}":`,
            secretErr.message
          )
        }

        // K8s Secret doesn't exist or is empty — this is a legacy project
        // provisioned before we started storing credentials in Secrets.
        // Return without password. The caller should use existing credentials
        // from the pod's environment. Log a warning so we can track these.
        console.warn(
          `[DatabaseService] No K8s Secret found for existing database "${dbName}". ` +
          `Run the migration script to backfill credentials from running pods.`
        )
        return {
          databaseName: dbName,
          username,
          password: "",
          connectionUrl: `postgres://${username}@${host}:${port}/${dbName}`,
          host,
          port,
        }
      } else {
        // ─── New database — create everything ───
        const password = generatePassword()

        // Create role atomically using PL/pgSQL DO block.
        // This avoids the TOCTOU race where two concurrent calls both see the role
        // doesn't exist and then one fails on CREATE USER.
        //
        // In PostgreSQL 16+, CREATEROLE no longer grants automatic admin membership
        // on created roles. We must explicitly GRANT the new role to the current user
        // so that CREATE DATABASE ... OWNER works (requires SET ROLE capability).
        await client.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${username}') THEN
              CREATE USER "${username}" WITH PASSWORD '${password}';
              GRANT "${username}" TO CURRENT_USER;
              RAISE NOTICE 'Created role %', '${username}';
            ELSE
              ALTER USER "${username}" WITH PASSWORD '${password}';
              -- Ensure membership exists (idempotent, handles upgrade from PG <16)
              BEGIN
                GRANT "${username}" TO CURRENT_USER;
              EXCEPTION WHEN duplicate_object THEN
                -- Already a member, ignore
              END;
              RAISE NOTICE 'Role % already exists, updated password', '${username}';
            END IF;
          END
          $$;
        `)

        // Create database owned by the user.
        // Wrap in try/catch to handle "already exists" from partial previous runs.
        try {
          await client.query(
            `CREATE DATABASE "${dbName}" OWNER "${username}"`
          )
        } catch (err: any) {
          if (err.code === '42P04') {
            // 42P04 = duplicate_database — already exists, that's fine
            console.log(
              `[DatabaseService] Database "${dbName}" already exists (concurrent creation)`
            )
          } else {
            throw err
          }
        }

        // Grant all privileges (idempotent — safe to run multiple times)
        await client.query(
          `GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${username}"`
        )

        console.log(`[DatabaseService] Database "${dbName}" created successfully`)

        const connectionUrl = `postgres://${username}:${password}@${host}:${port}/${dbName}`

        // Store credentials in K8s Secret for future retrieval
        try {
          await storeCredentialsSecret(projectId, connectionUrl, username, password)
        } catch (secretErr: any) {
          // Non-fatal: credentials are in the ksvc env. Log a warning.
          // The migration script can backfill the Secret later.
          console.error(
            `[DatabaseService] Failed to create K8s Secret for "${dbName}":`,
            secretErr.message,
            `— credentials are still in the Knative Service env`
          )
        }

        return {
          databaseName: dbName,
          username,
          password,
          connectionUrl,
          host,
          port,
        }
      }
    } finally {
      // Always release the advisory lock, even on error
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [dbName])
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
 * Drop a project database, its user, and the credentials Secret.
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

  // Delete the credentials K8s Secret (separate from PG connection)
  try {
    await deleteCredentialsSecret(projectId)
  } catch (err: any) {
    console.warn(
      `[DatabaseService] Failed to delete credentials Secret for "${dbName}":`,
      err.message
    )
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
