/**
 * Generated from TestSpecifications for task-teams-module-exports
 * Task: teams-module-exports
 */

import { describe, test, expect } from "bun:test"

// ============================================================
// Test: index.ts re-exports TeamsDomain scope
// ============================================================
describe("index.ts re-exports TeamsDomain scope", () => {
  test("TeamsDomain is defined", async () => {
    const { TeamsDomain } = await import("../index")
    expect(TeamsDomain).toBeDefined()
  })

  test("TeamsDomain.export() returns entity types", async () => {
    const { TeamsDomain } = await import("../index")
    const types = TeamsDomain.export()
    expect(types.Organization).toBeDefined()
    expect(types.Team).toBeDefined()
    expect(types.Membership).toBeDefined()
  })
})

// ============================================================
// Test: index.ts re-exports createTeamsStore factory
// ============================================================
describe("index.ts re-exports createTeamsStore factory", () => {
  test("createTeamsStore is a function", async () => {
    const { createTeamsStore } = await import("../index")
    expect(createTeamsStore).toBeDefined()
    expect(typeof createTeamsStore).toBe("function")
  })

  test("createTeamsStore() returns store factory result", async () => {
    const { createTeamsStore } = await import("../index")
    const result = createTeamsStore()
    expect(result.createStore).toBeDefined()
    expect(result.RootStoreModel).toBeDefined()
  })
})

// ============================================================
// Test: Public API accessible via @shogo/state-api
// ============================================================
describe("Public API accessible via @shogo/state-api", () => {
  test("TeamsDomain is accessible from main package", async () => {
    // This tests the re-export from main index.ts
    const stateApi = await import("../../index")
    expect(stateApi.TeamsDomain).toBeDefined()
  })

  test("createTeamsStore is accessible from main package", async () => {
    const stateApi = await import("../../index")
    expect(stateApi.createTeamsStore).toBeDefined()
  })

  test("No internal modules exposed directly", async () => {
    const stateApi = await import("../../index")
    // Internal implementation details should not be exposed
    // (RoleLevels is internal)
    expect((stateApi as any).RoleLevels).toBeUndefined()
  })
})
