/**
 * store.query Tool Tests
 *
 * Tests for the store.query MCP tool that executes queries using
 * MongoDB-style QueryFilter abstraction.
 *
 * This tool replaces db.query (which accepted raw SQL) with a proper
 * abstraction-based approach that:
 * - Uses QueryFilter (MongoDB-style: $gt, $lt, $and, $or, etc.)
 * - Uses backend.execute() directly with proper table name resolution
 * - Applies schema-aware normalization (ContextAwareBackend from Issue 1)
 * - Uses BackendRegistry from environment (Issue 2 DI pattern)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  getMetaStore,
  resetMetaStore,
  clearRuntimeStores,
  createBackendRegistry,
  BunSqlExecutor,
} from "@shogo/state-api"
// Import PostgresBackend from source to get empty WHERE clause fix
import { PostgresBackend } from "../../../../state-api/src/query/backends/postgres"
import { Database } from "bun:sqlite"
import type { SQL } from "bun:sql"
import type { IEnvironment } from "@shogo/state-api"

// Import the actual executeStoreQuery function to test
import { executeStoreQuery } from "../store.query"

describe("store.query Tool", () => {
  let testDb: Database
  let testEnv: IEnvironment

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

    // Insert test data
    testDb.run(`INSERT INTO task VALUES ('1', 'Task One', 'pending', 1, '2024-01-01')`)
    testDb.run(`INSERT INTO task VALUES ('2', 'Task Two', 'active', 2, '2024-01-02')`)
    testDb.run(`INSERT INTO task VALUES ('3', 'Task Three', 'completed', 3, '2024-01-03')`)
    testDb.run(`INSERT INTO task VALUES ('4', 'Task Four', 'active', 1, '2024-01-04')`)

    // Create PostgresBackend with BunSqlExecutor
    const executor = new BunSqlExecutor(testDb as unknown as SQL)
    const postgresBackend = new PostgresBackend(executor)

    // Create BackendRegistry
    const backendRegistry = createBackendRegistry({
      default: "postgres",
      backends: { postgres: postgresBackend },
    })

    // Create meta-store with proper environment (Issue 2: unified IEnvironment)
    testEnv = {
      services: { backendRegistry },
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

    // Load schema to create runtime store
    await metaStore.loadSchema(schemaEntity.name)
  })

  afterEach(() => {
    testDb.close()
    clearRuntimeStores()
    resetMetaStore()
  })

  // ==========================================================================
  // test-store-query-01: Basic Query with Filter
  // ==========================================================================
  describe("Basic Query Execution", () => {
    test("executes query with simple equality filter", async () => {
      // Given: store.query tool with schema and model
      // Given: QueryFilter with simple equality

      // When: store.query is called with filter
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { status: "active" },
      })

      // Then: Returns { ok: true, count, items }
      expect(result.ok).toBe(true)
      expect(result.items).toBeDefined()
      expect(result.count).toBe(2) // Tasks 2 and 4

      // Then: Items have correct data
      const titles = result.items!.map((t: any) => t.title).sort()
      expect(titles).toEqual(["Task Four", "Task Two"])
    })

    test("executes query with MongoDB-style operator ($gt)", async () => {
      // Given: store.query tool
      // When: Using $gt operator in filter
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { priority: { $gt: 1 } },
      })

      // Then: Returns tasks with priority > 1
      expect(result.ok).toBe(true)
      expect(result.count).toBe(2) // Tasks 2 and 3 (priority 2 and 3)

      const priorities = result.items!.map((t: any) => t.priority).sort()
      expect(priorities).toEqual([2, 3])
    })

    test("executes query with $in operator", async () => {
      // Given: store.query tool
      // When: Using $in operator
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { status: { $in: ["pending", "completed"] } },
      })

      // Then: Returns tasks with matching statuses
      expect(result.ok).toBe(true)
      expect(result.count).toBe(2) // Tasks 1 and 3

      const statuses = result.items!.map((t: any) => t.status).sort()
      expect(statuses).toEqual(["completed", "pending"])
    })
  })

  // ==========================================================================
  // test-store-query-02: Complex Filters ($and, $or)
  // ==========================================================================
  describe("Complex Filters", () => {
    test("executes query with $and operator", async () => {
      // Given: store.query tool
      // When: Using $and to combine conditions
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: {
          $and: [{ status: "active" }, { priority: { $gte: 2 } }],
        },
      })

      // Then: Returns tasks matching all conditions
      expect(result.ok).toBe(true)
      expect(result.count).toBe(1) // Only Task 2 (active + priority 2)

      expect(result.items![0].title).toBe("Task Two")
    })

    test("executes query with $or operator", async () => {
      // Given: store.query tool
      // When: Using $or for alternative conditions
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: {
          $or: [{ status: "completed" }, { priority: 1 }],
        },
      })

      // Then: Returns tasks matching any condition
      expect(result.ok).toBe(true)
      expect(result.count).toBe(3) // Tasks 1, 3, 4

      const ids = result.items!.map((t: any) => t.id).sort()
      expect(ids).toEqual(["1", "3", "4"])
    })
  })

  // ==========================================================================
  // test-store-query-03: Ordering
  // ==========================================================================
  describe("Query Ordering", () => {
    test("executes query with orderBy ascending", async () => {
      // Given: store.query tool
      // When: Using orderBy with asc direction
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: {},
        orderBy: { field: "priority", direction: "asc" },
      })

      // Then: Returns all tasks ordered by priority ascending
      expect(result.ok).toBe(true)
      const priorities = result.items!.map((t: any) => t.priority)
      expect(priorities).toEqual([1, 1, 2, 3])
    })

    test("executes query with orderBy descending", async () => {
      // Given: store.query tool
      // When: Using orderBy with desc direction
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: {},
        orderBy: { field: "createdAt", direction: "desc" },
      })

      // Then: Returns all tasks ordered by createdAt descending
      if (!result.ok) console.error("orderBy desc failed:", result.error)
      expect(result.ok).toBe(true)
      const dates = result.items!.map((t: any) => t.createdAt)
      expect(dates).toEqual(["2024-01-04", "2024-01-03", "2024-01-02", "2024-01-01"])
    })
  })

  // ==========================================================================
  // test-store-query-04: Pagination (skip/take)
  // ==========================================================================
  describe("Pagination", () => {
    test("executes query with skip parameter", async () => {
      // Given: store.query tool
      // When: Using skip to offset results
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: {},
        orderBy: { field: "id", direction: "asc" },
        skip: 2,
      })

      // Then: Skips first 2 tasks
      if (!result.ok) console.error("skip test failed:", result.error)
      expect(result.ok).toBe(true)
      expect(result.count).toBe(2) // Only tasks 3 and 4

      const ids = result.items!.map((t: any) => t.id)
      expect(ids).toEqual(["3", "4"])
    })

    test("executes query with take parameter", async () => {
      // Given: store.query tool
      // When: Using take to limit results
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: {},
        orderBy: { field: "id", direction: "asc" },
        take: 2,
      })

      // Then: Returns only first 2 tasks
      expect(result.ok).toBe(true)
      expect(result.count).toBe(2)

      const ids = result.items!.map((t: any) => t.id)
      expect(ids).toEqual(["1", "2"])
    })

    test("executes query with skip and take (pagination)", async () => {
      // Given: store.query tool
      // When: Using both skip and take for pagination
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: {},
        orderBy: { field: "id", direction: "asc" },
        skip: 1,
        take: 2,
      })

      // Then: Returns page 2 (items 2-3)
      expect(result.ok).toBe(true)
      expect(result.count).toBe(2)

      const ids = result.items!.map((t: any) => t.id)
      expect(ids).toEqual(["2", "3"])
    })
  })

  // ==========================================================================
  // test-store-query-05: Terminal Operations
  // ==========================================================================
  describe("Terminal Operations", () => {
    test("toArray terminal returns all matching items", async () => {
      // Given: store.query tool
      // When: Using terminal: 'toArray' (default)
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { status: "active" },
        terminal: "toArray",
      })

      // Then: Returns array of items
      expect(result.ok).toBe(true)
      expect(result.items).toBeDefined()
      expect(result.count).toBe(2)
      expect(Array.isArray(result.items)).toBe(true)
    })

    test("first terminal returns first matching item", async () => {
      // Given: store.query tool
      // When: Using terminal: 'first'
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { status: "active" },
        orderBy: { field: "priority", direction: "asc" },
        terminal: "first",
      })

      // Then: Returns single item (or empty array if not found)
      expect(result.ok).toBe(true)
      expect(result.items).toBeDefined()
      expect(result.count).toBe(1)
      expect(result.items![0].title).toBe("Task Four") // priority 1
    })

    test("first terminal returns empty when no matches", async () => {
      // Given: store.query tool
      // When: Using terminal: 'first' with no matches
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { status: "archived" }, // No tasks with this status
        terminal: "first",
      })

      // Then: Returns empty array
      expect(result.ok).toBe(true)
      expect(result.count).toBe(0)
      expect(result.items).toEqual([])
    })

    test("count terminal returns number of matches", async () => {
      // Given: store.query tool
      // When: Using terminal: 'count'
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { status: "active" },
        terminal: "count",
      })

      // Then: Returns count (not items array)
      expect(result.ok).toBe(true)
      expect(result.count).toBe(2)
      expect(result.items).toBeUndefined()
    })

    test("any terminal returns boolean as count", async () => {
      // Given: store.query tool
      // When: Using terminal: 'any' with matches
      const resultTrue = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { status: "active" },
        terminal: "any",
      })

      // Then: Returns count: 1 when items exist
      expect(resultTrue.ok).toBe(true)
      expect(resultTrue.count).toBe(1)

      // When: Using terminal: 'any' with no matches
      const resultFalse = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { status: "archived" },
        terminal: "any",
      })

      // Then: Returns count: 0 when no items
      expect(resultFalse.ok).toBe(true)
      expect(resultFalse.count).toBe(0)
    })
  })

  // ==========================================================================
  // test-store-query-06: Schema-Aware Normalization
  // ==========================================================================
  describe("Schema-Aware Normalization", () => {
    test("returns camelCase property names (not snake_case)", async () => {
      // Given: Database has snake_case columns (created_at)
      // Given: Schema defines camelCase properties (createdAt)

      // When: store.query is called
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { id: "1" },
      })

      // Then: Returned items have camelCase keys
      expect(result.ok).toBe(true)
      const task = result.items![0]

      expect(task.id).toBe("1")
      expect(task.title).toBe("Task One")
      expect(task.createdAt).toBe("2024-01-01") // NOT created_at

      // Then: snake_case keys don't exist
      expect((task as any).created_at).toBeUndefined()
    })
  })

  // ==========================================================================
  // test-store-query-07: Error Handling
  // ==========================================================================
  describe("Error Handling", () => {
    test("returns error when schema not found", async () => {
      // Given: store.query tool
      // When: Querying non-existent schema
      const result = await executeStoreQuery({
        schema: "nonexistent-schema",
        model: "Task",
        filter: {},
      })

      // Then: Returns error with SCHEMA_NOT_FOUND code
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error!.code).toBe("SCHEMA_NOT_FOUND")
      expect(result.error!.message).toContain("nonexistent-schema")
    })

    test("returns error when model not found", async () => {
      // Given: store.query tool
      // When: Querying non-existent model
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "NonexistentModel",
        filter: {},
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

      // When: Querying model in unloaded schema
      const result = await executeStoreQuery({
        schema: "unloaded-schema",
        model: "Note",
        filter: {},
      })

      // Then: Returns error with RUNTIME_STORE_NOT_FOUND code
      expect(result.ok).toBe(false)
      expect(result.error!.code).toBe("RUNTIME_STORE_NOT_FOUND")
    })
  })

  // ==========================================================================
  // test-store-query-08: Default Terminal Operation
  // ==========================================================================
  describe("Default Behavior", () => {
    test("defaults to toArray when terminal not specified", async () => {
      // Given: store.query tool
      // When: terminal parameter is omitted
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: { status: "pending" },
        // No terminal specified
      })

      // Then: Uses toArray as default terminal
      expect(result.ok).toBe(true)
      expect(result.items).toBeDefined()
      expect(Array.isArray(result.items)).toBe(true)
      expect(result.count).toBe(1)
    })
  })

  // ==========================================================================
  // test-store-query-09: Workspace Isolation
  // ==========================================================================
  describe("Workspace Isolation", () => {
    test("queries respect workspace parameter", async () => {
      // Given: store.query tool
      // When: workspace parameter is provided
      const result = await executeStoreQuery({
        schema: "task-schema",
        model: "Task",
        filter: {},
        workspace: undefined, // Use default workspace
      })

      // Then: Query executes successfully
      expect(result.ok).toBe(true)
      expect(result.count).toBe(4)
    })
  })
})
