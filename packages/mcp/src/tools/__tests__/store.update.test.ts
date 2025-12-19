/**
 * store.update MCP Tool Tests
 *
 * Tests for entity updates - both single and batch modes.
 *
 * API:
 * - Single: { schema, model, id, changes } → { ok, data }
 * - Batch: { schema, model, filter, changes } (no id) → { ok, count }
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

import { executeStoreUpdate } from "../store.update"

// =============================================================================
// Test Setup
// =============================================================================

// Use temp directory for test workspace to avoid affecting repo files
const TEST_WORKSPACE = "/tmp/mcp-test-schemas"

describe("store.update", () => {
  let testDb: Database
  let testEnv: IEnvironment

  beforeEach(async () => {
    resetMetaStore()
    clearRuntimeStores()

    // Create in-memory SQLite database
    testDb = new Database(":memory:")

    // Create test table with namespace prefix (task-schema -> task_schema)
    testDb.run(`
      CREATE TABLE task_schema__task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'pending'
      )
    `)

    // Insert test data
    testDb.run(`INSERT INTO task_schema__task (id, title, status) VALUES ('task-1', 'Task One', 'pending')`)
    testDb.run(`INSERT INTO task_schema__task (id, title, status) VALUES ('task-2', 'Task Two', 'pending')`)
    testDb.run(`INSERT INTO task_schema__task (id, title, status) VALUES ('task-3', 'Task Three', 'active')`)

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

    // Load schema to create runtime store (with test workspace for cache key consistency)
    await metaStore.loadSchema(schemaEntity.name, TEST_WORKSPACE)

    // Load data into collection
    const runtimeStore = getRuntimeStore(schemaEntity.id, TEST_WORKSPACE)
    await runtimeStore!.taskCollection.loadAll()
  })

  afterEach(() => {
    clearRuntimeStores()
    resetMetaStore()
    testDb?.close()
  })

  // ===========================================================================
  // Single Entity Mode (id + changes)
  // ===========================================================================

  describe("single entity mode (id + changes)", () => {
    test("updates entity and returns { ok, data }", async () => {
      // When: update called with id + changes
      const result = await executeStoreUpdate({
        schema: "task-schema",
        model: "Task",
        id: "task-1",
        changes: { title: "Updated Title", status: "active" },
        workspace: TEST_WORKSPACE,
      })

      // Then: Returns ok with updated data
      expect(result.ok).toBe(true)
      expect(result.data).toMatchObject({ id: "task-1", title: "Updated Title", status: "active" })
      // Single mode should NOT have count
      expect(result.count).toBeUndefined()
    })

    test("entity is persisted to database", async () => {
      // When: update called
      await executeStoreUpdate({
        schema: "task-schema",
        model: "Task",
        id: "task-1",
        changes: { title: "Updated Title" },
        workspace: TEST_WORKSPACE,
      })

      // Then: Database is updated
      const row = testDb.query("SELECT * FROM task_schema__task WHERE id = ?").get("task-1") as any
      expect(row.title).toBe("Updated Title")
    })

    test("returns NOT_FOUND when entity does not exist", async () => {
      const result = await executeStoreUpdate({
        schema: "task-schema",
        model: "Task",
        id: "non-existent",
        changes: { title: "Updated" },
        workspace: TEST_WORKSPACE,
      })

      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("NOT_FOUND")
    })
  })

  // ===========================================================================
  // Batch Mode (filter + changes, no id)
  // ===========================================================================

  describe("batch mode (filter + changes)", () => {
    test("updates matching entities and returns { ok, count }", async () => {
      // When: update called with filter (no id)
      const result = await executeStoreUpdate({
        schema: "task-schema",
        model: "Task",
        filter: { status: "pending" },
        changes: { status: "active" },
        workspace: TEST_WORKSPACE,
      })

      // Then: Returns ok with count
      expect(result.ok).toBe(true)
      expect(result.count).toBe(2)
      // Batch mode should NOT have data
      expect(result.data).toBeUndefined()
    })

    test("all matching entities are updated in database", async () => {
      // When: update called with filter
      await executeStoreUpdate({
        schema: "task-schema",
        model: "Task",
        filter: { status: "pending" },
        changes: { status: "archived" },
        workspace: TEST_WORKSPACE,
      })

      // Then: All matching entities are updated
      const archived = testDb.query("SELECT * FROM task_schema__task WHERE status = 'archived'").all() as any[]
      expect(archived).toHaveLength(2)
    })

    test("returns count 0 when no entities match", async () => {
      // When: update with non-matching filter
      const result = await executeStoreUpdate({
        schema: "task-schema",
        model: "Task",
        filter: { status: "nonexistent" },
        changes: { status: "active" },
        workspace: TEST_WORKSPACE,
      })

      // Then: Returns count 0
      expect(result.ok).toBe(true)
      expect(result.count).toBe(0)
    })
  })

  // ===========================================================================
  // Error Cases
  // ===========================================================================

  describe("error cases", () => {
    test("returns SCHEMA_NOT_FOUND when schema does not exist", async () => {
      const result = await executeStoreUpdate({
        schema: "non-existent-schema",
        model: "Task",
        id: "task-1",
        changes: { title: "Updated" },
        workspace: TEST_WORKSPACE,
      })

      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("SCHEMA_NOT_FOUND")
    })

    test("returns MODEL_NOT_FOUND when model does not exist", async () => {
      const result = await executeStoreUpdate({
        schema: "task-schema",
        model: "NonExistentModel",
        id: "task-1",
        changes: { title: "Updated" },
        workspace: TEST_WORKSPACE,
      })

      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("MODEL_NOT_FOUND")
    })

    test("returns VALIDATION_ERROR when neither id nor filter provided", async () => {
      const result = await executeStoreUpdate({
        schema: "task-schema",
        model: "Task",
        changes: { title: "Updated" },
        workspace: TEST_WORKSPACE,
      } as any)

      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("VALIDATION_ERROR")
    })
  })
})
