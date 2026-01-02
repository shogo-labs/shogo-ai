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
import type { BackendRegistry } from "../query/registry"
import { getMetaStore } from "../meta/bootstrap"
import { cacheRuntimeStore } from "../meta/runtime-store-cache"
import { domain } from "../domain/domain"
import { NullPersistence } from "../persistence/null"

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
  const dialect = getDialect(schema)
  const diff = compareSchemas(oldSchema, schema)

  // Generate migration operations
  const migrationOutput = generateMigration(diff, dialect, {
    schemaName,
    version: latest.version + 1,
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
 * Gets the appropriate SQL dialect based on schema's x-persistence.backend.
 */
function getDialect(schema: any) {
  const backend = schema["x-persistence"]?.backend
  if (backend === "postgresql" || backend === "postgres") {
    return createPostgresDialect()
  }
  // Default to SQLite
  return createSqliteDialect()
}

/**
 * Reconstructs the old schema from migration history.
 *
 * This is a simplified approach - in a real implementation, we might:
 * 1. Store the full schema JSON in migration records
 * 2. Apply migration operations in reverse to reconstruct
 * 3. Use schema versioning in a separate table
 *
 * For now, we look up the schema from meta-store (which has the current version).
 * This means diff detection works by comparing current meta-store state.
 */
async function reconstructSchemaFromMigration(
  schemaName: string,
  version: number
): Promise<any> {
  // Get the schema entity from meta-store
  const metaStore = getMetaStore()
  const schemaEntity = metaStore.schemaCollection.all().find(
    (s: any) => s.name === schemaName
  )

  if (!schemaEntity) {
    // Return empty schema - diff will treat all current models as added
    return { $defs: {} }
  }

  // Get the previous schema state
  // Note: In a production system, we'd store full schema snapshots
  // For now, return empty to trigger full migration generation
  // The migration generator will handle this as "add all columns"
  return { $defs: {} }
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
