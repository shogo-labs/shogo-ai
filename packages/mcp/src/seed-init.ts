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

import { loadSchema, domain, SHOGO_ORG_ID, PLATFORM_PROJECT_ID, isS3Enabled, NullPersistence } from "@shogo/state-api"
import {
  isPostgresAvailable,
  isSqliteAvailable,
  getGlobalBackendRegistry,
} from "./postgres-init"

/**
 * Get the effective workspace location for schema loading.
 * - S3 mode: Uses WORKSPACE_ID environment variable
 * - Filesystem mode: Uses the provided schemasDir path
 */
function getEffectiveWorkspace(schemasDir: string): string {
  if (isS3Enabled()) {
    return process.env.WORKSPACE_ID || "workspace"
  }
  return schemasDir
}
import {
  COMPONENT_DEFINITIONS,
  REGISTRIES,
  RENDERER_BINDINGS,
  LAYOUT_TEMPLATES,
  COMPOSITIONS,
} from "./seed-data/component-builder"

// ============================================================================
// Types
// ============================================================================

interface SeedResult {
  alreadySeeded: boolean
  created?: { orgId: string; projectId: string }
}

interface ComponentBuilderSeedResult {
  alreadySeeded: boolean
  created?: {
    componentDefinitions: number
    registries: number
    rendererBindings: number
    layoutTemplates: number
    compositions: number
  }
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
  // Note: studio-core uses Workspace (not Organization)
  const existingWorkspace = await store.workspaceCollection
    .query()
    .where({ id: SHOGO_ORG_ID })
    .first()

  if (existingWorkspace) {
    return { alreadySeeded: true }
  }

  // Insert via .insertOne() - syncs to backend
  await store.workspaceCollection.insertOne({
    id: SHOGO_ORG_ID,
    name: "Shogo",
    slug: "shogo",
    description: "Shogo AI Platform",
    createdAt: Date.now(),
  })

