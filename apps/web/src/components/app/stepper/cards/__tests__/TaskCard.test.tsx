/**
 * Tests for TaskCard Component
 * Task: task-2-3d-task-card
 * Updated: task-cbe-009 (PropertyRenderer audit)
 *
 * TDD tests for the task card component that displays ImplementationTask entities
 * with status badges, acceptance criteria, and dependency indicators.
 *
 * Test Specifications from task acceptance criteria:
 * - TaskCard.tsx created in stepper/cards/ directory
 * - Component wrapped with observer() from mobx-react-lite for MST reactivity
 * - Displays task name, description, and status using PropertyRenderer with task-status-badge xRenderer
 * - Renders acceptanceCriteria via PropertyRenderer with string-array xRenderer
 * - Includes DependencyIndicator showing task dependencies
 * - Uses shadcn Card with hover effects
 * - Exports TaskCard and TaskCardProps
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: TaskCard component file exists
// ============================================================

describe("TaskCard component file exists", () => {
  test("TaskCard.tsx file exists in stepper/cards/", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })
})

// ============================================================
// Test 2: TaskCard is wrapped with observer()
// ============================================================

describe("TaskCard is wrapped with observer()", () => {
  test("TaskCard imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("TaskCard exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(function TaskCard/)
  })
})

// ============================================================
// Test 3: TaskCard displays task name, description, and status
// ============================================================

describe("TaskCard displays task properties", () => {
  test("TaskCard accepts task prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/task/)
  })

  test("TaskCard displays task name", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/task\.name/)
  })

  test("TaskCard displays task description", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/task\.description/)
  })

  test("TaskCard displays status badge", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/task\.status/)
  })
})

// ============================================================
// Test 4: TaskCard uses PropertyRenderer for status badge
// ============================================================

describe("TaskCard uses PropertyRenderer for status", () => {
  test("TaskCard imports PropertyRenderer from rendering", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*PropertyRenderer.*from.*@\/components\/rendering/)
  })

  test("TaskCard defines statusPropertyMeta with xRenderer task-status-badge", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/statusPropertyMeta.*PropertyMetadata/)
    expect(componentSource).toMatch(/xRenderer.*task-status-badge/)
  })

  test("TaskCard uses PropertyRenderer for status", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{task\.status\}/)
  })

  test("statusPropertyMeta includes all valid task statuses", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Check that enum includes all 4 task statuses
    expect(componentSource).toMatch(/enum:.*planned/)
    expect(componentSource).toMatch(/enum:.*in_progress/)
    expect(componentSource).toMatch(/enum:.*complete/)
    expect(componentSource).toMatch(/enum:.*blocked/)
  })
})

// ============================================================
// Test 5: TaskCard renders acceptanceCriteria via PropertyRenderer
// ============================================================

describe("TaskCard renders acceptanceCriteria via PropertyRenderer", () => {
  test("TaskCard has acceptanceCriteria section", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/acceptanceCriteria/)
  })

  test("TaskCard defines acceptanceCriteriaPropertyMeta with xRenderer string-array", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/acceptanceCriteriaPropertyMeta.*PropertyMetadata/)
    expect(componentSource).toMatch(/xRenderer.*string-array/)
  })

  test("acceptanceCriteria uses PropertyRenderer", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{task\.acceptanceCriteria\}/)
  })

  test("acceptanceCriteria PropertyRenderer has config for collapsible behavior", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Check that config is passed with customProps for collapsible behavior
    expect(componentSource).toMatch(/config=\{[\s\S]*?collapsible/)
  })
})

// ============================================================
// Test 6: TaskCard includes DependencyIndicator
// ============================================================

describe("TaskCard includes DependencyIndicator", () => {
  test("TaskCard imports DependencyIndicator", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/DependencyIndicator/)
  })
})

// ============================================================
// Test 7: TaskCard uses shadcn Card with hover effects
// ============================================================

describe("TaskCard uses shadcn Card with hover effects", () => {
  test("TaskCard imports Card from ui", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*Card.*from.*@\/components\/ui\/card/)
  })

  test("TaskCard has hover effects", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/hover:shadow-md|hover:border-primary/)
  })
})

// ============================================================
// Test 8: TaskCard has data-testid
// ============================================================

describe("TaskCard has data-testid", () => {
  test("TaskCard has data-testid attribute", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*task-card/)
  })
})

// ============================================================
// Test 9: TaskCard exports TaskCard and TaskCardProps
// ============================================================

describe("TaskCard exports", () => {
  test("TaskCard exports TaskCard component", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*TaskCard/)
  })

  test("TaskCard exports TaskCardProps type", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*TaskCardProps/)
  })

  test("TaskCard exports TaskStatus type", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Verify TaskStatus type is exported (replaces taskStatusVariants export)
    expect(componentSource).toMatch(/export.*type.*TaskStatus/)
  })
})
