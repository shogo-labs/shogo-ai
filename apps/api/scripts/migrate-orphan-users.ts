/**
 * Migration Script: Migrate Orphan Users
 * Task: task-org-006
 *
 * One-time migration script that finds users without Member records
 * and creates personal organizations for them.
 *
 * This handles the case where:
 * - Users were created before the databaseHooks.user.create.after hook was added
 * - Users exist but have no organization membership
 *
 * Usage:
 *   bun run apps/api/scripts/migrate-orphan-users.ts
 *
 * Requirements:
 *   - DATABASE_URL environment variable must be set
 *   - Script is idempotent (safe to re-run)
 */

import { Pool } from "pg"
import { studioCoreDomain } from "@shogo/state-api/studio-core/domain"
import { BunPostgresExecutor } from "@shogo/state-api/query/execution/bun-postgres"
import { createBackendRegistry } from "@shogo/state-api/query/registry"
import { SqlBackend } from "@shogo/state-api/query/backends/sql"
import { NullPersistence } from "@shogo/state-api/persistence/null"

/**
 * User data returned from the orphaned users query
 */
interface OrphanedUser {
  id: string
  name: string | null
  email: string
}

/**
 * Creates a domain store with PostgreSQL backend
 */
async function createDomainStore(databaseUrl: string) {
  const isSupabase = databaseUrl.includes("supabase")
  const executor = new BunPostgresExecutor(databaseUrl, {
    tls: isSupabase,
    max: 5,
  })

  const registry = createBackendRegistry()
  const sqlBackend = new SqlBackend({ dialect: "pg", executor })
  registry.register("postgres", sqlBackend)
  registry.setDefault("postgres")

  return studioCoreDomain.createStore({
    services: {
      persistence: new NullPersistence(),
      backendRegistry: registry,
    },
    context: {
      schemaName: "studio-core",
    },
  })
}

/**
 * Finds and migrates users who have no Member records.
 *
 * Algorithm:
 * 1. Query Better Auth users who have no corresponding Member records
 * 2. For each orphaned user, create a personal organization via domain
 * 3. Log progress and summary
 *
 * @param pool - PostgreSQL connection pool (for user query)
 * @param store - Domain store (for creating orgs)
 * @returns Number of users migrated
 */
export async function migrateOrphanUsers(
  pool: Pool,
  store: ReturnType<typeof studioCoreDomain.createStore>
): Promise<number> {
  console.log("[migrate-orphan-users] Starting migration...")

  // Query for users without any Member records
  // Uses LEFT JOIN to find users with no membership entries
  const query = `
    SELECT u.id, u.name, u.email
    FROM better_auth."user" u
    LEFT JOIN studio_core.member m ON m.user_id = u.id
    WHERE m.id IS NULL
  `

  const result = await pool.query<OrphanedUser>(query)
  const orphanedUsers = result.rows

  if (orphanedUsers.length === 0) {
    console.log("[migrate-orphan-users] No orphaned users found. Migration complete.")
    console.log("Migrated 0 users")
    return 0
  }

  console.log(`[migrate-orphan-users] Found ${orphanedUsers.length} orphaned users`)

  let migratedCount = 0

  for (const user of orphanedUsers) {
    try {
      console.log(`[migrate-orphan-users] Creating personal org for user ${user.email}...`)

      await store.createPersonalOrganization(user.id, user.name || "User")

      migratedCount++
    } catch (error) {
      console.error(
        `[migrate-orphan-users] Failed to create org for ${user.email}:`,
        error instanceof Error ? error.message : String(error)
      )
      // Continue with other users even if one fails
    }
  }

  console.log(`[migrate-orphan-users] Migration complete.`)
  console.log(`Migrated ${migratedCount} users`)

  return migratedCount
}

/**
 * Main entry point when script is run directly
 */
async function main() {
  // Validate DATABASE_URL is set
  if (!process.env.DATABASE_URL) {
    console.error("Error: DATABASE_URL environment variable is not set")
    process.exit(1)
  }

  // Create connection pool for user query
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  })

  // Create domain store for org creation
  const store = await createDomainStore(process.env.DATABASE_URL)

  try {
    await migrateOrphanUsers(pool, store)
  } catch (error) {
    console.error("Migration failed:", error)
    process.exit(1)
  } finally {
    // Close pool connection
    await pool.end()
  }
}

// Run if executed directly (not imported as module)
// Check if this file is being run directly
const isMainModule = import.meta.path === Bun.main

if (isMainModule) {
  main()
}
