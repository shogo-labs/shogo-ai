/**
 * Platform Features Domain Tests
 *
 * Tests for findByProject collection query
 * Generated from TestSpecifications: test-spw-001, test-spw-002, test-spw-003
 * Task: task-spw-001
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { platformFeaturesDomain } from "../domain"

describe("FeatureSessionCollection.findByProject", () => {
  let store: any

  beforeEach(() => {
    // Create fresh store for each test
    store = platformFeaturesDomain.createStore()
  })

  // test-spw-001: findByProject returns matching features
  test("returns features matching the projectId", () => {
    // Given: Features with different project IDs
    store.featureSessionCollection.add({
      id: "feature-a",
      name: "Feature A",
      intent: "Test feature A",
      status: "discovery",
      project: "proj-1",
      createdAt: Date.now(),
    })
    store.featureSessionCollection.add({
      id: "feature-b",
      name: "Feature B",
      intent: "Test feature B",
      status: "discovery",
      project: "proj-2",
      createdAt: Date.now(),
    })
    store.featureSessionCollection.add({
      id: "feature-c",
      name: "Feature C",
      intent: "Test feature C",
      status: "discovery",
      project: "proj-1",
      createdAt: Date.now(),
    })

    // When: findByProject('proj-1') is called
    const result = store.featureSessionCollection.findByProject("proj-1")

    // Then: Returns array with 2 features (A and C)
    expect(result).toHaveLength(2)
    expect(result.map((f: any) => f.id)).toContain("feature-a")
    expect(result.map((f: any) => f.id)).toContain("feature-c")
    // Does not include Feature B
    expect(result.map((f: any) => f.id)).not.toContain("feature-b")
    // Returned features have correct project field
    expect(result.every((f: any) => f.project === "proj-1")).toBe(true)
  })

  // test-spw-002: findByProject returns empty array when no matches
  test("returns empty array when no features match projectId", () => {
    // Given: Features exist but none match the projectId
    store.featureSessionCollection.add({
      id: "feature-a",
      name: "Feature A",
      intent: "Test feature A",
      status: "discovery",
      project: "proj-1",
      createdAt: Date.now(),
    })
    store.featureSessionCollection.add({
      id: "feature-b",
      name: "Feature B",
      intent: "Test feature B",
      status: "discovery",
      project: "proj-2",
      createdAt: Date.now(),
    })

    // When: findByProject with non-existent projectId
    const result = store.featureSessionCollection.findByProject("nonexistent-proj")

    // Then: Returns empty array and does not throw
    expect(result).toEqual([])
  })

  // test-spw-003: findByProject handles null/undefined gracefully
  test("returns empty array when projectId is null", () => {
    // Given: Features with project IDs exist
    store.featureSessionCollection.add({
      id: "feature-a",
      name: "Feature A",
      intent: "Test feature A",
      status: "discovery",
      project: "proj-1",
      createdAt: Date.now(),
    })
    // Also add a feature WITHOUT a project to ensure we don't accidentally match it
    store.featureSessionCollection.add({
      id: "feature-no-project",
      name: "Feature No Project",
      intent: "Test feature without project",
      status: "discovery",
      createdAt: Date.now(),
    })

    // When: findByProject(null) is called
    const result = store.featureSessionCollection.findByProject(null as any)

    // Then: Returns empty array and does not throw
    expect(result).toEqual([])
  })

  test("returns empty array when projectId is undefined", () => {
    // Given: Features with project IDs exist
    store.featureSessionCollection.add({
      id: "feature-a",
      name: "Feature A",
      intent: "Test feature A",
      status: "discovery",
      project: "proj-1",
      createdAt: Date.now(),
    })
    // Also add a feature WITHOUT a project
    store.featureSessionCollection.add({
      id: "feature-no-project",
      name: "Feature No Project",
      intent: "Test feature without project",
      status: "discovery",
      createdAt: Date.now(),
    })

    // When: findByProject(undefined) is called
    const result = store.featureSessionCollection.findByProject(undefined as any)

    // Then: Returns empty array and does not throw
    expect(result).toEqual([])
  })
})
