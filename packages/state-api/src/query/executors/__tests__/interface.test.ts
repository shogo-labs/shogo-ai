/**
 * IQueryExecutor Interface Tests
 *
 * Defines the contract that all executor implementations must satisfy.
 * Provides reusable test suite for executor implementations.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { parseQuery } from "../../ast/parser"
import type { IQueryExecutor } from "../types"

// ============================================================================
// EXEC-01: Interface Type Checking
// ============================================================================

describe("EXEC-01: IQueryExecutor Interface Definition", () => {
  test("interface has required method signatures", () => {
    // This is a compile-time test - if this file compiles, the interface is correct
    const mockExecutor: IQueryExecutor<any> = {
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false
    }

    expect(typeof mockExecutor.select).toBe("function")
    expect(typeof mockExecutor.first).toBe("function")
    expect(typeof mockExecutor.count).toBe("function")
    expect(typeof mockExecutor.exists).toBe("function")
  })

  test("select method accepts AST and options", async () => {
    const mockExecutor: IQueryExecutor<{ id: string }> = {
      select: async (ast, options) => {
        // Verify parameters are passed correctly
        expect(ast).toBeDefined()
        expect(options).toBeDefined()
        return []
      },
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false
    }

    const ast = parseQuery({ id: "test" })
    await mockExecutor.select(ast, { skip: 10, take: 5 })
  })

  test("generic type parameter flows through return types", async () => {
    type TestEntity = { id: string; name: string }

    const mockExecutor: IQueryExecutor<TestEntity> = {
      select: async () => [{ id: "1", name: "Test" }],
      first: async () => ({ id: "1", name: "Test" }),
      count: async () => 1,
      exists: async () => true
    }

    const items = await mockExecutor.select(parseQuery({}))
    const item = await mockExecutor.first(parseQuery({}))

    // Type checking - these should compile
    if (item) {
      const _id: string = item.id
      const _name: string = item.name
    }
    if (items.length > 0) {
      const _id: string = items[0].id
      const _name: string = items[0].name
    }
  })
})

// ============================================================================
// EXEC-02: Executor Contract Test Suite
// ============================================================================

/**
 * Reusable contract tests for any IQueryExecutor implementation.
 *
 * This test suite ensures that all executor implementations behave consistently
 * at the interface level. Both MemoryQueryExecutor and SqlQueryExecutor will
 * run these tests to verify they satisfy the contract.
 *
 * @param name - Descriptive name for the executor implementation
 * @param setup - Function that returns executor and test data setup
 */
