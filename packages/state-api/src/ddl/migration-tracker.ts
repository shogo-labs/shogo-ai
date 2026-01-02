/**
 * Migration Tracker
 *
 * Functions for tracking applied migrations using the system-migrations store.
 * Provides query and record functions for migration state management.
 *
 * Requirements:
 * - REQ-DDL-MIG-004: Track applied migrations
 */

import { getMetaStore } from "../meta/bootstrap"
import type { MigrationRecord } from "./migration-types"
import type { BackendRegistry } from "../query/registry"

/**
 * Get the system-migrations runtime store.
 *
 * @returns Runtime store for system-migrations, or null if not initialized
 *
 * @remarks
 * Returns null if system-migrations schema hasn't been loaded yet.
 * Callers should handle graceful degradation.
 */
function getSystemMigrationsStore(): any | null {
  try {
    const metaStore = getMetaStore()
    const schemaEntity = metaStore.schemaCollection.all().find(
      (s: any) => s.name === "system-migrations"
    )

    if (!schemaEntity) {
      return null
    }

    return schemaEntity.runtimeStore
  } catch {
    return null
  }
}

/**
 * Get all applied migrations for a schema, ordered by version ascending.
 *
 * @param schemaName - Name of the schema to get migrations for
 * @returns Array of MigrationRecord objects, ordered by version
 *
 * @remarks
 * Uses query() to fetch from SQL database (not just MST memory).
 * Returns empty array if:
 * - system-migrations store is not initialized
 * - No migrations exist for the schema
 */
export async function getAppliedMigrations(schemaName: string): Promise<MigrationRecord[]> {
  const store = getSystemMigrationsStore()

  if (!store) {
    // Graceful degradation - system-migrations not initialized
    return []
  }

  try {
    const collection = store.migrationRecordCollection

    // Query SQL directly (not MST memory) for all migrations
    return await collection.query()
      .where({ schemaName })
      .orderBy("version", "asc")
      .toArray()
  } catch {
    return []
  }
}

/**
 * Get the latest (highest version) migration for a schema.
 *
 * @param schemaName - Name of the schema to get latest migration for
 * @returns Latest MigrationRecord or null if none exist
 *
 * @remarks
 * Uses query() to fetch from SQL database (not just MST memory).
 * This ensures migrations are found on server restart.
 */
export async function getLatestMigration(schemaName: string): Promise<MigrationRecord | null> {
  const store = getSystemMigrationsStore()

  if (!store) {
    return null
  }

  try {
    const collection = store.migrationRecordCollection

    // Query SQL directly (not MST memory) to find latest migration
    // This ensures idempotency across server restarts
    const result = await collection.query()
      .where({ schemaName })
      .orderBy("version", "desc")
      .first()

    return result ?? null
  } catch {
    return null
  }
}

/**
 * Check if a specific migration version has been applied.
 *
 * @param schemaName - Name of the schema
 * @param version - Version number to check
 * @returns True if version has been applied, false otherwise
 *
 * @remarks
 * Uses query() to check SQL database (not just MST memory).
 */
export async function isMigrationApplied(schemaName: string, version: number): Promise<boolean> {
  const store = getSystemMigrationsStore()

  if (!store) {
    return false
  }

  try {
    const collection = store.migrationRecordCollection

    // Query SQL directly (not MST memory) to check if version exists
    return await collection.query()
      .where({ schemaName, version })
      .any()
  } catch {
    return false
  }
}

/**
 * Record a new migration in the system-migrations store.
 *
 * @param record - MigrationRecord data to store
 * @throws Error if system-migrations store is not initialized
 *
 * @remarks
 * Use this to record successful or failed migration attempts.
 * The record should include all required fields:
 * - id, schemaName, version, checksum, appliedAt, success
 * - Optional: statements, errorMessage
 */
export async function recordMigration(record: Omit<MigrationRecord, "id"> & { id?: string }): Promise<void> {
  const store = getSystemMigrationsStore()

  if (!store) {
    throw new Error(
      "Cannot record migration: system-migrations store not initialized. " +
      "Call BackendRegistry.initialize() first."
    )
  }

  const recordWithId = {
    ...record,
    id: record.id ?? crypto.randomUUID(),
    // Serialize statements array to JSON for SQL TEXT storage
    statements: record.statements ? JSON.stringify(record.statements) : undefined,
  }

  // Use insertOne() to persist to SQL (via CollectionMutatable mixin)
  await store.migrationRecordCollection.insertOne(recordWithId)
}

/**
 * Compute a checksum for a schema to detect drift.
 *
 * @param schema - Enhanced JSON Schema to hash
 * @returns Deterministic hash string
 *
 * @remarks
 * Uses JSON stringification with recursively sorted keys for deterministic output.
 * Only considers $defs for the hash (ignores metadata like $schema, $id).
 */
export function computeSchemaChecksum(schema: any): string {
  // Extract only the $defs for consistent hashing
  const contentToHash = schema.$defs ?? schema

  // Deterministic JSON serialization with recursively sorted keys
  const serialized = stableStringify(contentToHash)

  // Simple hash using built-in crypto
  return hashString(serialized)
}

/**
 * Recursively sorts object keys for deterministic JSON serialization.
 *
 * @param obj - Value to serialize
 * @returns JSON string with all object keys sorted alphabetically
 */
function stableStringify(obj: any): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj)
  }

  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]"
  }

  if (typeof obj === "object") {
    const sortedKeys = Object.keys(obj).sort()
    const pairs = sortedKeys.map(key => JSON.stringify(key) + ":" + stableStringify(obj[key]))
    return "{" + pairs.join(",") + "}"
  }

  return JSON.stringify(obj)
}

/**
 * Simple string hash function using djb2 algorithm.
 *
 * @param str - String to hash
 * @returns Hex string hash
 */
function hashString(str: string): string {
  let hash = 5381

  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
  }

  // Convert to unsigned 32-bit and then to hex
  return (hash >>> 0).toString(16)
}
