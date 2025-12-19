/**
 * Integration Tests: Isomorphic Query System
 *
 * Top-down TDD specs expressing how the query system SHOULD work
 * at the composition layer using real domain() compositions.
 *
 * These tests will be RED until all underlying layers are implemented.
 *
 * Domain: teams-workspace
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqlExecutor } from "../../src/query/execution/bun-sql"
import { teamsDomain } from "../../src/teams/domain"
import type { IQueryable } from "../../src/composition/queryable"
import { generateDDL, createSqliteDialect, tableDefToCreateTableSQL, deriveNamespace } from "../../src/ddl"

// Test utilities (to be implemented)
import {
  createEnvironment,
  createSeededStore,
  type TestData
} from "../helpers/query-test-utils"

// Cache dialect instance for direct SQL tests
const sqliteDialect = createSqliteDialect()
// Schema name must match what createEnvironment uses
const SCHEMA_NAME = "teams-workspace"

/**
 * Create tables from Enhanced JSON Schema using DDL generator.
 * Uses namespace for table isolation.
 */
function createTablesFromSchema(db: Database) {
  // Use same namespace derivation as BackendRegistry.resolve()
  const namespace = deriveNamespace(SCHEMA_NAME)
  const ddl = generateDDL(teamsDomain.enhancedSchema, sqliteDialect, { namespace })
  for (const tableName of ddl.executionOrder) {
    const table = ddl.tables.find(t => t.name === tableName)
    if (table) {
      db.run(tableDefToCreateTableSQL(table, sqliteDialect))
    }
  }
}

// ============================================================================
// INT-01: Memory Backend - Basic Query Operations
// ============================================================================

describe("INT-01: Memory Backend Query Operations", () => {
  let store: any
  let orgId: string
  let team1Id: string
  let team2Id: string
  let mem1Id: string
  let mem2Id: string
  let mem3Id: string

  beforeEach(() => {
    // Generate UUIDs
    orgId = crypto.randomUUID()
    team1Id = crypto.randomUUID()
    team2Id = crypto.randomUUID()
    mem1Id = crypto.randomUUID()
    mem2Id = crypto.randomUUID()
    mem3Id = crypto.randomUUID()

    // Setup: Create teams-workspace domain with memory backend
    const env = createEnvironment({
      backend: "memory"
    })

    store = teamsDomain.createStore(env)

    // Seed test data
    store.organizationCollection.add({
      id: orgId,
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now()
    })

    store.teamCollection.add({
      id: team1Id,
      name: "Engineering",
      organizationId: orgId,
      createdAt: Date.now()
    })

    store.teamCollection.add({
      id: team2Id,
      name: "Design",
      organizationId: orgId,
      createdAt: Date.now()
    })

    store.membershipCollection.add({
      id: mem1Id,
      userId: "user-alice",
      role: "admin",
      teamId: team1Id,
      createdAt: Date.now()
    })

    store.membershipCollection.add({
      id: mem2Id,
      userId: "user-bob",
      role: "member",
      teamId: team1Id,
      createdAt: Date.now()
    })

    store.membershipCollection.add({
      id: mem3Id,
      userId: "user-alice",
      role: "viewer",
      teamId: team2Id,
      createdAt: Date.now()
    })
  })

  test("toArray() returns all matching items", async () => {
    const memberships = await store.membershipCollection
      .query()
      .where({ userId: "user-alice" })
      .toArray()

    expect(memberships).toHaveLength(2)
    expect(memberships.map((m: any) => m.teamId.id)).toContain(team1Id)
    expect(memberships.map((m: any) => m.teamId.id)).toContain(team2Id)
  })

  test("first() returns first matching item or undefined", async () => {
    const membership = await store.membershipCollection
      .query()
      .where({ userId: "user-alice", role: "admin" })
      .first()

    expect(membership).toBeDefined()
    expect(membership.id).toBe(mem1Id)

    const noMatch = await store.membershipCollection
      .query()
      .where({ userId: "user-charlie" })
      .first()

    expect(noMatch).toBeUndefined()
  })

  test("count() returns number of matching items", async () => {
    const aliceCount = await store.membershipCollection
      .query()
      .where({ userId: "user-alice" })
      .count()

    expect(aliceCount).toBe(2)

    const adminCount = await store.membershipCollection
      .query()
      .where({ role: "admin" })
      .count()

    expect(adminCount).toBe(1)
  })

  test("any() returns boolean existence check", async () => {
    const hasAlice = await store.membershipCollection
      .query()
      .where({ userId: "user-alice" })
      .any()

    expect(hasAlice).toBe(true)

    const hasCharlie = await store.membershipCollection
      .query()
      .where({ userId: "user-charlie" })
      .any()

    expect(hasCharlie).toBe(false)
  })

  test("orderBy() sorts results", async () => {
    const teams = await store.teamCollection
      .query()
      .orderBy("name", "asc")
      .toArray()

    expect(teams[0].name).toBe("Design")
    expect(teams[1].name).toBe("Engineering")

    const teamsDesc = await store.teamCollection
      .query()
      .orderBy("name", "desc")
      .toArray()

    expect(teamsDesc[0].name).toBe("Engineering")
    expect(teamsDesc[1].name).toBe("Design")
  })

  test("skip() and take() paginate results", async () => {
    const page1 = await store.teamCollection
      .query()
      .orderBy("name", "asc")
      .take(1)
      .toArray()

    expect(page1).toHaveLength(1)
    expect(page1[0].name).toBe("Design")

    const page2 = await store.teamCollection
      .query()
      .orderBy("name", "asc")
      .skip(1)
      .take(1)
      .toArray()

    expect(page2).toHaveLength(1)
    expect(page2[0].name).toBe("Engineering")
  })

  test("chained where() combines with AND", async () => {
    const result = await store.membershipCollection
      .query()
      .where({ userId: "user-alice" })
      .where({ role: "admin" })
      .toArray()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(mem1Id)
  })
})

