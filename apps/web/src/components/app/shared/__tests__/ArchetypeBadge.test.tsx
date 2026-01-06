/**
 * Tests for ArchetypeBadge Component
 * Task: task-2-3b-004
 *
 * TDD tests for the archetype badge component with CVA archetype variants.
 *
 * Test Specifications:
 * - test-2-3b-009: ArchetypeBadge renders with valid archetype prop
 * - test-2-3b-010: ArchetypeBadge applies correct CVA variants for all 4 archetypes
 * - test-2-3b-011: ArchetypeBadge size variants affect padding and font size
 * - test-2-3b-040: ArchetypeBadge exports archetypeBadgeVariants CVA function
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: ArchetypeBadge renders with valid archetype prop
// (test-2-3b-009)
// ============================================================

describe("test-2-3b-009: ArchetypeBadge renders with valid archetype prop", () => {
  test("ArchetypeBadge component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("ArchetypeBadge accepts archetype prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/archetype/)
  })

  test("ArchetypeBadge displays archetype text", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should display the archetype value
    expect(componentSource).toMatch(/\{archetype\}/)
  })

  test("ArchetypeBadge has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*archetype-badge/)
  })
})

// ============================================================
// Test 2: ArchetypeBadge applies correct CVA variants for all 4 archetypes
// (test-2-3b-010)
// ============================================================

describe("test-2-3b-010: ArchetypeBadge applies correct CVA variants for all 4 archetypes", () => {
  test("ArchetypeBadge imports cva from class-variance-authority", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cva.*from.*class-variance-authority/)
  })

  test("ArchetypeBadge defines archetypeBadgeVariants with cva", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/archetypeBadgeVariants.*=.*cva/)
  })

  test("Domain archetype has blue styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/domain.*bg-blue-100.*text-blue/)
  })

  test("Service archetype has purple styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/service.*bg-purple-100.*text-purple/)
  })

  test("Infrastructure archetype has green styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/infrastructure.*bg-green-100.*text-green/)
  })

  test("Hybrid archetype has amber styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/hybrid.*bg-amber-100.*text-amber/)
  })
})

// ============================================================
// Test 3: ArchetypeBadge size variants affect padding and font size
// (test-2-3b-011)
// ============================================================

describe("test-2-3b-011: ArchetypeBadge size variants affect padding and font size", () => {
  test("ArchetypeBadge accepts size prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/size/)
  })

  test("ArchetypeBadge has sm size variant", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/sm:/)
  })

  test("ArchetypeBadge has md size variant", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/md:/)
  })
})

// ============================================================
// Test 4: ArchetypeBadge exports archetypeBadgeVariants CVA function
// (test-2-3b-040)
// ============================================================

describe("test-2-3b-040: ArchetypeBadge exports archetypeBadgeVariants CVA function", () => {
  test("ArchetypeBadge exports archetypeBadgeVariants", () => {
    const componentPath = path.resolve(import.meta.dir, "../ArchetypeBadge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*archetypeBadgeVariants/)
  })

  test("archetypeBadgeVariants can be imported", async () => {
    const module = await import("../ArchetypeBadge")
    expect(module.archetypeBadgeVariants).toBeDefined()
    expect(typeof module.archetypeBadgeVariants).toBe("function")
  })

  test("ArchetypeBadge component can be imported", async () => {
    const module = await import("../ArchetypeBadge")
    expect(module.ArchetypeBadge).toBeDefined()
    expect(typeof module.ArchetypeBadge).toBe("function")
  })
})
