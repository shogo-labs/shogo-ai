/**
 * Delete Feature Session Tests
 * Task: task-delete-001-domain-enhancement
 *
 * Tests for the deleteFeatureSession rootStore action that orchestrates
 * cascade deletion of all child entities in the correct order.
 *
 * Test Specifications:
 * - test-spec-df-001-action-exists: deleteFeatureSession action exists on rootStore
 * - test-spec-df-001-cascade-order: Cascade deletion follows correct leaf-first order
 * - test-spec-df-001-returns-counts: deleteFeatureSession returns success with deletion counts
 * - test-spec-df-001-error-handling: deleteFeatureSession throws Error for non-existent session
 * - test-spec-df-001-batch-operations: Uses batch deleteMany for each entity type
 * - test-spec-df-001-indirect-refs: Handles indirect references via TaskExecution and TestSpecification
 *
 * Test Isolation: All tests use memory backend via mock registry.
 * No production/dev postgres data is affected.
 */

import { describe, test, expect, beforeEach } from "bun:test"
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

describe("rootStore.deleteFeatureSession", () => {
  let store: any

  beforeEach(() => {
    // Create fresh store for each test with memory backend
    const env = createTestEnvironment()
    store = platformFeaturesDomain.createStore(env)
  })

  // ============================================================
  // test-spec-df-001-action-exists: deleteFeatureSession action exists on rootStore
  // ============================================================

  describe("test-spec-df-001-action-exists: deleteFeatureSession action exists on rootStore", () => {
    test("deleteFeatureSession is a function on rootStore", () => {
      expect(typeof store.deleteFeatureSession).toBe("function")
    })

    test("deleteFeatureSession accepts sessionId string parameter", async () => {
      // Add a session to delete
      store.featureSessionCollection.add({
        id: "session-to-delete",
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      // Should accept sessionId and return a Promise
      const result = await store.deleteFeatureSession("session-to-delete")
      expect(result).toBeDefined()
    })
  })

  // ============================================================
  // test-spec-df-001-cascade-order: Cascade deletion follows correct leaf-first order
  // ============================================================

  describe("test-spec-df-001-cascade-order: Cascade deletion follows correct leaf-first order", () => {
    test("deletes all child entities and the session", async () => {
      // Given: FeatureSession exists with id 'session-test'
      const sessionId = "session-test"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      // Add child entities
      store.requirementCollection.add({
        id: "req-1",
        session: sessionId,
        name: "Requirement 1",
        description: "Test requirement",
        priority: "must",
        status: "proposed",
        createdAt: Date.now(),
      })

      store.analysisFindingCollection.add({
        id: "finding-1",
        session: sessionId,
        name: "Finding 1",
        type: "pattern",
        description: "Test finding",
        location: "test.ts",
        createdAt: Date.now(),
      })

      store.implementationTaskCollection.add({
        id: "task-1",
        session: sessionId,
        name: "Task 1",
        description: "Test task",
        acceptanceCriteria: ["criteria 1"],
        status: "planned",
        createdAt: Date.now(),
      })

      // When: deleteFeatureSession('session-test') is called
      await store.deleteFeatureSession(sessionId)

      // Then: No orphaned child entities remain
      expect(store.featureSessionCollection.get(sessionId)).toBeUndefined()
      expect(store.requirementCollection.all().filter((r: any) => r.session?.id === sessionId)).toHaveLength(0)
      expect(store.analysisFindingCollection.all().filter((f: any) => f.session?.id === sessionId)).toHaveLength(0)
      expect(store.implementationTaskCollection.all().filter((t: any) => t.session?.id === sessionId)).toHaveLength(0)
    })

    test("deletes TaskExecutions via run.session path", async () => {
      // Given: Session with ImplementationRun and TaskExecution
      const sessionId = "session-with-executions"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "implementation",
        createdAt: Date.now(),
      })

      store.implementationTaskCollection.add({
        id: "task-exec-1",
        session: sessionId,
        name: "Task 1",
        description: "Test task",
        acceptanceCriteria: ["criteria"],
        status: "in_progress",
        createdAt: Date.now(),
      })

      store.implementationRunCollection.add({
        id: "run-1",
        session: sessionId,
        status: "in_progress",
        completedTasks: [],
        failedTasks: [],
        startedAt: Date.now(),
      })

      store.taskExecutionCollection.add({
        id: "exec-1",
        run: "run-1",
        task: "task-exec-1",
        status: "pending",
        startedAt: Date.now(),
      })

      // Verify setup
      expect(store.taskExecutionCollection.all()).toHaveLength(1)

      // When: deleteFeatureSession is called
      await store.deleteFeatureSession(sessionId)

      // Then: TaskExecutions are deleted
      expect(store.taskExecutionCollection.all()).toHaveLength(0)
    })

    test("deletes TestSpecifications via task.session path", async () => {
      // Given: Session with ImplementationTask and TestSpecification
      const sessionId = "session-with-specs"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "testing",
        createdAt: Date.now(),
      })

      store.implementationTaskCollection.add({
        id: "task-spec-1",
        session: sessionId,
        name: "Task 1",
        description: "Test task",
        acceptanceCriteria: ["criteria"],
        status: "planned",
        createdAt: Date.now(),
      })

      store.testSpecificationCollection.add({
        id: "spec-1",
        task: "task-spec-1",
        scenario: "Test scenario",
        given: ["given statement"],
        when: "when action",
        then: ["then result"],
        testType: "unit",
        createdAt: Date.now(),
      })

      // Verify setup
      expect(store.testSpecificationCollection.all()).toHaveLength(1)

      // When: deleteFeatureSession is called
      await store.deleteFeatureSession(sessionId)

      // Then: TestSpecifications are deleted
      expect(store.testSpecificationCollection.all()).toHaveLength(0)
    })
  })

  // ============================================================
  // test-spec-df-001-returns-counts: deleteFeatureSession returns success with deletion counts
  // ============================================================

  describe("test-spec-df-001-returns-counts: deleteFeatureSession returns success with deletion counts", () => {
    test("returns object with success: true", async () => {
      // Given: FeatureSession exists
      store.featureSessionCollection.add({
        id: "session-count",
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      // When: deleteFeatureSession is called
      const result = await store.deleteFeatureSession("session-count")

      // Then: Returns success: true
      expect(result.success).toBe(true)
    })

    test("returns deletedCounts record mapping entity type to count", async () => {
      // Given: FeatureSession with 2 Requirements, 1 AnalysisFinding, 3 ImplementationTasks
      const sessionId = "session-counts"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      // Add 2 Requirements
      store.requirementCollection.add({
        id: "req-c1",
        session: sessionId,
        name: "Req 1",
        description: "desc",
        priority: "must",
        status: "proposed",
        createdAt: Date.now(),
      })
      store.requirementCollection.add({
        id: "req-c2",
        session: sessionId,
        name: "Req 2",
        description: "desc",
        priority: "should",
        status: "proposed",
        createdAt: Date.now(),
      })

      // Add 1 AnalysisFinding
      store.analysisFindingCollection.add({
        id: "finding-c1",
        session: sessionId,
        name: "Finding 1",
        type: "pattern",
        description: "desc",
        location: "test.ts",
        createdAt: Date.now(),
      })

      // Add 3 ImplementationTasks
      store.implementationTaskCollection.add({
        id: "task-c1",
        session: sessionId,
        name: "Task 1",
        description: "desc",
        acceptanceCriteria: [],
        status: "planned",
        createdAt: Date.now(),
      })
      store.implementationTaskCollection.add({
        id: "task-c2",
        session: sessionId,
        name: "Task 2",
        description: "desc",
        acceptanceCriteria: [],
        status: "planned",
        createdAt: Date.now(),
      })
      store.implementationTaskCollection.add({
        id: "task-c3",
        session: sessionId,
        name: "Task 3",
        description: "desc",
        acceptanceCriteria: [],
        status: "planned",
        createdAt: Date.now(),
      })

      // When: deleteFeatureSession is called
      const result = await store.deleteFeatureSession(sessionId)

      // Then: Returns deletedCounts record with correct counts
      expect(result.deletedCounts).toBeDefined()
      expect(typeof result.deletedCounts).toBe("object")
      expect(result.deletedCounts.Requirement).toBe(2)
      expect(result.deletedCounts.AnalysisFinding).toBe(1)
      expect(result.deletedCounts.ImplementationTask).toBe(3)
      expect(result.deletedCounts.FeatureSession).toBe(1)
    })
  })

  // ============================================================
  // test-spec-df-001-error-handling: deleteFeatureSession throws Error for non-existent session
  // ============================================================

  describe("test-spec-df-001-error-handling: deleteFeatureSession throws Error for non-existent session", () => {
    test("rejects with Error when session does not exist", async () => {
      // Given: No FeatureSession exists with id 'non-existent-session'
      expect(store.featureSessionCollection.get("non-existent-session")).toBeUndefined()

      // When/Then: deleteFeatureSession rejects with Error
      await expect(store.deleteFeatureSession("non-existent-session")).rejects.toThrow()
    })

    test("Error message indicates session not found", async () => {
      // Given: No FeatureSession exists
      const nonExistentId = "session-does-not-exist"

      // When/Then: Error message is descriptive
      try {
        await store.deleteFeatureSession(nonExistentId)
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain(nonExistentId)
      }
    })

    test("no entities are deleted when session not found", async () => {
      // Given: A different session exists
      store.featureSessionCollection.add({
        id: "existing-session",
        name: "Existing",
        intent: "Test",
        status: "discovery",
        createdAt: Date.now(),
      })
      store.requirementCollection.add({
        id: "req-existing",
        session: "existing-session",
        name: "Req",
        description: "desc",
        priority: "must",
        status: "proposed",
        createdAt: Date.now(),
      })

      // When: Try to delete non-existent session
      try {
        await store.deleteFeatureSession("non-existent")
      } catch {
        // Expected
      }

      // Then: Existing entities are not affected
      expect(store.featureSessionCollection.all()).toHaveLength(1)
      expect(store.requirementCollection.all()).toHaveLength(1)
    })
  })

  // ============================================================
  // test-spec-df-001-batch-operations: Uses batch deleteMany for each entity type
  // ============================================================

  describe("test-spec-df-001-batch-operations: Uses batch operations", () => {
    test("deletes multiple entities of same type efficiently", async () => {
      // Given: FeatureSession with multiple child entities of same type
      const sessionId = "session-batch"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Test Session",
        intent: "Test intent",
        status: "discovery",
        createdAt: Date.now(),
      })

      // Add 5 requirements
      for (let i = 0; i < 5; i++) {
        store.requirementCollection.add({
          id: `req-batch-${i}`,
          session: sessionId,
          name: `Req ${i}`,
          description: "desc",
          priority: "must",
          status: "proposed",
          createdAt: Date.now(),
        })
      }

      expect(store.requirementCollection.all()).toHaveLength(5)

      // When: deleteFeatureSession is called
      const result = await store.deleteFeatureSession(sessionId)

      // Then: All 5 requirements deleted in single batch
      expect(store.requirementCollection.all()).toHaveLength(0)
      expect(result.deletedCounts.Requirement).toBe(5)
    })
  })

  // ============================================================
  // test-spec-df-001-indirect-refs: Handles indirect references
  // ============================================================

  describe("test-spec-df-001-indirect-refs: Handles indirect references", () => {
    test("deletes entities with both direct and indirect session references", async () => {
      // Given: Full hierarchy with indirect references
      const sessionId = "session-full"
      store.featureSessionCollection.add({
        id: sessionId,
        name: "Full Test Session",
        intent: "Test intent",
        status: "testing",
        createdAt: Date.now(),
      })

      // Direct children
      store.requirementCollection.add({
        id: "req-full",
        session: sessionId,
        name: "Req",
        description: "desc",
        priority: "must",
        status: "proposed",
        createdAt: Date.now(),
      })

      store.designDecisionCollection.add({
        id: "decision-full",
        session: sessionId,
        name: "Decision",
        question: "Q?",
        decision: "D",
        rationale: "R",
        createdAt: Date.now(),
      })

      store.classificationDecisionCollection.add({
        id: "classification-full",
        session: sessionId,
        validatedArchetype: "domain",
        rationale: "R",
        createdAt: Date.now(),
      })

      store.analysisFindingCollection.add({
        id: "finding-full",
        session: sessionId,
        name: "Finding",
        type: "pattern",
        description: "desc",
        location: "test.ts",
        createdAt: Date.now(),
      })

      store.integrationPointCollection.add({
        id: "ip-full",
        session: sessionId,
        name: "IP",
        filePath: "test.ts",
        description: "desc",
        createdAt: Date.now(),
      })

      store.testCaseCollection.add({
        id: "tc-full",
        session: sessionId,
        name: "TC",
        description: "desc",
        given: "given",
        when: "when",
        then: "then",
        status: "specified",
        createdAt: Date.now(),
      })

      // Task (direct) -> TestSpecification (indirect via task)
      store.implementationTaskCollection.add({
        id: "task-full",
        session: sessionId,
        name: "Task",
        description: "desc",
        acceptanceCriteria: [],
        status: "planned",
        createdAt: Date.now(),
      })

      store.testSpecificationCollection.add({
        id: "spec-full",
        task: "task-full",
        scenario: "scenario",
        given: ["given"],
        when: "when",
        then: ["then"],
        testType: "unit",
        createdAt: Date.now(),
      })

      // Run (direct) -> TaskExecution (indirect via run)
      store.implementationRunCollection.add({
        id: "run-full",
        session: sessionId,
        status: "in_progress",
        completedTasks: [],
        failedTasks: [],
        startedAt: Date.now(),
      })

      store.taskExecutionCollection.add({
        id: "exec-full",
        run: "run-full",
        task: "task-full",
        status: "pending",
        startedAt: Date.now(),
      })

      // When: deleteFeatureSession is called
      const result = await store.deleteFeatureSession(sessionId)

      // Then: All entities deleted
      expect(result.success).toBe(true)
      expect(store.featureSessionCollection.get(sessionId)).toBeUndefined()
      expect(store.requirementCollection.all()).toHaveLength(0)
      expect(store.designDecisionCollection.all()).toHaveLength(0)
      expect(store.classificationDecisionCollection.all()).toHaveLength(0)
      expect(store.analysisFindingCollection.all()).toHaveLength(0)
      expect(store.integrationPointCollection.all()).toHaveLength(0)
      expect(store.testCaseCollection.all()).toHaveLength(0)
      expect(store.implementationTaskCollection.all()).toHaveLength(0)
      expect(store.testSpecificationCollection.all()).toHaveLength(0)
      expect(store.implementationRunCollection.all()).toHaveLength(0)
      expect(store.taskExecutionCollection.all()).toHaveLength(0)

      // Verify counts
      expect(result.deletedCounts.FeatureSession).toBe(1)
      expect(result.deletedCounts.Requirement).toBe(1)
      expect(result.deletedCounts.DesignDecision).toBe(1)
      expect(result.deletedCounts.ClassificationDecision).toBe(1)
      expect(result.deletedCounts.AnalysisFinding).toBe(1)
      expect(result.deletedCounts.IntegrationPoint).toBe(1)
      expect(result.deletedCounts.TestCase).toBe(1)
      expect(result.deletedCounts.ImplementationTask).toBe(1)
      expect(result.deletedCounts.TestSpecification).toBe(1)
      expect(result.deletedCounts.ImplementationRun).toBe(1)
      expect(result.deletedCounts.TaskExecution).toBe(1)
    })
  })
})
