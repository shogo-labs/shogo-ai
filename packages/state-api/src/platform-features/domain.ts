/**
 * Platform Features Domain Store
 *
 * Uses the domain() composition API to define FeatureSession and related entities
 * for the platform feature development lifecycle: discovery → design → build → deploy.
 *
 * Entities:
 * - FeatureSession: Container for feature development
 * - Requirement: Requirements derived from intent
 * - DesignDecision: Architectural decisions
 * - ClassificationDecision: Feature archetype classification
 * - AnalysisFinding: Codebase analysis findings
 * - IntegrationPoint: Code locations for changes
 * - TestCase: Requirement-scoped acceptance tests
 * - ImplementationTask: Discrete implementation units
 * - TestSpecification: Task-scoped test specs
 * - ImplementationRun: Execution run records
 * - TaskExecution: Individual task execution records
 */

import { scope } from "arktype"
import { v4 as uuidv4 } from "uuid"
import { getRoot } from "mobx-state-tree"
import { domain } from "../domain"

// ============================================================
// 1. STATUS AND PHASE MAPPINGS
// ============================================================

/** Map status to phase for UI display */
export const StatusToPhase: Record<string, string> = {
  discovery: "discovery",
  analysis: "design",
  classification: "design",
  design: "design",
  spec: "build",
  implementation: "build",
  testing: "build",
  complete: "deploy",
}

/** Status progression order */
export const StatusOrder: string[] = [
  "discovery",
  "analysis",
  "classification",
  "design",
  "spec",
  "implementation",
  "testing",
  "complete",
]

// ============================================================
// 2. DOMAIN SCHEMA (ArkType)
// ============================================================

export const PlatformFeaturesDomain = scope({
  FeatureSession: {
    id: "string",
    name: "string",
    intent: "string",
    status: "'discovery' | 'analysis' | 'classification' | 'design' | 'spec' | 'implementation' | 'testing' | 'complete'",
    "affectedPackages?": "string[]",
    "schemaName?": "string",
    "initialAssessment?": {
      "likelyArchetype?": "'service' | 'domain' | 'infrastructure' | 'hybrid'",
      "indicators?": "string[]",
      "uncertainties?": "string[]",
    },
    "featureArchetype?": "'service' | 'domain' | 'infrastructure' | 'hybrid'",
    "applicablePatterns?": "string[]",
    createdAt: "number",
    "updatedAt?": "number",
    "project?": "string", // Loose ref to Project.id
  },

  Requirement: {
    id: "string",
    session: "FeatureSession",
    name: "string",
    description: "string",
    priority: "'must' | 'should' | 'could'",
    status: "'proposed' | 'accepted' | 'implemented'",
    "createdAt?": "number",
  },

  DesignDecision: {
    id: "string",
    session: "FeatureSession",
    name: "string",
    question: "string",
    decision: "string",
    rationale: "string",
    "createdAt?": "number",
  },

  ClassificationDecision: {
    id: "string",
    session: "FeatureSession",
    "initialAssessment?": "'service' | 'domain' | 'infrastructure' | 'hybrid'",
    validatedArchetype: "'service' | 'domain' | 'infrastructure' | 'hybrid'",
    "evidenceChecklist?": "unknown",
    rationale: "string",
    "correction?": "string",
    createdAt: "number",
  },

  AnalysisFinding: {
    id: "string",
    session: "FeatureSession",
    name: "string",
    type: "'pattern' | 'integration_point' | 'risk' | 'gap' | 'existing_test' | 'verification' | 'classification_evidence'",
    description: "string",
    location: "string",
    "relevantCode?": "string",
    "recommendation?": "string",
    createdAt: "number",
  },

  IntegrationPoint: {
    id: "string",
    session: "FeatureSession",
    name: "string",
    filePath: "string",
    "package?": "string",
    "targetFunction?": "string",
    "changeType?": "'add' | 'modify' | 'extend' | 'remove'",
    description: "string",
    "rationale?": "string",
    "finding?": "AnalysisFinding",
    "isGenerated?": "boolean",
    createdAt: "number",
  },

  TestCase: {
    id: "string",
    session: "FeatureSession",
    "requirement?": "Requirement",
    name: "string",
    description: "string",
    given: "string",
    when: "string",
    then: "string",
    status: "'specified' | 'implemented' | 'passing'",
    "createdAt?": "number",
  },

  ImplementationTask: {
    id: "string",
    session: "FeatureSession",
    name: "string",
    "integrationPoint?": "IntegrationPoint",
    "requirement?": "Requirement",
    description: "string",
    acceptanceCriteria: "string[]",
    "dependencies?": "ImplementationTask[]",
    status: "'planned' | 'in_progress' | 'complete' | 'blocked'",
    createdAt: "number",
    "updatedAt?": "number",
  },

  TestSpecification: {
    id: "string",
    task: "ImplementationTask",
    "requirement?": "Requirement",
    scenario: "string",
    given: "string[]",
    when: "string",
    then: "string[]",
    testType: "'unit' | 'integration' | 'acceptance'",
    "targetFile?": "string",
    createdAt: "number",
  },

  ImplementationRun: {
    id: "string",
    session: "FeatureSession",
    status: "'in_progress' | 'blocked' | 'complete' | 'failed'",
    "currentTaskId?": "string",
    "completedTasks?": "string[]",
    "failedTasks?": "string[]",
    startedAt: "number",
    "completedAt?": "number",
    "lastError?": "string",
  },

  TaskExecution: {
    id: "string",
    run: "ImplementationRun",
    task: "ImplementationTask",
    status: "'pending' | 'test_written' | 'test_failing' | 'implementing' | 'test_passing' | 'failed'",
    "testFilePath?": "string",
    "implementationFilePath?": "string",
    "testOutput?": "string",
    "retryCount?": "number",
    "errorMessage?": "string",
    startedAt: "number",
    "completedAt?": "number",
  },
})

