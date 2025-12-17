/**
 * Generated from TestSpecification: test-p2-exec-index-01, test-p2-exec-index-02, test-p2-exec-index-03
 * Task: task-p2-execution-index
 * Requirement: req-08-database-executor
 *
 * Tests for query/execution module barrel exports
 */

import { describe, test, expect } from "bun:test"

describe("execution index exports", () => {
  /**
   * Test Spec: test-p2-exec-index-01
   * Scenario: execution index exports ISqlExecutor interface
   * Given: query/execution/index.ts module exists
   * When: ISqlExecutor is imported from query/execution
   * Then: ISqlExecutor interface is available, No runtime errors on import
   */
  test("exports ISqlExecutor interface", () => {
    // When: Import from query/execution
    // Then: No runtime errors on import (TypeScript interfaces are compile-time only)
    expect(() => {
      const module = require("../index")
      // Verify the module loaded successfully
      expect(module).toBeDefined()
    }).not.toThrow()
  })

  test("exports SqlExecutorConfig type", () => {
    // When: Import SqlExecutorConfig from query/execution
    // Then: No runtime errors on import (TypeScript types are compile-time only)
    expect(() => {
      const module = require("../index")
      expect(module).toBeDefined()
    }).not.toThrow()
  })

  /**
   * Test Spec: test-p2-exec-index-02
   * Scenario: execution index exports BunSqlExecutor class
   * Given: query/execution/index.ts module exists
   * When: BunSqlExecutor is imported from query/execution
   * Then: BunSqlExecutor class is available, Can instantiate BunSqlExecutor
   */
  test("exports BunSqlExecutor class", () => {
    // When: Import BunSqlExecutor from query/execution
    const { BunSqlExecutor } = require("../index")

    // Then: BunSqlExecutor class is available
    expect(BunSqlExecutor).toBeDefined()
    expect(typeof BunSqlExecutor).toBe("function")
  })

  test("BunSqlExecutor can be instantiated", () => {
    // Given: BunSqlExecutor is imported
    const { BunSqlExecutor } = require("../index")

    // When: Attempting to instantiate with a mock connection
    const mockConnection = {} as any

    // Then: Can instantiate BunSqlExecutor
    expect(() => {
      new BunSqlExecutor(mockConnection)
    }).not.toThrow()

    const instance = new BunSqlExecutor(mockConnection)
    expect(instance).toBeInstanceOf(BunSqlExecutor)
  })

  /**
   * Test Spec: test-p2-exec-index-03
   * Scenario: execution index exports utility functions
   * Given: query/execution/index.ts module exists
   * When: snakeToCamel, camelToSnake, normalizeRow, normalizeRows are imported
   * Then: All utility functions are available, Functions are callable, All exports use named exports
   */
  test("exports snakeToCamel utility function", () => {
    // When: Import snakeToCamel from query/execution
    const { snakeToCamel } = require("../index")

    // Then: snakeToCamel is available and callable
    expect(snakeToCamel).toBeDefined()
    expect(typeof snakeToCamel).toBe("function")

    // Verify it's functional
    expect(snakeToCamel("created_at")).toBe("createdAt")
  })

  test("exports camelToSnake utility function", () => {
    // When: Import camelToSnake from query/execution
    const { camelToSnake } = require("../index")

    // Then: camelToSnake is available and callable
    expect(camelToSnake).toBeDefined()
    expect(typeof camelToSnake).toBe("function")

    // Verify it's functional
    expect(camelToSnake("createdAt")).toBe("created_at")
  })

  test("exports normalizeRow utility function", () => {
    // When: Import normalizeRow from query/execution
    const { normalizeRow } = require("../index")

    // Then: normalizeRow is available and callable
    expect(normalizeRow).toBeDefined()
    expect(typeof normalizeRow).toBe("function")

    // Verify it's functional
    const result = normalizeRow({ user_id: 1, created_at: "2024-01-01" })
    expect(result).toEqual({ userId: 1, createdAt: "2024-01-01" })
  })

  test("exports normalizeRows utility function", () => {
    // When: Import normalizeRows from query/execution
    const { normalizeRows } = require("../index")

    // Then: normalizeRows is available and callable
    expect(normalizeRows).toBeDefined()
    expect(typeof normalizeRows).toBe("function")

    // Verify it's functional
    const result = normalizeRows([
      { user_id: 1, created_at: "2024-01-01" },
      { user_id: 2, created_at: "2024-01-02" },
    ])
    expect(result).toEqual([
      { userId: 1, createdAt: "2024-01-01" },
      { userId: 2, createdAt: "2024-01-02" },
    ])
  })

  test("all exports use named exports (no default export)", () => {
    // When: Import module
    const module = require("../index")

    // Then: No default export
    expect(module.default).toBeUndefined()

    // And all expected named exports exist
    expect(module.BunSqlExecutor).toBeDefined()
    expect(module.snakeToCamel).toBeDefined()
    expect(module.camelToSnake).toBeDefined()
    expect(module.normalizeRow).toBeDefined()
    expect(module.normalizeRows).toBeDefined()
  })

  test("can import all exports together", () => {
    // When: Import all exports in one statement (simulated)
    expect(() => {
      const {
        BunSqlExecutor,
        snakeToCamel,
        camelToSnake,
        normalizeRow,
        normalizeRows,
      } = require("../index")

      // Verify all are defined
      expect(BunSqlExecutor).toBeDefined()
      expect(snakeToCamel).toBeDefined()
      expect(camelToSnake).toBeDefined()
      expect(normalizeRow).toBeDefined()
      expect(normalizeRows).toBeDefined()
    }).not.toThrow()
  })
})
