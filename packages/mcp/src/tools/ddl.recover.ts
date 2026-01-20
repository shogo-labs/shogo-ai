/**
 * DDL Recover Tool
 *
 * MCP tool for recovering from failed or incomplete migrations.
 * Supports two recovery strategies:
 * - additive: Create only missing tables without affecting existing data
 * - reset: Clear migration records and re-run full migration from scratch
 *
 * Usage:
 * - Use 'additive' strategy for safe recovery that preserves data
 * - Use 'reset' strategy when you need a clean slate (data loss warning)
 * - Support dryRun mode to preview recovery actions
 *
 * @module mcp/tools/ddl.recover
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import {
  getMetaStore,
  deriveNamespace,
  getActualTablesFullNames,
  detectDialect,
  generateDDL,
  ddlOutputToSQL,
  createPostgresDialect,
  createSqliteDialect,
  isS3Enabled,
  findBySchema,
  toSnakeCase,
  qualifyTableName,
  normalizeTableNameForComparison,
  type QualifyDialect,
} from "@shogo/state-api"
import { getGlobalBackendRegistry, getWorkspaceBackendRegistry } from "../postgres-init"
import { getEffectiveWorkspace } from "../state"

const Params = t({
  schemaName: "string",
  strategy: "'additive' | 'reset'",
  "dryRun?": "boolean",
  "workspace?": "string",
})

export function registerDdlRecover(server: FastMCP) {
  server.addTool({
    name: "ddl.recover",
    description:
      "Recover from failed or incomplete migrations. " +
      "Strategy 'additive' creates missing tables only (safe). " +
      "Strategy 'reset' clears migration records and re-runs full migration (data loss warning). " +
      "Use dryRun: true to preview recovery actions.",
    parameters: Params,
    execute: async (args: any) => {
      const { schemaName, strategy, dryRun = false, workspace } = args as {
        schemaName: string
        strategy: "additive" | "reset"
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

        // 2. Get Enhanced JSON Schema
        const enhancedJson = schema.toEnhancedJson

        // 3. Get backend for operations
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
              message: `Cannot recover: backend "${backendName}" not found or has no executor.`,
            },
          })
        }

        const executor = backend.executor
        const isPostgres = backend.dialect === "pg" || backend.dialect === "postgres"
        const dialect = isPostgres ? createPostgresDialect() : createSqliteDialect()

        // Detect dialect for proper table name qualification
        const introspectionDialect = await detectDialect(executor)
        const qualifyDialect: QualifyDialect = (introspectionDialect === "pg" || introspectionDialect === "postgres" || introspectionDialect === "postgresql")
          ? "postgresql"
          : "sqlite"

        const namespace = deriveNamespace(schemaName)

        // Execute based on strategy
        if (strategy === "additive") {
          return await executeAdditiveRecovery(
            schemaName,
            enhancedJson,
            namespace,
            executor,
            dialect,
            introspectionDialect,
            qualifyDialect,
            dryRun
          )
        } else {
          return await executeResetRecovery(
            schemaName,
            enhancedJson,
            namespace,
            executor,
            dialect,
            qualifyDialect,
            registry,
            dryRun
          )
        }
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "RECOVERY_ERROR",
            message: error.message || "Failed to execute recovery",
            details: error.stack,
          },
        })
      }
    },
  })
}

/**
 * Execute additive recovery - create only missing tables.
 */
