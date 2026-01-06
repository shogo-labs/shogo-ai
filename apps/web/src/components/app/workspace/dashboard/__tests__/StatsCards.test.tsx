/**
 * Tests for StatsCards Component
 * Task: task-2-2-007
 *
 * TDD tests for the stats cards grid showing feature counts by phase.
 *
 * Test Specifications:
 * - test-2-2-007-004: StatsCards renders grid with responsive columns
 * - test-2-2-007-005: StatsCards shows count for each phase
 * - test-2-2-007-006: StatsCards uses shadcn Card component
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import React from "react"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { Window } from "happy-dom"

// ============================================================
// Happy-DOM Setup
// ============================================================

let window: Window
let container: HTMLElement
let root: Root
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window({ url: "http://localhost:3000/" })
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

beforeEach(() => {
  container = window.document.createElement("div")
  container.id = "root"
  window.document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

// ============================================================
// Test 4: StatsCards renders grid with responsive columns
// (test-2-2-007-004)
// ============================================================

describe("test-2-2-007-004: StatsCards renders grid with responsive columns", () => {
  test("Grid has grid-cols-2 for small screens", async () => {
    const { StatsCards } = await import("../StatsCards")

    const mockFeaturesByPhase = {
      discovery: [],
      analysis: [],
      classification: [],
      design: [],
      spec: [],
      testing: [],
      implementation: [],
      complete: [],
    }

    await act(async () => {
      root.render(<StatsCards featuresByPhase={mockFeaturesByPhase} />)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const grid = container.querySelector('[data-testid="stats-cards"]')
    expect(grid).not.toBeNull()
    expect(grid?.className).toMatch(/grid-cols-2/)
  })

  test("Grid has md:grid-cols-4 for medium+ screens", async () => {
    const { StatsCards } = await import("../StatsCards")

    const mockFeaturesByPhase = {
      discovery: [],
      analysis: [],
      classification: [],
      design: [],
      spec: [],
      testing: [],
      implementation: [],
      complete: [],
    }

    await act(async () => {
      root.render(<StatsCards featuresByPhase={mockFeaturesByPhase} />)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const grid = container.querySelector('[data-testid="stats-cards"]')
    expect(grid).not.toBeNull()
    expect(grid?.className).toMatch(/md:grid-cols-4/)
  })
})

// ============================================================
// Test 5: StatsCards shows count for each phase
// (test-2-2-007-005)
// ============================================================

describe("test-2-2-007-005: StatsCards shows count for each phase", () => {
  test("Discovery card shows correct count", async () => {
    const { StatsCards } = await import("../StatsCards")

    const mockFeaturesByPhase = {
      discovery: [{ id: "f1" }, { id: "f2" }, { id: "f3" }],
      analysis: [],
      classification: [],
      design: [],
      spec: [],
      testing: [],
      implementation: [],
      complete: [],
    }

    await act(async () => {
      root.render(<StatsCards featuresByPhase={mockFeaturesByPhase} />)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const discoveryCard = container.querySelector('[data-testid="stat-card-discovery"]')
    expect(discoveryCard).not.toBeNull()
    expect(discoveryCard?.textContent).toContain("3")
  })

  test("Design card shows correct count", async () => {
    const { StatsCards } = await import("../StatsCards")

    const mockFeaturesByPhase = {
      discovery: [],
      analysis: [],
      classification: [],
      design: [{ id: "f1" }, { id: "f2" }, { id: "f3" }, { id: "f4" }, { id: "f5" }],
      spec: [],
      testing: [],
      implementation: [],
      complete: [],
    }

    await act(async () => {
      root.render(<StatsCards featuresByPhase={mockFeaturesByPhase} />)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const designCard = container.querySelector('[data-testid="stat-card-design"]')
    expect(designCard).not.toBeNull()
    expect(designCard?.textContent).toContain("5")
  })

  test("All 8 phases have cards", async () => {
    const { StatsCards } = await import("../StatsCards")

    const mockFeaturesByPhase = {
      discovery: [],
      analysis: [],
      classification: [],
      design: [],
      spec: [],
      testing: [],
      implementation: [],
      complete: [],
    }

    await act(async () => {
      root.render(<StatsCards featuresByPhase={mockFeaturesByPhase} />)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Check all 8 phases have cards
    const phases = [
      "discovery",
      "analysis",
      "classification",
      "design",
      "spec",
      "testing",
      "implementation",
      "complete",
    ]

    for (const phase of phases) {
      const card = container.querySelector(`[data-testid="stat-card-${phase}"]`)
      expect(card).not.toBeNull()
    }
  })
})

// ============================================================
// Test 6: StatsCards uses shadcn Card component
// (test-2-2-007-006)
// ============================================================

describe("test-2-2-007-006: StatsCards uses shadcn Card component", () => {
  test("shadcn Card component is used", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../StatsCards.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import Card from @/components/ui/card
    expect(componentSource).toMatch(/import.*Card.*from\s+['"]@\/components\/ui\/card['"]/)
  })

  test("Each card shows phase name", async () => {
    const { StatsCards } = await import("../StatsCards")

    const mockFeaturesByPhase = {
      discovery: [],
      analysis: [],
      classification: [],
      design: [],
      spec: [],
      testing: [],
      implementation: [],
      complete: [],
    }

    await act(async () => {
      root.render(<StatsCards featuresByPhase={mockFeaturesByPhase} />)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Check that phase names are displayed
    const discoveryCard = container.querySelector('[data-testid="stat-card-discovery"]')
    expect(discoveryCard?.textContent?.toLowerCase()).toContain("discovery")

    const designCard = container.querySelector('[data-testid="stat-card-design"]')
    expect(designCard?.textContent?.toLowerCase()).toContain("design")

    const completeCard = container.querySelector('[data-testid="stat-card-complete"]')
    expect(completeCard?.textContent?.toLowerCase()).toContain("complete")
  })

  test("Each card shows feature count", async () => {
    const { StatsCards } = await import("../StatsCards")

    const mockFeaturesByPhase = {
      discovery: [{ id: "f1" }],
      analysis: [{ id: "f2" }, { id: "f3" }],
      classification: [],
      design: [{ id: "f4" }, { id: "f5" }, { id: "f6" }],
      spec: [],
      testing: [],
      implementation: [],
      complete: [{ id: "f7" }],
    }

    await act(async () => {
      root.render(<StatsCards featuresByPhase={mockFeaturesByPhase} />)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Check feature counts are displayed
    const discoveryCard = container.querySelector('[data-testid="stat-card-discovery"]')
    expect(discoveryCard?.textContent).toContain("1")

    const analysisCard = container.querySelector('[data-testid="stat-card-analysis"]')
    expect(analysisCard?.textContent).toContain("2")

    const designCard = container.querySelector('[data-testid="stat-card-design"]')
    expect(designCard?.textContent).toContain("3")

    const completeCard = container.querySelector('[data-testid="stat-card-complete"]')
    expect(completeCard?.textContent).toContain("1")
  })

  test("Cards have hover state styling", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../StatsCards.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have hover: classes in the styling
    expect(componentSource).toMatch(/hover:/)
  })
})

// ============================================================
// Test: Clean break - StatsCards in /components/app/workspace/dashboard/
// (test-2-2-007-007 partial)
// ============================================================

describe("test-2-2-007-007: Clean break - StatsCards file structure", () => {
  test("File located at apps/web/src/components/app/workspace/dashboard/", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../StatsCards.tsx")

    // File should exist
    expect(fs.existsSync(componentPath)).toBe(true)

    // Path should be in /components/app/workspace/dashboard/
    expect(componentPath).toMatch(/components\/app\/workspace\/dashboard\/StatsCards\.tsx$/)
  })

  test("Zero imports from /components/Studio/", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../StatsCards.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should NOT import from /components/Studio/
    expect(componentSource).not.toMatch(/from ['"].*\/Studio\//)
    expect(componentSource).not.toMatch(/from ['"].*\/components\/Studio/)
  })

  test("Uses shadcn Card patterns", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../StatsCards.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use Card component from shadcn
    expect(componentSource).toMatch(/Card/)
  })
})
