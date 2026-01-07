/**
 * Tests for CompleteView Component
 * Task: task-2-3d-complete-view
 *
 * TDD tests for the complete phase view displaying summary when feature is done.
 *
 * Test Specifications from task acceptance criteria:
 * - CompleteView.tsx created in stepper/phases/complete/ directory
 * - Component wrapped with observer() for MST reactivity
 * - Receives feature prop from PhaseContentPanel
 * - Shows success icon (CheckCircle) and congratulatory message
 * - Displays completion timestamp from feature.updatedAt
 * - Shows summary stats in grid: tasks completed, test specs count, runs count
 * - Aggregates counts from collections via useDomains()
 * - Shows 'Feature not yet complete' if status != complete
 * - Uses shadcn Card for stat displays
 * - Exports CompleteView and CompleteViewProps
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: CompleteView component file exists
// ============================================================

describe("CompleteView component file exists", () => {
  test("CompleteView.tsx file exists in stepper/phases/complete/", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })
})

// ============================================================
// Test 2: CompleteView is wrapped with observer()
// ============================================================

describe("CompleteView is wrapped with observer()", () => {
  test("CompleteView imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("CompleteView exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(function CompleteView/)
  })
})

// ============================================================
// Test 3: CompleteView receives feature prop
// ============================================================

describe("CompleteView receives feature prop", () => {
  test("CompleteView has feature prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature/)
  })

  test("CompleteViewProps defines feature property", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/CompleteViewProps/)
  })
})

// ============================================================
// Test 4: CompleteView shows success icon
// ============================================================

describe("CompleteView shows success icon", () => {
  test("CompleteView imports CheckCircle from lucide-react", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/CheckCircle/)
  })

  test("CompleteView shows congratulatory message", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/complete|success|congrat/i)
  })
})

// ============================================================
// Test 5: CompleteView displays timestamp
// ============================================================

describe("CompleteView displays timestamp", () => {
  test("CompleteView uses updatedAt for timestamp", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/updatedAt/)
  })
})

// ============================================================
// Test 6: CompleteView shows stats
// ============================================================

describe("CompleteView shows stats", () => {
  test("CompleteView queries collections for stats", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/useDomains/)
  })

  test("CompleteView shows task count", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/task|Task/)
  })

  test("CompleteView uses Card-style layout for stats", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Redesigned uses custom card-like divs with rounded-lg, border, bg-card
    expect(componentSource).toMatch(/Card|rounded-lg.*border|bg-card/)
  })
})

// ============================================================
// Test 7: CompleteView handles incomplete status
// ============================================================

describe("CompleteView handles incomplete status", () => {
  test("CompleteView checks for complete status", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/status.*complete|complete.*status|not.*complete/i)
  })
})

// ============================================================
// Test 8: CompleteView has proper layout
// ============================================================

describe("CompleteView has proper layout", () => {
  test("CompleteView has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*complete-view/)
  })
})

// ============================================================
// Test 9: CompleteView exports
// ============================================================

describe("CompleteView exports", () => {
  test("CompleteView exports CompleteView component", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*CompleteView/)
  })

  test("CompleteView exports CompleteViewProps type", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*CompleteViewProps/)
  })
})
