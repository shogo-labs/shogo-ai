/**
 * useFeatureMetrics Hook
 * Task: task-w1-use-feature-metrics-hook
 *
 * Computes aggregated metrics for a feature session.
 * Returns counts for requirements, tasks, tests, and findings.
 */

import { useMemo } from "react"
import { useDomains } from "@shogo/app-core"

/**
 * Minimal input types for the metrics computation
 */
export interface RequirementInput {
  id: string
  priority: "must" | "should" | "could"
  status: string
}

export interface TaskInput {
  id: string
  status: "planned" | "in_progress" | "complete" | "blocked"
}

export interface TestSpecInput {
  id: string
  testType: "unit" | "integration" | "acceptance"
}

export interface FindingInput {
  id: string
  type: string
}

export interface FeatureMetricsInput {
  requirements: RequirementInput[]
  tasks: TaskInput[]
  testSpecs: TestSpecInput[]
  findings: FindingInput[]
}

/**
 * Requirements metrics grouped by priority
 */
export interface RequirementMetrics {
  must: number
  should: number
  could: number
  total: number
}

/**
 * Task metrics grouped by status
 */
export interface TaskMetrics {
  planned: number
  in_progress: number
  complete: number
  blocked: number
  total: number
  completionPercentage: number
}

/**
 * Test metrics grouped by type
 */
export interface TestMetrics {
  unit: number
  integration: number
  acceptance: number
  total: number
}

/**
 * Finding metrics grouped by type
 */
export interface FindingMetrics {
  pattern: number
  integration_point: number
  gap: number
  risk: number
  verification: number
  classification_evidence: number
  existing_test: number
  total: number
  [key: string]: number // Allow dynamic finding types
}

/**
 * Complete feature metrics result
 */
export interface FeatureMetrics {
  requirements: RequirementMetrics
  tasks: TaskMetrics
  tests: TestMetrics
  findings: FindingMetrics
}

/**
 * Pure function to compute metrics from input data
 * Can be used outside React context for testing
 */
export function computeFeatureMetrics(input: FeatureMetricsInput): FeatureMetrics {
  // Count requirements by priority
  const requirements: RequirementMetrics = {
    must: 0,
    should: 0,
    could: 0,
    total: 0,
  }

  for (const req of input.requirements) {
    if (req.priority in requirements) {
      requirements[req.priority as keyof Omit<RequirementMetrics, "total">]++
    }
    requirements.total++
  }

  // Count tasks by status
  const tasks: TaskMetrics = {
    planned: 0,
    in_progress: 0,
    complete: 0,
    blocked: 0,
    total: 0,
    completionPercentage: 0,
  }

  for (const task of input.tasks) {
    if (task.status in tasks) {
      tasks[task.status as keyof Omit<TaskMetrics, "total" | "completionPercentage">]++
    }
    tasks.total++
  }

  // Calculate completion percentage
  tasks.completionPercentage = tasks.total > 0
    ? Math.round((tasks.complete / tasks.total) * 100)
    : 0

  // Count tests by type
  const tests: TestMetrics = {
    unit: 0,
    integration: 0,
    acceptance: 0,
    total: 0,
  }

  for (const test of input.testSpecs) {
    if (test.testType in tests) {
      tests[test.testType as keyof Omit<TestMetrics, "total">]++
    }
    tests.total++
  }

  // Count findings by type
  const findings: FindingMetrics = {
    pattern: 0,
    integration_point: 0,
    gap: 0,
    risk: 0,
    verification: 0,
    classification_evidence: 0,
    existing_test: 0,
    total: 0,
  }

  for (const finding of input.findings) {
    if (finding.type in findings) {
      findings[finding.type]++
    } else {
      // Handle unknown finding types dynamically
      findings[finding.type] = (findings[finding.type] || 0) + 1
    }
    findings.total++
  }

  return {
    requirements,
    tasks,
    tests,
    findings,
  }
}

/**
 * Hook that computes aggregated metrics for a feature session
 *
 * @param sessionId - The feature session ID to compute metrics for
 * @returns Metrics object with requirement, task, test, and finding counts
 *
 * @example
 * ```tsx
 * function FeatureSummary({ sessionId }: { sessionId: string }) {
 *   const metrics = useFeatureMetrics(sessionId)
 *
 *   return (
 *     <div>
 *       <p>Tasks: {metrics.tasks.complete}/{metrics.tasks.total}</p>
 *       <p>Progress: {metrics.tasks.completionPercentage}%</p>
 *     </div>
 *   )
 * }
 * ```
 */
export function useFeatureMetrics(sessionId: string): FeatureMetrics {
  // Access platformFeatures domain from DomainProvider
  const { platformFeatures } = useDomains<{ platformFeatures: any }>()

  return useMemo(() => {
    if (!platformFeatures || !sessionId) {
      return computeFeatureMetrics({
        requirements: [],
        tasks: [],
        testSpecs: [],
        findings: [],
      })
    }

    // Query collections for this session
    const requirements = platformFeatures.requirementCollection?.items?.filter(
      (r: any) => r.session === sessionId
    ) || []

    const tasks = platformFeatures.implementationTaskCollection?.items?.filter(
      (t: any) => t.session === sessionId
    ) || []

    const testSpecs = platformFeatures.testSpecificationCollection?.items?.filter(
      (t: any) => {
        // Test specs are linked to tasks, need to find tasks for this session
        const taskIds = tasks.map((task: any) => task.id)
        return taskIds.includes(t.task)
      }
    ) || []

    const findings = platformFeatures.analysisFindingCollection?.items?.filter(
      (f: any) => f.session === sessionId
    ) || []

    return computeFeatureMetrics({
      requirements,
      tasks,
      testSpecs,
      findings,
    })
  }, [platformFeatures, sessionId])
}

/**
 * Get empty metrics object (useful for loading states)
 */
export function getEmptyMetrics(): FeatureMetrics {
  return computeFeatureMetrics({
    requirements: [],
    tasks: [],
    testSpecs: [],
    findings: [],
  })
}