async function executeAdditiveRecovery(
  schemaName: string,
  enhancedJson: any,
  namespace: string,
  executor: any,
  dialect: any,
  introspectionDialect: any,
  qualifyDialect: QualifyDialect,
  dryRun: boolean
): Promise<string> {
  // Get expected tables using dialect-aware qualification
  const models = enhancedJson.$defs || enhancedJson.definitions || {}
  const expectedTables = Object.keys(models).map(modelName => {
    const tableName = toSnakeCase(modelName)
    return qualifyTableName(namespace, tableName, qualifyDialect)
  })

  // Get actual tables (pass namespace without __ suffix)
  let actualTables: string[] = []
  try {
    actualTables = await getActualTablesFullNames(namespace, executor, introspectionDialect)
  } catch {
    actualTables = []
  }

  // Find missing tables using normalization to handle quoting differences
  const actualNormalized = actualTables.map(normalizeTableNameForComparison)
  const missingTables = expectedTables.filter(t => !actualNormalized.includes(normalizeTableNameForComparison(t)))

  if (missingTables.length === 0) {
    return JSON.stringify({
      ok: true,
      strategy: "additive",
      dryRun,
      schemaName,
      namespace,
      message: "No missing tables - schema is already in sync",
      tablesCreated: [],
      migrationRecordsAffected: 0,
    })
  }

  // Generate DDL for the full schema to get proper CREATE TABLE statements
  const ddlOutput = generateDDL(enhancedJson, dialect, { namespace })

  // Filter to only tables that are missing
  const missingLower = missingTables.map(t => t.toLowerCase())
  const tablesToCreate = ddlOutput.tables.filter(t =>
    missingLower.includes(`${namespace}__${t.name}`.toLowerCase())
  )

  // Generate SQL for just the missing tables
  const statements: string[] = []
  for (const tableDef of tablesToCreate) {
    // Generate CREATE TABLE IF NOT EXISTS
    const createSql = dialect.createTable(tableDef, { ifNotExists: true })
    statements.push(createSql)
  }

  if (!dryRun && statements.length > 0) {
    // Execute the statements
    if (typeof executor.executeMany === "function") {
      await executor.executeMany(statements)
    } else {
      for (const stmt of statements) {
        await executor.execute([stmt, []])
      }
    }
  }

  return JSON.stringify({
    ok: true,
    strategy: "additive",
    dryRun,
    schemaName,
    namespace,
    tablesCreated: missingTables,
    statements: dryRun ? statements : undefined,
    migrationRecordsAffected: 0,
    message: dryRun
      ? `Dry run: would create ${missingTables.length} missing table(s)`
      : `Created ${missingTables.length} missing table(s)`,
  })
}

/**
 * Execute reset recovery - clear migration records and re-run full migration.
 */
async function executeResetRecovery(
  schemaName: string,
  enhancedJson: any,
  namespace: string,
  executor: any,
  dialect: any,
  qualifyDialect: QualifyDialect,
  registry: any,
  dryRun: boolean
): Promise<string> {
  // Get existing migration records
  const existingRecords = await findBySchema(schemaName)
  const recordCount = existingRecords.length

  // Generate full DDL for schema
  const ddlOutput = generateDDL(enhancedJson, dialect, { namespace })
  const statements = ddlOutputToSQL(ddlOutput, dialect, { ifNotExists: true })

  // Get expected tables using dialect-aware qualification
  const models = enhancedJson.$defs || enhancedJson.definitions || {}
  const expectedTables = Object.keys(models).map(modelName => {
    const tableName = toSnakeCase(modelName)
    return qualifyTableName(namespace, tableName, qualifyDialect)
  })

  if (dryRun) {
    return JSON.stringify({
      ok: true,
      strategy: "reset",
      dryRun: true,
      schemaName,
      namespace,
      tablesCreated: expectedTables,
      statements,
      migrationRecordsAffected: recordCount,
      warning: "DATA LOSS WARNING: Reset strategy will delete migration history. " +
        "Existing data may become inconsistent if tables already exist.",
      message: `Dry run: would clear ${recordCount} migration record(s) and execute ${statements.length} DDL statement(s)`,
    })
  }

  // Execute: Clear migration records for this schema
  // Note: This requires direct SQL since we need to delete from system-migrations
  const deleteRecordsSql = dialect.name === "sqlite"
    ? `DELETE FROM "system_migrations__migration_record" WHERE "schema_name" = ?`
    : `DELETE FROM "system_migrations__migration_record" WHERE "schema_name" = $1`

  try {
    await executor.execute([deleteRecordsSql, [schemaName]])
  } catch {
    // Migration record table might not exist yet, which is fine
  }

  // Execute DDL statements
  if (statements.length > 0) {
    if (typeof executor.executeMany === "function") {
      await executor.executeMany(statements)
    } else {
      for (const stmt of statements) {
        await executor.execute([stmt, []])
      }
    }
  }

  // Re-sync schema through normal orchestrator to create proper migration record
  await registry.syncSchema(schemaName, enhancedJson)

  return JSON.stringify({
    ok: true,
    strategy: "reset",
    dryRun: false,
    schemaName,
    namespace,
    tablesCreated: expectedTables,
    migrationRecordsAffected: recordCount,
    statementsExecuted: statements.length,
    message: `Reset complete: cleared ${recordCount} migration record(s), executed ${statements.length} DDL statement(s)`,
  })
}
