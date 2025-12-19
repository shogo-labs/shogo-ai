/**
 * store.create MCP Tool Tests
 *
 * Tests for entity creation - both single and batch modes.
 *
 * API:
 * - Single: { schema, model, data: object } → { ok, id, data }
 * - Batch: { schema, model, data: object[] } → { ok, count, items }
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  getMetaStore,
  resetMetaStore,
  clearRuntimeStores,
  createBackendRegistry,
  BunSqlExecutor,
  getRuntimeStore,
  SqlBackend,
  NullPersistence,
} from "@shogo/state-api"
import { Database } from "bun:sqlite"
import type { IEnvironment } from "@shogo/state-api"

import { executeStoreCreate } from "../store.create"

// =============================================================================
// Test Setup
// =============================================================================

describe("store.create", () => {
  let testDb: Database
  let testEnv: IEnvironment

  beforeEach(async () => {
    resetMetaStore()
    clearRuntimeStores()

    // Create in-memory SQLite database
    testDb = new Database(":memory:")

    // Create test table
    testDb.run(`
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'pending'
      )
    `)

    // Create SqlBackend with SQLite dialect
    const executor = new BunSqlExecutor(testDb)
    const sqlBackend = new SqlBackend({ dialect: "sqlite", executor })

    // Create BackendRegistry
    const backendRegistry = createBackendRegistry({
      default: "postgres",
      backends: { postgres: sqlBackend },
    })

    // Create environment
    testEnv = {
      services: {
        persistence: new NullPersistence(),
        backendRegistry,
      },
    }

    const metaStore = getMetaStore(testEnv)

    // Ingest schema
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Task: {
          type: "object",
          "x-persistence": {
            strategy: "flat",
            backend: "postgres",
          },
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            title: { type: "string" },
            status: { type: "string" },
          },
          required: ["id", "title"],
        },
      },
    }

    const schemaEntity = metaStore.ingestEnhancedJsonSchema(schema, {
      name: "task-schema",
    })

    // Load schema to create runtime store
    await metaStore.loadSchema(schemaEntity.name)
  })

  afterEach(() => {
    clearRuntimeStores()
    resetMetaStore()
    testDb?.close()
  })

  // ===========================================================================
  // Single Entity Mode (data: object)
  // ===========================================================================

  describe("single entity mode (data: object)", () => {
    test("creates entity and returns { ok, id, data }", async () => {
      // When: create called with single object
      const result = await executeStoreCreate({
        schema: "task-schema",
        model: "Task",
        data: { id: "task-1", title: "Test Task", status: "pending" }
      })

      // Then: Returns ok with id and data
      expect(result.ok).toBe(true)
      expect(result.id).toBe("task-1")
      expect(result.data).toMatchObject({ id: "task-1", title: "Test Task" })
      // Single mode should NOT have count/items
      expect(result.count).toBeUndefined()
      expect(result.items).toBeUndefined()
    })

    test("entity is persisted to database", async () => {
      // When: create called
      await executeStoreCreate({
        schema: "task-schema",
        model: "Task",
        data: { id: "task-1", title: "Test Task" }
      })

      // Then: Entity exists in database
      const row = testDb.query("SELECT * FROM task WHERE id = ?").get("task-1") as any
      expect(row).toBeDefined()
      expect(row.title).toBe("Test Task")
    })
  })

  // ===========================================================================
  // Batch Mode (data: object[])
  // ===========================================================================

  describe("batch mode (data: object[])", () => {
    test("creates multiple entities and returns { ok, count, items }", async () => {
      // When: create called with array
      const result = await executeStoreCreate({
        schema: "task-schema",
        model: "Task",
        data: [
          { id: "task-1", title: "Task One", status: "pending" },
          { id: "task-2", title: "Task Two", status: "active" },
          { id: "task-3", title: "Task Three", status: "pending" }
        ]
      })

      // Then: Returns ok with count and items
      expect(result.ok).toBe(true)
      expect(result.count).toBe(3)
      expect(result.items).toHaveLength(3)
      expect(result.items?.[0]).toMatchObject({ id: "task-1", title: "Task One" })
      expect(result.items?.[1]).toMatchObject({ id: "task-2", title: "Task Two" })
      expect(result.items?.[2]).toMatchObject({ id: "task-3", title: "Task Three" })
      // Batch mode should NOT have id/data
      expect(result.id).toBeUndefined()
      expect(result.data).toBeUndefined()
    })

    test("all entities are persisted to database", async () => {
      // When: create called with array
      await executeStoreCreate({
        schema: "task-schema",
        model: "Task",
        data: [
          { id: "task-1", title: "Task One" },
          { id: "task-2", title: "Task Two" }
        ]
      })

      // Then: All entities exist in database
      const rows = testDb.query("SELECT * FROM task ORDER BY id").all() as any[]
      expect(rows).toHaveLength(2)
      expect(rows[0].id).toBe("task-1")
      expect(rows[1].id).toBe("task-2")
    })

    test("empty array returns { ok, count: 0, items: [] }", async () => {
      // When: create called with empty array
      const result = await executeStoreCreate({
        schema: "task-schema",
        model: "Task",
        data: []
      })

      // Then: Returns ok with count 0
      expect(result.ok).toBe(true)
      expect(result.count).toBe(0)
      expect(result.items).toHaveLength(0)
    })
  })

  // ===========================================================================
  // Error Cases
  // ===========================================================================

  describe("error cases", () => {
    test("returns SCHEMA_NOT_FOUND when schema does not exist", async () => {
      const result = await executeStoreCreate({
        schema: "non-existent-schema",
        model: "Task",
        data: { id: "1", title: "Test" }
      })

      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("SCHEMA_NOT_FOUND")
    })

    test("returns MODEL_NOT_FOUND when model does not exist", async () => {
      const result = await executeStoreCreate({
        schema: "task-schema",
        model: "NonExistentModel",
        data: { id: "1", title: "Test" }
      })

      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("MODEL_NOT_FOUND")
    })
  })
})
