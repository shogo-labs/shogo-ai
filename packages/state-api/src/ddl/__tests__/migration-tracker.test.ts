/**
 * Migration Tracker Tests
 *
 * Generated from TestSpecifications for task-mig-008-tracker.
 * Tests functions for tracking applied migrations in the system-migrations store.
 *
 * Requirements:
 * - REQ-DDL-MIG-004: Track applied migrations
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { resetMetaStore, getMetaStore, clearRuntimeStores, cacheRuntimeStore } from "../../meta/bootstrap"
import { BunSqlExecutor } from "../../query/execution/bun-sql"
import { SqlBackend } from "../../query/backends/sql"
import { BackendRegistry } from "../../query/registry"
import { domain } from "../../domain/domain"
import { NullPersistence } from "../../persistence/null"
import {
  getAppliedMigrations,
  getLatestMigration,
  isMigrationApplied,
  recordMigration,
  computeSchemaChecksum,
  getChain,
  getLastApplied,
  findBySchema,
} from "../migration-tracker"

// System migrations schema for testing (v2 with chain model)
// Note: x-original-name is required for enhancedJsonSchemaToMST to recognize entity types
const systemMigrationsSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "system-migrations",
  "x-persistence": {
    bootstrap: true,
    backend: "sql",
  },
  $defs: {
    MigrationRecord: {
      type: "object",
      "x-original-name": "MigrationRecord",
      properties: {
        id: { type: "string", "x-mst-type": "identifier" },
        schemaName: { type: "string" },
        fromVersion: { type: "integer" },
        toVersion: { type: "integer" },
        checksum: { type: "string" },
        appliedAt: { type: "number" },
        statements: { type: "array" },
        success: { type: "boolean" },
        verified: { type: "boolean" },
        errorMessage: { type: "string" },
        verificationDetails: { type: "object" },
      },
      required: ["id", "schemaName", "toVersion", "checksum", "appliedAt", "success", "verified"],
    },
  },
}

describe("Migration Tracker", () => {
  let db: Database
  let registry: BackendRegistry

  beforeEach(async () => {
    // Reset state
    resetMetaStore()
    clearRuntimeStores()

    // Create fresh in-memory SQLite database
    db = new Database(":memory:")
    const executor = new BunSqlExecutor(db)
    const backend = new SqlBackend({ dialect: "sqlite", executor })

    // Set up registry with SQL backend
    registry = new BackendRegistry()
    registry.register("sql", backend)
    registry.setDefault("sql")

    // Ingest system-migrations schema into meta-store
    const schemaEntity = getMetaStore().ingestEnhancedJsonSchema(systemMigrationsSchema, { name: "system-migrations" })

    // Execute DDL to create tables
    await registry.initialize()

    // Create and cache runtime store for system-migrations
    // Use domain() for proper mixin composition (matches production setup)
    const d = domain({
      name: "system-migrations",
      from: systemMigrationsSchema
    })

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
  })

  describe("getAppliedMigrations", () => {
    test("returns all migrations for schema ordered by toVersion", async () => {
      // Given: Test data seeded with 3 MigrationRecord entities
      const schemaEntity = getMetaStore().schemaCollection.all().find((s: any) => s.name === "system-migrations")
      const store = schemaEntity?.runtimeStore

      // Seed test data (use insertOne to persist to SQL backend)
      // Note: statements array must be JSON-serialized for SQL TEXT storage
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: 1,
        toVersion: 2,
        checksum: "abc222",
        appliedAt: 2000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: null,
        toVersion: 1,
        checksum: "abc111",
        appliedAt: 1000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: 2,
        toVersion: 3,
        checksum: "abc333",
        appliedAt: 3000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })

      // When: getAppliedMigrations is called
      const migrations = await getAppliedMigrations("user-schema")

      // Then: Returns array of 3 records ordered by toVersion ascending
      expect(migrations.length).toBe(3)
      expect(migrations[0].toVersion).toBe(1)
      expect(migrations[1].toVersion).toBe(2)
      expect(migrations[2].toVersion).toBe(3)
    })

    test("returns empty array for new schema", async () => {
      // Given: No MigrationRecord entities for 'new-schema'

      // When: getAppliedMigrations is called
      const migrations = await getAppliedMigrations("new-schema")

      // Then: Returns empty array
      expect(migrations).toEqual([])
    })
  })

  describe("getLatestMigration", () => {
    test("returns most recent migration by toVersion", async () => {
      // Given: Test data seeded with migrations v1, v2, v3
      const schemaEntity = getMetaStore().schemaCollection.all().find((s: any) => s.name === "system-migrations")
      const store = schemaEntity?.runtimeStore

      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: null,
        toVersion: 1,
        checksum: "abc111",
        appliedAt: 1000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: 2,
        toVersion: 3,
        checksum: "abc333",
        appliedAt: 3000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: 1,
        toVersion: 2,
        checksum: "abc222",
        appliedAt: 2000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })

      // When: getLatestMigration is called
      const latest = await getLatestMigration("user-schema")

      // Then: Returns MigrationRecord with toVersion 3
      expect(latest).not.toBeNull()
      expect(latest!.toVersion).toBe(3)
      expect(latest!.schemaName).toBe("user-schema")
    })

    test("returns null for new schema", async () => {
      // Given: No MigrationRecord entities for 'new-schema'

      // When: getLatestMigration is called
      const latest = await getLatestMigration("new-schema")

      // Then: Returns null
      expect(latest).toBeNull()
    })
  })

  describe("isMigrationApplied", () => {
    test("returns true for applied version", async () => {
      // Given: Test data seeded with MigrationRecord for toVersion=2
      const schemaEntity = getMetaStore().schemaCollection.all().find((s: any) => s.name === "system-migrations")
      const store = schemaEntity?.runtimeStore

      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: 1,
        toVersion: 2,
        checksum: "abc222",
        appliedAt: 2000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })

      // When: isMigrationApplied is called
      const result = await isMigrationApplied("user-schema", 2)

      // Then: Returns true
      expect(result).toBe(true)
    })

    test("returns false for unapplied version", async () => {
      // Given: Test data seeded with MigrationRecord for toVersion=1 only
      const schemaEntity = getMetaStore().schemaCollection.all().find((s: any) => s.name === "system-migrations")
      const store = schemaEntity?.runtimeStore

      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: null,
        toVersion: 1,
        checksum: "abc111",
        appliedAt: 1000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })

      // When: isMigrationApplied is called for v2
      const result = await isMigrationApplied("user-schema", 2)

      // Then: Returns false
      expect(result).toBe(false)
    })
  })

  describe("recordMigration", () => {
    test("creates new MigrationRecord", async () => {
      // Given: Valid MigrationRecord data with chain model
      const record = {
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: null as number | null,
        toVersion: 1,
        checksum: "abc123",
        appliedAt: Date.now(),
        statements: ["CREATE TABLE users (id TEXT)"],
        success: true,
        verified: true,
      }

      // When: recordMigration is called
      await recordMigration(record)

      // Then: Record retrievable via getAppliedMigrations
      const migrations = await getAppliedMigrations("user-schema")
      expect(migrations.length).toBe(1)
      expect(migrations[0].schemaName).toBe("user-schema")
      expect(migrations[0].toVersion).toBe(1)
      // SQLite returns null as undefined
      expect(migrations[0].fromVersion == null).toBe(true)
      expect(migrations[0].checksum).toBe("abc123")
    })
  })

  describe("computeSchemaChecksum", () => {
    test("returns consistent hash", () => {
      // Given: Schema object with specific content
      const schema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      }

      // When: computeSchemaChecksum called twice
      const hash1 = computeSchemaChecksum(schema)
      const hash2 = computeSchemaChecksum(schema)

      // Then: Returns same hash both times
      expect(hash1).toBe(hash2)
      expect(typeof hash1).toBe("string")
      expect(hash1.length).toBeGreaterThan(0)
    })

    test("detects changes", () => {
      // Given: Two different schemas
      const schemaA = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      }

      const schemaB = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              email: { type: "string" },
            },
          },
        },
      }

      // When: computeSchemaChecksum called on both
      const hashA = computeSchemaChecksum(schemaA)
      const hashB = computeSchemaChecksum(schemaB)

      // Then: Returns different hash for each
      expect(hashA).not.toBe(hashB)
    })
  })

  describe("Graceful degradation", () => {
    test("handles uninitialized system-migrations gracefully", async () => {
      // Given: Reset to simulate uninitialized state
      resetMetaStore()
      clearRuntimeStores()
      // Note: NOT loading system-migrations schema

      // When: getAppliedMigrations is called
      const migrations = await getAppliedMigrations("some-schema")

      // Then: Returns empty array without throwing
      expect(migrations).toEqual([])
    })
  })

  describe("getChain", () => {
    test("returns complete migration chain ordered by toVersion", async () => {
      const schemaEntity = getMetaStore().schemaCollection.all().find((s: any) => s.name === "system-migrations")
      const store = schemaEntity?.runtimeStore

      // Insert migrations out of order
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: 1,
        toVersion: 2,
        checksum: "abc222",
        appliedAt: 2000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: null,
        toVersion: 1,
        checksum: "abc111",
        appliedAt: 1000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })

      const chain = await getChain("user-schema")

      expect(chain.length).toBe(2)
      expect(chain[0].toVersion).toBe(1)
      // SQLite returns null as undefined
      expect(chain[0].fromVersion == null).toBe(true)
      expect(chain[1].toVersion).toBe(2)
      expect(chain[1].fromVersion).toBe(1)
    })

    test("returns empty array for non-existent schema", async () => {
      const chain = await getChain("non-existent-schema")
      expect(chain).toEqual([])
    })
  })

  describe("getLastApplied", () => {
    test("returns highest verified migration", async () => {
      const schemaEntity = getMetaStore().schemaCollection.all().find((s: any) => s.name === "system-migrations")
      const store = schemaEntity?.runtimeStore

      // v1: success + verified
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: null,
        toVersion: 1,
        checksum: "abc111",
        appliedAt: 1000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })
      // v2: success but NOT verified
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: 1,
        toVersion: 2,
        checksum: "abc222",
        appliedAt: 2000,
        statements: JSON.stringify([]),
        success: true,
        verified: false,
      })
      // v3: NOT success
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: 2,
        toVersion: 3,
        checksum: "abc333",
        appliedAt: 3000,
        statements: JSON.stringify([]),
        success: false,
        verified: false,
      })

      const lastApplied = await getLastApplied("user-schema")

      // Should return v1 because it's the highest with success=true AND verified=true
      expect(lastApplied).not.toBeNull()
      expect(lastApplied!.toVersion).toBe(1)
    })

    test("returns null when no verified migrations exist", async () => {
      const schemaEntity = getMetaStore().schemaCollection.all().find((s: any) => s.name === "system-migrations")
      const store = schemaEntity?.runtimeStore

      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: null,
        toVersion: 1,
        checksum: "abc111",
        appliedAt: 1000,
        statements: JSON.stringify([]),
        success: true,
        verified: false,
      })

      const lastApplied = await getLastApplied("user-schema")
      expect(lastApplied).toBeNull()
    })
  })

  describe("findBySchema", () => {
    test("returns all migrations for schema", async () => {
      const schemaEntity = getMetaStore().schemaCollection.all().find((s: any) => s.name === "system-migrations")
      const store = schemaEntity?.runtimeStore

      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "user-schema",
        fromVersion: null,
        toVersion: 1,
        checksum: "abc111",
        appliedAt: 1000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })
      await store.migrationRecordCollection.insertOne({
        id: crypto.randomUUID(),
        schemaName: "other-schema",
        fromVersion: null,
        toVersion: 1,
        checksum: "def111",
        appliedAt: 1000,
        statements: JSON.stringify([]),
        success: true,
        verified: true,
      })

      const migrations = await findBySchema("user-schema")
      expect(migrations.length).toBe(1)
      expect(migrations[0].schemaName).toBe("user-schema")
    })
  })
})

describe("Tracker exports", () => {
  test("functions are exported from barrel", async () => {
    // Dynamic import to test exports
    const ddl = await import("../index")

    // Then: All tracker functions are exported
    expect(typeof ddl.getAppliedMigrations).toBe("function")
    expect(typeof ddl.getLatestMigration).toBe("function")
    expect(typeof ddl.isMigrationApplied).toBe("function")
    expect(typeof ddl.recordMigration).toBe("function")
    expect(typeof ddl.computeSchemaChecksum).toBe("function")
    expect(typeof ddl.getChain).toBe("function")
    expect(typeof ddl.getLastApplied).toBe("function")
    expect(typeof ddl.findBySchema).toBe("function")
  })
})
