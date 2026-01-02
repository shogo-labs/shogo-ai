/**
 * Orchestrator Tests
 *
 * Generated for task-p2-orchestrator.
 * Tests the ensureSchemaSynced() orchestrator function that coordinates
 * schema synchronization across bootstrap, fresh deploy, unchanged, and migration scenarios.
 *
 * Requirements:
 * - REQ-DDL-MIG-005: Orchestrate schema synchronization
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { resetMetaStore, getMetaStore, clearRuntimeStores } from "../../meta/bootstrap"
import { BunSqlExecutor } from "../../query/execution/bun-sql"
import { SqlBackend } from "../../query/backends/sql"
import { BackendRegistry } from "../../query/registry"

// Import the functions under test (will fail initially)
import {
  ensureSchemaSynced,
  type SchemaSyncResult,
  type SchemaSyncResultCreated,
  type SchemaSyncResultMigrated,
  type SchemaSyncResultUnchanged,
  type SchemaSyncResultBootstrap,
} from "../orchestrator"

// System migrations schema for testing
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
        version: { type: "integer" },
        checksum: { type: "string" },
        appliedAt: { type: "number" },
        statements: { type: "array", items: { type: "string" } },
        success: { type: "boolean" },
        errorMessage: { type: "string" },
      },
      required: ["id", "schemaName", "version", "checksum", "appliedAt", "success"],
    },
  },
}

// Test user schema for non-bootstrap tests
const userSchemaV1 = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "user-schema",
  "x-persistence": {
    backend: "sql",
  },
  $defs: {
    User: {
      type: "object",
      "x-original-name": "User",
      properties: {
        id: { type: "string", "x-mst-type": "identifier" },
        name: { type: "string" },
        email: { type: "string" },
      },
      required: ["id", "name"],
    },
  },
}

// Modified user schema for migration tests
const userSchemaV2 = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "user-schema",
  "x-persistence": {
    backend: "sql",
  },
  $defs: {
    User: {
      type: "object",
      "x-original-name": "User",
      properties: {
        id: { type: "string", "x-mst-type": "identifier" },
        name: { type: "string" },
        email: { type: "string" },
        age: { type: "integer" }, // Added column
      },
      required: ["id", "name"],
    },
  },
}

describe("Orchestrator", () => {
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

    // Bootstrap system-migrations via ensureSchemaSynced (NOT manual store creation)
    // This ensures the runtime store is created via domain() with CollectionMutatable mixin
    await ensureSchemaSynced("system-migrations", systemMigrationsSchema, registry)
  })

  describe("SchemaSyncResult types", () => {
    test("bootstrap result has action 'bootstrap'", () => {
      const result: SchemaSyncResultBootstrap = { action: "bootstrap" }
      expect(result.action).toBe("bootstrap")
    })

    test("created result has action 'created', version 1, and statements", () => {
      const result: SchemaSyncResultCreated = {
        action: "created",
        version: 1,
        statements: ["CREATE TABLE user (id TEXT PRIMARY KEY)"],
      }
      expect(result.action).toBe("created")
      expect(result.version).toBe(1)
      expect(result.statements).toEqual(["CREATE TABLE user (id TEXT PRIMARY KEY)"])
    })

    test("unchanged result has action 'unchanged' and version", () => {
      const result: SchemaSyncResultUnchanged = {
        action: "unchanged",
        version: 3,
      }
      expect(result.action).toBe("unchanged")
      expect(result.version).toBe(3)
    })

    test("migrated result has action 'migrated', fromVersion, toVersion, and statements", () => {
      const result: SchemaSyncResultMigrated = {
        action: "migrated",
        fromVersion: 1,
        toVersion: 2,
        statements: ["ALTER TABLE user ADD COLUMN age INTEGER"],
      }
      expect(result.action).toBe("migrated")
      expect(result.fromVersion).toBe(1)
      expect(result.toVersion).toBe(2)
      expect(result.statements).toEqual(["ALTER TABLE user ADD COLUMN age INTEGER"])
    })

    test("SchemaSyncResult is discriminated union of all four types", () => {
      // Test that we can assign any of the four types to SchemaSyncResult
      const results: SchemaSyncResult[] = [
        { action: "bootstrap" },
        { action: "created", version: 1, statements: [] },
        { action: "unchanged", version: 1 },
        { action: "migrated", fromVersion: 1, toVersion: 2, statements: [] },
      ]

      // Verify discrimination works
      for (const result of results) {
        switch (result.action) {
          case "bootstrap":
            expect(result).toEqual({ action: "bootstrap" })
            break
          case "created":
            expect(result.version).toBe(1)
            break
          case "unchanged":
            expect(result.version).toBe(1)
            break
          case "migrated":
            expect(result.fromVersion).toBe(1)
            expect(result.toVersion).toBe(2)
            break
        }
      }
    })
  })

  describe("ensureSchemaSynced", () => {
    test("bootstrap schema returns bootstrap action without self-checking", async () => {
      // Given: A bootstrap schema (x-persistence.bootstrap: true)
      const bootstrapSchema = {
        ...systemMigrationsSchema,
        $id: "test-bootstrap",
      }

      // Ingest the bootstrap schema
      getMetaStore().ingestEnhancedJsonSchema(bootstrapSchema, { name: "test-bootstrap" })

      // When: ensureSchemaSynced is called
      const result = await ensureSchemaSynced("test-bootstrap", bootstrapSchema, registry)

      // Then: Returns { action: 'bootstrap' }
      expect(result.action).toBe("bootstrap")
    })

    test("fresh deploy executes DDL and records v1", async () => {
      // Given: A non-bootstrap schema with no prior migrations
      getMetaStore().ingestEnhancedJsonSchema(userSchemaV1, { name: "user-schema" })

      // When: ensureSchemaSynced is called
      const result = await ensureSchemaSynced("user-schema", userSchemaV1, registry)

      // Then: Returns { action: 'created', version: 1, statements: [...] }
      expect(result.action).toBe("created")
      if (result.action === "created") {
        expect(result.version).toBe(1)
        expect(Array.isArray(result.statements)).toBe(true)
        expect(result.statements.length).toBeGreaterThan(0)
      }

      // And: A migration record was created in system-migrations
      const migrationsStore = getMetaStore().schemaCollection.all().find(
        (s: any) => s.name === "system-migrations"
      )?.runtimeStore

      const migrations = migrationsStore?.migrationRecordCollection.all().filter(
        (r: any) => r.schemaName === "user-schema"
      )
      expect(migrations?.length).toBe(1)
      expect(migrations?.[0].version).toBe(1)
      expect(migrations?.[0].success).toBe(true)
    })

    test("unchanged schema returns unchanged action with no DDL", async () => {
      // Given: A schema that has already been synced (v1 migration exists)
      getMetaStore().ingestEnhancedJsonSchema(userSchemaV1, { name: "user-schema" })

      // First sync - creates v1
      await ensureSchemaSynced("user-schema", userSchemaV1, registry)

      // When: ensureSchemaSynced is called again with same schema
      const result = await ensureSchemaSynced("user-schema", userSchemaV1, registry)

      // Then: Returns { action: 'unchanged', version: 1 }
      expect(result.action).toBe("unchanged")
      if (result.action === "unchanged") {
        expect(result.version).toBe(1)
      }

      // And: No new migration record was created
      const migrationsStore = getMetaStore().schemaCollection.all().find(
        (s: any) => s.name === "system-migrations"
      )?.runtimeStore

      const migrations = migrationsStore?.migrationRecordCollection.all().filter(
        (r: any) => r.schemaName === "user-schema"
      )
      expect(migrations?.length).toBe(1) // Still just 1 migration
    })

    test("changed schema runs migration pipeline and records vN+1", async () => {
      // Given: A schema that has been synced, then modified
      getMetaStore().ingestEnhancedJsonSchema(userSchemaV1, { name: "user-schema" })

      // First sync - creates v1
      await ensureSchemaSynced("user-schema", userSchemaV1, registry)

      // When: ensureSchemaSynced is called with modified schema
      const result = await ensureSchemaSynced("user-schema", userSchemaV2, registry)

      // Then: Returns { action: 'migrated', fromVersion: 1, toVersion: 2, statements: [...] }
      expect(result.action).toBe("migrated")
      if (result.action === "migrated") {
        expect(result.fromVersion).toBe(1)
        expect(result.toVersion).toBe(2)
        expect(Array.isArray(result.statements)).toBe(true)
        expect(result.statements.length).toBeGreaterThan(0)
      }

      // And: A v2 migration record was created
      const migrationsStore = getMetaStore().schemaCollection.all().find(
        (s: any) => s.name === "system-migrations"
      )?.runtimeStore

      const migrations = migrationsStore?.migrationRecordCollection.all().filter(
        (r: any) => r.schemaName === "user-schema"
      )
      expect(migrations?.length).toBe(2)

      const v2Migration = migrations?.find((m: any) => m.version === 2)
      expect(v2Migration).toBeDefined()
      expect(v2Migration?.success).toBe(true)
    })
  })
})

describe("Orchestrator exports", () => {
  test("functions and types are exported from barrel", async () => {
    // Dynamic import to test exports
    const ddl = await import("../index")

    // Then: ensureSchemaSynced is exported
    expect(typeof ddl.ensureSchemaSynced).toBe("function")
  })
})

/**
 * Bootstrap Self-Initialization Tests
 *
 * These tests verify that system-migrations bootstrap initializes its own
 * runtime store, which is required for recording migrations for other schemas.
 *
 * NOTE: This describe block uses MINIMAL beforeEach setup - specifically
 * NOT setting up the system-migrations runtime store manually. This ensures
 * we test that ensureSchemaSynced does the initialization itself.
 */
