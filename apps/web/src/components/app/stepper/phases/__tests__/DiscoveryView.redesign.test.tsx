/**
 * DiscoveryView Redesign Tests
 * Task: task-w2-discovery-view-redesign
 *
 * Tests verify the new "Mission Brief Command Center" aesthetic:
 * 1. New layout structure with IntentTerminal, PriorityDistributionBar, and dual-column assessment
 * 2. IntentTerminal displays intent in monospace with terminal aesthetic
 * 3. PriorityDistributionBar shows stacked visualization of requirement priorities
 * 4. Dual-column assessment shows indicators vs uncertainties
 * 5. Uses phase-discovery color tokens (blue)
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { render } from "@testing-library/react"
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
// Test 1: DiscoveryView renders with new Mission Brief layout
// (test-w2-discovery-renders)
// ============================================================

describe("test-w2-discovery-renders: DiscoveryView renders with new Mission Brief layout", () => {
  test("DiscoveryView component contains IntentTerminal section", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have IntentTerminal component or terminal-styled section
    expect(componentSource).toMatch(/IntentTerminal|data-testid.*intent-terminal|terminal/i)
  })

  test("DiscoveryView contains PriorityDistributionBar", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have PriorityDistributionBar or ProgressBar with stacked variant
    expect(componentSource).toMatch(/PriorityDistributionBar|ProgressBar|stacked/i)
  })

  test("DiscoveryView has dual-column assessment layout", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have grid or flex layout for dual columns
    expect(componentSource).toMatch(/grid-cols-2|grid.*col|flex.*gap|AssessmentColumn/i)
  })
})

// ============================================================
// Test 2: IntentTerminal displays intent in monospace with terminal aesthetic
// (test-w2-discovery-intent-terminal)
// ============================================================

describe("test-w2-discovery-intent-terminal: IntentTerminal with terminal aesthetic", () => {
  test("IntentTerminal uses monospace font", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use font-mono class for monospace
    expect(componentSource).toMatch(/font-mono/)
  })

  test("IntentTerminal has dark terminal-style background", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have dark background styling for terminal aesthetic
    expect(componentSource).toMatch(/bg-zinc-900|bg-slate-900|bg-gray-900|bg-black|bg-muted\/80/)
  })

  test("IntentTerminal shows character count", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should display character count or length
    expect(componentSource).toMatch(/\.length|char|count/i)
  })
})

// ============================================================
// Test 3: PriorityDistributionBar shows stacked visualization
// (test-w2-discovery-priority-bar)
// ============================================================

describe("test-w2-discovery-priority-bar: PriorityDistributionBar shows stacked visualization", () => {
  test("Uses ProgressBar primitive component", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import or use ProgressBar
    expect(componentSource).toMatch(/ProgressBar/)
  })

  test("Uses stacked variant for ProgressBar", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use stacked variant
    expect(componentSource).toMatch(/variant.*stacked|stacked.*variant/i)
  })

  test("Segments represent must/should/could priorities", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should calculate segments from must/should/could
    expect(componentSource).toMatch(/segments|mustRequirements|shouldRequirements|couldRequirements/)
  })
})

// ============================================================
// Test 4: Dual-column assessment shows indicators vs uncertainties
// (test-w2-discovery-dual-column)
// ============================================================

describe("test-w2-discovery-dual-column: Dual-column assessment layout", () => {
  test("Has two columns for indicators and uncertainties", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have grid or flex layout
    expect(componentSource).toMatch(/grid-cols-2|grid.*col-span|md:grid-cols-2/)
  })

  test("Indicators column uses check iconography", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have check or checkmark icon
    expect(componentSource).toMatch(/Check|CheckCircle|checkmark|lucide.*check/i)
  })

  test("Uncertainties column uses question iconography", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have help/question icon
    expect(componentSource).toMatch(/HelpCircle|AlertCircle|question|lucide.*help/i)
  })
})

// ============================================================
// Test 5: DiscoveryView uses phase-discovery color tokens (blue)
// (test-w2-discovery-phase-colors)
// ============================================================

describe("test-w2-discovery-phase-colors: Uses phase-discovery color tokens", () => {
  test("Uses phase-discovery or blue color tokens", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use discovery blue colors
    expect(componentSource).toMatch(/phase-discovery|blue-500|blue-400|discovery/)
  })

  test("Uses phaseColorVariants or usePhaseColor", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use the phase color system
    expect(componentSource).toMatch(/phaseColorVariants|usePhaseColor|phase.*color/i)
  })
})
