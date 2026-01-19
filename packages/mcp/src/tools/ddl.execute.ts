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
  deriveNamespace,
  isS3Enabled,
} from "@shogo/state-api"
import { getGlobalBackendRegistry, getWorkspaceBackendRegistry } from "../postgres-init"
import { getEffectiveWorkspace } from "../state"

const Params = t({
  schemaName: "string",
  "dryRun?": "boolean",
  "workspace?": "string",
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
      const { schemaName, dryRun = false, workspace } = args as {
        schemaName: string
        dryRun?: boolean
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

        // 2. Get Enhanced JSON Schema for DDL generation
        const enhancedJson = schema.toEnhancedJson

        // 3. Dry run mode - generate DDL preview without executing
        if (dryRun) {
          // Determine dialect from schema's x-persistence.backend
          const backendName = enhancedJson['x-persistence']?.backend
          const dialect = backendName === 'sqlite'
            ? createSqliteDialect()
            : createPostgresDialect()

          // Derive namespace from schema name for table isolation
          const namespace = deriveNamespace(schemaName)

          const statements = generateSQL(enhancedJson, dialect, {
            ifNotExists: true,
            namespace,
          })

          return JSON.stringify({
            ok: true,
            dryRun: true,
            schemaName,
            namespace,
            backend: backendName || 'default',
            statements,
            statementCount: statements.length,
          })
        }

        // 4. Execute DDL via syncSchema (handles migration recording)
        // Backend selection: use workspace-specific SQLite when S3 mode enabled
        // and schema doesn't explicitly require postgres
        const schemaBackend = enhancedJson['x-persistence']?.backend
        const usePostgres = schemaBackend === 'postgres'

        const registry = usePostgres
          ? getGlobalBackendRegistry()  // System schemas → PostgreSQL
          : (isS3Enabled() && workspace
              ? await getWorkspaceBackendRegistry(effectiveWorkspace)  // User schemas → S3 SQLite
              : getGlobalBackendRegistry())

        const syncResult = await registry.syncSchema(schemaName, enhancedJson)

        // Format response based on sync result action
        const getVersion = () => {
          switch (syncResult.action) {
            case "created": return syncResult.version
            case "migrated": return syncResult.toVersion
            case "unchanged": return syncResult.version
            default: return undefined
          }
        }

        const getStatements = () => {
          if (syncResult.action === "created" || syncResult.action === "migrated") {
            return syncResult.statements
          }
          return []
        }

        const getMessage = () => {
          switch (syncResult.action) {
            case "bootstrap":
              return `Bootstrap schema '${schemaName}' initialized`
            case "created":
              return `Schema '${schemaName}' created (v${syncResult.version})`
            case "unchanged":
              return `Schema '${schemaName}' unchanged (v${syncResult.version})`
            case "migrated":
              return `Schema '${schemaName}' migrated from v${syncResult.fromVersion} to v${syncResult.toVersion}`
          }
        }

        return JSON.stringify({
          ok: true,
          dryRun: false,
          schemaName,
          action: syncResult.action,
          version: getVersion(),
          statements: getStatements(),
          statementCount: getStatements().length,
          executed: getStatements().length,
          message: getMessage(),
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