// ============================================================================
// INT-02: SQL Backend - Same Query Operations
// ============================================================================

describe("INT-02: SQL Backend Query Operations", () => {
  let store: any
  let db: Database
  let orgId: string
  let team1Id: string
  let team2Id: string
  let mem1Id: string
  let mem2Id: string
  let mem3Id: string

  beforeEach(async () => {
    // Generate UUIDs
    orgId = crypto.randomUUID()
    team1Id = crypto.randomUUID()
    team2Id = crypto.randomUUID()
    mem1Id = crypto.randomUUID()
    mem2Id = crypto.randomUUID()
    mem3Id = crypto.randomUUID()

    // Setup: Create in-memory SQLite database
    db = new Database(":memory:")

    // Create tables using DDL generator (schema has proper x-mst-type metadata)
    createTablesFromSchema(db)

    // Setup: Create teams-workspace domain with SQL backend
    const executor = new BunSqlExecutor(db)
    const env = createEnvironment({
      backend: "sql",
      sqlExecutor: executor
    })

    store = teamsDomain.createStore(env)

    // Seed data using CollectionMutatable.insertOne for isomorphic behavior
    const now = Date.now()
    await store.organizationCollection.insertOne({ id: orgId, name: "Acme Corp", slug: "acme", createdAt: now })
    await store.teamCollection.insertOne({ id: team1Id, name: "Engineering", organizationId: orgId, createdAt: now })
    await store.teamCollection.insertOne({ id: team2Id, name: "Design", organizationId: orgId, createdAt: now })
    await store.membershipCollection.insertOne({ id: mem1Id, userId: "user-alice", role: "admin", teamId: team1Id, createdAt: now })
    await store.membershipCollection.insertOne({ id: mem2Id, userId: "user-bob", role: "member", teamId: team1Id, createdAt: now })
    await store.membershipCollection.insertOne({ id: mem3Id, userId: "user-alice", role: "viewer", teamId: team2Id, createdAt: now })
  })

  afterEach(() => {
    db.close()
  })

  // IDENTICAL tests to INT-01 - proving isomorphic behavior

  test("toArray() returns all matching items", async () => {
    const memberships = await store.membershipCollection
      .query()
      .where({ userId: "user-alice" })
      .toArray()

    expect(memberships).toHaveLength(2)
    // Results should have proper camelCase property names (normalized)
    expect(memberships[0]).toHaveProperty("userId", "user-alice")
    expect(memberships[0]).not.toHaveProperty("user_id")
  })

  test("first() returns first matching item or undefined", async () => {
    const membership = await store.membershipCollection
      .query()
      .where({ userId: "user-alice", role: "admin" })
      .first()

    expect(membership).toBeDefined()
    expect(membership.id).toBe(mem1Id)

    const noMatch = await store.membershipCollection
      .query()
      .where({ userId: "user-charlie" })
      .first()

    expect(noMatch).toBeUndefined()
  })

  test("count() uses SQL COUNT(*) optimization", async () => {
    const aliceCount = await store.membershipCollection
      .query()
      .where({ userId: "user-alice" })
      .count()

    expect(aliceCount).toBe(2)

    // This should NOT fetch all rows - verify via query log if available
  })

  test("any() uses SQL EXISTS optimization", async () => {
    const hasAlice = await store.membershipCollection
      .query()
      .where({ userId: "user-alice" })
      .any()

    expect(hasAlice).toBe(true)

    const hasCharlie = await store.membershipCollection
      .query()
      .where({ userId: "user-charlie" })
      .any()

    expect(hasCharlie).toBe(false)

    // This should NOT fetch all rows - verify via query log if available
  })

  test("orderBy() generates ORDER BY clause", async () => {
    const teams = await store.teamCollection
      .query()
      .orderBy("name", "asc")
      .toArray()

    expect(teams[0].name).toBe("Design")
    expect(teams[1].name).toBe("Engineering")
  })

  test("skip() and take() generate LIMIT/OFFSET", async () => {
    const page2 = await store.teamCollection
      .query()
      .orderBy("name", "asc")
      .skip(1)
      .take(1)
      .toArray()

    expect(page2).toHaveLength(1)
    expect(page2[0].name).toBe("Engineering")
  })
})

