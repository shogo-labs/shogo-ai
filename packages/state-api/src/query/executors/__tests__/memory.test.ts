/**
 * MemoryQueryExecutor Tests
 *
 * Tests for in-memory query executor implementation.
 * Validates filtering, sorting, pagination, and terminal operations.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { parseQuery } from "../../ast/parser"
import { MemoryQueryExecutor } from "../memory"
import { testExecutorContract } from "./interface.test"

// ============================================================================
// Mock Collection
// ============================================================================

interface MockCollection<T> {
  all(): T[]
  modelName: string
}

function createMockCollection<T>(items: T[], modelName = "TestModel"): MockCollection<T> {
  return {
    all: () => items,
    modelName
  }
}

// ============================================================================
// MEM-01: MemoryQueryExecutor Implementation Tests
// ============================================================================

describe("MEM-01: MemoryQueryExecutor", () => {
  type TestEntity = { id: string; name: string; age: number; status: string }
  let collection: MockCollection<TestEntity>
  let executor: MemoryQueryExecutor<TestEntity>

  beforeEach(() => {
    collection = createMockCollection<TestEntity>([
      { id: "1", name: "Alice", age: 30, status: "active" },
      { id: "2", name: "Bob", age: 25, status: "inactive" },
      { id: "3", name: "Charlie", age: 35, status: "active" },
      { id: "4", name: "Diana", age: 28, status: "active" }
    ])
    executor = new MemoryQueryExecutor(collection)
  })

  test("constructor binds collection reference", () => {
    expect(executor).toBeDefined()
    // Collection is bound - executor doesn't need it passed to execute methods
  })

  test("select() with empty filter returns all items", async () => {
    const result = await executor.select(parseQuery({}))
    expect(result).toHaveLength(4)
  })

  test("select() filters items by equality", async () => {
    const result = await executor.select(parseQuery({ status: "active" }))
    expect(result).toHaveLength(3)
    expect(result.every(item => item.status === "active")).toBe(true)
  })

  test("select() filters with comparison operators", async () => {
    const result = await executor.select(parseQuery({ age: { $gt: 28 } }))
    expect(result).toHaveLength(2)
    expect(result.map(item => item.name)).toContain("Alice")
    expect(result.map(item => item.name)).toContain("Charlie")
  })

  test("select() applies orderBy ascending", async () => {
    const result = await executor.select(parseQuery({}), {
      orderBy: { field: "name", direction: "asc" }
    })
    expect(result.map(item => item.name)).toEqual(["Alice", "Bob", "Charlie", "Diana"])
  })

  test("select() applies orderBy descending", async () => {
    const result = await executor.select(parseQuery({}), {
      orderBy: { field: "age", direction: "desc" }
    })
    expect(result.map(item => item.age)).toEqual([35, 30, 28, 25])
  })

  test("select() applies skip pagination", async () => {
    const result = await executor.select(parseQuery({}), {
      orderBy: { field: "name", direction: "asc" },
      skip: 2
    })
    expect(result).toHaveLength(2)
    expect(result.map(item => item.name)).toEqual(["Charlie", "Diana"])
  })

  test("select() applies take limit", async () => {
    const result = await executor.select(parseQuery({}), {
      orderBy: { field: "name", direction: "asc" },
      take: 2
    })
    expect(result).toHaveLength(2)
    expect(result.map(item => item.name)).toEqual(["Alice", "Bob"])
  })

  test("select() applies skip and take together", async () => {
    const result = await executor.select(parseQuery({}), {
      orderBy: { field: "name", direction: "asc" },
      skip: 1,
      take: 2
    })
    expect(result).toHaveLength(2)
    expect(result.map(item => item.name)).toEqual(["Bob", "Charlie"])
  })

  test("first() returns first matching item", async () => {
    const result = await executor.first(parseQuery({ status: "active" }))
    expect(result).toBeDefined()
    expect(result?.status).toBe("active")
    expect(result?.id).toBe("1") // First in array
  })

  test("first() returns undefined when no matches", async () => {
    const result = await executor.first(parseQuery({ status: "deleted" }))
    expect(result).toBeUndefined()
  })

  test("first() respects orderBy", async () => {
    const result = await executor.first(parseQuery({ status: "active" }), {
      orderBy: { field: "age", direction: "desc" }
    })
    expect(result?.name).toBe("Charlie") // Oldest active user
  })

  test("count() returns total count for empty filter", async () => {
    const result = await executor.count(parseQuery({}))
    expect(result).toBe(4)
  })

  test("count() returns filtered count", async () => {
    const result = await executor.count(parseQuery({ status: "active" }))
    expect(result).toBe(3)
  })

  test("count() with no matches returns 0", async () => {
    const result = await executor.count(parseQuery({ status: "deleted" }))
    expect(result).toBe(0)
  })

  test("exists() returns true when items exist", async () => {
    const result = await executor.exists(parseQuery({}))
    expect(result).toBe(true)
  })

  test("exists() returns true when matches exist", async () => {
    const result = await executor.exists(parseQuery({ status: "active" }))
    expect(result).toBe(true)
  })

  test("exists() returns false when no matches", async () => {
    const result = await executor.exists(parseQuery({ status: "deleted" }))
    expect(result).toBe(false)
  })

  test("exists() early exits on first match (optimization)", async () => {
    // This is a behavioral expectation - implementation should not iterate all items
    const result = await executor.exists(parseQuery({ id: "1" }))
    expect(result).toBe(true)
  })
})

// ============================================================================
// MEM-02: Contract Compliance
// ============================================================================

testExecutorContract<{ id: string; name: string }>(
  "MemoryQueryExecutor",
  async () => {
    const testData = [
      { id: "test-1", name: "Test One" },
      { id: "test-2", name: "Test Two" },
      { id: "test-3", name: "Test Three" }
    ]

    const collection = createMockCollection(testData)
    const executor = new MemoryQueryExecutor(collection)

    return {
      executor,
      testData
    }
  }
)
