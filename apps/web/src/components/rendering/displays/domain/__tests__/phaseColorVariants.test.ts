/**
 * Phase Color Variants Tests
 * Task: task-w1-phase-color-variants
 *
 * Tests verify:
 * 1. phaseColorVariants CVA function is exported
 * 2. Supports all 8 phase values
 * 3. Includes bg, text, border, and ring variants
 * 4. TypeScript type safety
 */

import { describe, test, expect } from "bun:test"
import { phaseColorVariants, type PhaseType, PHASE_VALUES } from "../variants"

describe("phaseColorVariants - Export", () => {
  test("phaseColorVariants function is exported from variants.ts", () => {
    expect(phaseColorVariants).toBeDefined()
    expect(typeof phaseColorVariants).toBe("function")
  })

  test("function is callable with phase parameter", () => {
    const result = phaseColorVariants({ phase: "discovery" })
    expect(typeof result).toBe("string")
  })

  test("returns className string", () => {
    const result = phaseColorVariants({ phase: "discovery" })
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("phaseColorVariants - All Phases", () => {
  test("returns valid classes for 'discovery' phase", () => {
    const result = phaseColorVariants({ phase: "discovery" })
    expect(result).toBeTruthy()
    expect(typeof result).toBe("string")
  })

  test("returns valid classes for 'analysis' phase", () => {
    const result = phaseColorVariants({ phase: "analysis" })
    expect(result).toBeTruthy()
  })

  test("returns valid classes for 'classification' phase", () => {
    const result = phaseColorVariants({ phase: "classification" })
    expect(result).toBeTruthy()
  })

  test("returns valid classes for 'design' phase", () => {
    const result = phaseColorVariants({ phase: "design" })
    expect(result).toBeTruthy()
  })

  test("returns valid classes for 'spec' phase", () => {
    const result = phaseColorVariants({ phase: "spec" })
    expect(result).toBeTruthy()
  })

  test("returns valid classes for 'testing' phase", () => {
    const result = phaseColorVariants({ phase: "testing" })
    expect(result).toBeTruthy()
  })

  test("returns valid classes for 'implementation' phase", () => {
    const result = phaseColorVariants({ phase: "implementation" })
    expect(result).toBeTruthy()
  })

  test("returns valid classes for 'complete' phase", () => {
    const result = phaseColorVariants({ phase: "complete" })
    expect(result).toBeTruthy()
  })
})

describe("phaseColorVariants - Variant Types", () => {
  test("returns background color classes when variant is 'bg'", () => {
    const result = phaseColorVariants({ phase: "discovery", variant: "bg" })
    expect(result).toContain("bg-")
  })

  test("returns text color classes when variant is 'text'", () => {
    const result = phaseColorVariants({ phase: "discovery", variant: "text" })
    expect(result).toContain("text-")
  })

  test("returns border color classes when variant is 'border'", () => {
    const result = phaseColorVariants({ phase: "discovery", variant: "border" })
    expect(result).toContain("border-")
  })

  test("returns ring/accent color classes when variant is 'ring'", () => {
    const result = phaseColorVariants({ phase: "discovery", variant: "ring" })
    expect(result).toContain("ring-")
  })

  test("default variant returns combined classes", () => {
    const result = phaseColorVariants({ phase: "discovery" })
    // Default should include background and text at minimum
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("phaseColorVariants - TypeScript Types", () => {
  test("PHASE_VALUES array contains all 8 phases", () => {
    expect(PHASE_VALUES).toContain("discovery")
    expect(PHASE_VALUES).toContain("analysis")
    expect(PHASE_VALUES).toContain("classification")
    expect(PHASE_VALUES).toContain("design")
    expect(PHASE_VALUES).toContain("spec")
    expect(PHASE_VALUES).toContain("testing")
    expect(PHASE_VALUES).toContain("implementation")
    expect(PHASE_VALUES).toContain("complete")
    expect(PHASE_VALUES.length).toBe(8)
  })

  test("PhaseType is exported", () => {
    // This is a compile-time check - if PhaseType doesn't exist, this file won't compile
    const phase: PhaseType = "discovery"
    expect(phase).toBe("discovery")
  })
})

describe("phaseColorVariants - Each Phase Has Distinct Colors", () => {
  test("each phase returns different class strings", () => {
    const phases = PHASE_VALUES
    const results = phases.map(phase => phaseColorVariants({ phase, variant: "bg" }))

    // All results should be unique
    const uniqueResults = new Set(results)
    expect(uniqueResults.size).toBe(phases.length)
  })
})
