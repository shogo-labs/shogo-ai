/**
 * BackendRegistry.syncSchema Tests
 *
 * Tests the syncSchema() method that delegates to ensureSchemaSynced.
 * Verifies correct SchemaSyncResult for each synchronization case.
 *
 * TDD: Tests written first to define expected behavior.
 *
 * Requirements:
 * - REQ-DDL-MIG-010: Registry syncSchema method delegates to orchestrator
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { resetMetaStore, clearRuntimeStores } from "../../meta/bootstrap"
import { BunSqlExecutor } from "../execution/bun-sql"
import { SqlBackend } from "../backends/sql"
import { BackendRegistry } from "../registry"
import { ensureSchemaSynced } from "../../ddl/orchestrator"

// System migrations schema for bootstrapping
const systemMigrationsSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "system-migrations",
  "x-persistence": { bootstrap: true, backend: "sql" },
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

// Test schema (non-bootstrap)
const testSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "test-schema",
  "x-persistence": { backend: "sql" },
  $defs: {
    TestEntity: {
      type: "object",
      "x-original-name": "TestEntity",
      properties: {
        id: { type: "string", "x-mst-type": "identifier" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    },
  },
}

describe("BackendRegistry.syncSchema", () => {
  let db: Database
  let registry: BackendRegistry

  beforeEach(async () => {
    resetMetaStore()
    clearRuntimeStores()
    db = new Database(":memory:")
    const executor = new BunSqlExecutor(db)
    const backend = new SqlBackend({ dialect: "sqlite", executor })
    registry = new BackendRegistry()
    registry.register("sql", backend)
    registry.setDefault("sql")

    // Bootstrap system-migrations via ensureSchemaSynced (NOT manual store creation)
    // This ensures the runtime store is created via domain() with CollectionMutatable mixin
    await ensureSchemaSynced("system-migrations", systemMigrationsSchema, registry)
  })

  test("syncSchema method exists on registry", () => {
    expect(typeof registry.syncSchema).toBe("function")
  })

  test("syncSchema returns bootstrap action for bootstrap schema", async () => {
    const bootstrapSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "bootstrap-test",
      "x-persistence": { bootstrap: true, backend: "sql" },
      $defs: {
        BootstrapEntity: {
          type: "object",
          "x-original-name": "BootstrapEntity",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
          },
          required: ["id"],
        },
      },
    }
    const result = await registry.syncSchema("bootstrap-test", bootstrapSchema)
    expect(result.action).toBe("bootstrap")
  })

  test("syncSchema returns created action for fresh deploy", async () => {
    const result = await registry.syncSchema("test-schema", testSchema)
    expect(result.action).toBe("created")
    if (result.action === "created") {
      expect(result.version).toBe(1)
      expect(Array.isArray(result.statements)).toBe(true)
    }
  })

  test("syncSchema returns unchanged for matching checksum", async () => {
    // First sync
    await registry.syncSchema("test-schema", testSchema)
    // Second sync with same schema
    const result = await registry.syncSchema("test-schema", testSchema)
    expect(result.action).toBe("unchanged")
    if (result.action === "unchanged") {
      expect(result.version).toBe(1)
    }
  })

  test("existing executeDDL method still works", async () => {
    const result = await registry.executeDDL("test-schema", testSchema, { ifNotExists: true })
    expect(result.success).toBe(true)
  })
})