// ============================================================================
// INT-03: Isomorphic Behavior Verification
// ============================================================================

describe("INT-03: Isomorphic Behavior", () => {
  let testData: TestData
  let memoryStore: any
  let sqlStore: any

  beforeEach(async () => {
    // Generate test data with proper UUIDs
    const orgId = crypto.randomUUID()
    const team1Id = crypto.randomUUID()
    const team2Id = crypto.randomUUID()
    const team3Id = crypto.randomUUID()

    testData = {
      organizations: [
        { id: orgId, name: "Acme Corp", slug: "acme", createdAt: 1000 }
      ],
      teams: [
        { id: team1Id, name: "Engineering", organizationId: orgId, createdAt: 1000 },
        { id: team2Id, name: "Design", organizationId: orgId, createdAt: 2000 },
        { id: team3Id, name: "Marketing", organizationId: orgId, createdAt: 3000 }
      ],
      memberships: [
        { id: crypto.randomUUID(), userId: "alice", role: "admin", teamId: team1Id, createdAt: 1000 },
        { id: crypto.randomUUID(), userId: "bob", role: "member", teamId: team1Id, createdAt: 2000 },
        { id: crypto.randomUUID(), userId: "alice", role: "viewer", teamId: team2Id, createdAt: 3000 }
      ]
    }

    // Setup both stores with identical data
    memoryStore = await createSeededStore("memory", testData)
    sqlStore = await createSeededStore("sql", testData)
  })

  describe.each([
    ["Memory", () => memoryStore],
    ["SQL", () => sqlStore]
  ])("%s backend", (name, getStore) => {

    test("where + toArray", async () => {
      const store = getStore()
      const result = await store.membershipCollection
        .query()
        .where({ userId: "alice" })
        .toArray()

      expect(result).toHaveLength(2)
    })

    test("where + orderBy + toArray", async () => {
      const store = getStore()
      const result = await store.teamCollection
        .query()
        .orderBy("createdAt", "desc")
        .toArray()

      expect(result.map((t: any) => t.name)).toEqual([
        "Marketing", "Design", "Engineering"
      ])
    })

    test("where + count", async () => {
      const store = getStore()
      const count = await store.membershipCollection
        .query()
        .where({ userId: "alice" })
        .count()

      expect(count).toBe(2)
    })

    test("where + any (exists)", async () => {
      const store = getStore()

      const exists = await store.membershipCollection
        .query()
        .where({ role: "owner" })
        .any()

      expect(exists).toBe(false)
    })

    test("complex filter with $gt", async () => {
      const store = getStore()
      const result = await store.teamCollection
        .query()
        .where({ createdAt: { $gt: 1500 } })
        .toArray()

      expect(result).toHaveLength(2)
      expect(result.map((t: any) => t.name)).toContain("Design")
      expect(result.map((t: any) => t.name)).toContain("Marketing")
    })

    test("pagination consistency", async () => {
      const store = getStore()

      const page1 = await store.teamCollection
        .query()
        .orderBy("name", "asc")
        .skip(0)
        .take(2)
        .toArray()

      const page2 = await store.teamCollection
        .query()
        .orderBy("name", "asc")
        .skip(2)
        .take(2)
        .toArray()

      expect(page1).toHaveLength(2)
      expect(page2).toHaveLength(1)
      expect([...page1, ...page2].map((t: any) => t.name)).toEqual([
        "Design", "Engineering", "Marketing"
      ])
    })
  })

  test("Memory and SQL produce identical results", async () => {
    // Run same query on both
    const memoryResult = await memoryStore.membershipCollection
      .query()
      .where({ userId: "alice" })
      .orderBy("createdAt", "asc")
      .toArray()

    const sqlResult = await sqlStore.membershipCollection
      .query()
      .where({ userId: "alice" })
      .orderBy("createdAt", "asc")
      .toArray()

    // Strip any backend-specific metadata and compare
    const normalize = (items: any[]) => items.map((i: any) => ({
      id: i.id,
      userId: i.userId,
      role: i.role,
      createdAt: i.createdAt
    }))

    expect(normalize(memoryResult)).toEqual(normalize(sqlResult))
  })
})

