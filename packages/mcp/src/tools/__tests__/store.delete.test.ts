/**
 * store.delete Tool Tests
 *
 * Tests for the store.delete MCP tool that deletes an entity by ID.
 * Uses CollectionMutatable.deleteOne for proper MST state + backend persistence.
 *
 * TDD RED Tests - These tests are written first, before implementation.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  getMetaStore,
  resetMetaStore,
  clearRuntimeStores,
  createBackendRegistry,
  getRuntimeStore,
  SqlBackend,
  NullPersistence,
} from "@shogo/state-api"
import { BunSqlExecutor } from "@shogo/state-api/query/execution/bun-sql"
import { Database } from "bun:sqlite"
import type { IEnvironment } from "@shogo/state-api"

// Import the actual executeStoreDelete function to test
import { executeStoreDelete } from "../store.delete"

// Use temp directory for test workspace to avoid affecting repo files
const TEST_WORKSPACE = "/tmp/mcp-test-schemas"

describe("store.delete Tool", () => {
  let testDb: Database
  let testEnv: IEnvironment
  let schemaId: string

  beforeEach(async () => {
    resetMetaStore()
    clearRuntimeStores()

    // Create in-memory SQLite database for testing
    testDb = new Database(":memory:")

    // Create test table with snake_case columns (as DDL would create)
    testDb.run(`
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        priority INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
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

    // Create meta-store with proper environment
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
            status: { type: "string", enum: ["pending", "active", "completed"] },
            priority: { type: "number" },
            createdAt: { type: "string", format: "date" },
          },
          required: ["id", "title", "createdAt"],
        },
      },
    }

    const schemaEntity = metaStore.ingestEnhancedJsonSchema(schema, {
      name: "task-schema",
    })
    schemaId = schemaEntity.id

    // Load schema to create runtime store (with test workspace for cache key consistency)
    await metaStore.loadSchema(schemaEntity.name, TEST_WORKSPACE)

    // Insert test data via collection (adds to both MST and database)
    const runtimeStore = getRuntimeStore(schemaEntity.id, TEST_WORKSPACE)
    const taskCollection = runtimeStore!.taskCollection
    await taskCollection.insertOne({ id: "1", title: "Task One", status: "pending", priority: 1, createdAt: "2024-01-01" })
    await taskCollection.insertOne({ id: "2", title: "Task Two", status: "active", priority: 2, createdAt: "2024-01-02" })
    await taskCollection.insertOne({ id: "3", title: "Task Three", status: "completed", priority: 3, createdAt: "2024-01-03" })
  })

  afterEach(() => {
    testDb.close()
    clearRuntimeStores()
    resetMetaStore()
  })

  // ==========================================================================
  // test-store-delete-01: Basic Delete
  // ==========================================================================
  describe("Basic Delete Execution", () => {
    test("returns ok:true and deleted entity data on success", async () => {
      // Given: Entity exists in database
      // When: store.delete is called with valid id
      const result = await executeStoreDelete({
        schema: "task-schema",
        model: "Task",
        id: "1",
        workspace: TEST_WORKSPACE,
      })

      // Then: Returns { ok: true, data: <deleted entity> }
      expect(result.ok).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data.id).toBe("1")
      expect(result.data.title).toBe("Task One")

      // Then: Entity is actually deleted from database
      const rows = testDb.query("SELECT * FROM task WHERE id = '1'").all()
      expect(rows.length).toBe(0)
    })

    test("returns ok:false with NOT_FOUND when entity missing", async () => {
      // Given: Entity does not exist
      // When: store.delete is called with non-existent id
      const result = await executeStoreDelete({
        schema: "task-schema",
        model: "Task",
        id: "nonexistent-id",
        workspace: TEST_WORKSPACE,
      })

      // Then: Returns error with NOT_FOUND code
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error!.code).toBe("NOT_FOUND")
      expect(result.error!.message).toContain("nonexistent-id")
    })

    test("deletes correct entity without affecting others", async () => {
      // Given: Multiple entities exist
      // When: store.delete is called for one entity
      const result = await executeStoreDelete({
        schema: "task-schema",
        model: "Task",
        id: "2",
        workspace: TEST_WORKSPACE,
      })

      // Then: Only the specified entity is deleted
      expect(result.ok).toBe(true)

      // Other entities remain
      const remainingRows = testDb.query("SELECT id FROM task ORDER BY id").all()
      expect(remainingRows).toEqual([{ id: "1" }, { id: "3" }])
    })
  })

  // ==========================================================================
  // test-store-delete-02: Error Handling
  // ==========================================================================
  describe("Error Handling", () => {
    test("returns ok:false with SCHEMA_NOT_FOUND when schema not loaded", async () => {
      // Given: store.delete tool
      // When: Deleting from non-existent schema
      const result = await executeStoreDelete({
        schema: "nonexistent-schema",
        model: "Task",
        id: "1",
        workspace: TEST_WORKSPACE,
      })

      // Then: Returns error with SCHEMA_NOT_FOUND code
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error!.code).toBe("SCHEMA_NOT_FOUND")
      expect(result.error!.message).toContain("nonexistent-schema")
    })

    test("returns ok:false with MODEL_NOT_FOUND when model does not exist", async () => {
      // Given: store.delete tool
      // When: Deleting from non-existent model
      const result = await executeStoreDelete({
        schema: "task-schema",
        model: "NonexistentModel",
        id: "1",
        workspace: TEST_WORKSPACE,
      })

      // Then: Returns error with MODEL_NOT_FOUND code
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error!.code).toBe("MODEL_NOT_FOUND")
      expect(result.error!.message).toContain("NonexistentModel")
    })

    test("returns error when runtime store not found", async () => {
      // Given: Schema exists but runtime store not loaded
      resetMetaStore()
      const metaStore = getMetaStore(testEnv)
      metaStore.ingestEnhancedJsonSchema(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $defs: { Note: { type: "object", properties: { id: { type: "string" } } } },
        },
        { name: "unloaded-schema" }
      )
      // Don't call loadSchema - runtime store not created

      // When: Deleting from unloaded schema
      const result = await executeStoreDelete({
        schema: "unloaded-schema",
        model: "Note",
        id: "1",
        workspace: TEST_WORKSPACE,
      })

      // Then: Returns error with RUNTIME_STORE_NOT_FOUND code
      expect(result.ok).toBe(false)
      expect(result.error!.code).toBe("RUNTIME_STORE_NOT_FOUND")
    })
  })

  // ==========================================================================
  // test-store-delete-03: Workspace Isolation
  // ==========================================================================
  describe("Workspace Isolation", () => {
    test("deletes respect workspace parameter", async () => {
      // Given: store.delete tool
      // When: workspace parameter is provided
      const result = await executeStoreDelete({
        schema: "task-schema",
        model: "Task",
        id: "1",
        workspace: TEST_WORKSPACE,
      })

      // Then: Delete executes successfully
      expect(result.ok).toBe(true)
      expect(result.data).toBeDefined()
    })
  })

  // ==========================================================================
  // test-store-delete-04: Batch Mode (filter, no id)
  // ==========================================================================
  describe("Batch Mode (filter)", () => {
    test("deletes matching entities and returns { ok, count }", async () => {
      // Given: Multiple entities with same status
      // When: delete called with filter (no id)
      const result = await executeStoreDelete({
        schema: "task-schema",
        model: "Task",
        filter: { status: "pending" },
        workspace: TEST_WORKSPACE,
      } as any)

      // Then: Returns ok with count
      expect(result.ok).toBe(true)
      expect(result.count).toBe(1) // Only task "1" is pending
      // Batch mode should NOT have data
      expect(result.data).toBeUndefined()
    })

    test("all matching entities are removed from database", async () => {
      // Given: Multiple pending entities - add another via collection
      const runtimeStore = getRuntimeStore(schemaId, TEST_WORKSPACE)
      await runtimeStore!.taskCollection.insertOne({ id: "4", title: "Task Four", status: "pending", priority: 4, createdAt: "2024-01-04" })

      // When: delete called with filter
      await executeStoreDelete({
        schema: "task-schema",
        model: "Task",
        filter: { status: "pending" },
        workspace: TEST_WORKSPACE,
      } as any)

      // Then: All matching entities are removed
      const pending = testDb.query("SELECT * FROM task WHERE status = 'pending'").all()
      expect(pending).toHaveLength(0)

      // Other tasks remain (active, completed)
      const remaining = testDb.query("SELECT * FROM task").all()
      expect(remaining.length).toBeGreaterThan(0)
    })

    test("returns count 0 when no entities match", async () => {
      // When: delete with non-matching filter
      const result = await executeStoreDelete({
        schema: "task-schema",
        model: "Task",
        filter: { status: "nonexistent" },
        workspace: TEST_WORKSPACE,
      } as any)

      // Then: Returns count 0
      expect(result.ok).toBe(true)
      expect(result.count).toBe(0)
    })

    test("returns VALIDATION_ERROR when neither id nor filter provided", async () => {
      const result = await executeStoreDelete({
        schema: "task-schema",
        model: "Task",
        workspace: TEST_WORKSPACE,
      } as any)

      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("VALIDATION_ERROR")
    })
  })
})
