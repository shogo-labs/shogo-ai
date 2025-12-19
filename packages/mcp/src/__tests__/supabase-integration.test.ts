/**
 * Supabase Integration Tests
 *
 * End-to-end tests validating the complete flow against a real PostgreSQL database.
 * These tests require DATABASE_URL environment variable to be set.
 *
 * Test Flow:
 * 1. Initialize postgres backend
 * 2. Create schema with x-persistence.backend: "postgres"
 * 3. Execute DDL to create tables
 * 4. Insert entities via store.create
 * 5. Query entities via store.query
 * 6. Update entities via store.update
 * 7. Cleanup test data
 *
 * @requires DATABASE_URL environment variable
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import {
  getMetaStore,
  resetMetaStore,
  clearRuntimeStores,
  generateSQL,
  createPostgresDialect,
  cacheRuntimeStore,
  enhancedJsonSchemaToMST,
  FileSystemPersistence,
  CollectionPersistable,
  type IEnvironment,
} from "@shogo/state-api"
import { types } from "mobx-state-tree"
import {
  initializePostgresBackend,
  getPostgresExecutor,
  isPostgresAvailable,
  getGlobalBackendRegistry,
  shutdownPostgres,
  __resetForTesting,
} from "../postgres-init"

// Check if we have DATABASE_URL for integration tests
const hasPostgres = !!process.env.DATABASE_URL

// Generate unique test identifiers to avoid collisions
const testRunId = Date.now().toString(36)

// Skip entire file if no DATABASE_URL
const describeIntegration = hasPostgres ? describe : describe.skip

describeIntegration("Supabase Integration Tests", () => {
  // Test schema name (unique per test run)
  const TEST_SCHEMA_NAME = `test_schema_${testRunId}`

  // Tables created during tests (for cleanup)
  const createdTables: string[] = []

  beforeAll(async () => {
    // Initialize postgres connection
    __resetForTesting()
    const initialized = initializePostgresBackend()

    if (!initialized) {
      throw new Error("Failed to initialize PostgreSQL backend. Check DATABASE_URL.")
    }

    expect(isPostgresAvailable()).toBe(true)
  })

  afterAll(async () => {
    // Cleanup: Drop all test tables
    const executor = getPostgresExecutor()
    if (executor && createdTables.length > 0) {
      for (const tableName of createdTables.reverse()) {
        try {
          await executor.execute([`DROP TABLE IF EXISTS "${tableName}" CASCADE`, []])
        } catch (e) {
          console.warn(`Failed to drop table ${tableName}:`, e)
        }
      }
    }

    // Shutdown postgres connection
    await shutdownPostgres()
  })

  beforeEach(() => {
    // Reset meta-store and runtime stores before each test
    resetMetaStore()
    clearRuntimeStores()
  })

  describe("connection and initialization", () => {
    test("postgres executor is available", () => {
      const executor = getPostgresExecutor()
      expect(executor).toBeDefined()
    })

    test("can execute simple query", async () => {
      const executor = getPostgresExecutor()!
      const result = await executor.execute(["SELECT 1 as num", []])

      expect(result.length).toBe(1)
      expect(result[0].num).toBe(1)
    })

    test("backend registry includes postgres", () => {
      const registry = getGlobalBackendRegistry()
      expect(registry.has("postgres")).toBe(true)
      expect(registry.has("memory")).toBe(true)
    })
  })

  describe("DDL execution flow", () => {
    test("generates and executes CREATE TABLE", async () => {
      // Given: A simple schema
      const schema = {
        $defs: {
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              title: { type: "string" },
              completed: { type: "boolean" },
            },
            required: ["id", "title"],
          },
        },
      }

      // When: Generating DDL with unique table name
      const tableName = `task_${testRunId}`
      const schemaWithUniqueTable = {
        $defs: {
          [`Task_${testRunId}`]: schema.$defs.Task,
        },
      }

      const dialect = createPostgresDialect()
      const statements = generateSQL(schemaWithUniqueTable as any, dialect, { ifNotExists: true })

      expect(statements.length).toBeGreaterThan(0)

      // Execute DDL
      const executor = getPostgresExecutor()!
      await executor.executeMany(statements)

      // Track for cleanup
      createdTables.push(`task_${testRunId}`)

      // Verify table exists
      const checkResult = await executor.execute([
        `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
        [`task_${testRunId}`],
      ])

      expect(checkResult.length).toBe(1)
    })

    test("IF NOT EXISTS allows re-running DDL", async () => {
      // Given: A schema
      const tableName = `rerun_test_${testRunId}`
      const schema = {
        $defs: {
          [`RerunTest_${testRunId}`]: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              name: { type: "string" },
            },
            required: ["id", "name"],
          },
        },
      }

      const dialect = createPostgresDialect()
      const statements = generateSQL(schema as any, dialect, { ifNotExists: true })

      const executor = getPostgresExecutor()!

      // First execution - creates table
      await executor.executeMany(statements)
      createdTables.push(tableName)

      // Second execution - should not error (IF NOT EXISTS makes it idempotent)
      await executor.executeMany(statements)
    })
  })

  describe("CRUD operations", () => {
    const crudTableName = `crud_item_${testRunId}`

    beforeAll(async () => {
      // Create test table for CRUD operations
      const schema = {
        $defs: {
          [`CrudItem_${testRunId}`]: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              name: { type: "string" },
              quantity: { type: "integer" },
            },
            required: ["id", "name"],
          },
        },
      }

      const dialect = createPostgresDialect()
      const statements = generateSQL(schema as any, dialect, { ifNotExists: true })

      const executor = getPostgresExecutor()!
      await executor.executeMany(statements)
      createdTables.push(crudTableName)
    })

    test("INSERT and SELECT work correctly", async () => {
      const executor = getPostgresExecutor()!
      const testId = crypto.randomUUID()

      // INSERT
      await executor.execute([
        `INSERT INTO "${crudTableName}" (id, name, quantity) VALUES ($1, $2, $3)`,
        [testId, "Test Item", 10],
      ])

      // SELECT
      const result = await executor.execute([
        `SELECT * FROM "${crudTableName}" WHERE id = $1`,
        [testId],
      ])

      expect(result.length).toBe(1)
      expect(result[0].name).toBe("Test Item")
      expect(result[0].quantity).toBe(10)

      // Cleanup
      await executor.execute([`DELETE FROM "${crudTableName}" WHERE id = $1`, [testId]])
    })

    test("UPDATE modifies existing row", async () => {
      const executor = getPostgresExecutor()!
      const testId = crypto.randomUUID()

      // Setup: INSERT
      await executor.execute([
        `INSERT INTO "${crudTableName}" (id, name, quantity) VALUES ($1, $2, $3)`,
        [testId, "Original Name", 5],
      ])

      // UPDATE
      await executor.execute([
        `UPDATE "${crudTableName}" SET name = $1, quantity = $2 WHERE id = $3`,
        ["Updated Name", 15, testId],
      ])

      // Verify
      const result = await executor.execute([
        `SELECT * FROM "${crudTableName}" WHERE id = $1`,
        [testId],
      ])

      expect(result[0].name).toBe("Updated Name")
      expect(result[0].quantity).toBe(15)

      // Cleanup
      await executor.execute([`DELETE FROM "${crudTableName}" WHERE id = $1`, [testId]])
    })

    test("DELETE removes row", async () => {
      const executor = getPostgresExecutor()!
      const testId = crypto.randomUUID()

      // Setup: INSERT
      await executor.execute([
        `INSERT INTO "${crudTableName}" (id, name, quantity) VALUES ($1, $2, $3)`,
        [testId, "To Delete", 1],
      ])

      // DELETE
      await executor.execute([
        `DELETE FROM "${crudTableName}" WHERE id = $1`,
        [testId],
      ])

      // Verify
      const result = await executor.execute([
        `SELECT * FROM "${crudTableName}" WHERE id = $1`,
        [testId],
      ])

      expect(result.length).toBe(0)
    })
  })

  describe("transaction support", () => {
    const txTableName = `tx_item_${testRunId}`

    beforeAll(async () => {
      // Create test table for transaction tests
      const schema = {
        $defs: {
          [`TxItem_${testRunId}`]: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              value: { type: "integer" },
            },
            required: ["id", "value"],
          },
        },
      }

      const dialect = createPostgresDialect()
      const statements = generateSQL(schema as any, dialect, { ifNotExists: true })

      const executor = getPostgresExecutor()!
      await executor.executeMany(statements)
      createdTables.push(txTableName)
    })

    test("successful transaction commits all changes", async () => {
      const executor = getPostgresExecutor()!
      const id1 = crypto.randomUUID()
      const id2 = crypto.randomUUID()

      // Execute transaction
      await executor.beginTransaction(async (tx) => {
        await tx.execute([
          `INSERT INTO "${txTableName}" (id, value) VALUES ($1, $2)`,
          [id1, 100],
        ])
        await tx.execute([
          `INSERT INTO "${txTableName}" (id, value) VALUES ($1, $2)`,
          [id2, 200],
        ])
      })

      // Verify both inserts committed
      const result = await executor.execute([
        `SELECT * FROM "${txTableName}" WHERE id IN ($1, $2)`,
        [id1, id2],
      ])

      expect(result.length).toBe(2)

      // Cleanup
      await executor.execute([`DELETE FROM "${txTableName}" WHERE id IN ($1, $2)`, [id1, id2]])
    })

    test("failed transaction rolls back all changes", async () => {
      const executor = getPostgresExecutor()!
      const id1 = crypto.randomUUID()
      const id2 = crypto.randomUUID()

      // Attempt transaction that fails
      try {
        await executor.beginTransaction(async (tx) => {
          await tx.execute([
            `INSERT INTO "${txTableName}" (id, value) VALUES ($1, $2)`,
            [id1, 100],
          ])
          // This will fail due to invalid SQL
          throw new Error("Simulated failure")
        })
      } catch (e) {
        // Expected to throw
      }

      // Verify no inserts committed
      const result = await executor.execute([
        `SELECT * FROM "${txTableName}" WHERE id = $1`,
        [id1],
      ])

      expect(result.length).toBe(0)
    })
  })

  describe("foreign key relationships", () => {
    const parentTableName = `parent_${testRunId}`
    const childTableName = `child_${testRunId}`

    beforeAll(async () => {
      // Create parent-child relationship tables
      const executor = getPostgresExecutor()!

      // Create parent table
      await executor.execute([
        `CREATE TABLE IF NOT EXISTS "${parentTableName}" (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL
        )`,
        [],
      ])
      createdTables.push(parentTableName)

      // Create child table with FK
      await executor.execute([
        `CREATE TABLE IF NOT EXISTS "${childTableName}" (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          parent_id UUID NOT NULL REFERENCES "${parentTableName}"(id) ON DELETE CASCADE
        )`,
        [],
      ])
      createdTables.push(childTableName)
    })

    test("can insert related entities respecting FK constraints", async () => {
      const executor = getPostgresExecutor()!
      const parentId = crypto.randomUUID()
      const childId = crypto.randomUUID()

      // Insert parent
      await executor.execute([
        `INSERT INTO "${parentTableName}" (id, name) VALUES ($1, $2)`,
        [parentId, "Parent Entity"],
      ])

      // Insert child referencing parent
      await executor.execute([
        `INSERT INTO "${childTableName}" (id, name, parent_id) VALUES ($1, $2, $3)`,
        [childId, "Child Entity", parentId],
      ])

      // Verify relationship
      const result = await executor.execute([
        `SELECT c.*, p.name as parent_name
         FROM "${childTableName}" c
         JOIN "${parentTableName}" p ON c.parent_id = p.id
         WHERE c.id = $1`,
        [childId],
      ])

      expect(result.length).toBe(1)
      expect(result[0].parent_name).toBe("Parent Entity")

      // Cleanup (cascade should delete child)
      await executor.execute([`DELETE FROM "${parentTableName}" WHERE id = $1`, [parentId]])
    })

    test("FK constraint prevents orphan references", async () => {
      const executor = getPostgresExecutor()!
      const nonExistentParentId = crypto.randomUUID()
      const childId = crypto.randomUUID()

      // Attempt to insert child with non-existent parent should fail
      await expect(
        executor.execute([
          `INSERT INTO "${childTableName}" (id, name, parent_id) VALUES ($1, $2, $3)`,
          [childId, "Orphan Child", nonExistentParentId],
        ])
      ).rejects.toThrow()
    })
  })

  describe("SqlQueryExecutor integration", () => {
    test("resolves SqlQueryExecutor for postgres-configured model", () => {
      // Given: Schema with x-persistence.backend configured
      const metaStore = getMetaStore()
      const schema = {
        $defs: {
          [`PostgresModel_${testRunId}`]: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              name: { type: "string" },
            },
            required: ["id", "name"],
            "x-persistence": {
              backend: "postgres",
              strategy: "flat",
            },
          },
        },
      }

      metaStore.ingestEnhancedJsonSchema(schema as any, { name: TEST_SCHEMA_NAME })

      // When: Resolving executor
      const registry = getGlobalBackendRegistry()
      const executor = registry.resolve(TEST_SCHEMA_NAME, `PostgresModel_${testRunId}`)

      // Then: Returns SqlQueryExecutor
      expect(executor).toBeDefined()
      expect(typeof executor.select).toBe("function")
      expect(typeof executor.insert).toBe("function")
      expect(typeof executor.update).toBe("function")
      expect(typeof executor.delete).toBe("function")
    })
  })
})
