/**
 * Seed Data Initialization
 *
 * Initializes seed data (Shogo organization, Platform project) at MCP server startup.
 * Uses the isomorphic pattern: .query() for idempotency, .insertOne() for writes.
 *
 * Usage:
 * ```ts
 * // At server startup, after DDL initialization
 * await initializeSeedData(join(import.meta.dir, "../../../.schemas"))
 * ```
 *
 * @module mcp/seed-init
 */

import { loadSchema, domain, SHOGO_ORG_ID, PLATFORM_PROJECT_ID } from "@shogo/state-api"
import {
  isPostgresAvailable,
  isSqliteAvailable,
  getGlobalBackendRegistry,
} from "./postgres-init"

// ============================================================================
// Types
// ============================================================================

interface SeedResult {
  alreadySeeded: boolean
  created?: { orgId: string; projectId: string }
}

// ============================================================================
// Seed Function
// ============================================================================

/**
 * Seed studio-core domain with Shogo organization and Platform project.
 *
 * Uses isomorphic pattern:
 * - .query().where().first() for idempotency check
 * - .insertOne() for writes (syncs to backend)
 *
 * @param store - Runtime store with queryable/mutatable collections
 * @returns Seed result indicating whether data was created or already existed
 */
async function seedStudioCore(store: any): Promise<SeedResult> {
  // Check idempotency via .query()
  const existingOrg = await store.organizationCollection
    .query()
    .where({ id: SHOGO_ORG_ID })
    .first()

  if (existingOrg) {
    return { alreadySeeded: true }
  }

  // Insert via .insertOne() - syncs to backend
  await store.organizationCollection.insertOne({
    id: SHOGO_ORG_ID,
    name: "Shogo",
    slug: "shogo",
    description: "Shogo AI Platform",
    createdAt: Date.now(),
  })

  await store.projectCollection.insertOne({
    id: PLATFORM_PROJECT_ID,
    name: "shogo-platform",
    organization: SHOGO_ORG_ID,
    description: "Internal platform development",
    tier: "internal",
    status: "active",
    createdAt: Date.now(),
  })

  // Note: No member seeding - members created via auth flow

  return {
    alreadySeeded: false,
    created: { orgId: SHOGO_ORG_ID, projectId: PLATFORM_PROJECT_ID },
  }
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Initialize seed data for studio-core domain.
 *
 * Loads the studio-core schema, creates a runtime store with backendRegistry,
 * and seeds Shogo organization and Platform project via .query()/.insertOne().
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

    // 4. Create runtime store with backendRegistry only (no FileSystemPersistence)
    const store = d.createStore({
      services: {
        backendRegistry: getGlobalBackendRegistry(),
      },
      context: {
        schemaName: "studio-core",
        location: schemasDir,
      },
    })

    // 5. Seed using isomorphic .query()/.insertOne() pattern
    const result = await seedStudioCore(store)

    // 6. Log result clearly
    if (result.alreadySeeded) {
      console.log("[seed-init] Seed data already exists - skipping creation")
    } else {
      console.log("[seed-init] Seed data created successfully")
    }
  } catch (error) {
    // 7. Handle errors gracefully - log but don't crash
    console.warn(
      `[seed-init] Failed to initialize seed data: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
