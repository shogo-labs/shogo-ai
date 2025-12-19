/**
 * DDL Execute Tool
 *
 * MCP tool for generating and executing DDL (Data Definition Language) statements
 * from Enhanced JSON Schema. Uses BackendRegistry for automatic dialect resolution.
 *
 * Usage:
 * - dryRun: true - returns DDL statements without executing
 * - dryRun: false/omitted - executes DDL via resolved backend (postgres/sqlite/memory)
 *
 * Backend Resolution:
 * - Reads schema's x-persistence.backend property
 * - Falls back to registry default backend
 * - Memory backend returns success with no-op (no tables to create)
 *
 * @module mcp/tools/ddl.execute
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import {
  getMetaStore,
  generateSQL,
  createPostgresDialect,
  createSqliteDialect,
} from "@shogo/state-api"
import { getGlobalBackendRegistry } from "../postgres-init"

const Params = t({
  schemaName: "string",
  "dryRun?": "boolean",
})

export function registerDdlExecute(server: FastMCP) {
  server.addTool({
    name: "ddl.execute",
    description:
      "Generate and execute DDL (CREATE TABLE) statements from a schema. " +
      "Use dryRun: true to preview SQL without executing. " +
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
              message: `Schema '${schemaName}' not found in meta-store. ` +
                `Use schema.set or schema.load to create/load a schema first.`,
            },
          })
        }

        // 2. Get Enhanced JSON Schema for DDL generation
        const enhancedJson = schema.toEnhancedJson

        // 3. Dry run mode - generate DDL preview without executing
        if (dryRun) {
          // Determine dialect from schema's x-persistence.backend
          const backendName = enhancedJson['x-persistence']?.backend
          const dialect = backendName === 'sqlite'
            ? createSqliteDialect()
            : createPostgresDialect()

          const statements = generateSQL(enhancedJson, dialect, { ifNotExists: true })

          return JSON.stringify({
            ok: true,
            dryRun: true,
            schemaName,
            backend: backendName || 'default',
            statements,
            statementCount: statements.length,
          })
        }

        // 4. Execute DDL via backend registry
        const registry = getGlobalBackendRegistry()
        const result = await registry.executeDDL(schemaName, enhancedJson, {
          ifNotExists: true,
        })

        if (!result.success) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "DDL_EXECUTION_ERROR",
              message: result.error || "Failed to execute DDL",
            },
          })
        }

        return JSON.stringify({
          ok: true,
          dryRun: false,
          schemaName,
          statements: result.statements,
          statementCount: result.statements.length,
          executed: result.executed,
          message: `Successfully executed ${result.executed} DDL statement(s) for schema '${schemaName}'`,
        })
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "DDL_EXECUTION_ERROR",
            message: error.message || "Failed to execute DDL",
            details: error.stack,
          },
        })
      }
    },
  })
}