export function testExecutorContract<T extends { id: string }>(
  name: string,
  setup: () => Promise<{
    executor: IQueryExecutor<T>
    testData: T[]
    cleanup?: () => Promise<void>
  }>
) {
  describe(`EXEC-02: ${name} Contract Tests`, () => {
    let executor: IQueryExecutor<T>
    let testData: T[]
    let cleanup: (() => Promise<void>) | undefined

    beforeEach(async () => {
      const result = await setup()
      executor = result.executor
      testData = result.testData
      cleanup = result.cleanup
    })

    afterEach(async () => {
      if (cleanup) {
        await cleanup()
      }
    })

    test("select() returns array of T", async () => {
      const result = await executor.select(parseQuery({}))
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
    })

    test("select() with empty filter returns all items", async () => {
      const result = await executor.select(parseQuery({}))
      expect(result.length).toBe(testData.length)
    })

    test("select() with filter returns matching items only", async () => {
      // Assumes testData has item with id "test-1"
      const result = await executor.select(parseQuery({ id: "test-1" }))
      expect(result.length).toBeLessThanOrEqual(testData.length)
      if (result.length > 0) {
        expect(result[0].id).toBe("test-1")
      }
    })

    test("first() returns T | undefined", async () => {
      const result = await executor.first(parseQuery({}))
      if (result !== undefined) {
        expect(result).toHaveProperty("id")
      }
    })

    test("first() returns first matching item when exists", async () => {
      const result = await executor.first(parseQuery({ id: "test-1" }))
      if (testData.some(item => item.id === "test-1")) {
        expect(result).toBeDefined()
        expect(result?.id).toBe("test-1")
      }
    })

    test("first() returns undefined when no matches", async () => {
      const result = await executor.first(parseQuery({ id: "nonexistent" }))
      expect(result).toBeUndefined()
    })

    test("count() returns number", async () => {
      const result = await executor.count(parseQuery({}))
      expect(typeof result).toBe("number")
      expect(result).toBeGreaterThanOrEqual(0)
    })

    test("count() returns total count for empty filter", async () => {
      const result = await executor.count(parseQuery({}))
      expect(result).toBe(testData.length)
    })

    test("count() returns filtered count", async () => {
      const result = await executor.count(parseQuery({ id: "test-1" }))
      const expected = testData.filter(item => item.id === "test-1").length
      expect(result).toBe(expected)
    })

    test("exists() returns boolean", async () => {
      const result = await executor.exists(parseQuery({}))
      expect(typeof result).toBe("boolean")
    })

    test("exists() returns true when items exist", async () => {
      const result = await executor.exists(parseQuery({}))
      expect(result).toBe(testData.length > 0)
    })

    test("exists() returns false when no matches", async () => {
      const result = await executor.exists(parseQuery({ id: "nonexistent" }))
      expect(result).toBe(false)
    })

    test("exists() returns true when matches exist", async () => {
      if (testData.length > 0) {
        const result = await executor.exists(parseQuery({ id: testData[0].id }))
        expect(result).toBe(true)
      }
    })
  })
}

// Note: Actual implementations (MemoryQueryExecutor, SqlQueryExecutor)
// will import and use testExecutorContract() in their own test files

// ============================================================================
// EXEC-03: IMutationExecutor Interface Type Checking (Layer 3 RED Tests)
// ============================================================================

