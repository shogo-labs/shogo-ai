/**
 * Tests for SpecView Component
 * Task: task-2-3d-spec-view
 *
 * TDD tests for the spec phase view displaying ImplementationTask entities.
 *
 * Test Specifications from task acceptance criteria:
 * - SpecView.tsx created in stepper/phases/spec/ directory
 * - Component wrapped with observer() for MST reactivity
 * - Receives feature prop from PhaseContentPanel
 * - Queries implementationTaskCollection.findBySession(feature.id) via useDomains()
 * - Renders list of TaskCard components for each task
 * - Tasks sorted by dependency order
 * - Shows empty state when no tasks exist
 * - Uses grid or flex column layout with gap-4
 * - Exports SpecView and SpecViewProps
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: SpecView component file exists
// ============================================================

describe("SpecView component file exists", () => {
  test("SpecView.tsx file exists in stepper/phases/spec/", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })
})

// ============================================================
// Test 2: SpecView is wrapped with observer()
// ============================================================

describe("SpecView is wrapped with observer()", () => {
  test("SpecView imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("SpecView exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(function SpecView/)
  })
})

// ============================================================
// Test 3: SpecView receives feature prop
// ============================================================

describe("SpecView receives feature prop", () => {
  test("SpecView has feature prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature/)
  })

  test("SpecViewProps defines feature property", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/SpecViewProps/)
  })
})

// ============================================================
// Test 4: SpecView queries implementationTaskCollection
// ============================================================

describe("SpecView queries implementationTaskCollection", () => {
  test("SpecView imports useDomains", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/useDomains/)
  })

  test("SpecView queries implementationTaskCollection", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/implementationTaskCollection/)
  })

  test("SpecView uses findBySession query", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/findBySession/)
  })
})

// ============================================================
// Test 5: SpecView renders TaskCard components
// ============================================================

describe("SpecView renders TaskCard components", () => {
  test("SpecView imports TaskCard", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/TaskCard/)
  })

  test("SpecView maps tasks to TaskCards", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Check that both .map and TaskCard are present (rendering list of cards)
    expect(componentSource).toMatch(/\.map/)
    expect(componentSource).toMatch(/TaskCard/)
  })
})

// ============================================================
// Test 6: SpecView shows empty state
// ============================================================

describe("SpecView shows empty state", () => {
  test("SpecView has empty state message", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/No implementation tasks|empty|no tasks/i)
  })
})

// ============================================================
// Test 7: SpecView has proper layout
// ============================================================

describe("SpecView has proper layout", () => {
  test("SpecView has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*spec-view/)
  })

  test("SpecView has gap-4 or similar spacing", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/gap-4|space-y-4/)
  })
})

// ============================================================
// Test 8: SpecView exports
// ============================================================

describe("SpecView exports", () => {
  test("SpecView exports SpecView component", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*SpecView/)
  })

  test("SpecView exports SpecViewProps type", () => {
    const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*SpecViewProps/)
  })
})
