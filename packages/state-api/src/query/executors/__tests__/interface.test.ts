/**
 * IQueryExecutor Interface Tests
 *
 * Defines the contract that all executor implementations must satisfy.
 * Provides reusable test suite for executor implementations.
 */

import { describe, test, expect } from "bun:test"
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
