/**
 * Bootstrap Migration Module
 *
 * Handles migration of the system-migrations table from the old schema
 * (with single `version` column) to the new chain model schema
 * (with `fromVersion`, `toVersion`, `verified`, `verificationDetails`).
 *
 * This migration is idempotent - safe to run multiple times.
 *
 * Old schema:
 * - version: INTEGER (single version number)
 *
 * New schema:
 * - fromVersion: INTEGER (nullable, null for fresh deploy)
 * - toVersion: INTEGER (replaces version)
 * - verified: BOOLEAN (required)
 * - verificationDetails: TEXT (JSON, optional)
 *
 * @module ddl/bootstrap-migration
 */

import type { ISqlExecutor } from "../query/execution/types"
import { tableExists, getTableColumns, detectDialect, type IntrospectionDialect } from "./introspection"

/**
 * Result of checking if migration is needed.
 */
export interface MigrationNeededResult {
  /** Whether migration is needed */
  needed: boolean
  /** Reason migration is or isn't needed */
  reason: string
  /** Current columns if table exists */
  currentColumns?: string[]
}

/**
 * Result of running the bootstrap migration.
 */
export interface BootstrapMigrationResult {
  /** Whether migration was successful */
  success: boolean
  /** What action was taken */
  action: "migrated" | "already_migrated" | "no_table" | "error"
  /** Details about what happened */
  message: string
  /** SQL statements that were executed (if any) */
  statementsExecuted?: string[]
  /** Error message if migration failed */
  error?: string
}

/**
 * Check if the migration_record table needs to be migrated from v1 to v2 schema.
 *
 * Detects the old schema by checking for:
 * - Existence of `version` column (old schema)
 * - Absence of `from_version` column (new schema)
 *
 * @param executor - SQL executor to use for introspection
 * @param dialect - Optional dialect (auto-detected if not provided)
 * @returns Result indicating if migration is needed
 */
export async function isMigrationNeeded(
  executor: ISqlExecutor,
  dialect?: IntrospectionDialect
): Promise<MigrationNeededResult> {
  const effectiveDialect = dialect ?? await detectDialect(executor)
  // Namespace WITHOUT __ suffix - introspection handles dialect-specific naming
  const namespace = "system_migrations"
  const tableName = "migration_record"

  // Check if table exists
  const exists = await tableExists(namespace, tableName, executor, effectiveDialect)

  if (!exists) {
    return {
      needed: false,
      reason: "migration_record table does not exist (fresh install)",
    }
  }

  // Get current columns
  const columns = await getTableColumns(namespace, tableName, executor, effectiveDialect)
  const columnNames = columns.map(c => c.name.toLowerCase())

  // Check for old schema indicators
  const hasOldVersion = columnNames.includes("version")
  const hasNewFromVersion = columnNames.includes("from_version")
  const hasNewVerified = columnNames.includes("verified")

  if (hasNewFromVersion && hasNewVerified) {
    // Already has new schema
    return {
      needed: false,
      reason: "Table already has v2 schema (from_version, verified columns exist)",
      currentColumns: columnNames,
    }
  }

  if (hasOldVersion && !hasNewFromVersion) {
    // Has old schema, needs migration
    return {
      needed: true,
      reason: "Table has v1 schema (version column exists, from_version missing)",
      currentColumns: columnNames,
    }
  }

  // Unexpected state
  return {
    needed: false,
    reason: `Unexpected schema state: version=${hasOldVersion}, from_version=${hasNewFromVersion}`,
    currentColumns: columnNames,
  }
}

/**
 * Run the bootstrap migration to upgrade migration_record from v1 to v2 schema.
 *
 * Migration steps:
 * 1. Add fromVersion column (INTEGER, nullable)
 * 2. Add toVersion column (INTEGER, not null)
 * 3. Add verified column (BOOLEAN, not null, default true)
 * 4. Add verificationDetails column (TEXT, nullable)
 * 5. Copy version -> toVersion
 * 6. Set verified = success for existing records
 * 7. Drop version column (SQLite: requires table rebuild)
 *
 * The migration is idempotent - safe to run multiple times.
 *
 * @param executor - SQL executor to use
 * @param dialect - Optional dialect (auto-detected if not provided)
 * @returns Result of the migration
 */
export async function runBootstrapMigration(
  executor: ISqlExecutor,
  dialect?: IntrospectionDialect
): Promise<BootstrapMigrationResult> {
  const effectiveDialect = dialect ?? await detectDialect(executor)

  // Check if migration is needed
  const migrationCheck = await isMigrationNeeded(executor, effectiveDialect)

  if (!migrationCheck.needed) {
    if (migrationCheck.reason.includes("does not exist")) {
      return {
        success: true,
        action: "no_table",
        message: migrationCheck.reason,
      }
    }

    return {
      success: true,
      action: "already_migrated",
      message: migrationCheck.reason,
    }
  }

  // Execute migration based on dialect
  try {
    if (effectiveDialect === "sqlite") {
      return await runSqliteMigration(executor, effectiveDialect)
    } else {
      return await runPostgresMigration(executor, effectiveDialect)
    }
  } catch (error: any) {
    return {
      success: false,
      action: "error",
      message: "Migration failed",
      error: error.message || String(error),
    }
  }
}

