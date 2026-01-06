/**
 * Tests for FindingCard Component
 * Task: task-2-3b-003
 *
 * TDD tests for the finding card component with CVA finding type badge variants.
 *
 * Test Specifications:
 * - test-2-3b-005: FindingCard renders with valid finding props
 * - test-2-3b-006: FindingCard applies correct CVA variants for all 7 finding types
 * - test-2-3b-007: FindingCard conditionally renders recommendation when present
 * - test-2-3b-008: FindingCard hides recommendation when not present
 * - test-2-3b-039: FindingCard exports findingTypeBadgeVariants CVA function
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: FindingCard renders with valid finding props
// (test-2-3b-005)
// ============================================================

describe("test-2-3b-005: FindingCard renders with valid finding props", () => {
  test("FindingCard component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("FindingCard accepts finding prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/finding/)
  })

  test("FindingCard displays finding name", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/finding\.name/)
  })

  test("FindingCard displays finding description", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/finding\.description/)
  })

  test("FindingCard displays type badge", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/finding\.type/)
  })

  test("FindingCard displays location in monospace font", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/finding\.location/)
    expect(componentSource).toMatch(/font-mono/)
  })

  test("FindingCard has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*finding-card/)
  })
})

// ============================================================
// Test 2: FindingCard applies correct CVA variants for all 7 finding types
// (test-2-3b-006)
// ============================================================

describe("test-2-3b-006: FindingCard applies correct CVA variants for all 7 finding types", () => {
  test("FindingCard imports cva from class-variance-authority", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cva.*from.*class-variance-authority/)
  })

  test("FindingCard defines findingTypeBadgeVariants with cva", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/findingTypeBadgeVariants.*=.*cva/)
  })

  test("Pattern type has purple styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/pattern.*bg-purple-100.*text-purple/)
  })

  test("Gap type has amber styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/gap.*bg-amber-100.*text-amber/)
  })

  test("Risk type has red styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/risk.*bg-red-100.*text-red/)
  })

  test("Classification_evidence type has blue styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/classification_evidence.*bg-blue-100.*text-blue/)
  })

  test("Integration_point type has cyan styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/integration_point.*bg-cyan-100.*text-cyan/)
  })

  test("Verification type has green styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/verification.*bg-green-100.*text-green/)
  })

  test("Existing_test type has indigo styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/existing_test.*bg-indigo-100.*text-indigo/)
  })
})

// ============================================================
// Test 3: FindingCard conditionally renders recommendation when present
// (test-2-3b-007)
// ============================================================

describe("test-2-3b-007: FindingCard conditionally renders recommendation when present", () => {
  test("FindingCard has recommendation section", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/finding\.recommendation/)
  })

  test("Recommendation section uses conditional rendering", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have conditional check for recommendation
    expect(componentSource).toMatch(/finding\.recommendation\s*&&|finding\.recommendation\s*\?/)
  })
})

// ============================================================
// Test 4: FindingCard hides recommendation when not present
// (test-2-3b-008)
// ============================================================

describe("test-2-3b-008: FindingCard hides recommendation when not present", () => {
  test("Recommendation rendering is conditional", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should conditionally render - not always display
    expect(componentSource).toMatch(/\{finding\.recommendation\s*&&|\{finding\.recommendation\s*\?/)
  })
})

// ============================================================
// Test 5: FindingCard exports findingTypeBadgeVariants CVA function
// (test-2-3b-039)
// ============================================================

describe("test-2-3b-039: FindingCard exports findingTypeBadgeVariants CVA function", () => {
  test("FindingCard exports findingTypeBadgeVariants", () => {
    const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*findingTypeBadgeVariants/)
  })

  test("findingTypeBadgeVariants can be imported", async () => {
    const module = await import("../FindingCard")
    expect(module.findingTypeBadgeVariants).toBeDefined()
    expect(typeof module.findingTypeBadgeVariants).toBe("function")
  })

  test("FindingCard component can be imported", async () => {
    const module = await import("../FindingCard")
    expect(module.FindingCard).toBeDefined()
    expect(typeof module.FindingCard).toBe("function")
  })
})