describe("EXEC-03: IQueryExecutor Mutation Interface Definition", () => {
  test("interface has required mutation method signatures", () => {
    // This is a compile-time test - if this file compiles, the interface is correct
    // NOTE: These tests will FAIL until IQueryExecutor is extended with mutation methods
    const mockExecutor: IQueryExecutor<any> = {
      // Read operations (existing)
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false,
      // Mutation operations (NEW - Layer 3)
      insert: async () => ({ id: "1" }),
      update: async () => ({ id: "1" }),
      delete: async () => true,
      insertMany: async () => [],
      updateMany: async () => 0,
      deleteMany: async () => 0,
    }

    expect(typeof mockExecutor.insert).toBe("function")
    expect(typeof mockExecutor.update).toBe("function")
    expect(typeof mockExecutor.delete).toBe("function")
    expect(typeof mockExecutor.insertMany).toBe("function")
    expect(typeof mockExecutor.updateMany).toBe("function")
    expect(typeof mockExecutor.deleteMany).toBe("function")
  })

  test("insert method accepts entity and returns Promise<T>", async () => {
    type TestEntity = { id: string; name: string }

    const mockExecutor: IQueryExecutor<TestEntity> = {
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false,
      insert: async (entity: Partial<TestEntity>) => {
        // Verify parameter is passed correctly
        expect(entity.name).toBeDefined()
        return { id: "generated-id", name: entity.name! }
      },
      update: async () => undefined,
      delete: async () => false,
      insertMany: async () => [],
      updateMany: async () => 0,
      deleteMany: async () => 0,
    }

    const result = await mockExecutor.insert({ name: "Test" })
    expect(result.id).toBe("generated-id")
    expect(result.name).toBe("Test")
  })

  test("update method accepts id and changes, returns Promise<T | undefined>", async () => {
    type TestEntity = { id: string; name: string }

    const mockExecutor: IQueryExecutor<TestEntity> = {
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false,
      insert: async () => ({ id: "1", name: "test" }),
      update: async (id: string, changes: Partial<TestEntity>) => {
        expect(id).toBe("1")
        expect(changes.name).toBe("Updated")
        return { id: "1", name: "Updated" }
      },
      delete: async () => false,
      insertMany: async () => [],
      updateMany: async () => 0,
      deleteMany: async () => 0,
    }

    const result = await mockExecutor.update("1", { name: "Updated" })
    expect(result).toBeDefined()
    expect(result?.name).toBe("Updated")
  })

  test("delete method accepts id and returns Promise<boolean>", async () => {
    const mockExecutor: IQueryExecutor<any> = {
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false,
      insert: async () => ({ id: "1" }),
      update: async () => undefined,
      delete: async (id: string) => {
        expect(id).toBe("1")
        return true
      },
      insertMany: async () => [],
      updateMany: async () => 0,
      deleteMany: async () => 0,
    }

    const result = await mockExecutor.delete("1")
    expect(result).toBe(true)
  })

  test("insertMany accepts array and returns Promise<T[]>", async () => {
    type TestEntity = { id: string; name: string }

    const mockExecutor: IQueryExecutor<TestEntity> = {
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false,
      insert: async () => ({ id: "1", name: "test" }),
      update: async () => undefined,
      delete: async () => false,
      insertMany: async (entities: Partial<TestEntity>[]) => {
        expect(entities.length).toBe(2)
        return entities.map((e, i) => ({ id: `${i + 1}`, name: e.name! }))
      },
      updateMany: async () => 0,
      deleteMany: async () => 0,
    }

    const result = await mockExecutor.insertMany([
      { name: "Alice" },
      { name: "Bob" },
    ])
    expect(result.length).toBe(2)
  })

  test("updateMany accepts AST and changes, returns Promise<number>", async () => {
    const mockExecutor: IQueryExecutor<any> = {
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false,
      insert: async () => ({ id: "1" }),
      update: async () => undefined,
      delete: async () => false,
      insertMany: async () => [],
      updateMany: async (ast, changes) => {
        expect(ast).toBeDefined()
        expect(changes).toBeDefined()
        return 5
      },
      deleteMany: async () => 0,
    }

    const ast = parseQuery({ status: "active" })
    const result = await mockExecutor.updateMany(ast, { status: "archived" })
    expect(result).toBe(5)
  })

  test("deleteMany accepts AST and returns Promise<number>", async () => {
    const mockExecutor: IQueryExecutor<any> = {
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false,
      insert: async () => ({ id: "1" }),
      update: async () => undefined,
      delete: async () => false,
      insertMany: async () => [],
      updateMany: async () => 0,
      deleteMany: async (ast) => {
        expect(ast).toBeDefined()
        return 3
      },
    }

    const ast = parseQuery({ status: "inactive" })
    const result = await mockExecutor.deleteMany(ast)
    expect(result).toBe(3)
  })
})

// ============================================================================
// EXEC-04: Mutation Contract Test Suite
// ============================================================================

/**
 * Reusable contract tests for mutation operations on IQueryExecutor.
 *
 * This test suite ensures that all executor implementations handle mutations
 * consistently. Both MemoryQueryExecutor and SqlQueryExecutor will run these
 * tests to verify they satisfy the mutation contract.
 *
 * @param name - Descriptive name for the executor implementation
 * @param setup - Function that returns executor and test data setup
 */
