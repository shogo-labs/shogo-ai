/**
 * Test Distribution Utility Tests
 * Task: task-w1-test-distribution-utility
 *
 * Tests verify:
 * 1. Returns counts by test type (unit, integration, acceptance)
 * 2. Returns percentages for each type
 * 3. Includes ideal pyramid ratios (70/20/10)
 * 4. Returns data compatible with ProgressBar stacked variant
 * 5. Handles empty array gracefully
 */

import { describe, test, expect } from "bun:test"
import { calculateTestDistribution, type TestSpecInput } from "./testDistribution"

// Mock test specifications for testing
const createTestSpecs = (unit: number, integration: number, acceptance: number): TestSpecInput[] => {
  const specs: TestSpecInput[] = []
  for (let i = 0; i < unit; i++) {
    specs.push({ id: `unit-${i}`, testType: "unit" })
  }
  for (let i = 0; i < integration; i++) {
    specs.push({ id: `integration-${i}`, testType: "integration" })
  }
  for (let i = 0; i < acceptance; i++) {
    specs.push({ id: `acceptance-${i}`, testType: "acceptance" })
  }
  return specs
}

describe("calculateTestDistribution - Counts", () => {
  test("returns object with unit count", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.counts.unit).toBe(5)
  })

  test("returns object with integration count", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.counts.integration).toBe(2)
  })

  test("returns object with acceptance count", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.counts.acceptance).toBe(1)
  })

  test("counts accurately reflect input data", () => {
    const specs = createTestSpecs(10, 5, 3)
    const result = calculateTestDistribution(specs)
    expect(result.counts.unit).toBe(10)
    expect(result.counts.integration).toBe(5)
    expect(result.counts.acceptance).toBe(3)
    expect(result.total).toBe(18)
  })
})

describe("calculateTestDistribution - Percentages", () => {
  test("returns unit percentage of 70 for 7/2/1 distribution", () => {
    const specs = createTestSpecs(7, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.percentages.unit).toBe(70)
  })

  test("returns integration percentage of 20 for 7/2/1 distribution", () => {
    const specs = createTestSpecs(7, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.percentages.integration).toBe(20)
  })

  test("returns acceptance percentage of 10 for 7/2/1 distribution", () => {
    const specs = createTestSpecs(7, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.percentages.acceptance).toBe(10)
  })

  test("percentages sum to 100", () => {
    const specs = createTestSpecs(7, 2, 1)
    const result = calculateTestDistribution(specs)
    const sum = result.percentages.unit + result.percentages.integration + result.percentages.acceptance
    expect(sum).toBe(100)
  })

  test("handles non-round percentages correctly", () => {
    const specs = createTestSpecs(3, 3, 3)
    const result = calculateTestDistribution(specs)
    // Each should be approximately 33.33%
    expect(result.percentages.unit).toBeCloseTo(33.33, 1)
    expect(result.percentages.integration).toBeCloseTo(33.33, 1)
    expect(result.percentages.acceptance).toBeCloseTo(33.33, 1)
  })
})

describe("calculateTestDistribution - Ideal Ratios", () => {
  test("returns idealRatios object", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.idealRatios).toBeDefined()
  })

  test("idealRatios.unit equals 70", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.idealRatios.unit).toBe(70)
  })

  test("idealRatios.integration equals 20", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.idealRatios.integration).toBe(20)
  })

  test("idealRatios.acceptance equals 10", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.idealRatios.acceptance).toBe(10)
  })
})

describe("calculateTestDistribution - ProgressBar Stacked Format", () => {
  test("returns segments array with 3 items", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.segments).toHaveLength(3)
  })

  test("each segment has value property", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    result.segments.forEach(segment => {
      expect(segment).toHaveProperty("value")
      expect(typeof segment.value).toBe("number")
    })
  })

  test("each segment has color property matching test type", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    result.segments.forEach(segment => {
      expect(segment).toHaveProperty("color")
      expect(typeof segment.color).toBe("string")
    })
  })

  test("segments ordered: unit, integration, acceptance", () => {
    const specs = createTestSpecs(5, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.segments[0].type).toBe("unit")
    expect(result.segments[1].type).toBe("integration")
    expect(result.segments[2].type).toBe("acceptance")
  })

  test("segment values match percentages", () => {
    const specs = createTestSpecs(7, 2, 1)
    const result = calculateTestDistribution(specs)
    expect(result.segments[0].value).toBe(70) // unit
    expect(result.segments[1].value).toBe(20) // integration
    expect(result.segments[2].value).toBe(10) // acceptance
  })
})

describe("calculateTestDistribution - Empty Array", () => {
  test("returns zero counts for all types", () => {
    const result = calculateTestDistribution([])
    expect(result.counts.unit).toBe(0)
    expect(result.counts.integration).toBe(0)
    expect(result.counts.acceptance).toBe(0)
  })

  test("returns zero percentages", () => {
    const result = calculateTestDistribution([])
    expect(result.percentages.unit).toBe(0)
    expect(result.percentages.integration).toBe(0)
    expect(result.percentages.acceptance).toBe(0)
  })

  test("does not throw error", () => {
    expect(() => calculateTestDistribution([])).not.toThrow()
  })

  test("still includes idealRatios", () => {
    const result = calculateTestDistribution([])
    expect(result.idealRatios.unit).toBe(70)
    expect(result.idealRatios.integration).toBe(20)
    expect(result.idealRatios.acceptance).toBe(10)
  })

  test("returns total of 0", () => {
    const result = calculateTestDistribution([])
    expect(result.total).toBe(0)
  })
})
