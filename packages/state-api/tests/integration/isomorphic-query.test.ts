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

  beforeEach(() => {
    // Setup: Create teams-workspace domain with memory backend
    const env = createEnvironment({
      backend: "memory"
    })

    store = teamsDomain.createStore(env)

    // Seed test data
    store.organizationCollection.add({
      id: "org-1",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now()
    })

    store.teamCollection.add({
      id: "team-1",
      name: "Engineering",
      organizationId: "org-1",
      createdAt: Date.now()
    })

    store.teamCollection.add({
      id: "team-2",
      name: "Design",
      organizationId: "org-1",
      createdAt: Date.now()
    })

    store.membershipCollection.add({
      id: "mem-1",
      userId: "user-alice",
      role: "admin",
      teamId: "team-1",
      createdAt: Date.now()
    })

    store.membershipCollection.add({
      id: "mem-2",
      userId: "user-bob",
      role: "member",
      teamId: "team-1",
      createdAt: Date.now()
    })

    store.membershipCollection.add({
      id: "mem-3",
      userId: "user-alice",
      role: "viewer",
      teamId: "team-2",
      createdAt: Date.now()
    })
  })

  test("toArray() returns all matching items", async () => {
    const memberships = await store.membershipCollection
      .query()
      .where({ userId: "user-alice" })
      .toArray()

    expect(memberships).toHaveLength(2)
    expect(memberships.map((m: any) => m.teamId.id)).toContain("team-1")
    expect(memberships.map((m: any) => m.teamId.id)).toContain("team-2")
  })

  test("first() returns first matching item or undefined", async () => {
    const membership = await store.membershipCollection
      .query()
      .where({ userId: "user-alice", role: "admin" })
      .first()

    expect(membership).toBeDefined()
    expect(membership.id).toBe("mem-1")

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
    expect(result[0].id).toBe("mem-1")
  })
})

// ============================================================================
// INT-02: SQL Backend - Same Query Operations
// ============================================================================

describe("INT-02: SQL Backend Query Operations", () => {
  let store: any
  let db: Database

  beforeEach(async () => {
    // Setup: Create in-memory SQLite database
    db = new Database(":memory:")

    // Create tables (DDL from schema)
    // const ddl = generateDDL(teamsDomain.enhancedSchema, { dialect: "sqlite" })
    // for (const statement of ddl) {
    //   db.run(statement)
    // }

    // Setup: Create teams-workspace domain with SQL backend
    // const executor = new BunSqlExecutor(db)
    const env = createEnvironment({
      backend: "sql",
      // sqlExecutor: executor
    })

    store = teamsDomain.createStore(env)

    // Seed test data (same as INT-01)
    await store.organizationCollection.add({
      id: "org-1",
      name: "Acme Corp",
      slug: "acme",
      createdAt: Date.now()
    })

    await store.teamCollection.add({
      id: "team-1",
      name: "Engineering",
      organizationId: "org-1",
      createdAt: Date.now()
    })

    await store.teamCollection.add({
      id: "team-2",
      name: "Design",
      organizationId: "org-1",
      createdAt: Date.now()
    })

    await store.membershipCollection.add({
      id: "mem-1",
      userId: "user-alice",
      role: "admin",
      teamId: "team-1",
      createdAt: Date.now()
    })

    await store.membershipCollection.add({
      id: "mem-2",
      userId: "user-bob",
      role: "member",
      teamId: "team-1",
      createdAt: Date.now()
    })

    await store.membershipCollection.add({
      id: "mem-3",
      userId: "user-alice",
      role: "viewer",
      teamId: "team-2",
      createdAt: Date.now()
    })
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
    expect(membership.id).toBe("mem-1")

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
  const testData: TestData = {
    organizations: [
      { id: "org-1", name: "Acme Corp", slug: "acme", createdAt: 1000 }
    ],
    teams: [
      { id: "team-1", name: "Engineering", organizationId: "org-1", createdAt: 1000 },
      { id: "team-2", name: "Design", organizationId: "org-1", createdAt: 2000 },
      { id: "team-3", name: "Marketing", organizationId: "org-1", createdAt: 3000 }
    ],
    memberships: [
      { id: "mem-1", userId: "alice", role: "admin", teamId: "team-1", createdAt: 1000 },
      { id: "mem-2", userId: "bob", role: "member", teamId: "team-1", createdAt: 2000 },
      { id: "mem-3", userId: "alice", role: "viewer", teamId: "team-2", createdAt: 3000 }
    ]
  }

  let memoryStore: any
  let sqlStore: any

  beforeEach(async () => {
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
