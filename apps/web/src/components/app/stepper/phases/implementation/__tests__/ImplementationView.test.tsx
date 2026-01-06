/**
 * Tests for ImplementationView Component
 * Task: task-2-3d-implementation-view
 *
 * TDD tests for the implementation phase view displaying run status and executions.
 *
 * Test Specifications from task acceptance criteria:
 * - ImplementationView.tsx created in stepper/phases/implementation/ directory
 * - Component wrapped with observer() for MST reactivity
 * - Receives feature prop from PhaseContentPanel
 * - Queries implementationRunCollection.findLatestBySession() via useDomains()
 * - Displays ExecutionProgress component at top when run exists
 * - Queries taskExecutionCollection.findByRun() for task executions
 * - Renders list of TaskExecutionRow components
 * - Shows empty state when no runs exist
 * - Exports ImplementationView and ImplementationViewProps
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: ImplementationView component file exists
// ============================================================

describe("ImplementationView component file exists", () => {
  test("ImplementationView.tsx file exists in stepper/phases/implementation/", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })
})

// ============================================================
// Test 2: ImplementationView is wrapped with observer()
// ============================================================

describe("ImplementationView is wrapped with observer()", () => {
  test("ImplementationView imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("ImplementationView exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(function ImplementationView/)
  })
})

// ============================================================
// Test 3: ImplementationView receives feature prop
// ============================================================

describe("ImplementationView receives feature prop", () => {
  test("ImplementationView has feature prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature/)
  })

  test("ImplementationViewProps defines feature property", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/ImplementationViewProps/)
  })
})

// ============================================================
// Test 4: ImplementationView queries collections
// ============================================================

describe("ImplementationView queries collections", () => {
  test("ImplementationView imports useDomains", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/useDomains/)
  })

  test("ImplementationView queries implementationRunCollection", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/implementationRunCollection/)
  })

  test("ImplementationView uses findLatestBySession", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/findLatestBySession/)
  })

  test("ImplementationView queries taskExecutionCollection", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/taskExecutionCollection/)
  })
})

// ============================================================
// Test 5: ImplementationView renders ExecutionProgress
// ============================================================

describe("ImplementationView renders ExecutionProgress", () => {
  test("ImplementationView imports ExecutionProgress", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/ExecutionProgress/)
  })
})

// ============================================================
// Test 6: ImplementationView renders TaskExecutionRow
// ============================================================

describe("ImplementationView renders TaskExecutionRow", () => {
  test("ImplementationView imports TaskExecutionRow", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/TaskExecutionRow/)
  })

  test("ImplementationView maps executions to rows", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Check that both .map and TaskExecutionRow are present (rendering list of rows)
    expect(componentSource).toMatch(/\.map/)
    expect(componentSource).toMatch(/TaskExecutionRow/)
  })
})

// ============================================================
// Test 7: ImplementationView shows empty state
// ============================================================

describe("ImplementationView shows empty state", () => {
  test("ImplementationView has empty state message", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/No implementation run|empty|no runs/i)
  })
})

// ============================================================
// Test 8: ImplementationView has proper layout
// ============================================================

describe("ImplementationView has proper layout", () => {
  test("ImplementationView has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*implementation-view/)
  })
})

// ============================================================
// Test 9: ImplementationView exports
// ============================================================

describe("ImplementationView exports", () => {
  test("ImplementationView exports ImplementationView component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*ImplementationView/)
  })

  test("ImplementationView exports ImplementationViewProps type", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*ImplementationViewProps/)
  })
})
