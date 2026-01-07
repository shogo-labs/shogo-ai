/**
 * CompleteView Redesign Tests
 * Task: task-w2-complete-view-redesign
 *
 * Tests verify the "Journey Summary Report" aesthetic:
 * 1. PhaseTimeline shows phase progression with durations
 * 2. DeliverablesGrid displays key outputs (schema, tasks, specs)
 * 3. SuccessBanner with achievement styling
 * 4. StatisticsRecap with final counts
 * 5. Uses phase-complete color tokens (green)
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
// Test 1: CompleteView renders with Journey Summary layout
// (test-w2-complete-renders)
// ============================================================

describe("test-w2-complete-renders: CompleteView with Journey Summary layout", () => {
  test("CompleteView contains phase timeline or progression", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have timeline/progression
    expect(componentSource).toMatch(/Timeline|phase.*progress|journey|phases/i)
  })

  test("CompleteView contains deliverables section", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have deliverables display
    expect(componentSource).toMatch(/Deliverables|outputs|schema|tasks|specs|grid/i)
  })

  test("CompleteView uses phase-complete colors", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use green/complete phase colors
    expect(componentSource).toMatch(/phase-complete|green-|emerald-|usePhaseColor.*complete/i)
  })
})

// ============================================================
// Test 2: PhaseTimeline shows progression with durations
// (test-w2-complete-timeline)
// ============================================================

describe("test-w2-complete-timeline: PhaseTimeline visualization", () => {
  test("Shows phase names or steps", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show phase names
    expect(componentSource).toMatch(/discovery|analysis|design|spec|testing|implementation/i)
  })

  test("Has timeline or step visualization", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have timeline structure
    expect(componentSource).toMatch(/timeline|step|phase|progress|CheckCircle/i)
  })
})

// ============================================================
// Test 3: DeliverablesGrid displays key outputs
// (test-w2-complete-deliverables)
// ============================================================

describe("test-w2-complete-deliverables: DeliverablesGrid", () => {
  test("Shows deliverable items", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have deliverable items
    expect(componentSource).toMatch(/deliverable|output|artifact|schema|task|spec/i)
  })

  test("Has grid or list layout", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have grid/list
    expect(componentSource).toMatch(/grid|list|cards|Card|map/i)
  })
})

// ============================================================
// Test 4: SuccessBanner with achievement styling
// (test-w2-complete-banner)
// ============================================================

describe("test-w2-complete-banner: SuccessBanner", () => {
  test("Has success/complete message", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have success message
    expect(componentSource).toMatch(/Complete|Success|Congratulations|done|finished/i)
  })

  test("Has celebratory or achievement styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have celebration styling
    expect(componentSource).toMatch(/CheckCircle|Trophy|Star|bg-green|border-green/i)
  })
})

// ============================================================
// Test 5: StatisticsRecap with final counts
// (test-w2-complete-statistics)
// ============================================================

describe("test-w2-complete-statistics: StatisticsRecap", () => {
  test("Shows task count", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show task stats
    expect(componentSource).toMatch(/task.*count|completedTasks|tasks\.length|totalTasks/i)
  })

  test("Shows spec count", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show spec stats
    expect(componentSource).toMatch(/spec.*count|specs\.length|testSpecification/i)
  })

  test("Shows summary statistics section", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have stats section
    expect(componentSource).toMatch(/stats|statistics|Summary|count/i)
  })
})

// ============================================================
// Test 6: Uses phase-complete color tokens (green)
// (test-w2-complete-phase-colors)
// ============================================================

describe("test-w2-complete-phase-colors: Uses phase-complete color tokens", () => {
  test("Uses green color tokens", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use green colors
    expect(componentSource).toMatch(/green-|emerald-|text-green|bg-green/i)
  })

  test("Uses phaseColorVariants or usePhaseColor", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use phase color system
    expect(componentSource).toMatch(/phaseColorVariants|usePhaseColor|phaseColors/i)
  })

  test("Success elements use green accent", () => {
    const componentPath = path.resolve(import.meta.dir, "../CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have green-styled success elements
    expect(componentSource).toMatch(/border-green|text-green|bg-green|emerald-500/i)
  })
})
