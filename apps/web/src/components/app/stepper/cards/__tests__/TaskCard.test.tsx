/**
 * Tests for TaskCard Component
 * Task: task-2-3d-task-card
 *
 * TDD tests for the task card component that displays ImplementationTask entities
 * with status badges, acceptance criteria, and dependency indicators.
 *
 * Test Specifications from task acceptance criteria:
 * - TaskCard.tsx created in stepper/cards/ directory
 * - Component wrapped with observer() from mobx-react-lite for MST reactivity
 * - Displays task name, description, and status using taskStatusVariants CVA
 * - Renders acceptanceCriteria as expandable/collapsible list
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
// Test 4: TaskCard uses taskStatusVariants CVA
// ============================================================

describe("TaskCard uses taskStatusVariants CVA", () => {
  test("TaskCard imports cva from class-variance-authority", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cva.*from.*class-variance-authority/)
  })

  test("TaskCard defines taskStatusVariants with cva", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/taskStatusVariants.*=.*cva/)
  })

  test("pending status has gray styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/planned.*bg-gray/)
  })

  test("in_progress status has blue styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/in_progress.*bg-blue/)
  })

  test("complete status has green styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/complete.*bg-green/)
  })

  test("blocked status has red styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/blocked.*bg-red/)
  })
})

// ============================================================
// Test 5: TaskCard renders acceptanceCriteria
// ============================================================

describe("TaskCard renders acceptanceCriteria", () => {
  test("TaskCard has acceptanceCriteria section", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/acceptanceCriteria/)
  })

  test("acceptanceCriteria renders as list", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/acceptanceCriteria.*map/)
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

  test("TaskCard exports taskStatusVariants", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*taskStatusVariants/)
  })
})
