/**
 * Tests for TestingView Component
 * Task: task-2-3d-testing-view
 *
 * TDD tests for the testing phase view displaying TestSpecification entities.
 *
 * Test Specifications from task acceptance criteria:
 * - TestingView.tsx created in stepper/phases/testing/ directory
 * - Component wrapped with observer() for MST reactivity
 * - Receives feature prop from PhaseContentPanel
 * - Queries tasks and test specifications via useDomains()
 * - Renders TestSpecCard components grouped by parent task
 * - Shows task name as section header with count
 * - Shows coverage summary at top
 * - Shows empty state when no specs exist
 * - Exports TestingView and TestingViewProps
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: TestingView component file exists
// ============================================================

describe("TestingView component file exists", () => {
  test("TestingView.tsx file exists in stepper/phases/testing/", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })
})

// ============================================================
// Test 2: TestingView is wrapped with observer()
// ============================================================

describe("TestingView is wrapped with observer()", () => {
  test("TestingView imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("TestingView exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(function TestingView/)
  })
})

// ============================================================
// Test 3: TestingView receives feature prop
// ============================================================

describe("TestingView receives feature prop", () => {
  test("TestingView has feature prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature/)
  })

  test("TestingViewProps defines feature property", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/TestingViewProps/)
  })
})

// ============================================================
// Test 4: TestingView queries collections
// ============================================================

describe("TestingView queries collections", () => {
  test("TestingView imports useDomains", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/useDomains/)
  })

  test("TestingView queries implementationTaskCollection", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/implementationTaskCollection/)
  })

  test("TestingView queries testSpecificationCollection", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/testSpecificationCollection/)
  })
})

// ============================================================
// Test 5: TestingView renders TestSpecCard components
// ============================================================

describe("TestingView renders TestSpecCard components", () => {
  test("TestingView imports TestSpecCard", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/TestSpecCard/)
  })

  test("TestingView maps specs to TestSpecCards", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Check that both .map and TestSpecCard are present (rendering list of cards)
    expect(componentSource).toMatch(/\.map/)
    expect(componentSource).toMatch(/TestSpecCard/)
  })
})

// ============================================================
// Test 6: TestingView shows coverage summary
// ============================================================

describe("TestingView shows coverage summary", () => {
  test("TestingView shows spec count", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/test specification|spec.*task|coverage/i)
  })
})

// ============================================================
// Test 7: TestingView shows empty state
// ============================================================

describe("TestingView shows empty state", () => {
  test("TestingView has empty state message", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/No test specification|empty|no specs/i)
  })
})

// ============================================================
// Test 8: TestingView has proper layout
// ============================================================

describe("TestingView has proper layout", () => {
  test("TestingView has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*testing-view/)
  })
})

// ============================================================
// Test 9: TestingView exports
// ============================================================

describe("TestingView exports", () => {
  test("TestingView exports TestingView component", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*TestingView/)
  })

  test("TestingView exports TestingViewProps type", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*TestingViewProps/)
  })
})
