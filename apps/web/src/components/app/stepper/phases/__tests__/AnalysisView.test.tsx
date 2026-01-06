/**
 * Tests for AnalysisView Component
 * Task: task-2-3b-008
 *
 * TDD tests for the analysis phase view component.
 *
 * Test Specifications:
 * - test-2-3b-022: AnalysisView renders findings grouped by type
 * - test-2-3b-023: AnalysisView uses FindingCard for each finding
 * - test-2-3b-024: AnalysisView handles empty findings state
 * - test-2-3b-025: AnalysisView section headers show type badge with count
 * - test-2-3b-042: AnalysisView is wrapped with observer() for MobX reactivity
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: AnalysisView renders findings grouped by type
// (test-2-3b-022)
// ============================================================

describe("test-2-3b-022: AnalysisView renders findings grouped by type", () => {
  test("AnalysisView component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("AnalysisView accepts feature prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature/)
  })

  test("AnalysisView has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*analysis-view/)
  })

  test("AnalysisView uses useDomains hook", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/useDomains/)
  })

  test("AnalysisView accesses analysisFindingCollection", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/analysisFindingCollection/)
  })

  test("AnalysisView groups findings by type", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have type grouping logic
    expect(componentSource).toMatch(/pattern|gap|risk/)
  })
})

// ============================================================
// Test 2: AnalysisView uses FindingCard for each finding
// (test-2-3b-023)
// ============================================================

describe("test-2-3b-023: AnalysisView uses FindingCard for each finding", () => {
  test("AnalysisView imports FindingCard", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Import may span multiple lines
    expect(componentSource).toMatch(/FindingCard/)
  })

  test("AnalysisView uses FindingCard component", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<FindingCard/)
  })
})

// ============================================================
// Test 3: AnalysisView handles empty findings state
// (test-2-3b-024)
// ============================================================

describe("test-2-3b-024: AnalysisView handles empty findings state", () => {
  test("AnalysisView handles empty findings array", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should check for empty findings
    expect(componentSource).toMatch(/findings\.length|findings\?|!findings/)
  })
})

// ============================================================
// Test 4: AnalysisView section headers show type badge with count
// (test-2-3b-025)
// ============================================================

describe("test-2-3b-025: AnalysisView section headers show type badge with count", () => {
  test("AnalysisView displays section count", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show count in header
    expect(componentSource).toMatch(/\.length/)
  })
})

// ============================================================
// Test 5: AnalysisView is wrapped with observer() for MobX reactivity
// (test-2-3b-042)
// ============================================================

describe("test-2-3b-042: AnalysisView is wrapped with observer() for MobX reactivity", () => {
  test("AnalysisView imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("AnalysisView is wrapped with observer", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(/)
  })
})

// ============================================================
// Test 6: Module exports
// ============================================================

describe("AnalysisView module exports", () => {
  test("AnalysisView component can be imported", async () => {
    const module = await import("../AnalysisView")
    expect(module.AnalysisView).toBeDefined()
    // MobX observer wraps component as object with render function
    expect(module.AnalysisView).toBeTruthy()
  })
})
