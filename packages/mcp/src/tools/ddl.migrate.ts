/**
 * DDL Migrate Tool
 *
 * MCP tool for generating and executing schema migrations.
 * Compares current schema to previous version and generates ALTER TABLE statements.
 *
 * Usage:
 * - dryRun: true - returns migration SQL without executing
 * - dryRun: false/omitted - executes migration and records in system-migrations
 * - fromVersion: optional baseline version for comparison
 *
 * Differences from ddl.execute:
 * - ddl.execute: CREATE TABLE IF NOT EXISTS (initial schema)
 * - ddl.migrate: ALTER TABLE ADD/DROP/MODIFY (schema changes)
 *
 * @module mcp/tools/ddl.migrate
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import {
  getMetaStore,
  compareSchemas,
  generateMigration,
  migrationOutputToSQL,
  createPostgresDialect,
  createSqliteDialect,
  deriveNamespace,
  getLatestMigration,
  recordMigration,
  computeSchemaChecksum,
  getSchemaSnapshot,
  MigrationOperation,
  type SchemaDiff,
  type MigrationOutput,
} from "@shogo/state-api"
import { getGlobalBackendRegistry } from "../postgres-init"

const Params = t({
  schemaName: "string",
  "dryRun?": "boolean",
  "fromVersion?": "number",
})

export function registerDdlMigrate(server: FastMCP) {
  server.addTool({
    name: "ddl.migrate",
    description:
      "Generate and execute schema migration SQL. " +
      "Use dryRun: true to preview migration without executing. " +
      "Optionally specify fromVersion to compare from a specific version.",
    parameters: Params,
    execute: async (args: any) => {
      const { schemaName, dryRun = false, fromVersion } = args as {
        schemaName: string
        dryRun?: boolean
        fromVersion?: number
      }

      try {
        // 1. Validate schema exists in meta-store
        const metaStore = getMetaStore()
        const schema = metaStore.findSchemaByName(schemaName)

        if (!schema) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "SCHEMA_NOT_FOUND",
              message: `Schema not found: ${schemaName}`,
            },
          })
        }

        // 2. Get Enhanced JSON Schema for current schema
        const currentSchema = schema.toEnhancedJson
        const currentChecksum = computeSchemaChecksum(currentSchema)

        // 3. Get previous schema version for comparison
        const latestMigration = await getLatestMigration(schemaName)

        // If no previous migration exists, this is initial setup - use ddl.execute instead
        if (!latestMigration) {
          return JSON.stringify({
            ok: true,
            noChanges: false,
            message: `No previous migration found for schema '${schemaName}'. Use ddl.execute for initial setup.`,
            suggestion: "Use ddl.execute for initial schema creation, then ddl.migrate for subsequent changes.",
          })
        }

        // 4. Check if checksum matches (no changes)
        if (latestMigration.checksum === currentChecksum) {
          return JSON.stringify({
            ok: true,
            noChanges: true,
            message: `No changes detected for schema '${schemaName}'`,
            currentVersion: latestMigration.version,
            checksum: currentChecksum,
          })
        }

        // 5. Get old schema from file snapshot at the recorded version
        const nextVersion = latestMigration.version + 1
        let oldSchema: Record<string, any> = { $defs: {} }
        try {
          const oldSnapshot = await getSchemaSnapshot(schemaName, latestMigration.version)
          oldSchema = oldSnapshot?.schema || { $defs: {} }
        } catch (e) {
          // If snapshot is missing, log warning but continue with empty schema
          // This allows recovery when history files are deleted
          console.warn(`Could not load schema snapshot v${latestMigration.version} for ${schemaName}:`, e)
        }

        // 6. Determine dialect from schema's x-persistence.backend
        const backendName = currentSchema["x-persistence"]?.backend
        const dialect =
          backendName === "sqlite" ? createSqliteDialect() : createPostgresDialect()
        const namespace = deriveNamespace(schemaName)

        // 7. Build diff - compare old snapshot to current schema (pass full schemas)
        const diff: SchemaDiff = compareSchemas(oldSchema, currentSchema)

        // Check if there are any changes
        const hasChanges =
          diff.addedModels.length > 0 ||
          diff.removedModels.length > 0 ||
          diff.modifiedModels.length > 0

        if (!hasChanges) {
          return JSON.stringify({
            ok: true,
            noChanges: true,
            message: `No structural changes detected for schema '${schemaName}'`,
            currentVersion: latestMigration.version,
            note: "Checksum differs but no model changes detected.",
          })
        }

        // 8. Generate migration
        const migrationOutput: MigrationOutput = generateMigration(diff, dialect, {
          schemaName,
          version: nextVersion,
          namespace,
        })

        // 9. Convert to SQL
        const statements = migrationOutputToSQL(migrationOutput, dialect)

        // 10. Collect warnings for destructive operations
        const warnings: Array<{ type: string; message: string }> = []
        for (const op of migrationOutput.operations) {
          if (op.type === MigrationOperation.DROP_COLUMN) {
            warnings.push({
              type: "DATA_LOSS",
              message: `Dropping column '${op.columnName}' from table '${op.tableName}' will delete data`,
            })
          }
          if (op.type === MigrationOperation.DROP_TABLE) {
            warnings.push({
              type: "DATA_LOSS",
              message: `Dropping table '${op.tableName}' will delete all data`,
            })
          }
        }

        // 11. Dry run mode - return SQL without executing
        if (dryRun) {
          return JSON.stringify({
            ok: true,
            dryRun: true,
            schemaName,
            namespace,
            fromVersion: latestMigration.version,
            toVersion: nextVersion,
            statements,
            statementCount: statements.length,
            warnings,
            diff: {
              addedModels: diff.addedModels,
              removedModels: diff.removedModels,
              modifiedModels: diff.modifiedModels.map(m => m.modelName),
            },
          })
        }

        // 12. Execute mode - run SQL and record migration
        const registry = getGlobalBackendRegistry()
        const backend = registry?.get(backendName || "sql")

        if (!backend?.executor) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "BACKEND_UNAVAILABLE",
              message: `SQL backend not available for schema '${schemaName}'`,
            },
          })
        }

        // Execute migration statements
        // Filter out BEGIN/COMMIT for postgres (postgres.js handles transactions via sql.begin())
        let filteredStatements = statements.filter(stmt => !stmt.startsWith("--"))
        if (backend.dialect === "pg") {
          filteredStatements = filteredStatements.filter(stmt =>
            stmt !== "BEGIN" && stmt !== "COMMIT"
          )
        }

        let executed = 0
        try {
          if (filteredStatements.length > 0 && backend.executor.executeMany) {
            await backend.executor.executeMany(filteredStatements)
            executed = filteredStatements.length
          }
        } catch (execError: any) {
          // Record failed migration
          await recordMigration({
            schemaName,
            version: nextVersion,
            checksum: currentChecksum,
            appliedAt: Date.now(),
            statements,
            success: false,
            errorMessage: execError.message,
          })

          return JSON.stringify({
            ok: false,
            error: {
              code: "MIGRATION_EXECUTION_ERROR",
              message: execError.message || "Failed to execute migration",
            },
            statements,
            migrationRecorded: true,
            migrationStatus: "failed",
          })
        }

        // 13. Record successful migration
        await recordMigration({
          schemaName,
          version: nextVersion,
          checksum: currentChecksum,
          appliedAt: Date.now(),
          statements,
          success: true,
        })

        return JSON.stringify({
          ok: true,
          dryRun: false,
          schemaName,
          namespace,
          fromVersion: latestMigration.version,
          toVersion: nextVersion,
          statements,
          executed,
          migrationRecorded: true,
          warnings,
          message: `Successfully executed ${executed} migration statement(s) for schema '${schemaName}'`,
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "MIGRATION_ERROR",
            message: error.message || "Failed to generate or execute migration",
            details: error.stack,
          },
        })
      }
    },
  })
}
