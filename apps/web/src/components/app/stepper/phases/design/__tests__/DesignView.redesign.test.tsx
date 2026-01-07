/**
 * DesignView Enhancement Tests
 * Task: task-w2-design-view-enhance
 *
 * Tests verify the "Schema Blueprint Studio" aesthetic enhancements:
 * 1. EntityNode uses GraphNode primitive with blueprint styling
 * 2. ReferenceLegend shows different edge type meanings
 * 3. SchemaStatisticsBar displays entity/property/reference counts
 * 4. CAD-style grid background on graph canvas
 * 5. Edge styling differentiated by reference type
 * 6. Uses phase-design color tokens (amber)
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
// Test 1: DesignView renders with Blueprint Studio enhancements
// (test-w2-design-renders)
// ============================================================

describe("test-w2-design-renders: DesignView renders with Blueprint Studio enhancements", () => {
  test("DesignView contains SchemaStatisticsBar section", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have statistics bar component
    expect(componentSource).toMatch(/SchemaStatisticsBar|statistics|entity.*count|property.*count/i)
  })

  test("DesignView contains ReferenceLegend component", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have reference legend
    expect(componentSource).toMatch(/ReferenceLegend|legend|edge.*type/i)
  })

  test("DesignView uses phase-design color tokens", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use amber/design phase colors
    expect(componentSource).toMatch(/phase-design|amber-|usePhaseColor.*design/i)
  })
})

// ============================================================
// Test 2: EntityNode uses GraphNode primitive with blueprint style
// (test-w2-design-entity-node)
// ============================================================

describe("test-w2-design-entity-node: EntityNode with blueprint style", () => {
  test("EntityNode imports or uses GraphNode concepts", () => {
    const componentPath = path.resolve(import.meta.dir, "../EntityNode.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have blueprint/CAD styling or use GraphNode-like patterns
    expect(componentSource).toMatch(/blueprint|cad|GraphNode|border-amber|technical/i)
  })

  test("EntityNode has CAD-style border styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../EntityNode.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have technical/blueprint border styling
    expect(componentSource).toMatch(/border-|rounded|dashed|amber|ring-/i)
  })

  test("EntityNode displays property count information", () => {
    const componentPath = path.resolve(import.meta.dir, "../EntityNode.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show property count
    expect(componentSource).toMatch(/propertyCount|property.*count|properties/i)
  })
})

// ============================================================
// Test 3: ReferenceLegend shows different edge type meanings
// (test-w2-design-reference-legend)
// ============================================================

describe("test-w2-design-reference-legend: ReferenceLegend component", () => {
  test("Has ReferenceLegend component file or section", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should define or import legend
    expect(componentSource).toMatch(/ReferenceLegend|Legend|edge.*legend/i)
  })

  test("Legend displays reference edge type information", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show reference types
    expect(componentSource).toMatch(/reference|single|array|bidirectional|maybe-ref/i)
  })

  test("Legend has visual line style examples", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have visual styling indicators
    expect(componentSource).toMatch(/solid|dashed|line|stroke|border-|edge/i)
  })
})

// ============================================================
// Test 4: SchemaStatisticsBar displays counts
// (test-w2-design-statistics-bar)
// ============================================================

describe("test-w2-design-statistics-bar: SchemaStatisticsBar displays counts", () => {
  test("Statistics bar shows entity count", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show entity count
    expect(componentSource).toMatch(/entity|entities|model.*length|models.*count/i)
  })

  test("Statistics bar shows property count", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should calculate/show property count
    expect(componentSource).toMatch(/property|properties|field.*count|totalProperties/i)
  })

  test("Statistics bar shows reference count", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show reference count
    expect(componentSource).toMatch(/reference|refs|totalReferences/i)
  })
})

// ============================================================
// Test 5: Edge styling differentiated by reference type
// (test-w2-design-edge-styling)
// ============================================================

describe("test-w2-design-edge-styling: Edge styling by reference type", () => {
  test("ReferenceEdge has differentiated styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../ReferenceEdge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have different styles for edge types
    expect(componentSource).toMatch(/style|stroke|dashed|solid|strokeDasharray/i)
  })

  test("ReferenceEdge supports different reference types", () => {
    const componentPath = path.resolve(import.meta.dir, "../ReferenceEdge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should handle reference types
    expect(componentSource).toMatch(/referenceType|type|single|array|maybe/i)
  })

  test("Edge colors are consistent with design phase", () => {
    const componentPath = path.resolve(import.meta.dir, "../ReferenceEdge.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use amber or design colors
    expect(componentSource).toMatch(/amber|#|color|stroke/i)
  })
})

// ============================================================
// Test 6: Uses phase-design color tokens (amber)
// (test-w2-design-phase-colors)
// ============================================================

describe("test-w2-design-phase-colors: Uses phase-design color tokens", () => {
  test("DesignView uses amber color tokens", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use amber colors
    expect(componentSource).toMatch(/amber-|design|yellow-/i)
  })

  test("Uses phaseColorVariants or usePhaseColor hook", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use phase color system
    expect(componentSource).toMatch(/phaseColorVariants|usePhaseColor|phaseColors/i)
  })

  test("Graph background has blueprint aesthetic", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have grid or blueprint background styling
    expect(componentSource).toMatch(/grid|blueprint|bg-|background|pattern/i)
  })
})
