/**
 * Domain Schema DDL Initialization
 *
 * Scans .schemas directory for schemas with x-persistence.backend: "postgres"
 * and executes DDL to ensure tables exist at MCP server startup.
 *
 * Usage:
 * ```ts
 * // At server startup, after backend initialization
 * await initializeDomainSchemas(join(import.meta.dir, "../../../.schemas"))
 * ```
 *
 * @module mcp/ddl-init
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  isPostgresAvailable,
  isSqliteAvailable,
  getGlobalBackendRegistry,
} from "./postgres-init"
import type { SchemaSyncResult } from "@shogo/state-api"

// ============================================================================
// Types
// ============================================================================

interface SchemaInfo {
  name: string
  schema: Record<string, unknown> & {
    "x-persistence"?: { backend?: string; namespace?: string }
  }
  path: string
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Initialize DDL for domain schemas with postgres backend.
 *
 * Scans the schemas directory for schemas configured with
 * `x-persistence.backend: "postgres"` and syncs schema DDL using
 * the migration-aware syncSchema method.
 *
 * @param schemasDir - Path to the .schemas directory
 *
 * @remarks
 * - Requires SQL backend to be initialized first (postgres or sqlite)
 * - Uses syncSchema for migration-aware DDL synchronization
 * - Logs action taken for each schema: bootstrap, created, unchanged, or migrated
 * - Logs errors on failure but does not throw
 *
 * @example
 * ```ts
 * await initializePostgresBackend()
 * await initializeDomainSchemas(join(import.meta.dir, "../../../.schemas"))
 * // Output:
 * // [ddl-init]   [created] my-schema (v1)
 * // [ddl-init]   [unchanged] other-schema
 * // [ddl-init]   [migrated] evolved-schema (v2)
 * ```
 */
export async function initializeDomainSchemas(schemasDir: string): Promise<void> {
  // 1. Check if SQL backend is available
  if (!isPostgresAvailable() && !isSqliteAvailable()) {
    console.log("[ddl-init] No SQL backend available - skipping DDL initialization")
    return
  }

  try {
    // 2. Scan schemas directory
    const schemas = await scanSchemasDirectory(schemasDir)

    // 3. Filter for postgres backend
    const postgresSchemas = schemas.filter(
      (s) => s.schema["x-persistence"]?.backend === "postgres"
    )

    if (postgresSchemas.length === 0) {
      console.log("[ddl-init] No schemas with postgres backend found")
      return
    }

    console.log(
      `[ddl-init] Found ${postgresSchemas.length} schema(s) with postgres backend`
    )

    // 4. Execute DDL for each schema
    const registry = getGlobalBackendRegistry()

    for (const { name, schema } of postgresSchemas) {
      try {
        const result: SchemaSyncResult = await registry.syncSchema(name, schema)

        // Log based on action
        switch (result.action) {
          case "bootstrap":
            console.log(`[ddl-init]   [bootstrap] ${name}`)
            break
          case "created":
            console.log(`[ddl-init]   [created] ${name} (v${result.version})`)
            break
          case "unchanged":
            console.log(`[ddl-init]   [unchanged] ${name}`)
            break
          case "migrated":
            console.log(`[ddl-init]   [migrated] ${name} (v${result.toVersion})`)
            break
        }
      } catch (error) {
        console.error(
          `[ddl-init]   [error] ${name}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  } catch (error) {
    console.warn(
      `[ddl-init] Failed to scan schemas directory: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Scan schemas directory and load all valid schema.json files.
 *
 * @param schemasDir - Path to the .schemas directory
 * @returns Array of schema info objects
 */
async function scanSchemasDirectory(schemasDir: string): Promise<SchemaInfo[]> {
  const entries = await readdir(schemasDir, { withFileTypes: true })

  const schemaPromises = entries
    .filter((e) => e.isDirectory())
    .map(async (dir): Promise<SchemaInfo | null> => {
      const schemaPath = join(schemasDir, dir.name, "schema.json")

      try {
        const content = await readFile(schemaPath, "utf-8")
        const schema = JSON.parse(content)
        return { name: dir.name, schema, path: schemaPath }
      } catch {
        // Skip non-existent or invalid schema files
        return null
      }
    })

  const results = await Promise.all(schemaPromises)
  return results.filter((s): s is SchemaInfo => s !== null)
}
