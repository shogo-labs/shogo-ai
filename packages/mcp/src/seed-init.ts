/**
 * Seed Data Initialization
 *
 * Initializes seed data (Shogo organization, Platform project) at MCP server startup.
 * Loads studio-core schema, creates runtime store, and calls bootstrapStudioCore().
 *
 * Usage:
 * ```ts
 * // At server startup, after DDL initialization
 * await initializeSeedData(join(import.meta.dir, "../../../.schemas"))
 * ```
 *
 * @module mcp/seed-init
 */

import {
  loadSchema,
  domain,
  bootstrapStudioCore,
  FileSystemPersistence,
} from "@shogo/state-api"
import {
  isPostgresAvailable,
  isSqliteAvailable,
  getGlobalBackendRegistry,
} from "./postgres-init"

// ============================================================================
// Main Function
// ============================================================================

/**
 * Initialize seed data for studio-core domain.
 *
 * Loads the studio-core schema, creates a runtime store, loads existing data,
 * and calls bootstrapStudioCore() to create Shogo organization and Platform project.
 *
 * @param schemasDir - Path to the .schemas directory
 *
 * @remarks
 * - Requires SQL backend to be initialized first (postgres or sqlite)
 * - Uses deterministic IDs for idempotent seed creation
 * - Logs result clearly - 'Seed data created' vs 'Seed data already exists'
 * - Handles errors gracefully - logs error but does not crash server startup
 *
 * @example
 * ```ts
 * await initializePostgresBackend()
 * await initializeDomainSchemas(schemasPath)
 * await initializeSeedData(schemasPath)
 * ```
 */
export async function initializeSeedData(schemasDir: string): Promise<void> {
  // 1. Check if SQL backend is available
  if (!isPostgresAvailable() && !isSqliteAvailable()) {
    console.log("[seed-init] No SQL backend available - skipping seed initialization")
    return
  }

  try {
    // 2. Load studio-core schema from disk
    const { enhanced } = await loadSchema("studio-core", schemasDir)

    // 3. Create domain factory from enhanced schema
    const d = domain({
      name: "studio-core",
      from: enhanced,
    })

    // 4. Create runtime store with backend registry
    const store = d.createStore({
      services: {
        persistence: new FileSystemPersistence(),
        backendRegistry: getGlobalBackendRegistry(),
      },
      context: {
        schemaName: "studio-core",
        location: schemasDir,
      },
    })

    // 5. Load existing data from backend before bootstrap check
    await store.loadAllFromBackend()

    // 6. Call bootstrapStudioCore - it handles idempotent check-before-create
    const result = bootstrapStudioCore(store, "system")

    // 7. Log result clearly
    if (result.alreadyBootstrapped) {
      console.log("[seed-init] Seed data already exists - skipping creation")
    } else {
      console.log(
        `[seed-init] Seed data created - organization '${result.organization.name}', project '${result.project.name}'`
      )
    }
  } catch (error) {
    // 8. Handle errors gracefully - log but don't crash
    console.warn(
      `[seed-init] Failed to initialize seed data: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
