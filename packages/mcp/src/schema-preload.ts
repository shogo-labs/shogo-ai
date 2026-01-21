/**
 * Schema Pre-loading for MCP Server
 *
 * Pre-loads core schemas into the meta-store at server startup.
 * This ensures schemas are available immediately for queries without
 * waiting for browser schema.load calls, which fixes race conditions
 * where queries fire before schemas are loaded.
 *
 * Core schemas loaded:
 * - studio-core: Workspaces, projects, members, folders
 * - better-auth: Authentication entities
 * - billing: Subscription and payment entities
 * - platform-features: Feature pipeline entities
 * - component-builder: Component building entities
 * - studio-chat: Chat session entities
 *
 * @module mcp/schema-preload
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  getMetaStore,
  loadSchema,
  domain,
  FileSystemPersistence,
  cacheRuntimeStore,
} from "@shogo/state-api"
import { getGlobalBackendRegistry } from "./postgres-init"

/**
 * Core schemas that should be pre-loaded at startup.
 * These are schemas with x-persistence.backend: "postgres" that are
 * essential for the application to function.
 */
const CORE_SCHEMAS = [
  "studio-core",
  "better-auth",
  "billing",
  "platform-features",
  "component-builder",
  "studio-chat",
  "teams-multi-tenancy",
  "teams-workspace",
  "virtual-tools",
]

/**
 * Pre-load core schemas into the meta-store at startup.
 *
 * This function:
 * 1. Reads each core schema from the schemas directory
 * 2. Ingests the schema into the meta-store
 * 3. Creates a runtime store with the PostgreSQL backend
 * 4. Caches the runtime store for immediate availability
 *
 * @param schemasDir - Path to the schemas directory
 */
export async function preloadCoreSchemas(schemasDir: string): Promise<void> {
  const startTime = Date.now()
  console.log(`[schema-preload] Pre-loading ${CORE_SCHEMAS.length} core schemas...`)

  const metaStore = getMetaStore()
  const backendRegistry = getGlobalBackendRegistry()
  let loadedCount = 0
  let errorCount = 0

  for (const schemaName of CORE_SCHEMAS) {
    try {
      // Check if schema already exists (from a previous load)
      const existing = metaStore.findSchemaByName(schemaName)
      if (existing) {
        console.log(`[schema-preload]   [cached] ${schemaName}`)
        loadedCount++
        continue
      }

      // Load schema from disk
      const { metadata, enhanced } = await loadSchema(schemaName, schemasDir)

      // Ingest into meta-store
      const schema = metaStore.ingestEnhancedJsonSchema(enhanced, metadata)

      // Create domain from enhanced schema
      const enhancedWithMetadata = schema.toEnhancedJson
      const d = domain({
        name: schema.name,
        from: enhancedWithMetadata,
      })

      // Create runtime store with PostgreSQL backend
      const runtimeStore = d.createStore({
        services: {
          persistence: new FileSystemPersistence(),
          backendRegistry,
        },
        context: {
          schemaName: schema.name,
          location: schemasDir,
        },
      })

      // Cache runtime store for immediate availability
      cacheRuntimeStore(schema.id, runtimeStore, schemasDir)

      console.log(`[schema-preload]   [loaded] ${schemaName}`)
      loadedCount++
    } catch (error: any) {
      // Don't fail startup for missing schemas - they might be optional
      if (error.code === "ENOENT") {
        console.log(`[schema-preload]   [skip] ${schemaName} (not found)`)
      } else {
        console.error(`[schema-preload]   [error] ${schemaName}: ${error.message}`)
        errorCount++
      }
    }
  }

  const duration = Date.now() - startTime
  console.log(
    `[schema-preload] Completed: ${loadedCount} loaded, ${errorCount} errors (${duration}ms)`
  )
}