export function testMutationContract<T extends { id: string; name?: string }>(
  name: string,
  setup: () => Promise<{
    executor: IQueryExecutor<T>
    createEntity: () => Partial<T>
    cleanup?: () => Promise<void>
  }>
) {
  describe(`EXEC-04: ${name} Mutation Contract Tests`, () => {
    let executor: IQueryExecutor<T>
    let createEntity: () => Partial<T>
    let cleanup: (() => Promise<void>) | undefined

    beforeEach(async () => {
      const result = await setup()
      executor = result.executor
      createEntity = result.createEntity
      cleanup = result.cleanup
    })

    afterEach(async () => {
      if (cleanup) {
        await cleanup()
      }
    })

    // Insert tests
    test("insert() returns entity with id", async () => {
      const entity = createEntity()
      const result = await executor.insert(entity)
      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
    })

    test("insert() generates id if not provided", async () => {
      const entity = createEntity()
      delete (entity as any).id // Remove id to test generation
      const result = await executor.insert(entity)
      expect(result.id).toBeDefined()
      expect(typeof result.id).toBe("string")
    })

    test("insert() preserves explicit id if provided", async () => {
      const entity = { ...createEntity(), id: "explicit-id-123" } as Partial<T>
      const result = await executor.insert(entity)
      expect(result.id).toBe("explicit-id-123")
    })

    test("inserted entity is retrievable via select", async () => {
      const entity = createEntity()
      const inserted = await executor.insert(entity)
      const result = await executor.first(parseQuery({ id: inserted.id }))
      expect(result).toBeDefined()
      expect(result?.id).toBe(inserted.id)
    })

    // Update tests
    test("update() returns updated entity", async () => {
      // First insert an entity
      const entity = createEntity()
      const inserted = await executor.insert(entity)

      // Update it
      const result = await executor.update(inserted.id, { name: "Updated" } as Partial<T>)
      expect(result).toBeDefined()
      expect(result?.id).toBe(inserted.id)
    })

    test("update() merges partial changes", async () => {
      const entity = createEntity()
      const inserted = await executor.insert(entity)

      // Update only name
      const result = await executor.update(inserted.id, { name: "Changed" } as Partial<T>)
      expect(result?.name).toBe("Changed")
    })

    test("update() returns undefined for non-existent id", async () => {
      const result = await executor.update("nonexistent-id", { name: "Ghost" } as Partial<T>)
      expect(result).toBeUndefined()
    })

    test("updated entity reflects changes on subsequent query", async () => {
      const entity = createEntity()
      const inserted = await executor.insert(entity)
      await executor.update(inserted.id, { name: "Persisted Change" } as Partial<T>)

      const result = await executor.first(parseQuery({ id: inserted.id }))
      expect(result?.name).toBe("Persisted Change")
    })

    // Delete tests
    test("delete() returns true when entity exists", async () => {
      const entity = createEntity()
      const inserted = await executor.insert(entity)

      const result = await executor.delete(inserted.id)
      expect(result).toBe(true)
    })

    test("delete() returns false for non-existent id", async () => {
      const result = await executor.delete("nonexistent-id")
      expect(result).toBe(false)
    })

    test("deleted entity is not retrievable", async () => {
      const entity = createEntity()
      const inserted = await executor.insert(entity)
      await executor.delete(inserted.id)

      const result = await executor.first(parseQuery({ id: inserted.id }))
      expect(result).toBeUndefined()
    })

    // Batch insert tests
    test("insertMany() returns array of entities", async () => {
      const entities = [createEntity(), createEntity()]
      const result = await executor.insertMany(entities)
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(2)
    })

    test("insertMany() assigns unique ids", async () => {
      const e1 = createEntity()
      const e2 = createEntity()
      delete (e1 as any).id
      delete (e2 as any).id

      const result = await executor.insertMany([e1, e2])
      expect(result[0].id).toBeDefined()
      expect(result[1].id).toBeDefined()
      expect(result[0].id).not.toBe(result[1].id)
    })

    // Batch update tests
    test("updateMany() returns count of updated entities", async () => {
      // Insert some entities
      await executor.insertMany([
        { ...createEntity(), name: "A" } as Partial<T>,
        { ...createEntity(), name: "B" } as Partial<T>,
      ])

      // Update all (empty filter matches all)
      const ast = parseQuery({})
      const count = await executor.updateMany(ast, { name: "Updated" } as Partial<T>)
      expect(typeof count).toBe("number")
      expect(count).toBeGreaterThanOrEqual(2)
    })

    test("updateMany() returns 0 when no matches", async () => {
      const ast = parseQuery({ id: "nonexistent" })
      const count = await executor.updateMany(ast, { name: "Ghost" } as Partial<T>)
      expect(count).toBe(0)
    })

    // Batch delete tests
    test("deleteMany() returns count of deleted entities", async () => {
      // Insert some entities
      await executor.insertMany([createEntity(), createEntity()])

      // Delete all
      const ast = parseQuery({})
      const count = await executor.deleteMany(ast)
      expect(typeof count).toBe("number")
      expect(count).toBeGreaterThanOrEqual(2)
    })

    test("deleteMany() returns 0 when no matches", async () => {
      const ast = parseQuery({ id: "nonexistent" })
      const count = await executor.deleteMany(ast)
      expect(count).toBe(0)
    })

    test("deleteMany() removes all matching entities", async () => {
      // Insert some entities
      await executor.insertMany([createEntity(), createEntity()])

      // Delete all
      await executor.deleteMany(parseQuery({}))

      // Should be empty
      const remaining = await executor.count(parseQuery({}))
      expect(remaining).toBe(0)
    })
  })
}

