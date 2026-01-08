/**
 * Async Delete Feature Session Tests
 *
 * RED Phase: These tests verify that deleteFeatureSession is async
 * and uses deleteOne/deleteMany from the mutatable mixin for backend sync.
 *
 * Test Isolation: All tests use memory backend via mock registry.
 * No production/dev postgres data is affected.
 *
 * Expected to FAIL until Phase 2 GREEN implementation.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import { platformFeaturesDomain } from "../domain"
import { BackendRegistry, MemoryBackend } from "../../query"

/**
 * Create test environment with memory backend.
 * This ensures tests don't affect production/dev postgres.
 */
function createTestEnvironment() {
  const registry = new BackendRegistry()
  registry.register("memory", new MemoryBackend())
  registry.setDefault("memory")

  return {
    services: {
      backendRegistry: registry,
    },
    context: {
      schemaName: "platform-features",
    },
  }
}

describe("deleteFeatureSession - async with deleteOne/deleteMany", () => {
  let store: any

  beforeEach(() => {
    // Create fresh store for each test with memory backend
    const env = createTestEnvironment()
    store = platformFeaturesDomain.createStore(env)
  })

  // ============================================================
  // Test 1: deleteFeatureSession returns Promise
  // ============================================================

  describe("deleteFeatureSession returns Promise", () => {
    test("deleteFeatureSession returns a Promise", async () => {
      // Given: A session exists
      store.featureSessionCollection.add({
        id: "session-async-test",
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      // When: Calling deleteFeatureSession
      const result = store.deleteFeatureSession("session-async-test")

      // Then: Returns a Promise (not a plain object)
      expect(result).toBeInstanceOf(Promise)
    })

    test("deleteFeatureSession can be awaited", async () => {
      // Given: A session exists
      store.featureSessionCollection.add({
        id: "session-await-test",
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      // When: Awaiting deleteFeatureSession
      const result = await store.deleteFeatureSession("session-await-test")

      // Then: Returns the expected result object
      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.deletedCounts).toBeDefined()
    })
  })

  // ============================================================
  // Test 2: deleteFeatureSession uses deleteOne for session
  // ============================================================

  describe("deleteFeatureSession uses deleteOne for session", () => {
    test("featureSessionCollection.deleteOne is called with session ID", async () => {
      // Given: A session exists and we spy on deleteOne
      const sessionId = "session-deleteone-test"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      // Create spy on deleteOne
      const deleteOneSpy = mock(() => Promise.resolve(true))
      const originalDeleteOne = store.featureSessionCollection.deleteOne
      store.featureSessionCollection.deleteOne = deleteOneSpy

      // When: deleteFeatureSession is called
      await store.deleteFeatureSession(sessionId)

      // Then: deleteOne was called with the session ID
      expect(deleteOneSpy).toHaveBeenCalled()
      expect(deleteOneSpy).toHaveBeenCalledWith(sessionId)

      // Restore
      store.featureSessionCollection.deleteOne = originalDeleteOne
    })
  })

  // ============================================================
  // Test 3: deleteFeatureSession uses deleteMany for children
  // ============================================================

  describe("deleteFeatureSession uses deleteMany for child entities", () => {
    test("requirementCollection.deleteMany is called for session children", async () => {
      // Given: A session with requirements exists
      const sessionId = "session-deletemany-test"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      store.requirementCollection.add({
        id: "req-dm-1",
        session: sessionId,
        name: "Requirement 1",
        description: "Test",
        priority: "must",
        status: "proposed",
        createdAt: Date.now(),
      })

      // Create spy on deleteMany
      const deleteManySpy = mock(() => Promise.resolve(1))
      const originalDeleteMany = store.requirementCollection.deleteMany
      store.requirementCollection.deleteMany = deleteManySpy

      // When: deleteFeatureSession is called
      await store.deleteFeatureSession(sessionId)

      // Then: deleteMany was called
      expect(deleteManySpy).toHaveBeenCalled()

      // Restore
      store.requirementCollection.deleteMany = originalDeleteMany
    })

    test("all child collection deleteMany methods are called", async () => {
      // Given: A session with various children exists
      const sessionId = "session-all-deletemany"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      store.requirementCollection.add({
        id: "req-all-1",
        session: sessionId,
        name: "Req",
        description: "Test",
        priority: "must",
        status: "proposed",
        createdAt: Date.now(),
      })

      store.analysisFindingCollection.add({
        id: "finding-all-1",
        session: sessionId,
        name: "Finding",
        type: "pattern",
        description: "Test",
        location: "test.ts",
        createdAt: Date.now(),
      })

      // Track which deleteMany methods are called
      const calledCollections: string[] = []

      const collections = [
        "requirementCollection",
        "analysisFindingCollection",
        "designDecisionCollection",
        "classificationDecisionCollection",
        "integrationPointCollection",
        "testCaseCollection",
        "implementationTaskCollection",
        "implementationRunCollection",
      ]

      // Spy on all collections
      const originalMethods: Record<string, any> = {}
      for (const col of collections) {
        originalMethods[col] = store[col].deleteMany
        store[col].deleteMany = mock(() => {
          calledCollections.push(col)
          return Promise.resolve(0)
        })
      }

      // Mock deleteOne for the session itself
      const originalDeleteOne = store.featureSessionCollection.deleteOne
      store.featureSessionCollection.deleteOne = mock(() => Promise.resolve(true))

      // When: deleteFeatureSession is called
      await store.deleteFeatureSession(sessionId)

      // Then: All child collections had deleteMany called
      for (const col of collections) {
        expect(calledCollections).toContain(col)
      }

      // Restore
      for (const col of collections) {
        store[col].deleteMany = originalMethods[col]
      }
      store.featureSessionCollection.deleteOne = originalDeleteOne
    })
  })

  // ============================================================
  // Test 4: Async delete actually removes from backend
  // ============================================================

  describe("async delete persists to backend", () => {
    test("session is removed after await completes", async () => {
      // Given: A session exists
      const sessionId = "session-persist-test"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      expect(store.featureSessionCollection.get(sessionId)).toBeDefined()

      // When: Awaiting deleteFeatureSession
      await store.deleteFeatureSession(sessionId)

      // Then: Session is gone
      expect(store.featureSessionCollection.get(sessionId)).toBeUndefined()
    })

    test("child entities are removed after await completes", async () => {
      // Given: A session with children exists
      const sessionId = "session-children-persist"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      store.requirementCollection.add({
        id: "req-persist-1",
        session: sessionId,
        name: "Req 1",
        description: "Test",
        priority: "must",
        status: "proposed",
        createdAt: Date.now(),
      })

      store.requirementCollection.add({
        id: "req-persist-2",
        session: sessionId,
        name: "Req 2",
        description: "Test",
        priority: "should",
        status: "proposed",
        createdAt: Date.now(),
      })

      expect(store.requirementCollection.all()).toHaveLength(2)

      // When: Awaiting deleteFeatureSession
      await store.deleteFeatureSession(sessionId)

      // Then: All requirements are gone
      expect(store.requirementCollection.all()).toHaveLength(0)
    })
  })

  // ============================================================
  // Test 5: Cascade order preserved with async
  // ============================================================

  describe("cascade deletion order with async", () => {
    test("indirect children (TaskExecution, TestSpecification) deleted before parents", async () => {
      // Given: Full hierarchy
      const sessionId = "session-cascade-async"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "testing",
        createdAt: Date.now(),
      })

      store.implementationTaskCollection.add({
        id: "task-cascade",
        session: sessionId,
        name: "Task",
        description: "Test",
        acceptanceCriteria: [],
        status: "planned",
        createdAt: Date.now(),
      })

      store.testSpecificationCollection.add({
        id: "spec-cascade",
        task: "task-cascade",
        scenario: "Test scenario",
        given: ["given"],
        when: "when",
        then: ["then"],
        testType: "unit",
        createdAt: Date.now(),
      })

      store.implementationRunCollection.add({
        id: "run-cascade",
        session: sessionId,
        status: "in_progress",
        completedTasks: [],
        failedTasks: [],
        startedAt: Date.now(),
      })

      store.taskExecutionCollection.add({
        id: "exec-cascade",
        run: "run-cascade",
        task: "task-cascade",
        status: "pending",
        startedAt: Date.now(),
      })

      // When: Awaiting deleteFeatureSession
      const result = await store.deleteFeatureSession(sessionId)

      // Then: All entities deleted
      expect(store.testSpecificationCollection.all()).toHaveLength(0)
      expect(store.taskExecutionCollection.all()).toHaveLength(0)
      expect(store.implementationTaskCollection.all()).toHaveLength(0)
      expect(store.implementationRunCollection.all()).toHaveLength(0)
      expect(store.featureSessionCollection.get(sessionId)).toBeUndefined()

      // And counts are correct
      expect(result.deletedCounts.TestSpecification).toBe(1)
      expect(result.deletedCounts.TaskExecution).toBe(1)
    })
  })
})
