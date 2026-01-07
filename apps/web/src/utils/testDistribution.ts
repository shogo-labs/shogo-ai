/**
 * Test Distribution Utility
 * Task: task-w1-test-distribution-utility
 *
 * Aggregates TestSpecification entities by testType (unit, integration, acceptance)
 * and returns distribution data for visualization components.
 */

/**
 * Minimal interface for test specifications input
 * Matches the shape needed from TestSpecification entities
 */
export interface TestSpecInput {
  id: string
  testType: "unit" | "integration" | "acceptance"
}

/**
 * Segment data compatible with ProgressBar stacked variant
 */
export interface TestSegment {
  type: "unit" | "integration" | "acceptance"
  value: number
  color: string
  label: string
}

/**
 * Complete test distribution result
 */
export interface TestDistributionResult {
  /** Raw counts by test type */
  counts: {
    unit: number
    integration: number
    acceptance: number
  }
  /** Percentages by test type (0-100) */
  percentages: {
    unit: number
    integration: number
    acceptance: number
  }
  /** Ideal test pyramid ratios (70/20/10) */
  idealRatios: {
    unit: number
    integration: number
    acceptance: number
  }
  /** Data formatted for ProgressBar stacked variant */
  segments: TestSegment[]
  /** Total number of tests */
  total: number
}

/**
 * Test type colors using CSS variable references for phase-aware styling
 */
const TEST_TYPE_COLORS: Record<string, string> = {
  unit: "var(--color-phase-testing)",      // cyan for unit tests
  integration: "var(--color-phase-spec)",  // emerald for integration
  acceptance: "var(--color-phase-complete)" // green for acceptance
}

/**
 * Fallback hex colors for when CSS variables aren't available
 */
const TEST_TYPE_COLORS_HEX: Record<string, string> = {
  unit: "#06b6d4",      // cyan-500
  integration: "#10b981", // emerald-500
  acceptance: "#22c55e"   // green-500
}

/**
 * Human-readable labels for test types
 */
const TEST_TYPE_LABELS: Record<string, string> = {
  unit: "Unit",
  integration: "Integration",
  acceptance: "Acceptance"
}

/**
 * Ideal test pyramid ratios (industry standard)
 * Unit tests should make up ~70%, integration ~20%, acceptance ~10%
 */
const IDEAL_RATIOS = {
  unit: 70,
  integration: 20,
  acceptance: 10
} as const

/**
 * Calculate test distribution from an array of test specifications
 *
 * @param specs - Array of test specifications with testType field
 * @returns Distribution data including counts, percentages, ideal ratios, and segments
 *
 * @example
 * ```ts
 * const specs = [
 *   { id: '1', testType: 'unit' },
 *   { id: '2', testType: 'unit' },
 *   { id: '3', testType: 'integration' },
 * ]
 * const result = calculateTestDistribution(specs)
 * // result.counts = { unit: 2, integration: 1, acceptance: 0 }
 * // result.percentages = { unit: 66.67, integration: 33.33, acceptance: 0 }
 * ```
 */
export function calculateTestDistribution(specs: TestSpecInput[]): TestDistributionResult {
  // Count tests by type
  const counts = {
    unit: 0,
    integration: 0,
    acceptance: 0
  }

  for (const spec of specs) {
    if (spec.testType in counts) {
      counts[spec.testType]++
    }
  }

  const total = counts.unit + counts.integration + counts.acceptance

  // Calculate percentages (handle division by zero)
  const percentages = {
    unit: total > 0 ? Number(((counts.unit / total) * 100).toFixed(2)) : 0,
    integration: total > 0 ? Number(((counts.integration / total) * 100).toFixed(2)) : 0,
    acceptance: total > 0 ? Number(((counts.acceptance / total) * 100).toFixed(2)) : 0
  }

  // Build segments for ProgressBar stacked variant
  const segments: TestSegment[] = [
    {
      type: "unit",
      value: percentages.unit,
      color: TEST_TYPE_COLORS_HEX.unit,
      label: TEST_TYPE_LABELS.unit
    },
    {
      type: "integration",
      value: percentages.integration,
      color: TEST_TYPE_COLORS_HEX.integration,
      label: TEST_TYPE_LABELS.integration
    },
    {
      type: "acceptance",
      value: percentages.acceptance,
      color: TEST_TYPE_COLORS_HEX.acceptance,
      label: TEST_TYPE_LABELS.acceptance
    }
  ]

  return {
    counts,
    percentages,
    idealRatios: { ...IDEAL_RATIOS },
    segments,
    total
  }
}

/**
 * Get deviation from ideal pyramid ratios
 * Useful for showing how close the test distribution is to ideal
 *
 * @param distribution - Result from calculateTestDistribution
 * @returns Deviation percentages (negative = below ideal, positive = above ideal)
 */
export function getDeviationFromIdeal(distribution: TestDistributionResult): {
  unit: number
  integration: number
  acceptance: number
} {
  return {
    unit: Number((distribution.percentages.unit - IDEAL_RATIOS.unit).toFixed(2)),
    integration: Number((distribution.percentages.integration - IDEAL_RATIOS.integration).toFixed(2)),
    acceptance: Number((distribution.percentages.acceptance - IDEAL_RATIOS.acceptance).toFixed(2))
  }
}