describe("Bootstrap self-initialization", () => {
  let db: Database
  let registry: BackendRegistry

  beforeEach(() => {
    // MINIMAL setup - NO manual system-migrations store initialization
    resetMetaStore()
    clearRuntimeStores()

    db = new Database(":memory:")
    const executor = new BunSqlExecutor(db)
    const backend = new SqlBackend({ dialect: "sqlite", executor })

    registry = new BackendRegistry()
    registry.register("sql", backend)
    registry.setDefault("sql")
    // NOTE: We do NOT call registry.initialize() or manually cache runtime store
  })

  test("system-migrations bootstrap initializes its own runtime store", async () => {
    // When: ensureSchemaSynced called on system-migrations
    const result = await ensureSchemaSynced("system-migrations", systemMigrationsSchema, registry)

    // Then: Returns bootstrap action
    expect(result.action).toBe("bootstrap")

    // AND: Runtime store is now accessible
    const schemaEntity = getMetaStore().schemaCollection.all().find(
      (s: any) => s.name === "system-migrations"
    )
    expect(schemaEntity).toBeDefined()
    expect(schemaEntity.runtimeStore).toBeDefined()
    expect(schemaEntity.runtimeStore.migrationRecordCollection).toBeDefined()
  })

  test("can record migration after system-migrations bootstrap", async () => {
    // Given: system-migrations bootstrapped
    await ensureSchemaSynced("system-migrations", systemMigrationsSchema, registry)

    // When: non-bootstrap schema synced
    getMetaStore().ingestEnhancedJsonSchema(userSchemaV1, { name: "user-schema" })
    const result = await ensureSchemaSynced("user-schema", userSchemaV1, registry)

    // Then: Should succeed with 'created' action (not throw)
    expect(result.action).toBe("created")
    if (result.action === "created") {
      expect(result.version).toBe(1)
    }
  })
})
