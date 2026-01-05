/**
 * DDL Migrate Tool
 *
 * MCP tool for generating and executing schema migrations.
 * Compares current schema to previous version and generates ALTER TABLE statements.
 *
 * Usage:
 * - dryRun: true - returns migration SQL without executing
 * - dryRun: false/omitted - executes migration and records in system-migrations
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
  deriveNamespace,
  MigrationOperation,
  type MigrationOutput,
} from "@shogo/state-api"
import { getGlobalBackendRegistry } from "../postgres-init"

const Params = t({
  schemaName: "string",
  "dryRun?": "boolean",
})

/**
 * Generates data loss warnings from migration operations.
 */
function generateWarnings(migrationOutput?: MigrationOutput): Array<{ type: string; message: string }> {
  if (!migrationOutput) return []

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
  return warnings
}

export function registerDdlMigrate(server: FastMCP) {
  server.addTool({
    name: "ddl.migrate",
    description:
      "Generate and execute schema migration SQL. " +
      "Use dryRun: true to preview migration without executing. " +
      "Automatically uses the backend configured in schema's x-persistence.backend.",
    parameters: Params,
    execute: async (args: any) => {
      const { schemaName, dryRun = false } = args as {
        schemaName: string
        dryRun?: boolean
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

        // 2. Get Enhanced JSON Schema
        const currentSchema = schema.toEnhancedJson

        // 3. Call orchestrator via registry.syncSchema with dryRun option
        const registry = getGlobalBackendRegistry()
        const result = await registry.syncSchema(schemaName, currentSchema, { dryRun })

        // 4. Handle each result type
        switch (result.action) {
          case "bootstrap":
            // ddl.migrate should not handle bootstrap schemas
            return JSON.stringify({
              ok: false,
              error: {
                code: "BOOTSTRAP_SCHEMA",
                message: `Schema '${schemaName}' is a bootstrap schema. Use ddl.execute instead.`,
              },
            })

          case "created":
            // ddl.migrate should not handle fresh deploys - that's ddl.execute's job
            return JSON.stringify({
              ok: true,
              noChanges: false,
              message: `No previous migration found for schema '${schemaName}'. Use ddl.execute for initial setup.`,
              suggestion: "Use ddl.execute for initial schema creation, then ddl.migrate for subsequent changes.",
            })

          case "unchanged":
            return JSON.stringify({
              ok: true,
              noChanges: true,
              message: `No changes detected for schema '${schemaName}'`,
              currentVersion: result.version,
            })

          case "migrated":
            const warnings = generateWarnings(result.migrationOutput)
            const namespace = deriveNamespace(schemaName)

            return JSON.stringify({
              ok: true,
              dryRun: result.dryRun ?? false,
              schemaName,
              namespace,
              fromVersion: result.fromVersion,
              toVersion: result.toVersion,
              statements: result.statements,
              statementCount: result.statements.length,
              executed: result.dryRun ? 0 : result.statements.length,
              migrationRecorded: !result.dryRun,
              warnings,
              diff: result.diff ? {
                addedModels: result.diff.addedModels,
                removedModels: result.diff.removedModels,
                modifiedModels: result.diff.modifiedModels.map(m => m.modelName),
              } : undefined,
              message: result.dryRun
                ? `Dry run: ${result.statements.length} migration statement(s) would be executed`
                : `Successfully executed ${result.statements.length} migration statement(s) for schema '${schemaName}'`,
            })
        }
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