  await store.projectCollection.insertOne({
    id: PLATFORM_PROJECT_ID,
    name: "shogo-platform",
    workspaceId: SHOGO_ORG_ID,
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

/**
 * Seed component-builder domain with ComponentDefinitions, Registries, and RendererBindings.
 *
 * Uses INCREMENTAL seeding pattern:
 * - Checks each entity by ID and only inserts if missing
 * - This allows new bindings to be added without clearing existing data
 * - Uses .query().where().first() for existence check, .insertOne() for writes
 *
 * @param store - Runtime store with queryable/mutatable collections
 * @returns Seed result indicating counts of newly created entities
 */
async function seedComponentBuilder(store: any): Promise<ComponentBuilderSeedResult> {
  const now = Date.now()
  let createdDefs = 0
  let createdRegs = 0
  let createdBindings = 0
  let createdLayouts = 0
  let createdCompositions = 0

  // Insert ComponentDefinitions - check each individually
  for (const def of COMPONENT_DEFINITIONS) {
    const existing = await store.componentDefinitionCollection
      .query()
      .where({ id: def.id })
      .first()

    if (!existing) {
      await store.componentDefinitionCollection.insertOne({
        ...def,
        createdAt: now,
      })
      createdDefs++
    }
  }

  // Insert Registries - check each individually
  for (const reg of REGISTRIES) {
    const existing = await store.registryCollection
      .query()
      .where({ id: reg.id })
      .first()

    if (!existing) {
      await store.registryCollection.insertOne({
        ...reg,
        createdAt: now,
      })
      createdRegs++
    }
  }

  // Insert RendererBindings - check each individually
  for (const binding of RENDERER_BINDINGS) {
    const existing = await store.rendererBindingCollection
      .query()
      .where({ id: binding.id })
      .first()

    if (!existing) {
      await store.rendererBindingCollection.insertOne({
        ...binding,
        createdAt: now,
      })
      createdBindings++
    }
  }

  // Insert LayoutTemplates - check each individually
  for (const layout of LAYOUT_TEMPLATES) {
    const existing = await store.layoutTemplateCollection
      .query()
      .where({ id: layout.id })
      .first()

    if (!existing) {
      await store.layoutTemplateCollection.insertOne({
        ...layout,
        createdAt: now,
      })
      createdLayouts++
    }
  }

  // Insert Compositions - check each individually
  for (const composition of COMPOSITIONS) {
    const existing = await store.compositionCollection
      .query()
      .where({ id: composition.id })
      .first()

    if (!existing) {
      await store.compositionCollection.insertOne({
        ...composition,
        createdAt: now,
      })
      createdCompositions++
    }
  }

  // Consider "already seeded" only if nothing new was created
  const totalCreated = createdDefs + createdRegs + createdBindings + createdLayouts + createdCompositions
  if (totalCreated === 0) {
    return { alreadySeeded: true }
  }

  return {
    alreadySeeded: false,
    created: {
      componentDefinitions: createdDefs,
      registries: createdRegs,
      rendererBindings: createdBindings,
      layoutTemplates: createdLayouts,
      compositions: createdCompositions,
    },
  }
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Initialize seed data for studio-core and component-builder domains.
 *
 * Loads each schema, creates a runtime store with backendRegistry,
 * and seeds data via .query()/.insertOne().
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

  // Get effective workspace for schema loading (S3: workspace ID, filesystem: path)
  const effectiveWorkspace = getEffectiveWorkspace(schemasDir)

  try {
    // =========================================================================
    // Studio Core Domain
    // =========================================================================

    // 2. Load studio-core schema (from S3 or filesystem based on SCHEMA_STORAGE)
    const { enhanced } = await loadSchema("studio-core", effectiveWorkspace)

    // 3. Create domain factory from enhanced schema
    const d = domain({
      name: "studio-core",
      from: enhanced,
    })

    // 4. Create runtime store with backendRegistry (NullPersistence since we use postgres backend)
    const store = d.createStore({
      services: {
        persistence: new NullPersistence(),
        backendRegistry: getGlobalBackendRegistry(),
      },
      context: {
        schemaName: "studio-core",
        location: effectiveWorkspace,
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

    // =========================================================================
    // Component Builder Domain
    // =========================================================================

    try {
      // 7. Load component-builder schema (from S3 or filesystem)
      const { enhanced: componentBuilderEnhanced } = await loadSchema("component-builder", effectiveWorkspace)

      // 8. Create domain factory from enhanced schema
      const componentBuilderDomain = domain({
        name: "component-builder",
        from: componentBuilderEnhanced,
      })

      // 9. Create runtime store with backendRegistry (NullPersistence since we use postgres backend)
      const componentBuilderStore = componentBuilderDomain.createStore({
        services: {
          persistence: new NullPersistence(),
          backendRegistry: getGlobalBackendRegistry(),
        },
        context: {
          schemaName: "component-builder",
          location: effectiveWorkspace,
        },
      })

      // 10. Seed component-builder data
      const componentBuilderResult = await seedComponentBuilder(componentBuilderStore)

      // 11. Log result
      if (componentBuilderResult.alreadySeeded) {
        console.log("[seed-init] component-builder seed data already exists - skipping creation")
      } else {
        console.log(
          `[seed-init] component-builder seed data created successfully ` +
            `(${componentBuilderResult.created?.componentDefinitions} definitions, ` +
            `${componentBuilderResult.created?.registries} registries, ` +
            `${componentBuilderResult.created?.rendererBindings} bindings, ` +
            `${componentBuilderResult.created?.layoutTemplates} layouts, ` +
            `${componentBuilderResult.created?.compositions} compositions)`
        )
      }
    } catch (componentBuilderError) {
      // Component-builder schema might not exist yet - that's okay
      console.log(
        `[seed-init] component-builder schema not available - skipping: ${
          componentBuilderError instanceof Error ? componentBuilderError.message : String(componentBuilderError)
        }`
      )
    }
  } catch (error) {
    // Handle errors gracefully - log but don't crash
    console.warn(
      `[seed-init] Failed to initialize seed data: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
