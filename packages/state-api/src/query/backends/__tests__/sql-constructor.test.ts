/**
 * SqlBackend Constructor Tests
 *
 * Tests for SqlBackend constructor accepting executor as a parameter
 * for cleaner composition and type safety.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { SqlBackend } from "../sql"
import { MemoryBackend } from "../memory"
import { BunSqlExecutor } from "../../execution/bun-sql"

// ============================================================================
// SQL-BACKEND-01: Constructor with Executor
// ============================================================================

describe("SQL-BACKEND-01: Constructor with executor", () => {
  let db: Database
  let executor: BunSqlExecutor

  beforeEach(() => {
    db = new Database(":memory:")
    executor = new BunSqlExecutor(db)
  })

  afterEach(() => {
    db.close()
  })

  test("accepts config object with dialect and executor", () => {
    const backend = new SqlBackend({
      dialect: "sqlite",
      executor: executor
    })

    expect(backend.dialect).toBe("sqlite")
    expect(backend.executor).toBe(executor)
  })

  test("accepts config object with pg dialect", () => {
    const backend = new SqlBackend({
      dialect: "pg",
      executor: executor
    })

    expect(backend.dialect).toBe("pg")
    expect(backend.executor).toBe(executor)
  })

  test("dialect-only constructor for backward compatibility", () => {
    const backend = new SqlBackend("sqlite")

    expect(backend.dialect).toBe("sqlite")
    expect(backend.executor).toBeUndefined()
  })

  test("defaults to pg dialect when not specified", () => {
    const backend = new SqlBackend({ executor })

    expect(backend.dialect).toBe("pg")
    expect(backend.executor).toBe(executor)
  })

  test("no-args constructor defaults to pg with no executor", () => {
    const backend = new SqlBackend()

    expect(backend.dialect).toBe("pg")
    expect(backend.executor).toBeUndefined()
  })
})

// ============================================================================
// SQL-BACKEND-02: Executor Property Access
// ============================================================================

describe("SQL-BACKEND-02: Executor property access", () => {
  let db: Database
  let executor: BunSqlExecutor

  beforeEach(() => {
    db = new Database(":memory:")
    executor = new BunSqlExecutor(db)
  })

  afterEach(() => {
    db.close()
  })

  test("executor is accessible as property", () => {
    const backend = new SqlBackend({ dialect: "sqlite", executor })

    expect(backend.executor).toBeDefined()
    expect(backend.executor).toBe(executor)
  })

  test("can check if backend has executor", () => {
    const withExecutor = new SqlBackend({ dialect: "sqlite", executor })
    const withoutExecutor = new SqlBackend("sqlite")

    expect(withExecutor.executor).toBeDefined()
    expect(withoutExecutor.executor).toBeUndefined()
  })
})

// ============================================================================
// SQL-BACKEND-03: Type Discrimination
// ============================================================================

describe("SQL-BACKEND-03: Type discrimination", () => {
  test("SqlBackend with dialect is SQL backend", () => {
    const backend = new SqlBackend("sqlite")

    // Duck typing: has dialect property → SQL backend
    expect("dialect" in backend).toBe(true)
    expect(typeof backend.dialect).toBe("string")
  })

  test("MemoryBackend does not have dialect", () => {
    const backend = new MemoryBackend()

    // No dialect property → Memory backend
    expect("dialect" in backend).toBe(false)
  })

  test("can discriminate backend type via dialect property", () => {
    const sqlBackend = new SqlBackend("sqlite")
    const memoryBackend = new MemoryBackend()

    function getBackendType(backend: any): "sql" | "memory" {
      return "dialect" in backend && backend.dialect ? "sql" : "memory"
    }

    expect(getBackendType(sqlBackend)).toBe("sql")
    expect(getBackendType(memoryBackend)).toBe("memory")
  })
})
