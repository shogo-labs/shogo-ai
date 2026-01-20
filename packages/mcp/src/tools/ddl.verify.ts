/**
 * DDL Verify Tool
 *
 * MCP tool for verifying that expected database tables exist for a schema.
 * This tool performs introspection without triggering any migrations.
 *
 * Usage:
 * - Checks if tables expected by the schema exist in the database
 * - Returns comparison of expected vs actual tables
 * - Does NOT execute any DDL or migrations
 *
 * Use cases:
 * - Pre-migration verification
 * - Post-migration verification
 * - Drift detection
 * - Recovery planning
 *
 * @module mcp/tools/ddl.verify
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import {
  getMetaStore,
  deriveNamespace,
  getActualTablesFullNames,
  detectDialect,
  isS3Enabled,
  toSnakeCase,
  qualifyTableName,
  normalizeTableNameForComparison,
  type QualifyDialect,
} from "@shogo/state-api"
import { getGlobalBackendRegistry, getWorkspaceBackendRegistry } from "../postgres-init"
import { getEffectiveWorkspace } from "../state"

const Params = t({
  schemaName: "string",
  "workspace?": "string",
})

export function registerDdlVerify(server: FastMCP) {
  server.addTool({
    name: "ddl.verify",
    description:
      "Verify that database tables exist for a schema. " +
      "Returns comparison of expected vs actual tables without triggering migrations. " +
      "Useful for drift detection and recovery planning.",
    parameters: Params,
    execute: async (args: any) => {
      const { schemaName, workspace } = args as {
        schemaName: string
        workspace?: string
      }

      // Determine effective workspace for backend resolution
      const effectiveWorkspace = getEffectiveWorkspace(workspace)

      try {
        // 1. Validate schema exists in meta-store
        const metaStore = getMetaStore()
        const schema = metaStore.findSchemaByName(schemaName)

        if (!schema) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "SCHEMA_NOT_FOUND",
              message: `Schema '${schemaName}' not found in meta-store. ` +
                `Use schema.set or schema.load to create/load a schema first.`,
            },
          })
        }

        // 2. Get Enhanced JSON Schema
        const enhancedJson = schema.toEnhancedJson

        // 3. Get backend for introspection (need this first for dialect detection)
        const schemaBackend = enhancedJson['x-persistence']?.backend
        const usePostgres = schemaBackend === 'postgres'

        let registry: Awaited<ReturnType<typeof getWorkspaceBackendRegistry>>

        if (usePostgres) {
          registry = getGlobalBackendRegistry()
        } else if (isS3Enabled() && effectiveWorkspace) {
          registry = await getWorkspaceBackendRegistry(effectiveWorkspace)
        } else {
          registry = getGlobalBackendRegistry()
        }

        // Get backend executor
        const backendName = schemaBackend || "sql"
        const backend = registry.get(backendName)

        if (!backend || !backend.executor) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "NO_EXECUTOR",
              message: `Cannot verify: backend "${backendName}" not found or has no executor.`,
            },
          })
        }

        // 4. Detect dialect for proper table name qualification
        const introspectionDialect = await detectDialect(backend.executor)
        const qualifyDialect: QualifyDialect = (introspectionDialect === "pg" || introspectionDialect === "postgres" || introspectionDialect === "postgresql")
          ? "postgresql"
          : "sqlite"

        // 5. Compute expected tables from schema models using dialect-aware naming
        const namespace = deriveNamespace(schemaName)
        const models = enhancedJson.$defs || enhancedJson.definitions || {}
        const expectedTables = Object.keys(models).map(modelName => {
          const tableName = toSnakeCase(modelName)
          return qualifyTableName(namespace, tableName, qualifyDialect)
        })

        // 6. Get actual tables from database
        // Pass namespace without __ suffix - introspection handles dialect internally
        let actualTables: string[] = []
        try {
          actualTables = await getActualTablesFullNames(namespace, backend.executor, introspectionDialect)
        } catch (error: any) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "INTROSPECTION_ERROR",
              message: `Failed to introspect database: ${error.message}`,
            },
          })
        }

        // 7. Compare expected vs actual using normalization to handle quoting differences
        // qualifyTableName returns quoted: "schema"."table"
        // introspection returns unquoted: schema.table
        const expectedNormalized = expectedTables.map(normalizeTableNameForComparison)
        const actualNormalized = actualTables.map(normalizeTableNameForComparison)
        const missing = expectedTables.filter(t => !actualNormalized.includes(normalizeTableNameForComparison(t)))
        const extra = actualTables.filter(t => !expectedNormalized.includes(normalizeTableNameForComparison(t)))

        const allMatch = missing.length === 0

        return JSON.stringify({
          ok: true,
          status: allMatch ? "match" : "mismatch",
          schemaName,
          namespace,
          expected: expectedTables,
          actual: actualTables,
          missing,
          extra,
          summary: allMatch
            ? `All ${expectedTables.length} expected table(s) exist`
            : `${missing.length} table(s) missing, ${extra.length} extra table(s) found`,
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "VERIFICATION_ERROR",
            message: error.message || "Failed to verify schema tables",
            details: error.stack,
          },
        })
      }
    },
  })
}