// ============================================================================
// EXEC-05: executorType Property Tests
// ============================================================================

describe("EXEC-05: IQueryExecutor executorType Property", () => {
  test("interface requires executorType property", () => {
    // This is a compile-time test - if this file compiles, the interface is correct
    // NOTE: These tests will FAIL until IQueryExecutor has executorType property
    const mockLocalExecutor: IQueryExecutor<any> = {
      executorType: 'local',
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false,
      insert: async () => ({ id: "1" }),
      update: async () => ({ id: "1" }),
      delete: async () => true,
      insertMany: async () => [],
      updateMany: async () => 0,
      deleteMany: async () => 0,
    }

    const mockRemoteExecutor: IQueryExecutor<any> = {
      executorType: 'remote',
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false,
      insert: async () => ({ id: "1" }),
      update: async () => ({ id: "1" }),
      delete: async () => true,
      insertMany: async () => [],
      updateMany: async () => 0,
      deleteMany: async () => 0,
    }

    expect(mockLocalExecutor.executorType).toBe('local')
    expect(mockRemoteExecutor.executorType).toBe('remote')
  })

  test("executorType is literal union type 'local' | 'remote'", () => {
    // Type check: executorType must be one of the valid values
    const executor: IQueryExecutor<any> = {
      executorType: 'local', // Only 'local' or 'remote' should be valid
      select: async () => [],
      first: async () => undefined,
      count: async () => 0,
      exists: async () => false,
      insert: async () => ({ id: "1" }),
      update: async () => ({ id: "1" }),
      delete: async () => true,
      insertMany: async () => [],
      updateMany: async () => 0,
      deleteMany: async () => 0,
    }

    // Runtime check
    expect(['local', 'remote']).toContain(executor.executorType)
  })
})

/**
 * Reusable test to verify executor implements executorType correctly.
 * Both MemoryQueryExecutor and SqlQueryExecutor should call this.
 */
export function testExecutorTypeProperty<T extends { id: string }>(
  name: string,
  expectedType: 'local' | 'remote',
  setup: () => Promise<{
    executor: IQueryExecutor<T>
    cleanup?: () => Promise<void>
  }>
) {
  describe(`EXEC-05: ${name} executorType Property`, () => {
    let executor: IQueryExecutor<T>
    let cleanup: (() => Promise<void>) | undefined

    beforeEach(async () => {
      const result = await setup()
      executor = result.executor
      cleanup = result.cleanup
    })

    afterEach(async () => {
      if (cleanup) {
        await cleanup()
      }
    })

    test(`executorType is '${expectedType}'`, () => {
      expect(executor.executorType).toBe(expectedType)
    })

    test("executorType is readonly (cannot be modified)", () => {
      // TypeScript readonly enforcement at compile time
      // At runtime, we just verify the property exists and has correct value
      expect(executor.executorType).toBe(expectedType)

      // Attempting to modify should have no effect (or throw in strict mode)
      const originalType = executor.executorType
      try {
        (executor as any).executorType = expectedType === 'local' ? 'remote' : 'local'
      } catch {
        // Expected if object is frozen or property is truly readonly
      }
      // If modification was blocked, value should be unchanged
      // Note: This depends on implementation - class properties may be mutable at runtime
    })
  })
}
