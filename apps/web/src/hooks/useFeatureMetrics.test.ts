/**
 * useFeatureMetrics Hook Tests
 * Task: task-w1-use-feature-metrics-hook
 *
 * Tests verify:
 * 1. Returns requirement counts by priority
 * 2. Returns task counts by status
 * 3. Returns test counts by type
 * 4. Returns finding counts by type
 * 5. Is memoized for performance
 */

import { describe, test, expect } from "bun:test"
import {
  computeFeatureMetrics,
  type FeatureMetricsInput,
  type FeatureMetrics,
} from "./useFeatureMetrics"

// Helper to create test data
const createTestData = (): FeatureMetricsInput => ({
  requirements: [
    { id: "req-1", priority: "must", status: "proposed" },
    { id: "req-2", priority: "must", status: "accepted" },
    { id: "req-3", priority: "should", status: "proposed" },
    { id: "req-4", priority: "could", status: "proposed" },
  ],
  tasks: [
    { id: "task-1", status: "planned" },
    { id: "task-2", status: "in_progress" },
    { id: "task-3", status: "complete" },
    { id: "task-4", status: "complete" },
    { id: "task-5", status: "blocked" },
  ],
  testSpecs: [
    { id: "test-1", testType: "unit" },
    { id: "test-2", testType: "unit" },
    { id: "test-3", testType: "unit" },
    { id: "test-4", testType: "integration" },
    { id: "test-5", testType: "acceptance" },
  ],
  findings: [
    { id: "finding-1", type: "pattern" },
    { id: "finding-2", type: "pattern" },
    { id: "finding-3", type: "gap" },
    { id: "finding-4", type: "risk" },
  ],
})

describe("computeFeatureMetrics - Requirement Counts", () => {
  test("returns requirements object with must count", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.requirements.must).toBe(2)
  })

  test("returns requirements object with should count", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.requirements.should).toBe(1)
  })

  test("returns requirements object with could count", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.requirements.could).toBe(1)
  })

  test("total equals sum of all priority counts", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    const total = result.requirements.must + result.requirements.should + result.requirements.could
    expect(result.requirements.total).toBe(total)
    expect(result.requirements.total).toBe(4)
  })
})

describe("computeFeatureMetrics - Task Counts", () => {
  test("returns tasks object with planned count", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.tasks.planned).toBe(1)
  })

  test("returns tasks object with in_progress count", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.tasks.in_progress).toBe(1)
  })

  test("returns tasks object with complete count", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.tasks.complete).toBe(2)
  })

  test("returns tasks object with blocked count", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.tasks.blocked).toBe(1)
  })

  test("total equals sum of all status counts", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.tasks.total).toBe(5)
  })

  test("completionPercentage is calculated correctly", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    // 2 complete out of 5 = 40%
    expect(result.tasks.completionPercentage).toBe(40)
  })
})

describe("computeFeatureMetrics - Test Counts", () => {
  test("returns tests object with unit count", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.tests.unit).toBe(3)
  })

  test("returns tests object with integration count", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.tests.integration).toBe(1)
  })

  test("returns tests object with acceptance count", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.tests.acceptance).toBe(1)
  })

  test("total equals sum of all test type counts", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.tests.total).toBe(5)
  })
})

describe("computeFeatureMetrics - Finding Counts", () => {
  test("returns findings object grouped by finding type", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.findings.pattern).toBe(2)
    expect(result.findings.gap).toBe(1)
    expect(result.findings.risk).toBe(1)
  })

  test("includes pattern, integration_point, risk, gap types", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.findings).toHaveProperty("pattern")
    expect(result.findings).toHaveProperty("gap")
    expect(result.findings).toHaveProperty("risk")
  })

  test("total equals sum of all type counts", () => {
    const data = createTestData()
    const result = computeFeatureMetrics(data)
    expect(result.findings.total).toBe(4)
  })
})

describe("computeFeatureMetrics - Empty Data", () => {
  test("handles empty arrays gracefully", () => {
    const emptyData: FeatureMetricsInput = {
      requirements: [],
      tasks: [],
      testSpecs: [],
      findings: [],
    }
    const result = computeFeatureMetrics(emptyData)

    expect(result.requirements.total).toBe(0)
    expect(result.tasks.total).toBe(0)
    expect(result.tests.total).toBe(0)
    expect(result.findings.total).toBe(0)
  })

  test("completionPercentage is 0 when no tasks", () => {
    const emptyData: FeatureMetricsInput = {
      requirements: [],
      tasks: [],
      testSpecs: [],
      findings: [],
    }
    const result = computeFeatureMetrics(emptyData)
    expect(result.tasks.completionPercentage).toBe(0)
  })
})

describe("computeFeatureMetrics - Memoization support", () => {
  test("returns consistent results for same input", () => {
    const data = createTestData()
    const result1 = computeFeatureMetrics(data)
    const result2 = computeFeatureMetrics(data)

    expect(result1.requirements.total).toBe(result2.requirements.total)
    expect(result1.tasks.completionPercentage).toBe(result2.tasks.completionPercentage)
  })
})
