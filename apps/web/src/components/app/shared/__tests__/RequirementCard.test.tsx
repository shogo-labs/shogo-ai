/**
 * Tests for RequirementCard Component
 * Task: task-2-3b-002
 *
 * TDD tests for the requirement card component with CVA priority badge variants.
 *
 * Test Specifications:
 * - test-2-3b-001: RequirementCard renders with valid requirement props
 * - test-2-3b-002: RequirementCard applies correct CVA variant for 'must' priority
 * - test-2-3b-003: RequirementCard applies correct CVA variant for 'should' priority
 * - test-2-3b-004: RequirementCard applies correct CVA variant for 'could' priority
 * - test-2-3b-038: RequirementCard exports priorityBadgeVariants CVA function
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: RequirementCard renders with valid requirement props
// (test-2-3b-001)
// ============================================================

describe("test-2-3b-001: RequirementCard renders with valid requirement props", () => {
  test("RequirementCard component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("RequirementCard accepts requirement prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/requirement/)
  })

  test("RequirementCard displays requirement name", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/requirement\.name/)
  })

  test("RequirementCard displays requirement description", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/requirement\.description/)
  })

  test("RequirementCard displays priority badge", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/requirement\.priority/)
  })

  test("RequirementCard has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*requirement-card/)
  })
})

// ============================================================
// Test 2: RequirementCard applies correct CVA variant for 'must' priority
// (test-2-3b-002)
// ============================================================

describe("test-2-3b-002: RequirementCard applies correct CVA variant for 'must' priority", () => {
  test("RequirementCard imports cva from class-variance-authority", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cva.*from.*class-variance-authority/)
  })

  test("RequirementCard defines priorityBadgeVariants with cva", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/priorityBadgeVariants.*=.*cva/)
  })

  test("Priority badge uses base styles matching FeatureItem pattern", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/inline-flex.*items-center.*rounded-full/)
  })

  test("Must priority has red background class", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/must.*bg-red-100/)
  })

  test("Must priority has red text class", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/must.*text-red/)
  })

  test("Must priority has dark mode classes", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/dark:bg-red-900\/30.*dark:text-red-400/)
  })
})

// ============================================================
// Test 3: RequirementCard applies correct CVA variant for 'should' priority
// (test-2-3b-003)
// ============================================================

describe("test-2-3b-003: RequirementCard applies correct CVA variant for 'should' priority", () => {
  test("Should priority has amber background class", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/should.*bg-amber-100/)
  })

  test("Should priority has amber text class", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/should.*text-amber/)
  })
})

// ============================================================
// Test 4: RequirementCard applies correct CVA variant for 'could' priority
// (test-2-3b-004)
// ============================================================

describe("test-2-3b-004: RequirementCard applies correct CVA variant for 'could' priority", () => {
  test("Could priority has blue background class", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/could.*bg-blue-100/)
  })

  test("Could priority has blue text class", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/could.*text-blue/)
  })
})

// ============================================================
// Test 5: RequirementCard exports priorityBadgeVariants CVA function
// (test-2-3b-038)
// ============================================================

describe("test-2-3b-038: RequirementCard exports priorityBadgeVariants CVA function", () => {
  test("RequirementCard exports priorityBadgeVariants", () => {
    const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*priorityBadgeVariants/)
  })

  test("priorityBadgeVariants can be imported", async () => {
    const module = await import("../RequirementCard")
    expect(module.priorityBadgeVariants).toBeDefined()
    expect(typeof module.priorityBadgeVariants).toBe("function")
  })

  test("RequirementCard component can be imported", async () => {
    const module = await import("../RequirementCard")
    expect(module.RequirementCard).toBeDefined()
    expect(typeof module.RequirementCard).toBe("function")
  })
})
