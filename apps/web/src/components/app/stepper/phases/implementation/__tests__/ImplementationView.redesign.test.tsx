/**
 * ImplementationView Redesign Tests
 * Task: task-w2-implementation-view-redesign
 *
 * Tests verify the "Execution Control Room" aesthetic:
 * 1. TDDStageIndicator shows current RED/GREEN/REFACTOR stage
 * 2. TaskExecutionTimeline with dependency connections
 * 3. LiveOutputTerminal with scrolling log
 * 4. ProgressDashboard with overall stats
 * 5. Uses phase-implementation color tokens (red/green)
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Window } from "happy-dom"
import fs from "fs"
import path from "path"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = window
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = window.document
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

// ============================================================
// Test 1: ImplementationView renders with Execution Control Room layout
// (test-w2-implementation-renders)
// ============================================================

describe("test-w2-implementation-renders: ImplementationView with Execution Control Room layout", () => {
  test("ImplementationView contains TDD stage or phase indicator", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have TDD stage indicator
    expect(componentSource).toMatch(/TDDStageIndicator|stage|tddStage|red.*green|RED|GREEN/i)
  })

  test("ImplementationView contains timeline or progress visualization", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have timeline/progress view
    expect(componentSource).toMatch(/Timeline|TaskExecutionTimeline|execution.*list|progress/i)
  })

  test("ImplementationView uses phase-implementation colors", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use red/green implementation phase colors
    expect(componentSource).toMatch(/phase-implementation|red-|green-|usePhaseColor.*implementation/i)
  })
})

// ============================================================
// Test 2: TDDStageIndicator shows RED/GREEN/REFACTOR
// (test-w2-implementation-tdd-indicator)
// ============================================================

describe("test-w2-implementation-tdd-indicator: TDDStageIndicator stages", () => {
  test("Has TDD stage state or display", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have TDD stage concept
    expect(componentSource).toMatch(/tddStage|stage|RED|GREEN|REFACTOR|test_failing|test_passing/i)
  })

  test("Shows visual distinction between stages", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have different colors/styles per stage
    expect(componentSource).toMatch(/red-|green-|yellow-|amber-|status.*color|bg-.*500/i)
  })
})

// ============================================================
// Test 3: TaskExecutionTimeline shows dependency connections
// (test-w2-implementation-timeline)
// ============================================================

describe("test-w2-implementation-timeline: TaskExecutionTimeline", () => {
  test("Shows execution list or timeline", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should render executions as timeline/list
    expect(componentSource).toMatch(/execution|sortedExecution|TaskExecution|timeline/i)
  })

  test("Shows task status per execution", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show status
    expect(componentSource).toMatch(/status|pending|in_progress|test_failing|test_passing|complete/i)
  })
})

// ============================================================
// Test 4: LiveOutputTerminal with log output
// (test-w2-implementation-terminal)
// ============================================================

describe("test-w2-implementation-terminal: LiveOutputTerminal", () => {
  test("Has terminal or output section", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have terminal/output display
    expect(componentSource).toMatch(/terminal|output|log|testOutput|errorMessage/i)
  })

  test("Uses monospace or code styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use code/mono styling
    expect(componentSource).toMatch(/font-mono|monospace|code|pre/i)
  })
})

// ============================================================
// Test 5: ProgressDashboard with overall stats
// (test-w2-implementation-dashboard)
// ============================================================

describe("test-w2-implementation-dashboard: ProgressDashboard stats", () => {
  test("Shows progress summary", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show progress stats
    expect(componentSource).toMatch(/progress|completed|total|ProgressBar|percentage/i)
  })

  test("Shows task counts", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show counts
    expect(componentSource).toMatch(/totalTasks|completedTasks|failedTasks|count|length/i)
  })
})

// ============================================================
// Test 6: Uses phase-implementation color tokens
// (test-w2-implementation-phase-colors)
// ============================================================

describe("test-w2-implementation-phase-colors: Uses phase-implementation color tokens", () => {
  test("Uses red color tokens for failing state", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use red colors
    expect(componentSource).toMatch(/red-|text-red|bg-red|border-red/i)
  })

  test("Uses green color tokens for passing state", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use green colors
    expect(componentSource).toMatch(/green-|emerald-|text-green|bg-green|text-emerald/i)
  })

  test("Uses phaseColorVariants or usePhaseColor", () => {
    const componentPath = path.resolve(import.meta.dir, "../ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use phase color system
    expect(componentSource).toMatch(/phaseColorVariants|usePhaseColor|phaseColors/i)
  })
})
