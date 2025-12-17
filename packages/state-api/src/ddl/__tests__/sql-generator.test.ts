/**
 * Unit tests for SQL string generation from DDL structures
 *
 * Tests the conversion of DDLOutput structures (TableDef, ColumnDef, ForeignKeyDef)
 * into executable SQL strings for PostgreSQL and SQLite dialects.
 */

import { describe, test, expect } from "bun:test"
import type { ColumnDef, TableDef, ForeignKeyDef, DDLOutput, SqlDialect } from "../types"
import { createPostgresDialect, createSqliteDialect } from "../dialect"
import {
  columnDefToSQL,
  tableDefToCreateTableSQL,
  foreignKeyDefToSQL,
  ddlOutputToSQL,
} from "../sql-generator"

describe("sql-generator", () => {
  const postgresDialect = createPostgresDialect()
  const sqliteDialect = createSqliteDialect()

  describe("columnDefToSQL", () => {
    test("generates column definition with all constraint types", () => {
      // test-sql-gen-009: Column definition formatting with all constraint types
      const column: ColumnDef = {
        name: "status",
        type: "TEXT",
        nullable: false,
        checkConstraint: "status IN ('active', 'inactive')",
      }

      const result = columnDefToSQL(column, false, postgresDialect)

      expect(result).toContain('"status"')
      expect(result).toContain("TEXT")
      expect(result).toContain("NOT NULL")
      expect(result).toContain("CHECK (status IN ('active', 'inactive'))")
    })

    test("generates primary key column definition", () => {
      const column: ColumnDef = {
        name: "id",
        type: "UUID",
        nullable: false,
      }

      const result = columnDefToSQL(column, true, postgresDialect)

      expect(result).toContain('"id"')
      expect(result).toContain("UUID")
      expect(result).toContain("PRIMARY KEY")
    })

    test("generates nullable column without NOT NULL", () => {
      const column: ColumnDef = {
        name: "description",
        type: "TEXT",
        nullable: true,
      }

      const result = columnDefToSQL(column, false, postgresDialect)

      expect(result).toContain('"description"')
      expect(result).toContain("TEXT")
      expect(result).not.toContain("NOT NULL")
    })
  })

  describe("tableDefToCreateTableSQL", () => {
    test("generates CREATE TABLE with simple columns", () => {
      // test-sql-gen-001: Generate CREATE TABLE with simple columns
      const table: TableDef = {
        name: "Organization",
        columns: [
          { name: "id", type: "UUID", nullable: false },
          { name: "name", type: "TEXT", nullable: false },
          { name: "description", type: "TEXT", nullable: true },
        ],
        primaryKey: "id",
        foreignKeys: [],
      }

      const result = tableDefToCreateTableSQL(table, postgresDialect)

      // Returns CREATE TABLE string
      expect(result).toContain("CREATE TABLE")

      // Table name escaped
      expect(result).toContain('"Organization"')

      // id column includes PRIMARY KEY
      expect(result).toMatch(/"id"\s+UUID\s+PRIMARY KEY/)

      // name column includes NOT NULL
      expect(result).toMatch(/"name"\s+TEXT\s+NOT NULL/)

      // description column nullable (no NOT NULL)
      expect(result).toMatch(/"description"\s+TEXT[^N]/)
      expect(result).not.toContain('"description" TEXT NOT NULL')

      // Proper indentation (2 spaces per column)
      expect(result).toContain("  \"id\"")

      // Ends with semicolon
      expect(result).toMatch(/;\s*$/)
    })

    test("generates CREATE TABLE with CHECK constraint", () => {
      // test-sql-gen-002: Generate CREATE TABLE with CHECK constraint
      const table: TableDef = {
        name: "User",
        columns: [
          { name: "id", type: "UUID", nullable: false },
          {
            name: "status",
            type: "TEXT",
            nullable: false,
            checkConstraint: "status IN ('active', 'inactive')",
          },
        ],
        primaryKey: "id",
        foreignKeys: [],
      }

      const result = tableDefToCreateTableSQL(table, postgresDialect)

      // Status column includes CHECK constraint
      expect(result).toContain("CHECK")

      // CHECK constraint properly quoted
      expect(result).toContain("CHECK (status IN ('active', 'inactive'))")

      // Constraint format correct
      expect(result).toMatch(/"status"\s+TEXT\s+NOT NULL\s+CHECK \(status IN \('active', 'inactive'\)\)/)
    })

    test("generates composite primary key for junction table", () => {
      // test-sql-gen-006: Composite primary key for junction table
      const table: TableDef = {
        name: "Team_members",
        columns: [
          { name: "team_id", type: "UUID", nullable: false },
          { name: "user_id", type: "UUID", nullable: false },
        ],
        primaryKey: "team_id, user_id",
        foreignKeys: [],
      }

      const result = tableDefToCreateTableSQL(table, postgresDialect)

      // PRIMARY KEY clause includes both columns
      expect(result).toContain("PRIMARY KEY")

      // Format: PRIMARY KEY ("team_id", "user_id")
      expect(result).toMatch(/PRIMARY KEY \("team_id",\s*"user_id"\)/)

      // Columns properly escaped and comma-separated
      expect(result).toContain('"team_id"')
      expect(result).toContain('"user_id"')
    })

    test("handles identifier escaping with special characters", () => {
      // test-sql-gen-007: Identifier escaping with special characters
      const table: TableDef = {
        name: 'user"table',
        columns: [
          { name: "id", type: "UUID", nullable: false },
        ],
        primaryKey: "id",
        foreignKeys: [],
      }

      const result = tableDefToCreateTableSQL(table, postgresDialect)

      // Table name properly escaped: "user""table"
      expect(result).toContain('"user""table"')

      // Internal quotes doubled
      expect(result).toMatch(/CREATE TABLE "user""table"/)

      // No SQL injection vulnerability
      expect(result).not.toContain('user"table')
    })

    test("generates SQLite CREATE TABLE with type fallbacks", () => {
      // test-sql-gen-010: SQLite CREATE TABLE with type fallbacks
      const table: TableDef = {
        name: "Organization",
        columns: [
          { name: "id", type: "TEXT", nullable: false }, // UUID becomes TEXT
          { name: "createdAt", type: "TEXT", nullable: true }, // TIMESTAMPTZ becomes TEXT
          { name: "isActive", type: "INTEGER", nullable: false }, // BOOLEAN becomes INTEGER
        ],
        primaryKey: "id",
        foreignKeys: [],
      }

      const result = tableDefToCreateTableSQL(table, sqliteDialect)

      // UUID becomes TEXT
      expect(result).toMatch(/"id"\s+TEXT\s+PRIMARY KEY/)

      // TIMESTAMPTZ becomes TEXT
      expect(result).toMatch(/"createdAt"\s+TEXT/)

      // BOOLEAN becomes INTEGER
      expect(result).toMatch(/"isActive"\s+INTEGER\s+NOT NULL/)

      // All other formatting same as PostgreSQL
      expect(result).toContain("CREATE TABLE")
      expect(result).toMatch(/;\s*$/)
    })
  })

  describe("foreignKeyDefToSQL", () => {
    test("generates ALTER TABLE for foreign key (PostgreSQL)", () => {
      // test-sql-gen-003: Generate ALTER TABLE for foreign key (PostgreSQL)
      const fk: ForeignKeyDef = {
        name: "fk_Team_organization_id",
        table: "Team",
        column: "organization_id",
        referencesTable: "Organization",
        referencesColumn: "id",
        onDelete: "CASCADE",
      }

      const result = foreignKeyDefToSQL(fk, postgresDialect)

      // Returns ALTER TABLE statement
      expect(result).toContain("ALTER TABLE")

      // Constraint name: fk_Team_organization_id
      expect(result).toContain("fk_Team_organization_id")

      // FOREIGN KEY (organization_id) REFERENCES Organization (id)
      expect(result).toContain('FOREIGN KEY ("organization_id")')
      expect(result).toContain('REFERENCES "Organization" ("id")')

      // ON DELETE CASCADE included
      expect(result).toContain("ON DELETE CASCADE")

      // All identifiers escaped
      expect(result).toContain('"Team"')
      expect(result).toContain('"Organization"')

      // Ends with semicolon
      expect(result).toMatch(/;\s*$/)
    })

    test("generates inline FK comment for SQLite", () => {
      // test-sql-gen-004: SQLite dialect generates inline FK comments
      const fk: ForeignKeyDef = {
        name: "fk_Team_organization_id",
        table: "Team",
        column: "organization_id",
        referencesTable: "Organization",
        referencesColumn: "id",
        onDelete: "CASCADE",
      }

      const result = foreignKeyDefToSQL(fk, sqliteDialect)

      // Returns comment string (not ALTER TABLE)
      expect(result).not.toContain("ALTER TABLE")

      // Comment starts with --
      expect(result).toMatch(/^--/)

      // Includes inline FK syntax
      expect(result).toContain("FOREIGN KEY")
      expect(result).toContain("REFERENCES")

      // Notes that FK should be in CREATE TABLE
      expect(result).toContain("inline")
    })

    test("generates SET NULL for optional foreign keys", () => {
      const fk: ForeignKeyDef = {
        name: "fk_Team_parent_id",
        table: "Team",
        column: "parent_id",
        referencesTable: "Team",
        referencesColumn: "id",
        onDelete: "SET NULL",
      }

      const result = foreignKeyDefToSQL(fk, postgresDialect)

      expect(result).toContain("ON DELETE SET NULL")
      expect(result).not.toContain("CASCADE")
    })
  })

  describe("ddlOutputToSQL", () => {
    test("generates complete DDL in execution order", () => {
      // test-sql-gen-005: Complete DDL generation in execution order
      const ddl: DDLOutput = {
        tables: [
          {
            name: "Organization",
            columns: [
              { name: "id", type: "UUID", nullable: false },
              { name: "name", type: "TEXT", nullable: false },
            ],
            primaryKey: "id",
            foreignKeys: [],
          },
          {
            name: "Team",
            columns: [
              { name: "id", type: "UUID", nullable: false },
              { name: "name", type: "TEXT", nullable: false },
              { name: "organization_id", type: "UUID", nullable: false },
            ],
            primaryKey: "id",
            foreignKeys: [
              {
                name: "fk_Team_organization_id",
                table: "Team",
                column: "organization_id",
                referencesTable: "Organization",
                referencesColumn: "id",
                onDelete: "CASCADE",
              },
            ],
          },
        ],
        junctionTables: [
          {
            name: "Team_members",
            columns: [
              { name: "team_id", type: "UUID", nullable: false },
              { name: "user_id", type: "UUID", nullable: false },
            ],
            primaryKey: "team_id, user_id",
            foreignKeys: [],
          },
        ],
        foreignKeys: [
          {
            name: "fk_Team_organization_id",
            table: "Team",
            column: "organization_id",
            referencesTable: "Organization",
            referencesColumn: "id",
            onDelete: "CASCADE",
          },
        ],
        executionOrder: ["Organization", "Team", "Team_members"],
      }

      const result = ddlOutputToSQL(ddl, postgresDialect)

      // Returns string[] in execution order
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)

      // Organization CREATE TABLE before Team CREATE TABLE
      const orgIndex = result.findIndex((s) => s.includes('CREATE TABLE "Organization"'))
      const teamIndex = result.findIndex((s) => s.includes('CREATE TABLE "Team"'))
      expect(orgIndex).toBeGreaterThan(-1)
      expect(teamIndex).toBeGreaterThan(-1)
      expect(orgIndex).toBeLessThan(teamIndex)

      // All entity CREATE TABLEs before junction tables
      const junctionIndex = result.findIndex((s) => s.includes('CREATE TABLE "Team_members"'))
      expect(junctionIndex).toBeGreaterThan(teamIndex)

      // All CREATE TABLEs before ALTER TABLE FKs
      const firstAlterIndex = result.findIndex((s) => s.startsWith("ALTER TABLE"))
      if (firstAlterIndex > -1) {
        expect(firstAlterIndex).toBeGreaterThan(junctionIndex)
      }

      // All statements valid SQL
      result.forEach((stmt) => {
        if (!stmt.startsWith("--")) {
          expect(stmt).toMatch(/;\s*$/)
        }
      })
    })

    test("handles empty DDLOutput", () => {
      const ddl: DDLOutput = {
        tables: [],
        junctionTables: [],
        foreignKeys: [],
        executionOrder: [],
      }

      const result = ddlOutputToSQL(ddl, postgresDialect)

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(0)
    })
  })
})
