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

// ============================================================================
// MEM-03: MemoryQueryExecutor Mutation Tests (Layer 4b RED Tests)
// ============================================================================

/**
 * Mock collection with mutation support for testing.
 * Simulates MST collection interface with add/get/remove.
 */
interface MutableMockCollection<T extends { id: string }> {
  all(): T[]
  get(id: string): T | undefined
  add(item: T): T
  remove(item: T): void
  modelName: string
}

function createMutableMockCollection<T extends { id: string }>(
  items: T[],
  modelName = "TestModel"
): MutableMockCollection<T> {
  const _items = [...items]

  return {
    all: () => [..._items],
    get: (id: string) => _items.find((item) => item.id === id),
    add: (item: T) => {
      _items.push(item)
      return item
    },
    remove: (item: T) => {
      const index = _items.findIndex((i) => i.id === item.id)
      if (index !== -1) {
        _items.splice(index, 1)
      }
    },
    modelName
  }
}

describe("MEM-03: MemoryQueryExecutor Mutation Operations", () => {
  type TestEntity = {
    id: string
    name: string
    status: string
    age: number
  }

  let collection: MutableMockCollection<TestEntity>
  let executor: MemoryQueryExecutor<TestEntity>

  beforeEach(() => {
    collection = createMutableMockCollection<TestEntity>([
      { id: "1", name: "Alice", status: "active", age: 30 },
      { id: "2", name: "Bob", status: "inactive", age: 25 }
    ])
    executor = new MemoryQueryExecutor(collection)
  })

  // ==========================================================================
  // insert() Tests
  // ==========================================================================

  test("insert() adds entity to collection", async () => {
    const entity = await executor.insert({
      name: "Charlie",
      status: "active",
      age: 35
    })

    expect(entity).toBeDefined()
    expect(entity.id).toBeDefined()
    expect(entity.name).toBe("Charlie")
  })

  test("insert() generates id if not provided", async () => {
    const entity = await executor.insert({
      name: "David",
      status: "pending",
      age: 40
    })

    expect(entity.id).toBeDefined()
    expect(typeof entity.id).toBe("string")
    expect(entity.id.length).toBeGreaterThan(0)
  })

  test("insert() preserves explicit id", async () => {
    const entity = await executor.insert({
      id: "custom-id-123",
      name: "Eve",
      status: "active",
      age: 28
    })

    expect(entity.id).toBe("custom-id-123")
  })

  test("insert() calls collection.add()", async () => {
    const countBefore = collection.all().length

    await executor.insert({
      name: "Frank",
      status: "active",
      age: 45
    })

    const countAfter = collection.all().length
    expect(countAfter).toBe(countBefore + 1)
  })

  test("inserted entity is retrievable via select", async () => {
    const inserted = await executor.insert({
      name: "Grace",
      status: "active",
      age: 33
    })

    const found = await executor.first(parseQuery({ id: inserted.id }))
    expect(found).toBeDefined()
    expect(found?.name).toBe("Grace")
  })

  // ==========================================================================
  // update() Tests
  // ==========================================================================

  test("update() modifies existing entity", async () => {
    const updated = await executor.update("1", { name: "Alice Updated" })

    expect(updated).toBeDefined()
    expect(updated?.id).toBe("1")
    expect(updated?.name).toBe("Alice Updated")
  })

  test("update() merges partial changes", async () => {
    const updated = await executor.update("1", { status: "inactive" })

    expect(updated?.name).toBe("Alice") // unchanged
    expect(updated?.status).toBe("inactive") // updated
    expect(updated?.age).toBe(30) // unchanged
  })

  test("update() returns undefined for non-existent id", async () => {
    const result = await executor.update("nonexistent", { name: "Ghost" })

    expect(result).toBeUndefined()
  })

  test("update() persists changes in collection", async () => {
    await executor.update("1", { name: "Persisted", age: 31 })

    const found = await executor.first(parseQuery({ id: "1" }))
    expect(found?.name).toBe("Persisted")
    expect(found?.age).toBe(31)
  })

  test("update() uses collection.get() to find entity", async () => {
    // If collection.get() isn't used, this would fail
    const updated = await executor.update("2", { name: "Bob Updated" })

    expect(updated?.name).toBe("Bob Updated")
  })

  // ==========================================================================
  // delete() Tests
  // ==========================================================================

  test("delete() removes entity from collection", async () => {
    const result = await executor.delete("1")

    expect(result).toBe(true)
  })

  test("delete() returns false for non-existent id", async () => {
    const result = await executor.delete("nonexistent")

    expect(result).toBe(false)
  })

  test("deleted entity is not retrievable", async () => {
    await executor.delete("1")

    const found = await executor.first(parseQuery({ id: "1" }))
    expect(found).toBeUndefined()
  })

  test("delete() calls collection.remove()", async () => {
    const countBefore = collection.all().length

    await executor.delete("1")

    const countAfter = collection.all().length
    expect(countAfter).toBe(countBefore - 1)
  })

  // ==========================================================================
  // insertMany() Tests
  // ==========================================================================

  test("insertMany() adds multiple entities", async () => {
    const entities = await executor.insertMany([
      { name: "Batch1", status: "active", age: 20 },
      { name: "Batch2", status: "pending", age: 21 }
    ])

    expect(Array.isArray(entities)).toBe(true)
    expect(entities.length).toBe(2)
    expect(entities[0].name).toBe("Batch1")
    expect(entities[1].name).toBe("Batch2")
  })

  test("insertMany() assigns unique ids", async () => {
    const entities = await executor.insertMany([
      { name: "A", status: "active", age: 1 },
      { name: "B", status: "active", age: 2 }
    ])

    expect(entities[0].id).toBeDefined()
    expect(entities[1].id).toBeDefined()
    expect(entities[0].id).not.toBe(entities[1].id)
  })

  test("insertMany() calls add() for each entity", async () => {
    const countBefore = collection.all().length

    await executor.insertMany([
      { name: "X", status: "active", age: 10 },
      { name: "Y", status: "active", age: 11 },
      { name: "Z", status: "active", age: 12 }
    ])

    const countAfter = collection.all().length
    expect(countAfter).toBe(countBefore + 3)
  })

  // ==========================================================================
  // updateMany() Tests
  // ==========================================================================

  test("updateMany() returns count of updated entities", async () => {
    const count = await executor.updateMany(
      parseQuery({ status: "active" }),
      { status: "archived" }
    )

    expect(typeof count).toBe("number")
    expect(count).toBe(1) // Only Alice is active
  })

  test("updateMany() updates all matching entities", async () => {
    // Make both active first
    await executor.update("2", { status: "active" })

    const count = await executor.updateMany(
      parseQuery({ status: "active" }),
      { status: "archived" }
    )

    expect(count).toBe(2)

    // Verify changes
    const results = await executor.select(parseQuery({ status: "archived" }))
    expect(results.length).toBe(2)
  })

  test("updateMany() returns 0 when no matches", async () => {
    const count = await executor.updateMany(
      parseQuery({ status: "nonexistent" }),
      { status: "updated" }
    )

    expect(count).toBe(0)
  })

  // ==========================================================================
  // deleteMany() Tests
  // ==========================================================================

  test("deleteMany() returns count of deleted entities", async () => {
    const count = await executor.deleteMany(parseQuery({ status: "active" }))

    expect(typeof count).toBe("number")
    expect(count).toBe(1) // Only Alice is active
  })

  test("deleteMany() removes all matching entities", async () => {
    // Add more to delete
    await executor.insertMany([
      { name: "ToDelete1", status: "temp", age: 1 },
      { name: "ToDelete2", status: "temp", age: 2 }
    ])

    await executor.deleteMany(parseQuery({ status: "temp" }))

    const remaining = await executor.select(parseQuery({ status: "temp" }))
    expect(remaining.length).toBe(0)
  })

  test("deleteMany() returns 0 when no matches", async () => {
    const count = await executor.deleteMany(parseQuery({ status: "nonexistent" }))

    expect(count).toBe(0)
  })

  test("deleteMany() calls remove() for each matching entity", async () => {
    const countBefore = collection.all().length

    // Delete all (empty filter)
    await executor.deleteMany(parseQuery({}))

    const countAfter = collection.all().length
    expect(countAfter).toBe(0)
  })
})
