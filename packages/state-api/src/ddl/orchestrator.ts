/**
 * Schema Sync Orchestrator
 *
 * Coordinates schema synchronization by detecting the current state (bootstrap, fresh deploy,
 * unchanged, or migration needed) and executing the appropriate actions.
 *
 * This is the main entry point for ensuring a schema is synchronized with the database.
 *
 * Requirements:
 * - REQ-DDL-MIG-005: Orchestrate schema synchronization
 */

import { getLatestMigration, recordMigration, computeSchemaChecksum } from "./migration-tracker"
import { compareSchemas } from "./diff"
import { generateMigration, migrationOutputToSQL } from "./migration-generator"
import { createSqliteDialect, createPostgresDialect } from "./dialect"
import { deriveNamespace } from "./namespace"
import type { BackendRegistry } from "../query/registry"
import { getMetaStore } from "../meta/bootstrap"
import { cacheRuntimeStore } from "../meta/runtime-store-cache"
import { domain } from "../domain/domain"
import { NullPersistence } from "../persistence/null"
import { getSchemaSnapshot } from "../persistence/schema-io"

// ============================================================================
// Schema Sync Result Types (Discriminated Union)
// ============================================================================

/**
 * Result when a bootstrap schema is synced.
 * Bootstrap schemas skip self-checking to avoid circular dependency.
 */
export interface SchemaSyncResultBootstrap {
  action: "bootstrap"
}

/**
 * Result when a schema is created for the first time (fresh deploy).
 */
export interface SchemaSyncResultCreated {
  action: "created"
  /** Always 1 for fresh deploy */
  version: 1
  /** SQL statements that were executed */
  statements: string[]
}

/**
 * Result when a schema is unchanged from last sync.
 */
export interface SchemaSyncResultUnchanged {
  action: "unchanged"
  /** Current schema version */
  version: number
}

/**
 * Result when a schema was migrated to a new version.
 */
export interface SchemaSyncResultMigrated {
  action: "migrated"
  /** Previous schema version */
  fromVersion: number
  /** New schema version after migration */
  toVersion: number
  /** SQL statements that were executed */
  statements: string[]
}

/**
 * Discriminated union of all possible schema sync results.
 */
export type SchemaSyncResult =
  | SchemaSyncResultBootstrap
  | SchemaSyncResultCreated
  | SchemaSyncResultUnchanged
  | SchemaSyncResultMigrated

// ============================================================================
// Orchestrator Implementation
// ============================================================================

/**
 * Ensures a schema is synchronized with the database.
 *
 * This is the main orchestration function that:
 * 1. Handles bootstrap schemas (skips self-checking)
 * 2. Detects fresh deploys (no prior migrations)
 * 3. Detects unchanged schemas (checksum matches)
 * 4. Runs migrations when schemas have changed
 *
 * @param schemaName - Name of the schema to sync
 * @param schema - Enhanced JSON Schema with x-persistence metadata
 * @param registry - Backend registry for executing DDL
 * @returns Promise resolving to SchemaSyncResult
 *
 * @example
 * ```ts
 * const result = await ensureSchemaSynced("user-schema", userSchema, registry)
 *
 * switch (result.action) {
 *   case "bootstrap":
 *     console.log("Bootstrap schema initialized")
 *     break
 *   case "created":
 *     console.log(`Schema created at v${result.version}`)
 *     break
 *   case "unchanged":
 *     console.log(`Schema unchanged at v${result.version}`)
 *     break
 *   case "migrated":
 *     console.log(`Migrated from v${result.fromVersion} to v${result.toVersion}`)
 *     break
 * }
 * ```
 */
