// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
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
  `projects-pg-rw.${process.env.SYSTEM_NAMESPACE || "shogo-system"}.svc.cluster.local`

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

/**
 * The admin URL with a database the superuser can actually connect to.
 *
 * CNPG's `<cluster>-superuser` Secret (what the overlays mount as
 * PROJECTS_DB_ADMIN_URL) ends its `uri` in `/*` — "any database" — and pg reads
 * that as a database literally named `*`, so every provision failed with
 * `database "*" does not exist`. CREATE DATABASE / CREATE ROLE only need the
 * maintenance database, so a wildcard or missing name means `postgres`.
 */
export function adminConnectionString(url: string): string {
  try {
    const parsed = new URL(url)
    const db = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    if (db === '' || db === '*') {
      parsed.pathname = '/postgres'
      return parsed.toString()
    }
    return url
  } catch {
    return url
  }
}

function getAdminPool(): InstanceType<typeof Pool> {
  if (!PROJECTS_DB_ADMIN_URL) {
    throw new Error("PROJECTS_DB_ADMIN_URL is not configured. Cannot connect to projects database.")
  }
  if (!adminPool) {
    adminPool = new Pool({
      connectionString: adminConnectionString(PROJECTS_DB_ADMIN_URL),
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
  opts: { secretName?: string; namespace?: string } = {}
): Promise<void> {
  const api = getK8sCoreApi()
  const namespace = opts.namespace ?? PROJECT_NAMESPACE
  const secretName = opts.secretName ?? dbSecretName(projectId)

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
  opts: { secretName?: string; namespace?: string } = {}
): Promise<{ connectionUrl: string; username: string; password: string } | null> {
  const api = getK8sCoreApi()
  const namespace = opts.namespace ?? PROJECT_NAMESPACE
  const secretName = opts.secretName ?? dbSecretName(projectId)

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
  opts: { secretName?: string; namespace?: string } = {}
): Promise<void> {
  const api = getK8sCoreApi()
  const namespace = opts.namespace ?? PROJECT_NAMESPACE
  const secretName = opts.secretName ?? dbSecretName(projectId)

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Convert a project UUID to a valid PostgreSQL database name.
 * PostgreSQL identifiers: max 63 chars, alphanumeric + underscore.
 * Validates that projectId is a well-formed UUID to prevent SQL injection
 * in dynamic identifier interpolation.
 */
export function projectIdToDbName(projectId: string): string {
  if (!UUID_RE.test(projectId)) {
    throw new Error(`Invalid project ID format: expected UUID, got "${projectId.slice(0, 40)}"`)
  }
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
export interface ProvisionDatabaseOptions {
  forcePasswordReset?: boolean
  /**
   * Database (and role) name. Defaults to the project-scoped name; published
   * environments pass one database per environment (SHO-308 §1).
   */
  databaseName?: string
  /** The K8s Secret that carries the credentials. */
  secretName?: string
  /**
   * Write the credentials Secret. Default true — the pod reads its
   * DATABASE_URL from it. A published environment passes false until its
   * Postgres schema has been applied, because the Secret is what moves the pod
   * off SQLite: writing it early would boot the app against an empty database.
   */
  writeSecret?: boolean
  /**
   * When the database already exists but no stored credentials can be found,
   * set a fresh password instead of returning a password-less URL. Only safe
   * for a role whose password lives nowhere but that Secret — a published
   * environment's (SHO-308). A legacy project database may still be reached
   * with a password held in a running pod's env, so the default stays false.
   */
  rotateWhenCredentialsUnknown?: boolean
}

export async function provisionDatabase(
  projectId: string,
  options: ProvisionDatabaseOptions = {}
): Promise<ProjectDatabase> {
  const pool = getAdminPool()
  const dbName = options.databaseName ?? projectIdToDbName(projectId)
  const secretName = options.secretName ?? dbSecretName(projectId)
  const writeSecret = options.writeSecret ?? true
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
            if (writeSecret) {
              await storeCredentialsSecret(projectId, connectionUrl, username, password, { secretName })
            }
          } catch (secretErr: any) {
            console.error(`[DatabaseService] Failed to update K8s Secret after password reset:`, secretErr.message)
            // Password was already changed in PG — log but don't fail
          }

          return { databaseName: dbName, username, password, connectionUrl, host, port }
        }

        // Try to read existing credentials from K8s Secret. Reading is harmless
        // even when this call must not write one: `writeSecret` only controls
        // whether a pod is pointed at the database.
        let secretReadFailed = false
        try {
          const stored = await readCredentialsSecret(projectId, { secretName })
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
          secretReadFailed = true
          console.warn(
            `[DatabaseService] Could not read K8s Secret for "${dbName}":`,
            secretErr.message
          )
        }

        // Only when the Secret is known to be absent: a failed read may hide a
        // Secret a live pod is using, and rotating would cut that pod off.
        if (options.rotateWhenCredentialsUnknown && !secretReadFailed) {
          // A published environment's database is created before its Secret is
          // written (the Secret is what moves the pod off SQLite), so a publish
          // that failed in between leaves a role whose password nobody holds.
          // Nothing can be using it, so give it a new one.
          const password = generatePassword()
          console.warn(
            `[DatabaseService] No stored credentials for existing database "${dbName}"; setting a new password`
          )
          await client.query(`ALTER USER "${username}" WITH PASSWORD '${password}'`)
          const connectionUrl = `postgres://${username}:${password}@${host}:${port}/${dbName}`
          if (writeSecret) {
            await storeCredentialsSecret(projectId, connectionUrl, username, password, { secretName })
          }
          return { databaseName: dbName, username, password, connectionUrl, host, port }
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
          if (writeSecret) {
            await storeCredentialsSecret(projectId, connectionUrl, username, password, { secretName })
          }
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
  options: { force?: boolean; databaseName?: string; secretName?: string } = {}
): Promise<void> {
  const pool = getAdminPool()
  const dbName = options.databaseName ?? projectIdToDbName(projectId)
  const secretName = options.secretName ?? dbSecretName(projectId)
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
    await deleteCredentialsSecret(projectId, { secretName })
  } catch (err: any) {
    console.warn(
      `[DatabaseService] Failed to delete credentials Secret for "${dbName}":`,
      err.message
    )
  }
}

/** Database identifiers this service will build SQL for. */
const SAFE_DB_NAME = /^[a-z][a-z0-9_]{0,62}$/

/**
 * Copy a database for a rehearsal (SHO-308 §7).
 *
 * `CREATE DATABASE … TEMPLATE` is Postgres's own copy: it reproduces the tables,
 * indexes and rows from the source without a dump round-trip, so a rehearsal
 * measures a real load against the environment's real schema — and because the
 * copy is a different database, the measured load never touches live rows.
 *
 * Postgres refuses to use a template that has other sessions attached, so this
 * reports `template_busy` with that cause rather than a bare driver error: the
 * caller's answer is to stop the warm pod (or the metal VM) and retry, not to
 * fix the copy.
 */
export async function cloneDatabase(
  sourceName: string,
  targetName: string,
): Promise<ProjectDatabase> {
  for (const name of [sourceName, targetName]) {
    if (!SAFE_DB_NAME.test(name)) {
      throw new Error(`Refusing to clone to/from unsafe database name "${name}"`)
    }
  }
  const pool = getAdminPool()
  const client = await pool.connect()
  try {
    const exists = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [targetName])
    if (exists.rows.length > 0) {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [targetName],
      )
      await client.query(`DROP DATABASE IF EXISTS "${targetName}"`)
    }
    if (!(await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [targetName])).rows.length) {
      // No password: the copy is only ever reached by this script, over the
      // primary, and it is dropped when the rehearsal ends.
      await client.query(`CREATE USER "${targetName}"`)
    }
    try {
      await client.query(`CREATE DATABASE "${targetName}" OWNER "${targetName}" TEMPLATE "${sourceName}"`)
    } catch (err: any) {
      if (err?.code === '55006') {
        throw new Error(
          `template_busy: "${sourceName}" still has open sessions, so Postgres cannot copy it. ` +
            `Stop the environment's pod (or the metal VM) and re-run the rehearsal.`,
        )
      }
      throw err
    }
    const connectionUrl = `postgres://${targetName}@${PROJECTS_DB_HOST}:${PROJECTS_DB_PORT}/${targetName}`
    return {
      databaseName: targetName,
      username: targetName,
      password: '',
      connectionUrl,
      host: PROJECTS_DB_HOST,
      port: parseInt(PROJECTS_DB_PORT, 10),
    }
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
 * Get the PgBouncer pooler host for the projects cluster, or null when this
 * deployment has no pooler.
 *
 * Published apps connect through the pooler (SHO-308 §1): a published
 * environment can run several replicas, and each Prisma client holds a handful
 * of connections, so the pooler — not the primary — owns the fan-out.
 *
 * There is deliberately no default hostname. A guessed Service name resolves to
 * nothing, and the failure would surface as an unresolvable DATABASE_URL inside
 * a published pod rather than as a publish-time refusal — the same trap
 * PROJECTS_DB_ADMIN_URL already avoids. No Pooler CR is deployed for
 * `projects-pg` yet, so callers must refuse with `database_unavailable` until
 * PROJECTS_DB_POOLER_HOST is set.
 */
export function getProjectsDbPoolerHost(): string | null {
  const host = process.env.PROJECTS_DB_POOLER_HOST?.trim()
  return host ? host : null
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
