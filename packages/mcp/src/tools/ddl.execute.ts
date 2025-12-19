/**
 * DDL Execute Tool
 *
 * MCP tool for generating and executing DDL (Data Definition Language) statements
 * from Enhanced JSON Schema. Creates database tables in PostgreSQL.
 *
 * Usage:
 * - dryRun: true - returns DDL statements without executing
 * - dryRun: false/omitted - executes DDL against PostgreSQL (requires DATABASE_URL)
 *
 * @module mcp/tools/ddl.execute
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import {
  getMetaStore,
  generateSQL,
  createPostgresDialect,
} from "@shogo/state-api"
import {
  getPostgresExecutor,
  isPostgresAvailable,
} from "../postgres-init"

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
      "Requires DATABASE_URL environment variable for execution.",
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

        // 2. Generate DDL from Enhanced JSON Schema
        const enhancedJson = schema.toEnhancedJson
        const dialect = createPostgresDialect()
        const statements = generateSQL(enhancedJson, dialect, { ifNotExists: true })

        if (statements.length === 0) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "NO_DDL_GENERATED",
              message: `No DDL statements generated for schema '${schemaName}'. ` +
                `Schema may have no model definitions.`,
            },
          })
        }

        // 3. Dry run mode - return DDL without executing
        if (dryRun) {
          return JSON.stringify({
            ok: true,
            dryRun: true,
            schemaName,
            statements,
            statementCount: statements.length,
          })
        }

        // 4. Check PostgreSQL availability
        if (!isPostgresAvailable()) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "POSTGRES_UNAVAILABLE",
              message: "PostgreSQL not available. Set DATABASE_URL environment variable " +
                "and ensure the MCP server was started with it. " +
                "Use dryRun: true to preview DDL without execution.",
            },
          })
        }

        // 5. Execute DDL statements
        const executor = getPostgresExecutor()
        if (!executor) {
          return JSON.stringify({
            ok: false,
            error: {
              code: "EXECUTOR_NOT_FOUND",
              message: "PostgreSQL executor not available despite initialization.",
            },
          })
        }

        // Execute all statements
        await executor.executeMany(statements)

        return JSON.stringify({
          ok: true,
          dryRun: false,
          schemaName,
          statements,
          statementCount: statements.length,
          executed: true,
          message: `Successfully executed ${statements.length} DDL statement(s) for schema '${schemaName}'`,
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
