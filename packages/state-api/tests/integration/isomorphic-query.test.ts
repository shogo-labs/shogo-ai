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

// Test utilities (to be implemented)
import {
  createEnvironment,
  createSeededStore,
  type TestData
} from "../helpers/query-test-utils"

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

    // Create tables manually (DDL generator requires x-mst-type metadata)
    db.run(`CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, created_at INTEGER)`)
    db.run(`CREATE TABLE team (id TEXT PRIMARY KEY, name TEXT, organization_id TEXT, created_at INTEGER)`)
    db.run(`CREATE TABLE membership (id TEXT PRIMARY KEY, user_id TEXT, role TEXT, team_id TEXT, created_at INTEGER)`)

    // Setup: Create teams-workspace domain with SQL backend
    const executor = new BunSqlExecutor(db)
    const env = createEnvironment({
      backend: "sql",
      sqlExecutor: executor
    })

    store = teamsDomain.createStore(env)

    // Seed data directly to database (SQL backend doesn't auto-persist)
    const now = Date.now()
    db.run(`INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)`, [orgId, "Acme Corp", "acme", now])
    db.run(`INSERT INTO team (id, name, organization_id, created_at) VALUES (?, ?, ?, ?)`, [team1Id, "Engineering", orgId, now])
    db.run(`INSERT INTO team (id, name, organization_id, created_at) VALUES (?, ?, ?, ?)`, [team2Id, "Design", orgId, now])
    db.run(`INSERT INTO membership (id, user_id, role, team_id, created_at) VALUES (?, ?, ?, ?, ?)`, [mem1Id, "user-alice", "admin", team1Id, now])
    db.run(`INSERT INTO membership (id, user_id, role, team_id, created_at) VALUES (?, ?, ?, ?, ?)`, [mem2Id, "user-bob", "member", team1Id, now])
    db.run(`INSERT INTO membership (id, user_id, role, team_id, created_at) VALUES (?, ?, ?, ?, ?)`, [mem3Id, "user-alice", "viewer", team2Id, now])
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