export async function ensureSchemaSynced(
  schemaName: string,
  schema: any,
  registry: BackendRegistry
): Promise<SchemaSyncResult> {
  // 1. Bootstrap case - skip self-checking to avoid circular dependency
  // Bootstrap schemas are auto-initialized during registry.initialize()
  if (schema["x-persistence"]?.bootstrap === true) {
    await registry.executeDDL(schemaName, schema, { ifNotExists: true })

    // For system-migrations, also initialize the runtime store
    // so subsequent schemas can record their migrations
    if (schemaName === "system-migrations") {
      initializeSystemMigrationsStore(schema, registry)
    }

    return { action: "bootstrap" }
  }

  // 2. Check latest migration for this schema
  const latest = await getLatestMigration(schemaName)
  const currentChecksum = computeSchemaChecksum(schema)

  // 3. Fresh deploy - no migration exists yet
  if (!latest) {
    const result = await registry.executeDDL(schemaName, schema, { ifNotExists: true })

    // Record v1 migration
    await recordMigration({
      schemaName,
      version: 1,
      checksum: currentChecksum,
      appliedAt: Date.now(),
      statements: result.statements,
      success: true,
    })

    return {
      action: "created",
      version: 1,
      statements: result.statements,
    }
  }

  // 4. Unchanged - checksum matches latest migration
  if (latest.checksum === currentChecksum) {
    return {
      action: "unchanged",
      version: latest.version,
    }
  }

  // 5. Migration needed - checksum differs from latest
  // We need to get the old schema to compute diff
  // For now, we'll use the fact that we have the new schema and need to generate migration SQL
  const oldSchema = await reconstructSchemaFromMigration(schemaName, latest.version)
  const dialect = getDialect(schema, registry)
  const diff = compareSchemas(oldSchema, schema)

  // Generate migration operations with namespace for table name prefixing
  const namespace = deriveNamespace(schemaName)
  const migrationOutput = generateMigration(diff, dialect, {
    schemaName,
    version: latest.version + 1,
    namespace,
  })

  // Convert to SQL statements
  const statements = migrationOutputToSQL(migrationOutput, dialect)

  // Execute migration statements
  await executeMigrationStatements(statements, registry, schema)

  // Record new migration
  const newVersion = latest.version + 1
  await recordMigration({
    schemaName,
    version: newVersion,
    checksum: currentChecksum,
    appliedAt: Date.now(),
    statements,
    success: true,
  })

  return {
    action: "migrated",
    fromVersion: latest.version,
    toVersion: newVersion,
    statements,
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets the appropriate SQL dialect from the registry's actual backend.
 *
 * This uses the ACTUAL runtime backend's dialect, not the schema's declared backend.
 * This is critical because a schema may declare "postgres" but the runtime may fall
 * back to SQLite if DATABASE_URL is not set. In that case, the SQLite backend is
 * registered under both "sqlite" AND "postgres" names.
 *
 * @param schema - Enhanced JSON Schema with x-persistence metadata
 * @param registry - Backend registry to look up actual backend
 * @returns SQL dialect matching the runtime backend
 */
function getDialect(schema: any, registry: BackendRegistry) {
  // Get the backend registered under the schema's declared backend name
  // This works because when DATABASE_URL is not set, SQLite is registered
  // under both "sqlite" AND "postgres" names (see postgres-init.ts)
  const backendName = schema["x-persistence"]?.backend
  const backend = backendName ? registry.get(backendName) : undefined

  // Use the ACTUAL backend's dialect property
  if (backend?.dialect === "sqlite") {
    return createSqliteDialect()
  }
  if (backend?.dialect === "pg" || backend?.dialect === "postgres" || backend?.dialect === "postgresql") {
    return createPostgresDialect()
  }

  // Fallback: if no backend found, use schema's declared backend
  if (backendName === "postgresql" || backendName === "postgres") {
    return createPostgresDialect()
  }

  // Default to SQLite
  return createSqliteDialect()
}

/**
 * Reconstructs the old schema from filesystem history.
 *
 * Uses the schema versioning system in schema-io.ts which automatically
 * saves snapshots to .schemas/{schemaName}/history/v{N}.json before
 * each schema update.
 *
 * @param schemaName - Name of the schema
 * @param version - Version number to retrieve
 * @returns Schema at the specified version, or empty schema if not found
 */
async function reconstructSchemaFromMigration(
  schemaName: string,
  version: number
): Promise<any> {
  try {
    const snapshot = await getSchemaSnapshot(schemaName, version)
    return snapshot.schema
  } catch {
    // Version not found in history - return empty for full table creation
    // This handles first migration where no history exists yet
    return { $defs: {} }
  }
}

/**
 * Executes migration SQL statements using the registry's backend.
 */
async function executeMigrationStatements(
  statements: string[],
  registry: BackendRegistry,
  schema: any
): Promise<void> {
  // Get the backend from registry
  const backendName = schema["x-persistence"]?.backend || "sql"
  const backend = registry.get(backendName)

  if (!backend || !backend.executor) {
    throw new Error(`Cannot execute migration: backend "${backendName}" not found or has no executor`)
  }

  // Filter out comments and use executeMany for DDL-style statements
  const filteredStatements = statements.filter(stmt => !stmt.startsWith("--"))

  // Use executeMany if available (preferred for DDL statements)
  if (typeof backend.executor.executeMany === "function") {
    await backend.executor.executeMany(filteredStatements)
  } else {
    // Fallback: execute each statement individually
    // Note: execute expects a tuple [sql, params]
    for (const stmt of filteredStatements) {
      await backend.executor.execute([stmt, []])
    }
  }
}

/**
 * Initializes the runtime store for system-migrations schema.
 *
 * This is called after bootstrap DDL to ensure the migration tracker
 * has an active store for recording migrations of other schemas.
 *
 * Uses domain() factory to apply CollectionMutatable mixin, enabling
 * insertOne() for SQL persistence (same pattern as schema.load).
 *
 * @param schema - The system-migrations Enhanced JSON Schema
 * @param registry - The BackendRegistry singleton from startup chain
 */
function initializeSystemMigrationsStore(schema: any, registry: BackendRegistry): void {
  const metaStore = getMetaStore()

  // Ingest schema into metaStore if not already present
  let schemaEntity = metaStore.schemaCollection.all().find(
    (s: any) => s.name === "system-migrations"
  )

  if (!schemaEntity) {
    schemaEntity = metaStore.ingestEnhancedJsonSchema(schema, {
      name: "system-migrations"
    })
  }

  // Use domain() for proper mixin composition (same as schema.load)
  const d = domain({
    name: "system-migrations",
    from: schema
  })

  // Create store with backendRegistry - enables insertOne() to persist to SQL
  // Use NullPersistence since SQL backend handles actual persistence
  const runtimeStore = d.createStore({
    services: {
      persistence: new NullPersistence(),
      backendRegistry: registry
    },
    context: {
      schemaName: "system-migrations"
    }
  })

  cacheRuntimeStore(schemaEntity.id, runtimeStore)
}