// ============================================================
// 3. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * Platform Features domain with all enhancements.
 * Provides computed views, collection queries, and root store actions
 * for the feature development lifecycle.
 */
export const platformFeaturesDomain = domain({
  name: "platform-features",
  from: PlatformFeaturesDomain,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,

      FeatureSession: models.FeatureSession.views((self: any) => ({
        /**
         * Get count of requirements for this session
         */
        get requirementCount(): number {
          const root = getRoot(self) as any
          if (!root.requirementCollection) return 0
          return root.requirementCollection
            .all()
            .filter((r: any) => r.session?.id === self.id).length
        },

        /**
         * Get count of implementation tasks for this session
         */
        get taskCount(): number {
          const root = getRoot(self) as any
          if (!root.implementationTaskCollection) return 0
          return root.implementationTaskCollection
            .all()
            .filter((t: any) => t.session?.id === self.id).length
        },

        /**
         * Get count of analysis findings for this session
         */
        get findingCount(): number {
          const root = getRoot(self) as any
          if (!root.analysisFindingCollection) return 0
          return root.analysisFindingCollection
            .all()
            .filter((f: any) => f.session?.id === self.id).length
        },

        /**
         * Get count of design decisions for this session
         */
        get decisionCount(): number {
          const root = getRoot(self) as any
          if (!root.designDecisionCollection) return 0
          return root.designDecisionCollection
            .all()
            .filter((d: any) => d.session?.id === self.id).length
        },

        /**
         * Get count of test cases for this session
         */
        get testCaseCount(): number {
          const root = getRoot(self) as any
          if (!root.testCaseCollection) return 0
          return root.testCaseCollection
            .all()
            .filter((t: any) => t.session?.id === self.id).length
        },

        /**
         * Calculate completion progress (0-100)
         * Based on status progression through the lifecycle
         */
        get completionProgress(): number {
          const statusIndex = StatusOrder.indexOf(self.status)
          if (statusIndex === -1) return 0
          return Math.round((statusIndex / (StatusOrder.length - 1)) * 100)
        },

        /**
         * Get phase for UI display (discovery, design, build, deploy)
         */
        get phase(): string {
          return StatusToPhase[self.status] || "discovery"
        },

        /**
         * Get completed task count for progress display
         */
        get completedTaskCount(): number {
          const root = getRoot(self) as any
          if (!root.implementationTaskCollection) return 0
          return root.implementationTaskCollection
            .all()
            .filter((t: any) => t.session?.id === self.id && t.status === "complete").length
        },
      })),

      ImplementationTask: models.ImplementationTask.views((self: any) => ({
        /**
         * Check if task is blocked by incomplete dependencies
         */
        get isBlocked(): boolean {
          if (!self.dependencies || self.dependencies.length === 0) return false
          return self.dependencies.some((dep: any) => dep.status !== "complete")
        },

        /**
         * Get count of test specifications for this task
         */
        get testSpecCount(): number {
          const root = getRoot(self) as any
          if (!root.testSpecificationCollection) return 0
          return root.testSpecificationCollection
            .all()
            .filter((t: any) => t.task?.id === self.id).length
        },
      })),

      ImplementationRun: models.ImplementationRun.views((self: any) => ({
        /**
         * Get count of completed tasks in this run
         */
        get completedCount(): number {
          return self.completedTasks?.length || 0
        },

        /**
         * Get count of failed tasks in this run
         */
        get failedCount(): number {
          return self.failedTasks?.length || 0
        },

        /**
         * Calculate run duration in milliseconds
         */
        get duration(): number | null {
          if (!self.completedAt) return null
          return self.completedAt - self.startedAt
        },
      })),
    }),

    // --------------------------------------------------------
    // collections: Add query methods
    // --------------------------------------------------------
    collections: (collections) => ({
      ...collections,

      FeatureSessionCollection: collections.FeatureSessionCollection.views((self: any) => ({
        /**
         * Find sessions by status
         */
        findByStatus(status: string): any[] {
          return self.all().filter((s: any) => s.status === status)
        },

        /**
         * Find sessions by project
         * Returns empty array if projectId is null/undefined
         */
        findByProject(projectId: string | null | undefined): any[] {
          if (projectId == null) return []
          // Legacy fallback: features without a project are treated as belonging to shogo-platform
          // This allows existing data (created before project field was added) to appear
          // TODO: Remove this fallback once schema migrations are implemented and data is backfilled
          const SHOGO_PLATFORM_ID = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e"
          return self.all().filter((s: any) =>
            s.project === projectId ||
            (projectId === SHOGO_PLATFORM_ID && !s.project)
          )
        },

        /**
         * Find sessions currently in progress (not discovery or complete)
         */
        findInProgress(): any[] {
          return self.all().filter((s: any) =>
            !["discovery", "complete"].includes(s.status)
          )
        },

        /**
         * Find completed sessions
         */
        findCompleted(): any[] {
          return self.all().filter((s: any) => s.status === "complete")
        },

        /**
         * Find sessions in discovery phase
         */
        findInDiscovery(): any[] {
          return self.all().filter((s: any) => s.status === "discovery")
        },

        /**
         * Find sessions by phase
         */
        findByPhase(phase: string): any[] {
          return self.all().filter((s: any) => StatusToPhase[s.status] === phase)
        },
      })),

      RequirementCollection: collections.RequirementCollection.views((self: any) => ({
        /**
         * Find requirements for a session
         */
        findBySession(sessionId: string): any[] {
          return self.all().filter((r: any) => r.session?.id === sessionId)
        },

        /**
         * Find requirements by priority
         */
        findByPriority(priority: string): any[] {
          return self.all().filter((r: any) => r.priority === priority)
        },

        /**
         * Find requirements by status
         */
        findByStatus(status: string): any[] {
          return self.all().filter((r: any) => r.status === status)
        },
      })),

      DesignDecisionCollection: collections.DesignDecisionCollection.views((self: any) => ({
        /**
         * Find decisions for a session
         */
        findBySession(sessionId: string): any[] {
          return self.all().filter((d: any) => d.session?.id === sessionId)
        },
      })),

      AnalysisFindingCollection: collections.AnalysisFindingCollection.views((self: any) => ({
        /**
         * Find findings for a session
         */
        findBySession(sessionId: string): any[] {
          return self.all().filter((f: any) => f.session?.id === sessionId)
        },

        /**
         * Find findings by type
         */
        findByType(type: string): any[] {
          return self.all().filter((f: any) => f.type === type)
        },
      })),

      IntegrationPointCollection: collections.IntegrationPointCollection.views((self: any) => ({
        /**
         * Find integration points for a session
         */
        findBySession(sessionId: string): any[] {
          return self.all().filter((ip: any) => ip.session?.id === sessionId)
        },

        /**
         * Find integration points by package
         */
        findByPackage(packageName: string): any[] {
          return self.all().filter((ip: any) => ip.package === packageName)
        },
      })),

      ImplementationTaskCollection: collections.ImplementationTaskCollection.views((self: any) => ({
        /**
         * Find tasks for a session
         */
        findBySession(sessionId: string): any[] {
          return self.all().filter((t: any) => t.session?.id === sessionId)
        },

        /**
         * Find tasks by status
         */
        findByStatus(status: string): any[] {
          return self.all().filter((t: any) => t.status === status)
        },

        /**
         * Find blocked tasks
         */
        findBlocked(): any[] {
          return self.all().filter((t: any) => t.status === "blocked")
        },

        /**
         * Find tasks ready to execute (planned with no blocking dependencies)
         */
        findReady(): any[] {
          return self.all().filter((t: any) => {
            if (t.status !== "planned") return false
            if (!t.dependencies || t.dependencies.length === 0) return true
            return t.dependencies.every((dep: any) => dep.status === "complete")
          })
        },
      })),

      TestCaseCollection: collections.TestCaseCollection.views((self: any) => ({
        /**
         * Find test cases for a session
         */
        findBySession(sessionId: string): any[] {
          return self.all().filter((t: any) => t.session?.id === sessionId)
        },

        /**
         * Find test cases by status
         */
        findByStatus(status: string): any[] {
          return self.all().filter((t: any) => t.status === status)
        },
      })),

      TestSpecificationCollection: collections.TestSpecificationCollection.views((self: any) => ({
        /**
         * Find test specs for a task
         */
        findByTask(taskId: string): any[] {
          return self.all().filter((t: any) => t.task?.id === taskId)
        },

        /**
         * Find test specs by type
         */
        findByType(testType: string): any[] {
          return self.all().filter((t: any) => t.testType === testType)
        },
      })),

      ImplementationRunCollection: collections.ImplementationRunCollection.views((self: any) => ({
        /**
         * Find runs for a session
         */
        findBySession(sessionId: string): any[] {
          return self.all().filter((r: any) => r.session?.id === sessionId)
        },

        /**
         * Find the latest run for a session
         */
        findLatestBySession(sessionId: string): any | undefined {
          const runs = self.all().filter((r: any) => r.session?.id === sessionId)
          if (runs.length === 0) return undefined
          return runs.reduce((latest: any, r: any) =>
            r.startedAt > latest.startedAt ? r : latest
          )
        },

        /**
         * Find runs by status
         */
        findByStatus(status: string): any[] {
          return self.all().filter((r: any) => r.status === status)
        },
      })),

      TaskExecutionCollection: collections.TaskExecutionCollection.views((self: any) => ({
        /**
         * Find executions for a run
         */
        findByRun(runId: string): any[] {
          return self.all().filter((e: any) => e.run?.id === runId)
        },

        /**
         * Find executions for a task
         */
        findByTask(taskId: string): any[] {
          return self.all().filter((e: any) => e.task?.id === taskId)
        },
      })),
    }),

    // --------------------------------------------------------
    // rootStore: Add domain actions
    // --------------------------------------------------------
    rootStore: (RootModel) =>
      RootModel.actions((self: any) => ({
        /**
         * Create a new feature session
         */
        createFeatureSession(params: {
          name: string
          intent: string
          project?: string
          affectedPackages?: string[]
        }) {
          const session = self.featureSessionCollection.add({
            id: uuidv4(),
            name: params.name,
            intent: params.intent,
            status: "discovery",
            project: params.project,
            affectedPackages: params.affectedPackages || [],
            createdAt: Date.now(),
          })
          return session
        },

        /**
         * Update feature session status
         */
        updateFeatureStatus(
          sessionId: string,
          status: "discovery" | "analysis" | "classification" | "design" | "spec" | "implementation" | "testing" | "complete"
        ) {
          const session = self.featureSessionCollection.get(sessionId)
          if (session) {
            session.status = status
            session.updatedAt = Date.now()
          }
        },

        /**
         * Add a requirement to a session
         */
        addRequirement(params: {
          sessionId: string
          name: string
          description: string
          priority: "must" | "should" | "could"
        }) {
          const requirement = self.requirementCollection.add({
            id: uuidv4(),
            session: params.sessionId,
            name: params.name,
            description: params.description,
            priority: params.priority,
            status: "proposed",
            createdAt: Date.now(),
          })
          return requirement
        },

        /**
         * Add a design decision to a session
         */
        addDesignDecision(params: {
          sessionId: string
          name: string
          question: string
          decision: string
          rationale: string
        }) {
          const decision = self.designDecisionCollection.add({
            id: uuidv4(),
            session: params.sessionId,
            name: params.name,
            question: params.question,
            decision: params.decision,
            rationale: params.rationale,
            createdAt: Date.now(),
          })
          return decision
        },

        /**
         * Add an implementation task to a session
         */
        addImplementationTask(params: {
          sessionId: string
          name: string
          description: string
          acceptanceCriteria: string[]
          integrationPointId?: string
          requirementId?: string
          dependencyIds?: string[]
        }) {
          const task = self.implementationTaskCollection.add({
            id: uuidv4(),
            session: params.sessionId,
            name: params.name,
            description: params.description,
            acceptanceCriteria: params.acceptanceCriteria,
            integrationPoint: params.integrationPointId,
            requirement: params.requirementId,
            dependencies: params.dependencyIds || [],
            status: "planned",
            createdAt: Date.now(),
          })
          return task
        },

        /**
         * Update task status
         */
        updateTaskStatus(
          taskId: string,
          status: "planned" | "in_progress" | "complete" | "blocked"
        ) {
          const task = self.implementationTaskCollection.get(taskId)
          if (task) {
            task.status = status
            task.updatedAt = Date.now()
          }
        },

        /**
         * Start an implementation run for a session
         */
        startImplementationRun(sessionId: string) {
          const run = self.implementationRunCollection.add({
            id: uuidv4(),
            session: sessionId,
            status: "in_progress",
            completedTasks: [],
            failedTasks: [],
            startedAt: Date.now(),
          })
          return run
        },

        /**
         * Delete a feature session and all its child entities (cascade delete).
         * Deletes in leaf-first order to respect referential integrity:
         * 1. TaskExecution (refs run which refs session)
         * 2. TestSpecification (refs task which refs session)
         * 3. ImplementationRun (refs session)
         * 4. ImplementationTask (refs session)
         * 5. Direct session children: TestCase, IntegrationPoint, AnalysisFinding,
         *    ClassificationDecision, DesignDecision, Requirement
         * 6. FeatureSession
         *
         * @param sessionId - The ID of the FeatureSession to delete
         * @returns {success: boolean, deletedCounts: Record<string, number>}
         * @throws Error if session does not exist
         */
        async deleteFeatureSession(sessionId: string): Promise<{
          success: boolean
          deletedCounts: Record<string, number>
        }> {
          // Verify session exists
          const session = self.featureSessionCollection.get(sessionId)
          if (!session) {
            throw new Error(`FeatureSession with id '${sessionId}' not found`)
          }

          const deletedCounts: Record<string, number> = {}

          // 1. TaskExecution (refs run which refs session) - most deeply nested
          // Find all runs for this session, then delete their executions
          const sessionRuns = self.implementationRunCollection
            .all()
            .filter((r: any) => r.session?.id === sessionId)
          const runIds = sessionRuns.map((r: any) => r.id)

          let taskExecCount = 0
          for (const runId of runIds) {
            taskExecCount += await self.taskExecutionCollection.deleteMany({ "run.id": runId })
          }
          deletedCounts.TaskExecution = taskExecCount

          // 2. TestSpecification (refs task which refs session)
          // Find all tasks for this session, then delete their specs
          const sessionTasks = self.implementationTaskCollection
            .all()
            .filter((t: any) => t.session?.id === sessionId)
          const taskIds = sessionTasks.map((t: any) => t.id)

          let testSpecCount = 0
          for (const taskId of taskIds) {
            testSpecCount += await self.testSpecificationCollection.deleteMany({ "task.id": taskId })
          }
          deletedCounts.TestSpecification = testSpecCount

          // 3. ImplementationRun (refs session directly)
          // Use "session.id" for reference field filtering
          deletedCounts.ImplementationRun = await self.implementationRunCollection.deleteMany({
            "session.id": sessionId,
          })

          // 4. ImplementationTask (refs session directly)
          deletedCounts.ImplementationTask = await self.implementationTaskCollection.deleteMany({
            "session.id": sessionId,
          })

          // 5. Direct session children
          deletedCounts.TestCase = await self.testCaseCollection.deleteMany({
            "session.id": sessionId,
          })

          deletedCounts.IntegrationPoint = await self.integrationPointCollection.deleteMany({
            "session.id": sessionId,
          })

          deletedCounts.AnalysisFinding = await self.analysisFindingCollection.deleteMany({
            "session.id": sessionId,
          })

          deletedCounts.ClassificationDecision =
            await self.classificationDecisionCollection.deleteMany({
              "session.id": sessionId,
            })

          deletedCounts.DesignDecision = await self.designDecisionCollection.deleteMany({
            "session.id": sessionId,
          })

          deletedCounts.Requirement = await self.requirementCollection.deleteMany({
            "session.id": sessionId,
          })

          // 6. Finally, delete the FeatureSession itself
          const deleted = await self.featureSessionCollection.deleteOne(sessionId)
          deletedCounts.FeatureSession = deleted ? 1 : 0

          return {
            success: true,
            deletedCounts,
          }
        },
      })),
  },
})

// ============================================================
// 4. BACKWARD-COMPATIBLE STORE FACTORY
// ============================================================

export interface CreatePlatformFeaturesStoreOptions {
  /** Enable reference validation (default: true in dev) */
  validateReferences?: boolean
}

/**
 * Creates platform-features store with backward-compatible API.
 */
export function createPlatformFeaturesStore(_options: CreatePlatformFeaturesStoreOptions = {}) {
  return {
    createStore: platformFeaturesDomain.createStore,
    RootStoreModel: platformFeaturesDomain.RootStoreModel,
    domain: platformFeaturesDomain,
  }
}
