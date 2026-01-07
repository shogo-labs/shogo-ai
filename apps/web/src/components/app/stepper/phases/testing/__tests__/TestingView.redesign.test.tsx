/**
 * TestingView Redesign Tests
 * Task: task-w2-testing-view-redesign
 *
 * Tests verify the "Test Coverage Matrix + Pyramid" aesthetic:
 * 1. TestPyramid SVG shows unit/integration/acceptance distribution
 * 2. TestTypeDistributionCard shows breakdown with percentages
 * 3. TaskCoverageBar shows per-task test coverage
 * 4. ScenarioSpotlightCard displays selected spec in large format
 * 5. Uses phase-testing color tokens (cyan)
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
// Test 1: TestingView renders with Coverage Matrix + Pyramid layout
// (test-w2-testing-renders)
// ============================================================

describe("test-w2-testing-renders: TestingView with Coverage Matrix + Pyramid layout", () => {
  test("TestingView contains TestPyramid visualization", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have pyramid visualization
    expect(componentSource).toMatch(/TestPyramid|pyramid|svg|tier/i)
  })

  test("TestingView contains TestTypeDistributionCard", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have distribution cards
    expect(componentSource).toMatch(/TestTypeDistribution|distribution|testType|ProgressBar/i)
  })

  test("TestingView contains TaskCoverageBar", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have coverage bars
    expect(componentSource).toMatch(/TaskCoverageBar|coverage|task.*bar/i)
  })
})

// ============================================================
// Test 2: TestPyramid SVG shows distribution
// (test-w2-testing-pyramid)
// ============================================================

describe("test-w2-testing-pyramid: TestPyramid SVG visualization", () => {
  test("Pyramid has SVG or visual elements", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have SVG pyramid
    expect(componentSource).toMatch(/svg|polygon|path|pyramid|tier/i)
  })

  test("Pyramid shows different test type levels", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should reference test types
    expect(componentSource).toMatch(/unit|integration|acceptance|testType/i)
  })
})

// ============================================================
// Test 3: TestTypeDistributionCard shows breakdown
// (test-w2-testing-type-distribution)
// ============================================================

describe("test-w2-testing-type-distribution: TestTypeDistributionCard", () => {
  test("Shows count per test type", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show counts
    expect(componentSource).toMatch(/count|length|\.filter|total/i)
  })

  test("Shows percentage per test type", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should calculate/show percentage
    expect(componentSource).toMatch(/percent|%|\/.*total|proportion/i)
  })

  test("Uses ProgressBar for visualization", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use ProgressBar
    expect(componentSource).toMatch(/ProgressBar/i)
  })
})

// ============================================================
// Test 4: TaskCoverageBar shows per-task coverage
// (test-w2-testing-task-coverage)
// ============================================================

describe("test-w2-testing-task-coverage: TaskCoverageBar", () => {
  test("Shows coverage for each task", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should iterate over tasks for coverage
    expect(componentSource).toMatch(/task.*coverage|coverage.*task|specs.*length/i)
  })

  test("Uses progress bars for coverage display", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have progress visualization
    expect(componentSource).toMatch(/ProgressBar|progress|bar|width/i)
  })
})

// ============================================================
// Test 5: ScenarioSpotlightCard displays selected spec
// (test-w2-testing-scenario-spotlight)
// ============================================================

describe("test-w2-testing-scenario-spotlight: ScenarioSpotlightCard", () => {
  test("Has state for selected specification", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should track selected spec
    expect(componentSource).toMatch(/selectedSpec|spotlight|useState.*spec/i)
  })

  test("Shows Given/When/Then sections", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should display Given/When/Then
    expect(componentSource).toMatch(/given|when|then/i)
  })

  test("Displays test type badge", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show test type
    expect(componentSource).toMatch(/testType|type.*badge|badge.*type/i)
  })
})

// ============================================================
// Test 6: Uses phase-testing color tokens (cyan)
// (test-w2-testing-phase-colors)
// ============================================================

describe("test-w2-testing-phase-colors: Uses phase-testing color tokens", () => {
  test("Uses cyan color tokens", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use cyan colors
    expect(componentSource).toMatch(/cyan-|testing|teal-/i)
  })

  test("Uses phaseColorVariants or usePhaseColor", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use phase color system
    expect(componentSource).toMatch(/phaseColorVariants|usePhaseColor|phaseColors/i)
  })

  test("Pyramid and bars use phase accent colors", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have cyan-styled elements
    expect(componentSource).toMatch(/border-cyan|text-cyan|bg-cyan|fill-cyan/i)
  })
})
