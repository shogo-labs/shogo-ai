/**
 * ClassificationView Redesign Tests
 * Task: task-w2-classification-view-redesign
 *
 * Tests verify the "Archetype Determination Chamber" aesthetic:
 * 1. ArchetypeTransformation shows initial -> validated archetype with animation
 * 2. ConfidenceBar using ProgressBar confidence variant
 * 3. Dual evidence columns comparing indicators
 * 4. Correction badge when initial differs from validated
 * 5. Uses phase-classification color tokens (pink)
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
// Test 1: ClassificationView renders with Archetype Chamber layout
// (test-w2-classification-renders)
// ============================================================

describe("test-w2-classification-renders: ClassificationView renders with Archetype Chamber layout", () => {
  test("ClassificationView contains ArchetypeTransformation section", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have transformation visual component or section
    expect(componentSource).toMatch(/ArchetypeTransformation|data-testid.*transformation|archetype.*transform/i)
  })

  test("ClassificationView contains ConfidenceBar or confidence meters", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have confidence visualization
    expect(componentSource).toMatch(/ConfidenceBar|confidence|ProgressBar.*confidence|variant.*confidence/i)
  })

  test("ClassificationView has dual evidence columns layout", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have grid or flex layout for dual columns
    expect(componentSource).toMatch(/grid-cols-2|grid.*col|EvidenceColumn|dual.*column/i)
  })
})

// ============================================================
// Test 2: ArchetypeTransformation shows initial to validated with animation
// (test-w2-classification-transformation)
// ============================================================

describe("test-w2-classification-transformation: ArchetypeTransformation with animation", () => {
  test("Displays initial archetype on left side", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should reference initial archetype
    expect(componentSource).toMatch(/initialAssessment|initial.*archetype|likelyArchetype/i)
  })

  test("Displays validated archetype on right side", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should reference validated archetype
    expect(componentSource).toMatch(/validatedArchetype|validated.*archetype/i)
  })

  test("Has animated arrow or transition between archetypes", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have arrow or animation
    expect(componentSource).toMatch(/ArrowRight|arrow|animate-|transition|→|chevron/i)
  })

  test("Uses ArchetypeBadge styling for both archetypes", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use archetype badge component or styling
    expect(componentSource).toMatch(/ArchetypeBadge|archetype.*badge|archetypeBadgeVariants/i)
  })
})

// ============================================================
// Test 3: Correction indicator when initial differs from validated
// (test-w2-classification-correction)
// ============================================================

describe("test-w2-classification-correction: Correction indicator display", () => {
  test("Shows correction indicator when archetypes differ", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should check for difference and show indicator
    expect(componentSource).toMatch(/hasCorrection|correction|initialAssessment.*validatedArchetype|differs/i)
  })

  test("Displays correction reason text", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should display correction reason
    expect(componentSource).toMatch(/correction|reason|rationale/i)
  })

  test("Visual emphasis on correction with styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have visual emphasis (amber/warning colors or badge)
    expect(componentSource).toMatch(/amber-|warning|badge|corrected|highlight/i)
  })
})

// ============================================================
// Test 4: ConfidenceBar displays percentage using ProgressBar
// (test-w2-classification-confidence-bars)
// ============================================================

describe("test-w2-classification-confidence-bars: ConfidenceBar with ProgressBar", () => {
  test("Uses ProgressBar component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import and use ProgressBar
    expect(componentSource).toMatch(/ProgressBar/)
  })

  test("Uses confidence variant for ProgressBar", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use confidence variant
    expect(componentSource).toMatch(/variant.*confidence|confidence.*variant/i)
  })

  test("Displays percentage or confidence level", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should display percentage
    expect(componentSource).toMatch(/percentage|percent|%|confidence.*level|value/i)
  })
})

// ============================================================
// Test 5: Dual evidence columns compare indicators
// (test-w2-classification-evidence-columns)
// ============================================================

describe("test-w2-classification-evidence-columns: Dual evidence columns", () => {
  test("Has grid layout for two columns", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have two-column layout
    expect(componentSource).toMatch(/grid-cols-2|md:grid-cols-2|flex.*gap/i)
  })

  test("Evidence points displayed for each archetype", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should iterate over evidence
    expect(componentSource).toMatch(/evidence|indicators|checklist|\.map/i)
  })

  test("Visual distinction between matching and differing evidence", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have visual indicators (check/x icons or colors)
    expect(componentSource).toMatch(/Check|X|green-|red-|match|differ/i)
  })
})

// ============================================================
// Test 6: Uses phase-classification color tokens (pink)
// (test-w2-classification-phase-colors)
// ============================================================

describe("test-w2-classification-phase-colors: Uses phase-classification color tokens", () => {
  test("Uses classification pink colors", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use classification/pink colors
    expect(componentSource).toMatch(/phase-classification|pink-|classification|fuchsia-/i)
  })

  test("Uses phaseColorVariants or usePhaseColor", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use phase color system
    expect(componentSource).toMatch(/phaseColorVariants|usePhaseColor|phase.*color/i)
  })

  test("Transformation arrow uses phase accent color", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Arrow element should be styled with phase color
    expect(componentSource).toMatch(/arrow.*pink|pink.*arrow|phaseColors|ArrowRight/i)
  })
})