// ============================================================================
// INT-04: Batch Mutation Operations
// ============================================================================

describe("INT-04: Batch Mutation Operations", () => {
  describe("updateMany with SQL backend", () => {
    let store: any
    let db: Database
    let orgId: string
    let team1Id: string
    let team2Id: string
    let mem1Id: string
    let mem2Id: string
    let mem3Id: string

    beforeEach(async () => {
      // Generate UUIDs
      orgId = crypto.randomUUID()
      team1Id = crypto.randomUUID()
      team2Id = crypto.randomUUID()
      mem1Id = crypto.randomUUID()
      mem2Id = crypto.randomUUID()
      mem3Id = crypto.randomUUID()

      db = new Database(":memory:")
      createTablesFromSchema(db)

      const executor = new BunSqlExecutor(db)
      const env = createEnvironment({
        backend: "sql",
        sqlExecutor: executor
      })

      store = teamsDomain.createStore(env)

      // Seed test data
      const now = Date.now()
      await store.organizationCollection.insertOne({
        id: orgId,
        name: "Acme Corp",
        slug: "acme",
        createdAt: now
      })
      await store.teamCollection.insertOne({
        id: team1Id,
        name: "Engineering",
        organizationId: orgId,
        createdAt: now
      })
      await store.teamCollection.insertOne({
        id: team2Id,
        name: "Design",
        organizationId: orgId,
        createdAt: now
      })
      await store.membershipCollection.insertOne({
        id: mem1Id,
        userId: "user-alice",
        role: "admin",
        teamId: team1Id,
        createdAt: now
      })
      await store.membershipCollection.insertOne({
        id: mem2Id,
        userId: "user-bob",
        role: "member",
        teamId: team1Id,
        createdAt: now
      })
      await store.membershipCollection.insertOne({
        id: mem3Id,
        userId: "user-charlie",
        role: "member",
        teamId: team2Id,
        createdAt: now
      })
    })

    afterEach(() => {
      db.close()
    })

    test("updates only matching entities in SQL backend", async () => {
      // When: Update all memberships with role 'member' to 'viewer'
      const count = await store.membershipCollection.updateMany(
        { role: "member" },
        { role: "viewer" }
      )

      // Then: Should update exactly 2 entities (mem-2 and mem-3)
      expect(count).toBe(2)

      // Verify in database
      const allMemberships = await store.membershipCollection.query().toArray()
      const viewers = allMemberships.filter((m: any) => m.role === "viewer")
      const admins = allMemberships.filter((m: any) => m.role === "admin")

      expect(viewers).toHaveLength(2)
      expect(admins).toHaveLength(1) // mem-1 should still be admin
    })

    test("MST state reflects only matching entities updated", async () => {
      // Given: Track MST state before update
      const beforeUpdate = store.membershipCollection.all().map((m: any) => ({
        id: m.id,
        role: m.role
      }))

      // When: Update only members to viewers
      await store.membershipCollection.updateMany(
        { role: "member" },
        { role: "viewer" }
      )

      // Then: MST should show admin unchanged, members changed
      const mem1 = store.membershipCollection.get(mem1Id)
      const mem2 = store.membershipCollection.get(mem2Id)
      const mem3 = store.membershipCollection.get(mem3Id)

      expect(mem1.role).toBe("admin") // Unchanged
      expect(mem2.role).toBe("viewer") // Changed
      expect(mem3.role).toBe("viewer") // Changed
    })

    test("returns correct count of updated entities", async () => {
      // Update with filter that matches 2 entities
      const count1 = await store.membershipCollection.updateMany(
        { role: "member" },
        { role: "viewer" }
      )
      expect(count1).toBe(2)

      // Update with filter that matches 0 entities
      const count2 = await store.membershipCollection.updateMany(
        { role: "nonexistent" },
        { role: "admin" }
      )
      expect(count2).toBe(0)

      // Update with empty filter (matches all)
      const count3 = await store.membershipCollection.updateMany(
        {},
        { role: "admin" }
      )
      expect(count3).toBe(3)
    })

    test("non-matching filter updates zero entities", async () => {
      const count = await store.membershipCollection.updateMany(
        { role: "owner" },
        { role: "admin" }
      )

      expect(count).toBe(0)

      // Verify nothing changed in MST
      const allMemberships = store.membershipCollection.all()
      expect(allMemberships.filter((m: any) => m.role === "admin")).toHaveLength(1)
      expect(allMemberships.filter((m: any) => m.role === "member")).toHaveLength(2)
    })
  })

  describe("deleteMany with SQL backend", () => {
    let store: any
    let db: Database
    let orgId: string
    let team1Id: string
    let team2Id: string
    let mem1Id: string
    let mem2Id: string
    let mem3Id: string

    beforeEach(async () => {
      // Generate UUIDs
      orgId = crypto.randomUUID()
      team1Id = crypto.randomUUID()
      team2Id = crypto.randomUUID()
      mem1Id = crypto.randomUUID()
      mem2Id = crypto.randomUUID()
      mem3Id = crypto.randomUUID()

      db = new Database(":memory:")
      createTablesFromSchema(db)

      const executor = new BunSqlExecutor(db)
      const env = createEnvironment({
        backend: "sql",
        sqlExecutor: executor
      })

      store = teamsDomain.createStore(env)

      // Seed test data
      const now = Date.now()
      await store.organizationCollection.insertOne({
        id: orgId,
        name: "Acme Corp",
        slug: "acme",
        createdAt: now
      })
      await store.teamCollection.insertOne({
        id: team1Id,
        name: "Engineering",
        organizationId: orgId,
        createdAt: now
      })
      await store.teamCollection.insertOne({
        id: team2Id,
        name: "Design",
        organizationId: orgId,
        createdAt: now
      })
      await store.membershipCollection.insertOne({
        id: mem1Id,
        userId: "user-alice",
        role: "admin",
        teamId: team1Id,
        createdAt: now
      })
      await store.membershipCollection.insertOne({
        id: mem2Id,
        userId: "user-bob",
        role: "member",
        teamId: team1Id,
        createdAt: now
      })
      await store.membershipCollection.insertOne({
        id: mem3Id,
        userId: "user-charlie",
        role: "member",
        teamId: team2Id,
        createdAt: now
      })
    })

    afterEach(() => {
      db.close()
    })

    test("deletes only matching entities in SQL backend", async () => {
      // When: Delete all memberships with role 'member'
      const count = await store.membershipCollection.deleteMany({ role: "member" })

      // Then: Should delete exactly 2 entities (mem-2 and mem-3)
      expect(count).toBe(2)

      // Verify in database via query
      const remaining = await store.membershipCollection.query().toArray()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe(mem1Id) // Only admin should remain
    })

    test("MST state reflects only matching entities removed", async () => {
      // When: Delete only members
      await store.membershipCollection.deleteMany({ role: "member" })

      // Then: MST should show admin still present, members gone
      const mem1 = store.membershipCollection.get(mem1Id)
      const mem2 = store.membershipCollection.get(mem2Id)
      const mem3 = store.membershipCollection.get(mem3Id)

      expect(mem1).toBeDefined() // Admin still exists
      expect(mem2).toBeUndefined() // Member deleted
      expect(mem3).toBeUndefined() // Member deleted

      // Also verify via all()
      expect(store.membershipCollection.all()).toHaveLength(1)
    })

    test("returns correct count of deleted entities", async () => {
      // Delete with filter that matches 2 entities
      const count1 = await store.membershipCollection.deleteMany({ role: "member" })
      expect(count1).toBe(2)

      // Delete with filter that matches 0 entities
      const count2 = await store.membershipCollection.deleteMany({ role: "nonexistent" })
      expect(count2).toBe(0)
    })

    test("empty filter deletes all entities", async () => {
      // When: Delete with empty filter
      const count = await store.membershipCollection.deleteMany({})

      // Then: All entities should be deleted
      expect(count).toBe(3)
      expect(store.membershipCollection.all()).toHaveLength(0)
    })

    test("non-matching filter deletes zero entities", async () => {
      const count = await store.membershipCollection.deleteMany({ role: "owner" })

      expect(count).toBe(0)

      // Verify all entities still present in MST
      expect(store.membershipCollection.all()).toHaveLength(3)
    })
  })
})