/**
 * Run migration for SQLite.
 * SQLite doesn't support DROP COLUMN directly, so we need to rebuild the table.
 */
async function runSqliteMigration(
  executor: ISqlExecutor,
  dialect: IntrospectionDialect
): Promise<BootstrapMigrationResult> {
  const statements: string[] = []

  // SQLite migration: rename old table, create new table, copy data, drop old
  statements.push(
    // 1. Rename old table
    `ALTER TABLE "system_migrations__migration_record" RENAME TO "migration_record_v1_backup"`,

    // 2. Create new table with v2 schema
    `CREATE TABLE "system_migrations__migration_record" (
      "id" TEXT PRIMARY KEY,
      "schema_name" TEXT NOT NULL,
      "from_version" INTEGER,
      "to_version" INTEGER NOT NULL,
      "checksum" TEXT NOT NULL,
      "applied_at" INTEGER NOT NULL,
      "statements" TEXT,
      "success" INTEGER NOT NULL,
      "verified" INTEGER NOT NULL,
      "error_message" TEXT,
      "verification_details" TEXT
    )`,

    // 3. Copy data from old table, mapping version -> to_version
    `INSERT INTO "system_migrations__migration_record" (
      "id", "schema_name", "from_version", "to_version", "checksum",
      "applied_at", "statements", "success", "verified", "error_message"
    )
    SELECT
      "id", "schema_name", NULL, "version", "checksum",
      "applied_at", "statements", "success", "success", "error_message"
    FROM "migration_record_v1_backup"`,

    // 4. Drop backup table
    `DROP TABLE "migration_record_v1_backup"`
  )

  // Execute statements
  for (const stmt of statements) {
    await executor.execute([stmt, []])
  }

  // Verify migration
  const verifyResult = await isMigrationNeeded(executor, dialect)

  if (verifyResult.needed) {
    return {
      success: false,
      action: "error",
      message: "Migration completed but verification failed",
      statementsExecuted: statements,
      error: verifyResult.reason,
    }
  }

  return {
    success: true,
    action: "migrated",
    message: "Successfully migrated migration_record table to v2 schema",
    statementsExecuted: statements,
  }
}

/**
 * Run migration for PostgreSQL.
 * PostgreSQL supports ALTER TABLE ADD/DROP COLUMN directly.
 * Uses schema-qualified table names: "schema"."table"
 */
async function runPostgresMigration(
  executor: ISqlExecutor,
  dialect: IntrospectionDialect
): Promise<BootstrapMigrationResult> {
  const statements: string[] = []

  // PostgreSQL: use schema-qualified table name "system_migrations"."migration_record"
  const qualifiedTable = `"system_migrations"."migration_record"`

  // PostgreSQL migration: use ALTER TABLE to add/modify columns
  statements.push(
    // 1. Add new columns (if they don't exist)
    `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS "from_version" INTEGER`,
    `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS "to_version" INTEGER`,
    `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS "verified" BOOLEAN DEFAULT true`,
    `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS "verification_details" TEXT`,

    // 2. Copy version -> to_version for existing records (if version exists)
    `UPDATE ${qualifiedTable} SET "to_version" = "version" WHERE "to_version" IS NULL AND "version" IS NOT NULL`,

    // 3. Set verified = success for existing records
    `UPDATE ${qualifiedTable} SET "verified" = "success" WHERE "verified" IS NULL`,

    // 4. Drop old version column
    `ALTER TABLE ${qualifiedTable} DROP COLUMN IF EXISTS "version"`
  )

  // Execute statements
  for (const stmt of statements) {
    try {
      await executor.execute([stmt, []])
    } catch (error: any) {
      // Some statements may fail if columns already exist/don't exist
      // Continue with other statements
      if (!error.message?.includes("already exists") && !error.message?.includes("does not exist")) {
        throw error
      }
    }
  }

  // Verify migration
  const verifyResult = await isMigrationNeeded(executor, dialect)

  if (verifyResult.needed) {
    return {
      success: false,
      action: "error",
      message: "Migration completed but verification failed",
      statementsExecuted: statements,
      error: verifyResult.reason,
    }
  }

  return {
    success: true,
    action: "migrated",
    message: "Successfully migrated migration_record table to v2 schema",
    statementsExecuted: statements,
  }
}
