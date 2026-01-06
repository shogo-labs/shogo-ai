/**
 * Tests for DependencyIndicator Component
 * Task: task-2-3d-dependency-indicator
 *
 * TDD tests for the dependency indicator that shows task dependencies with status dots.
 *
 * Test Specifications from task acceptance criteria:
 * - DependencyIndicator.tsx created in stepper/cards/ directory
 * - Component wrapped with observer() from mobx-react-lite for MST reactivity
 * - Displays 'Depends on:' label followed by dependency task names
 * - Each dependency name preceded by status dot colored by task status
 * - Shows 'No dependencies' text when dependencies array is empty
 * - Handles ImplementationTask[] reference array from parent TaskCard
 * - Compact inline layout that fits within TaskCard footer area
 * - Exports DependencyIndicator and DependencyIndicatorProps
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: DependencyIndicator component file exists
// ============================================================

describe("DependencyIndicator component file exists", () => {
  test("DependencyIndicator.tsx file exists in stepper/cards/", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })
})

// ============================================================
// Test 2: DependencyIndicator is wrapped with observer()
// ============================================================

describe("DependencyIndicator is wrapped with observer()", () => {
  test("DependencyIndicator imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("DependencyIndicator exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(function DependencyIndicator/)
  })
})

// ============================================================
// Test 3: DependencyIndicator displays dependencies label
// ============================================================

describe("DependencyIndicator displays dependencies label", () => {
  test("DependencyIndicator shows 'Depends on:' label", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Depends on/)
  })
})

// ============================================================
// Test 4: DependencyIndicator shows status dots
// ============================================================

describe("DependencyIndicator shows status dots", () => {
  test("DependencyIndicator has status dot styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have dot/circle styling for status indicator
    expect(componentSource).toMatch(/rounded-full.*w-2.*h-2|w-2.*h-2.*rounded-full/)
  })

  test("DependencyIndicator has green color for complete status", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/complete.*green|green.*complete/)
  })

  test("DependencyIndicator has gray color for pending/planned status", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/planned.*gray|gray.*planned/)
  })

  test("DependencyIndicator has blue color for in_progress status", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/in_progress.*blue|blue.*in_progress/)
  })

  test("DependencyIndicator has red color for blocked status", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/blocked.*red|red.*blocked/)
  })
})

// ============================================================
// Test 5: DependencyIndicator handles empty dependencies
// ============================================================

describe("DependencyIndicator handles empty dependencies", () => {
  test("DependencyIndicator handles empty or undefined dependencies", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should check for empty/null dependencies
    expect(componentSource).toMatch(/dependencies.*length|!dependencies|dependencies\s*===\s*undefined/)
  })
})

// ============================================================
// Test 6: DependencyIndicator exports
// ============================================================

describe("DependencyIndicator exports", () => {
  test("DependencyIndicator exports DependencyIndicator component", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*DependencyIndicator/)
  })

  test("DependencyIndicator exports DependencyIndicatorProps type", () => {
    const componentPath = path.resolve(import.meta.dir, "../DependencyIndicator.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*DependencyIndicatorProps/)
  })
})
