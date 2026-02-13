/**
 * Domain Schema DDL Initialization
 *
 * Scans .schemas directory (or S3) for schemas with x-persistence.backend: "postgres"
 * and executes DDL to ensure tables exist at MCP server startup.
 *
 * Supports both filesystem and S3 backends via SCHEMA_STORAGE env var.
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
import {
  isS3Enabled,
  buildS3Key,
  listDirsInS3,
  readJsonFromS3,
  getS3Prefix,
  runBootstrapMigration,
} from "@shogo/state-api"

// ============================================================================
// Types
// ============================================================================

interface SchemaInfo {
  name: string
  schema: Record<string, unknown> & {
    "x-persistence"?: { backend?: string; namespace?: string; bootstrap?: boolean }
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

  // 2. Run bootstrap migration for system-migrations schema (v1 → v2 upgrade)
  // This is idempotent and safe to run every startup
  try {
    const registry = getGlobalBackendRegistry()
    // Get executor from the postgres or sqlite backend
    const backend = registry.get("postgres") || registry.get("sqlite")
    if (backend?.executor) {
      const bootstrapResult = await runBootstrapMigration(backend.executor)
      switch (bootstrapResult.action) {
        case "migrated":
          console.log(`[ddl-init] Bootstrap migration: ${bootstrapResult.message}`)
          break
        case "already_migrated":
          // Silent - already on v2 schema
          break
        case "no_table":
          // Silent - fresh install, table will be created by syncSchema
          break
        case "error":
          console.error(`[ddl-init] Bootstrap migration error: ${bootstrapResult.error}`)
          break
      }
    }
  } catch (error) {
    console.warn(
      `[ddl-init] Bootstrap migration check failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    // 3. Scan schemas directory
    const schemas = await scanSchemasDirectory(schemasDir)

    // 4. Filter for postgres backend
    const postgresSchemas = schemas.filter(
      (s) => s.schema["x-persistence"]?.backend === "postgres"
    )

    if (postgresSchemas.length === 0) {
      console.log("[ddl-init] No schemas with postgres backend found")
      return
    }

    // 5. Separate bootstrap schemas from regular schemas
    // Bootstrap schemas (like system-migrations) must be processed first
    // because other schemas depend on them for migration tracking
    const bootstrapSchemas = postgresSchemas.filter(
      (s) => s.schema["x-persistence"]?.bootstrap === true
    )
    const regularSchemas = postgresSchemas.filter(
      (s) => s.schema["x-persistence"]?.bootstrap !== true
    )

    // Process in order: bootstrap first, then regular
    const orderedSchemas = [...bootstrapSchemas, ...regularSchemas]

    console.log(
      `[ddl-init] Found ${postgresSchemas.length} schema(s) with postgres backend`
    )

    // 6. Execute DDL for each schema (bootstrap first, then regular)
    const registry = getGlobalBackendRegistry()

    for (const { name, schema } of orderedSchemas) {
      try {
        const result: SchemaSyncResult = await registry.syncSchema(name, schema)

        // Log based on action and success/verified status
        switch (result.action) {
          case "bootstrap":
            console.log(`[ddl-init]   [bootstrap] ${name}`)
            break
          case "created":
            if (!result.success) {
              console.error(`[ddl-init]   [created:FAILED] ${name} (v${result.version}): DDL execution failed`)
              if (result.errorMessage) {
                console.error(`[ddl-init]     Error: ${result.errorMessage}`)
              }
            } else if (!result.verified) {
              console.warn(`[ddl-init]   [created:UNVERIFIED] ${name} (v${result.version}): Tables not verified`)
              if (result.verificationDetails?.tablesMissing?.length) {
                console.warn(`[ddl-init]     Missing tables: ${result.verificationDetails.tablesMissing.join(", ")}`)
              }
            } else {
              console.log(`[ddl-init]   [created] ${name} (v${result.version})`)
            }
            break
          case "unchanged":
            console.log(`[ddl-init]   [unchanged] ${name}`)
            break
          case "migrated":
            if (!result.success) {
              console.error(`[ddl-init]   [migrated:FAILED] ${name} (v${result.fromVersion}→v${result.toVersion}): DDL execution failed`)
              if (result.errorMessage) {
                console.error(`[ddl-init]     Error: ${result.errorMessage}`)
              }
            } else if (!result.verified) {
              console.warn(`[ddl-init]   [migrated:UNVERIFIED] ${name} (v${result.fromVersion}→v${result.toVersion}): Tables not verified`)
              if (result.verificationDetails?.tablesMissing?.length) {
                console.warn(`[ddl-init]     Missing tables: ${result.verificationDetails.tablesMissing.join(", ")}`)
              }
            } else {
              console.log(`[ddl-init]   [migrated] ${name} (v${result.toVersion})`)
            }
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
 * Scan schemas directory (or S3) and load all valid schema.json files.
 *
 * @param schemasDir - Path to the .schemas directory (used for filesystem mode)
 * @returns Array of schema info objects
 */
async function scanSchemasDirectory(schemasDir: string): Promise<SchemaInfo[]> {
  // Use S3 if enabled
  if (isS3Enabled()) {
    return scanSchemasFromS3()
  }

  // Filesystem mode
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

/**
 * Scan schemas from S3 bucket.
 *
 * Looks in {prefix}/{workspace}/ for schema directories.
 */
async function scanSchemasFromS3(): Promise<SchemaInfo[]> {
  const workspace = process.env.WORKSPACE_ID || "workspace"
  const prefix = `${getS3Prefix()}${workspace}/`

  try {
    const schemaDirs = await listDirsInS3(prefix)
    console.log(`[ddl-init] Found ${schemaDirs.length} schema directories in S3 at ${prefix}`)

    const schemaPromises = schemaDirs.map(async (name): Promise<SchemaInfo | null> => {
      const schemaKey = buildS3Key(workspace, name, "schema.json")

      try {
        const schema = await readJsonFromS3(schemaKey)
        return { name, schema, path: `s3://${schemaKey}` }
      } catch (error) {
        console.debug(`[ddl-init] Failed to load schema from S3: ${schemaKey}`, error)
        return null
      }
    })

    const results = await Promise.all(schemaPromises)
    return results.filter((s): s is SchemaInfo => s !== null)
  } catch (error) {
    console.warn(`[ddl-init] Failed to scan S3 for schemas:`, error)
    return []
  }
}
