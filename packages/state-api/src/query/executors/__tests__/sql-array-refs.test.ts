/**
 * SqlQueryExecutor Array Reference Hydration Tests
 *
 * Tests for hydrating array references from junction tables.
 * Validates that select() returns entities with populated array reference IDs.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { parseQuery } from "../../ast/parser"
import { SqlBackend } from "../../backends/sql"
import { BunSqlExecutor } from "../../execution/bun-sql"
import { SqlQueryExecutor } from "../sql"
import { createColumnPropertyMap } from "../../execution/utils"
import type { ArrayReferenceMetadata } from "../../../ddl/utils"

// ============================================================================
// SQL-ArrayRefs: Array Reference Hydration Tests
// ============================================================================

describe("SQL-ArrayRefs: SqlQueryExecutor Array Reference Hydration", () => {
  type Team = {
    id: string
    name: string
    members?: string[]  // Hydrated from junction table
  }

  let db: Database
  let executor: SqlQueryExecutor<Team>

  const arrayRefsMeta: Record<string, ArrayReferenceMetadata> = {
    members: {
      junctionTable: "team_members",
      sourceColumn: "team_id",
      targetColumn: "user_id",
      targetModel: "User",
      isSelfReference: false
    }
  }

  beforeEach(() => {
    db = new Database(":memory:")

    // Create main table
    db.run(`
      CREATE TABLE team (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )
    `)

    // Create junction table
    db.run(`
      CREATE TABLE team_members (
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (team_id, user_id)
      )
    `)

    // Seed test data
    db.run(`INSERT INTO team VALUES ('team-1', 'Engineering')`)
    db.run(`INSERT INTO team VALUES ('team-2', 'Design')`)
    db.run(`INSERT INTO team_members VALUES ('team-1', 'user-1')`)
    db.run(`INSERT INTO team_members VALUES ('team-1', 'user-2')`)
    db.run(`INSERT INTO team_members VALUES ('team-1', 'user-3')`)
    db.run(`INSERT INTO team_members VALUES ('team-2', 'user-4')`)
    db.run(`INSERT INTO team_members VALUES ('team-2', 'user-5')`)

    const columnPropertyMap = createColumnPropertyMap(["id", "name"])
    const propertyTypes = { id: "string", name: "string" }

    executor = new SqlQueryExecutor(
      "team",
      new SqlBackend("sqlite"),
      new BunSqlExecutor(db),
      columnPropertyMap,
      "sqlite",
      propertyTypes,
      arrayRefsMeta
    )
  })

  afterEach(() => {
    db.close()
  })

  // ==========================================================================
  // getRelatedIds() Tests
  // ==========================================================================

  describe("getRelatedIds()", () => {
    test("returns array of related IDs from junction table", async () => {
      const ids = await executor.getRelatedIds("team-1", "members")

      expect(ids).toHaveLength(3)
      expect(ids).toContain("user-1")
      expect(ids).toContain("user-2")
      expect(ids).toContain("user-3")
    })

    test("returns empty array for entity with no relations", async () => {
      db.run(`INSERT INTO team VALUES ('team-lonely', 'Solo Team')`)

      const ids = await executor.getRelatedIds("team-lonely", "members")

      expect(ids).toEqual([])
    })

    test("throws for unknown relation name", async () => {
      await expect(
        executor.getRelatedIds("team-1", "unknownRelation")
      ).rejects.toThrow(/unknown.*relation/i)
    })
  })

  // ==========================================================================
  // select() with Hydration Tests
  // ==========================================================================

  describe("select() with hydration", () => {
    test("hydrates array reference IDs after main query", async () => {
      const results = await executor.select(parseQuery({ id: "team-1" }))

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe("team-1")
      expect(results[0].members).toBeDefined()
      expect(results[0].members).toHaveLength(3)
      expect(results[0].members).toContain("user-1")
      expect(results[0].members).toContain("user-2")
      expect(results[0].members).toContain("user-3")
    })

    test("hydrates multiple entities in batch", async () => {
      const results = await executor.select(parseQuery({}))

      expect(results).toHaveLength(2)

      const team1 = results.find(t => t.id === "team-1")
      const team2 = results.find(t => t.id === "team-2")

      expect(team1?.members).toHaveLength(3)
      expect(team2?.members).toHaveLength(2)
    })

    test("returns empty arrays for entities without relations", async () => {
      db.run(`INSERT INTO team VALUES ('team-empty', 'Empty Team')`)

      const results = await executor.select(parseQuery({ id: "team-empty" }))

      expect(results[0].members).toEqual([])
    })

    test("skips hydration when no arrayReferences metadata provided", async () => {
      const executorNoMeta = new SqlQueryExecutor(
        "team",
        new SqlBackend("sqlite"),
        new BunSqlExecutor(db),
        createColumnPropertyMap(["id", "name"]),
        "sqlite",
        { id: "string", name: "string" }
        // No arrayReferences parameter
      )

      const results = await executorNoMeta.select(parseQuery({}))

      // Should not have members property at all (undefined, not [])
      expect((results[0] as any).members).toBeUndefined()
    })
  })

  // ==========================================================================
  // first() with Hydration Tests
  // ==========================================================================

  describe("first() with hydration", () => {
    test("hydrates array reference on single entity", async () => {
      const result = await executor.first(parseQuery({ id: "team-1" }))

      expect(result?.members).toBeDefined()
      expect(result?.members).toHaveLength(3)
    })
  })

  // ==========================================================================
  // Self-Referential Array References
  // ==========================================================================

  describe("self-referential array references", () => {
    let categoryDb: Database
    let categoryExecutor: SqlQueryExecutor<{ id: string; name: string; subcategories?: string[] }>

    beforeEach(() => {
      categoryDb = new Database(":memory:")

      // Create category table
      categoryDb.run(`
        CREATE TABLE category (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        )
      `)

      // Create self-referential junction table
      categoryDb.run(`
        CREATE TABLE category_subcategories (
          source_category_id TEXT NOT NULL,
          target_category_id TEXT NOT NULL,
          PRIMARY KEY (source_category_id, target_category_id)
        )
      `)

      // Seed data
      categoryDb.run(`INSERT INTO category VALUES ('cat-parent', 'Parent')`)
      categoryDb.run(`INSERT INTO category VALUES ('cat-child1', 'Child 1')`)
      categoryDb.run(`INSERT INTO category VALUES ('cat-child2', 'Child 2')`)
      categoryDb.run(`INSERT INTO category_subcategories VALUES ('cat-parent', 'cat-child1')`)
      categoryDb.run(`INSERT INTO category_subcategories VALUES ('cat-parent', 'cat-child2')`)

      categoryExecutor = new SqlQueryExecutor(
        "category",
        new SqlBackend("sqlite"),
        new BunSqlExecutor(categoryDb),
        createColumnPropertyMap(["id", "name"]),
        "sqlite",
        { id: "string", name: "string" },
        {
          subcategories: {
            junctionTable: "category_subcategories",
            sourceColumn: "source_category_id",
            targetColumn: "target_category_id",
            targetModel: "Category",
            isSelfReference: true
          }
        }
      )
    })

    afterEach(() => {
      categoryDb.close()
    })

    test("handles self-reference column naming", async () => {
      const results = await categoryExecutor.select(parseQuery({ id: "cat-parent" }))

      expect(results[0].subcategories).toBeDefined()
      expect(results[0].subcategories).toHaveLength(2)
      expect(results[0].subcategories).toContain("cat-child1")
      expect(results[0].subcategories).toContain("cat-child2")
    })
  })

  // ==========================================================================
  // insert() with Junction Mutations
  // ==========================================================================

  describe("insert() with junction mutations", () => {
    test("inserts junction rows for array reference values", async () => {
      const entity = await executor.insert({
        id: "team-new",
        name: "New Team",
        members: ["user-10", "user-11"]
      } as any)

      // Verify main entity inserted
      expect(entity.id).toBe("team-new")
      expect(entity.name).toBe("New Team")

      // Verify junction rows created
      const junctionRows = db.query(
        "SELECT * FROM team_members WHERE team_id = ?"
      ).all("team-new") as any[]

      expect(junctionRows).toHaveLength(2)
      expect(junctionRows.map((r: any) => r.user_id)).toContain("user-10")
      expect(junctionRows.map((r: any) => r.user_id)).toContain("user-11")
    })

    test("returns entity with hydrated array reference", async () => {
      const entity = await executor.insert({
        id: "team-new",
        name: "New Team",
        members: ["user-10"]
      } as any)

      expect(entity.members).toBeDefined()
      expect(entity.members).toEqual(["user-10"])
    })

    test("handles insert with empty array reference", async () => {
      const entity = await executor.insert({
        id: "team-empty",
        name: "Empty Team",
        members: []
      } as any)

      expect(entity.members).toEqual([])

      const junctionRows = db.query(
        "SELECT * FROM team_members WHERE team_id = ?"
      ).all("team-empty")
      expect(junctionRows).toHaveLength(0)
    })

    test("handles insert with undefined array reference", async () => {
      const entity = await executor.insert({
        id: "team-undefined",
        name: "Undefined Members Team"
        // members not specified
      } as any)

      // Should not crash, members populated as empty from hydration
      expect(entity.members).toEqual([])
    })
  })

  // ==========================================================================
  // update() with Junction Mutations
  // ==========================================================================

  describe("update() with junction mutations", () => {
    test("replaces junction rows on array reference update", async () => {
      // Initially team-1 has user-1, user-2, user-3
      const updated = await executor.update("team-1", {
        members: ["user-99", "user-100"]
      } as any)

      expect(updated?.members).toBeDefined()
      expect(updated?.members).toHaveLength(2)
      expect(updated?.members).toContain("user-99")
      expect(updated?.members).toContain("user-100")

      // Verify old junction rows deleted
      const junctionRows = db.query(
        "SELECT * FROM team_members WHERE team_id = ?"
      ).all("team-1") as any[]

      expect(junctionRows).toHaveLength(2)
      expect(junctionRows.map((r: any) => r.user_id)).not.toContain("user-1")
      expect(junctionRows.map((r: any) => r.user_id)).toContain("user-99")
    })

    test("clears junction rows when array set to empty", async () => {
      const updated = await executor.update("team-1", {
        members: []
      } as any)

      expect(updated?.members).toEqual([])

      const junctionRows = db.query(
        "SELECT * FROM team_members WHERE team_id = ?"
      ).all("team-1")
      expect(junctionRows).toHaveLength(0)
    })

    test("preserves junction rows when array not in update", async () => {
      const updated = await executor.update("team-1", {
        name: "Renamed"
      } as any)

      expect(updated?.name).toBe("Renamed")
      expect(updated?.members).toHaveLength(3)
      expect(updated?.members).toContain("user-1")
    })
  })
})
