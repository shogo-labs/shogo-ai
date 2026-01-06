/**
 * Tests for ExecutionProgress Component
 * Task: task-2-3d-execution-progress
 *
 * TDD tests for the execution progress component showing implementation run status.
 *
 * Test Specifications from task acceptance criteria:
 * - ExecutionProgress.tsx created in stepper/cards/ directory
 * - Component wrapped with observer() for MST reactivity
 * - Displays run status indicator using runStatusVariants CVA
 * - Shows progress bar with percentage (completedTasks.length / total * 100)
 * - Displays elapsed time since startedAt
 * - Shows current task name when currentTaskId is set
 * - Handles undefined/null ImplementationRun gracefully
 * - Exports ExecutionProgress and ExecutionProgressProps
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: ExecutionProgress component file exists
// ============================================================

describe("ExecutionProgress component file exists", () => {
  test("ExecutionProgress.tsx file exists in stepper/cards/", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })
})

// ============================================================
// Test 2: ExecutionProgress is wrapped with observer()
// ============================================================

describe("ExecutionProgress is wrapped with observer()", () => {
  test("ExecutionProgress imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("ExecutionProgress exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(function ExecutionProgress/)
  })
})

// ============================================================
// Test 3: ExecutionProgress uses runStatusVariants CVA
// ============================================================

describe("ExecutionProgress uses runStatusVariants CVA", () => {
  test("ExecutionProgress imports cva from class-variance-authority", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cva.*from.*class-variance-authority/)
  })

  test("ExecutionProgress defines runStatusVariants with cva", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/runStatusVariants.*=.*cva/)
  })

  test("in_progress status has blue styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/in_progress.*blue|blue.*in_progress/)
  })

  test("complete status has green styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/complete.*green|green.*complete/)
  })

  test("failed status has red styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/failed.*red|red.*failed/)
  })
})

// ============================================================
// Test 4: ExecutionProgress shows progress bar
// ============================================================

describe("ExecutionProgress shows progress bar", () => {
  test("ExecutionProgress calculates progress percentage", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/completedTasks/)
    expect(componentSource).toMatch(/totalTasks|total/)
  })

  test("ExecutionProgress displays progress visually", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have progress bar styling or component
    expect(componentSource).toMatch(/progress|Progress|%/)
  })
})

// ============================================================
// Test 5: ExecutionProgress shows elapsed time
// ============================================================

describe("ExecutionProgress shows elapsed time", () => {
  test("ExecutionProgress uses startedAt", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/startedAt/)
  })

  test("ExecutionProgress formats time", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have time formatting
    expect(componentSource).toMatch(/formatTime|formatDuration|elapsed|duration/)
  })
})

// ============================================================
// Test 6: ExecutionProgress shows current task
// ============================================================

describe("ExecutionProgress shows current task", () => {
  test("ExecutionProgress handles currentTaskId", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/currentTask/)
  })
})

// ============================================================
// Test 7: ExecutionProgress handles null run
// ============================================================

describe("ExecutionProgress handles null run", () => {
  test("ExecutionProgress checks for run existence", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/!run|run\s*===\s*null|run\s*===\s*undefined|return null/)
  })
})

// ============================================================
// Test 8: ExecutionProgress exports
// ============================================================

describe("ExecutionProgress exports", () => {
  test("ExecutionProgress exports ExecutionProgress component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*ExecutionProgress/)
  })

  test("ExecutionProgress exports ExecutionProgressProps type", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*ExecutionProgressProps/)
  })

  test("ExecutionProgress exports runStatusVariants", () => {
    const componentPath = path.resolve(import.meta.dir, "../ExecutionProgress.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*runStatusVariants/)
  })
})
