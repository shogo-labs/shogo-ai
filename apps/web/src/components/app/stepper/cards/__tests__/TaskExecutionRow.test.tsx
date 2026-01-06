/**
 * Tests for TaskExecutionRow Component
 * Task: task-2-3d-task-execution-row
 *
 * TDD tests for the task execution row showing TDD cycle status.
 *
 * Test Specifications from task acceptance criteria:
 * - TaskExecutionRow.tsx created in stepper/cards/ directory
 * - Component wrapped with observer() for MST reactivity
 * - Displays task name (resolved from task reference)
 * - Shows status icon/badge using executionStatusVariants CVA
 * - Displays duration (completedAt - startedAt) formatted when completed
 * - Shows testFilePath and implementationFilePath as truncated paths
 * - Displays retryCount badge when > 0
 * - Shows errorMessage in expandable section when status='failed'
 * - Uses consistent row styling (border-b, py-3, hover:bg-muted/50)
 * - Exports TaskExecutionRow and TaskExecutionRowProps
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: TaskExecutionRow component file exists
// ============================================================

describe("TaskExecutionRow component file exists", () => {
  test("TaskExecutionRow.tsx file exists in stepper/cards/", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })
})

// ============================================================
// Test 2: TaskExecutionRow is wrapped with observer()
// ============================================================

describe("TaskExecutionRow is wrapped with observer()", () => {
  test("TaskExecutionRow imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("TaskExecutionRow exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(function TaskExecutionRow/)
  })
})

// ============================================================
// Test 3: TaskExecutionRow displays task name
// ============================================================

describe("TaskExecutionRow displays task name", () => {
  test("TaskExecutionRow displays task name", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/taskName/)
  })
})

// ============================================================
// Test 4: TaskExecutionRow uses executionStatusVariants CVA
// ============================================================

describe("TaskExecutionRow uses executionStatusVariants CVA", () => {
  test("TaskExecutionRow imports cva from class-variance-authority", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cva.*from.*class-variance-authority/)
  })

  test("TaskExecutionRow defines executionStatusVariants with cva", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/executionStatusVariants.*=.*cva/)
  })

  test("pending status has gray styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/pending.*gray/)
  })

  test("test_written status has amber styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/test_written.*amber/)
  })

  test("test_failing status has orange styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/test_failing.*orange/)
  })

  test("implementing status has blue styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/implementing.*blue/)
  })

  test("test_passing status has green styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/test_passing.*green/)
  })

  test("failed status has red styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/failed.*red/)
  })
})

// ============================================================
// Test 5: TaskExecutionRow shows duration
// ============================================================

describe("TaskExecutionRow shows duration", () => {
  test("TaskExecutionRow uses startedAt and completedAt", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/startedAt/)
    expect(componentSource).toMatch(/completedAt/)
  })
})

// ============================================================
// Test 6: TaskExecutionRow shows file paths
// ============================================================

describe("TaskExecutionRow shows file paths", () => {
  test("TaskExecutionRow has testFilePath", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/testFilePath/)
  })

  test("TaskExecutionRow has implementationFilePath", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/implementationFilePath/)
  })
})

// ============================================================
// Test 7: TaskExecutionRow shows retryCount
// ============================================================

describe("TaskExecutionRow shows retryCount", () => {
  test("TaskExecutionRow handles retryCount", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/retryCount/)
  })
})

// ============================================================
// Test 8: TaskExecutionRow shows errorMessage
// ============================================================

describe("TaskExecutionRow shows errorMessage", () => {
  test("TaskExecutionRow handles errorMessage", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/errorMessage/)
  })
})

// ============================================================
// Test 9: TaskExecutionRow has row styling
// ============================================================

describe("TaskExecutionRow has row styling", () => {
  test("TaskExecutionRow has border-b styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/border-b/)
  })

  test("TaskExecutionRow has hover effect", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/hover:bg-muted/)
  })
})

// ============================================================
// Test 10: TaskExecutionRow exports
// ============================================================

describe("TaskExecutionRow exports", () => {
  test("TaskExecutionRow exports TaskExecutionRow component", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*TaskExecutionRow/)
  })

  test("TaskExecutionRow exports TaskExecutionRowProps type", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*TaskExecutionRowProps/)
  })

  test("TaskExecutionRow exports executionStatusVariants", () => {
    const componentPath = path.resolve(import.meta.dir, "../TaskExecutionRow.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*executionStatusVariants/)
  })
})
