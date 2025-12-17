/**
 * SqlBackend Dialect Tests
 *
 * Tests for dialect-specific SQL generation and quirk handling.
 * Validates that SqlBackend correctly uses @ucast/sql dialects (pg, sqlite).
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { SqlBackend } from "../sql"
import { parseQuery } from "../../ast/parser"

// ============================================================================
// DIALECT-01: SqlBackend Dialect Configuration
// ============================================================================

describe("DIALECT-01: SqlBackend dialect configuration", () => {
  test("constructor accepts pg dialect", () => {
    const backend = new SqlBackend("pg")
    expect((backend as any).dialect).toBe("pg")
  })

  test("constructor accepts sqlite dialect", () => {
    const backend = new SqlBackend("sqlite")
    expect((backend as any).dialect).toBe("sqlite")
  })

  test("defaults to pg when not specified", () => {
    const backend = new SqlBackend()
    expect((backend as any).dialect).toBe("pg")
  })

  test("pg dialect generates $1 placeholders", () => {
    const backend = new SqlBackend("pg")
    const [sql, params] = backend.compileSelect(
      parseQuery({ name: "test" }),
      "users"
    )

    expect(sql).toContain("$1")
    expect(params).toEqual(["test"])
  })

  test("sqlite dialect generates ? placeholders", () => {
    const backend = new SqlBackend("sqlite")
    const [sql, params] = backend.compileSelect(
      parseQuery({ name: "test" }),
      "users"
    )

    expect(sql).toContain("?")
    expect(sql).not.toContain("$1")
    expect(params).toEqual(["test"])
  })

  test("pg dialect uses double quotes for identifiers", () => {
    const backend = new SqlBackend("pg")
    const [sql] = backend.compileSelect(parseQuery({ name: "test" }), "users")

    // compileSelect returns WHERE clause, not full SELECT
    // Should contain "name" with double quotes
    expect(sql).toMatch(/"name"/)
  })

  test("sqlite dialect uses backticks for identifiers", () => {
    const backend = new SqlBackend("sqlite")
    const [sql] = backend.compileSelect(parseQuery({ name: "test" }), "users")

    // compileSelect returns WHERE clause, not full SELECT
    // Should contain `name` with backticks
    expect(sql).toMatch(/`name`/)
  })
})

// ============================================================================
// DIALECT-02: SQLite OFFSET Requires LIMIT
// ============================================================================

describe("DIALECT-02: SQLite OFFSET requires LIMIT", () => {
  let sqliteBackend: SqlBackend
  let pgBackend: SqlBackend

  beforeEach(() => {
    sqliteBackend = new SqlBackend("sqlite")
    pgBackend = new SqlBackend("pg")
  })

  test("sqlite: skip without take auto-adds LIMIT -1", () => {
    const [sql] = sqliteBackend.compileSelect(
      parseQuery({}),
      "users",
      { skip: 10 }
    )

    expect(sql).toContain("LIMIT -1")
    expect(sql).toContain("OFFSET 10")
  })

  test("sqlite: skip with take uses explicit LIMIT", () => {
    const [sql] = sqliteBackend.compileSelect(
      parseQuery({}),
      "users",
      { skip: 10, take: 5 }
    )

    expect(sql).toContain("LIMIT 5")
    expect(sql).toContain("OFFSET 10")
    expect(sql).not.toContain("LIMIT -1")
  })

  test("sqlite: take without skip uses just LIMIT", () => {
    const [sql] = sqliteBackend.compileSelect(
      parseQuery({}),
      "users",
      { take: 5 }
    )

    expect(sql).toContain("LIMIT 5")
    expect(sql).not.toContain("OFFSET")
  })

  test("pg: OFFSET without LIMIT is valid", () => {
    const [sql] = pgBackend.compileSelect(
      parseQuery({}),
      "users",
      { skip: 10 }
    )

    expect(sql).toContain("OFFSET 10")
    expect(sql).not.toContain("LIMIT")
  })

  test("pg: skip and take both included", () => {
    const [sql] = pgBackend.compileSelect(
      parseQuery({}),
      "users",
      { skip: 10, take: 5 }
    )

    expect(sql).toContain("LIMIT 5")
    expect(sql).toContain("OFFSET 10")
  })
})

// ============================================================================
// DIALECT-03: Dialect-Specific Compilation Differences
// ============================================================================

describe("DIALECT-03: Compilation differences by dialect", () => {
  test("compileCount generates correct placeholder style", () => {
    const pgBackend = new SqlBackend("pg")
    const sqliteBackend = new SqlBackend("sqlite")

    const ast = parseQuery({ status: "active" })

    const [pgSql] = pgBackend.compileCount(ast, "users")
    const [sqliteSql] = sqliteBackend.compileCount(ast, "users")

    expect(pgSql).toContain("$1")
    expect(sqliteSql).toContain("?")
  })

  test("compileExists generates correct placeholder style", () => {
    const pgBackend = new SqlBackend("pg")
    const sqliteBackend = new SqlBackend("sqlite")

    const ast = parseQuery({ email: "test@example.com" })

    const [pgSql] = pgBackend.compileExists(ast, "users")
    const [sqliteSql] = sqliteBackend.compileExists(ast, "users")

    expect(pgSql).toContain("$1")
    expect(sqliteSql).toContain("?")
  })
})