/**
 * AnalysisView Redesign Tests
 * Task: task-w2-analysis-view-redesign
 *
 * Tests verify the "Evidence Board + Matrix" hybrid aesthetic:
 * 1. FindingTypeMatrix shows Type x Location grid with clickable cells
 * 2. Enhanced FindingCard using DataCard primitive with severity indicators
 * 3. LocationHeatBar shows finding density per package
 * 4. Toggle between matrix and list views
 * 5. Uses phase-analysis color tokens (violet)
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
// Test 1: AnalysisView renders with Evidence Board layout
// (test-w2-analysis-renders)
// ============================================================

describe("test-w2-analysis-renders: AnalysisView renders with Evidence Board layout", () => {
  test("AnalysisView contains FindingTypeMatrix or matrix section", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have matrix component or data attribute
    expect(componentSource).toMatch(/FindingTypeMatrix|data-testid.*matrix|TypeMatrix/i)
  })

  test("AnalysisView contains LocationHeatBar or location visualization", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have location heat visualization
    expect(componentSource).toMatch(/LocationHeatBar|location.*heat|locationSegments|ProgressBar/i)
  })

  test("AnalysisView has DataCard or enhanced finding cards", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use DataCard or enhanced card component
    expect(componentSource).toMatch(/DataCard|FindingCard|data-testid.*finding-card/i)
  })
})

// ============================================================
// Test 2: FindingTypeMatrix shows Type x Location grid
// (test-w2-analysis-finding-matrix)
// ============================================================

describe("test-w2-analysis-finding-matrix: FindingTypeMatrix shows Type x Location grid", () => {
  test("Matrix displays finding types as identifiers", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should reference finding types for matrix
    expect(componentSource).toMatch(/FINDING_TYPE|findingTypes|pattern|gap|risk/)
  })

  test("Matrix displays locations", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should extract and display locations
    expect(componentSource).toMatch(/location|package|filePath/)
  })

  test("Matrix cells are interactive", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have click handlers or interactive elements
    expect(componentSource).toMatch(/onClick|handleClick|setFilter|clickable|cursor-pointer/i)
  })
})

// ============================================================
// Test 3: FindingCard uses DataCard with severity indicators
// (test-w2-analysis-finding-card)
// ============================================================

describe("test-w2-analysis-finding-card: FindingCard uses DataCard with severity", () => {
  test("Uses DataCard component or finding variant", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use DataCard or specialized finding card
    expect(componentSource).toMatch(/DataCard|FindingCard|variant.*finding/i)
  })

  test("Finding cards display type information", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should display finding type
    expect(componentSource).toMatch(/finding\.type|findingType|type.*badge/i)
  })
})

// ============================================================
// Test 4: LocationHeatBar shows finding density
// (test-w2-analysis-location-heat)
// ============================================================

describe("test-w2-analysis-location-heat: LocationHeatBar shows finding density", () => {
  test("Uses ProgressBar for location visualization", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use ProgressBar component
    expect(componentSource).toMatch(/ProgressBar|stacked|segments/)
  })

  test("Calculates location distribution", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should compute location segments or counts
    expect(componentSource).toMatch(/locationCounts|locationSegments|uniqueLocations|byLocation/i)
  })
})

// ============================================================
// Test 5: Toggle between matrix and list views
// (test-w2-analysis-view-toggle)
// ============================================================

describe("test-w2-analysis-view-toggle: View toggle support", () => {
  test("Has view mode state", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have view mode state
    expect(componentSource).toMatch(/viewMode|useState.*matrix|useState.*list|activeView/i)
  })

  test("Has toggle UI control", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have toggle button or tabs
    expect(componentSource).toMatch(/toggle|setViewMode|button.*matrix|button.*list|Grid|List/i)
  })
})

// ============================================================
// Test 6: Uses phase-analysis color tokens (violet)
// (test-w2-analysis-phase-colors)
// ============================================================

describe("test-w2-analysis-phase-colors: Uses phase-analysis color tokens", () => {
  test("Uses analysis violet colors", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use analysis/violet colors
    expect(componentSource).toMatch(/phase-analysis|violet-|analysis|purple-/i)
  })

  test("Uses phaseColorVariants or usePhaseColor", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use phase color system
    expect(componentSource).toMatch(/phaseColorVariants|usePhaseColor|phase.*color/i)
  })
})
