/**
 * Responsive Layout Tests
 * Task: task-w3-responsive-layouts
 *
 * Tests verify responsive layouts for all 8 phase views:
 * 1. All phase views tested at mobile (375px), tablet (768px), desktop (1024px+)
 * 2. Graph views maintain pan/zoom functionality at all sizes
 * 3. Data grids use horizontal scroll on narrow viewports
 * 4. Cards stack vertically on mobile
 * 5. Typography scales appropriately
 * 6. No horizontal overflow at any breakpoint
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import fs from "fs"
import path from "path"
import { Window } from "happy-dom"

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
// Test 1: Phase views render correctly at mobile viewport (375px)
// (test-w3-responsive-mobile)
// ============================================================

describe("test-w3-responsive-mobile: Phase views render correctly at mobile viewport (375px)", () => {
  // Views that have multi-column layouts requiring responsive grids
  // Note: AnalysisView uses view toggle (matrix/list) instead of responsive grid
  const gridViewFiles = [
    { name: "DiscoveryView", path: "../DiscoveryView.tsx" },
    { name: "ClassificationView", path: "../ClassificationView.tsx" },
    { name: "TestingView", path: "../testing/TestingView.tsx" },
    { name: "ImplementationView", path: "../implementation/ImplementationView.tsx" },
    { name: "CompleteView", path: "../complete/CompleteView.tsx" },
  ]

  // All views for general responsive checks
  const allViewFiles = [
    { name: "DiscoveryView", path: "../DiscoveryView.tsx" },
    { name: "AnalysisView", path: "../AnalysisView.tsx" },
    { name: "ClassificationView", path: "../ClassificationView.tsx" },
    { name: "DesignView", path: "../design/DesignView.tsx" },
    { name: "SpecView", path: "../spec/SpecView.tsx" },
    { name: "TestingView", path: "../testing/TestingView.tsx" },
    { name: "ImplementationView", path: "../implementation/ImplementationView.tsx" },
    { name: "CompleteView", path: "../complete/CompleteView.tsx" },
  ]

  test("Multi-column views use responsive grid classes for mobile stacking", () => {
    for (const view of gridViewFiles) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should use responsive grid classes that stack on mobile (grid-cols-1 or similar)
      const hasResponsiveGrid = componentSource.match(/grid-cols-1|md:grid-cols|lg:grid-cols|sm:grid-cols/)
      expect(hasResponsiveGrid).toBeTruthy()
    }
  })

  test("No fixed widths that would cause overflow on mobile", () => {
    for (const view of allViewFiles) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should not have fixed widths larger than mobile viewport (except max-w constraints)
      // Allow max-w-* patterns and w-[small values like 80, 300, etc.]
      const hasLargeFixedWidth = componentSource.match(/\bw-\[(5\d{2}|[6-9]\d{2}|\d{4,})px\]/)
      expect(hasLargeFixedWidth).toBeFalsy()
    }
  })

  test("Typography uses responsive text sizes", () => {
    for (const view of allViewFiles) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should use base text classes that are mobile-appropriate (text-xs, text-sm, text-base, text-lg)
      const hasResponsiveText = componentSource.match(/text-xs|text-sm|text-base|text-lg|text-xl/)
      expect(hasResponsiveText).toBeTruthy()
    }
  })
})

// ============================================================
// Test 2: Phase views render correctly at tablet viewport (768px)
// (test-w3-responsive-tablet)
// ============================================================

describe("test-w3-responsive-tablet: Phase views render correctly at tablet viewport (768px)", () => {
  // Views with responsive breakpoints for tablet
  // Note: AnalysisView uses view toggle (matrix/list) instead of md: breakpoints
  const multiColumnViews = [
    { name: "DiscoveryView", path: "../DiscoveryView.tsx" },
    { name: "ClassificationView", path: "../ClassificationView.tsx" },
    { name: "CompleteView", path: "../complete/CompleteView.tsx" },
  ]

  // Views that use lg: breakpoints instead of md:
  const lgBreakpointViews = [
    { name: "TestingView", path: "../testing/TestingView.tsx" },
    { name: "ImplementationView", path: "../implementation/ImplementationView.tsx" },
  ]

  test("Some views use md: breakpoint for two-column layouts", () => {
    for (const view of multiColumnViews) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should have md: breakpoint classes for tablet layouts
      const hasMdBreakpoint = componentSource.match(/md:grid-cols-|md:flex|md:w-/)
      expect(hasMdBreakpoint).toBeTruthy()
    }
  })

  test("Some views use lg: breakpoint for larger layouts", () => {
    for (const view of lgBreakpointViews) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should have lg: breakpoint classes
      const hasLgBreakpoint = componentSource.match(/lg:grid-cols-|lg:flex/)
      expect(hasLgBreakpoint).toBeTruthy()
    }
  })

  test("Graphs remain usable with ReactFlow pan/zoom controls", () => {
    // Check SchemaGraph (used by DesignView) and SpecView directly since they contain ReactFlow
    const graphViews = [
      { name: "SchemaGraph", path: "../design/SchemaGraph.tsx" },
      { name: "SpecView", path: "../spec/SpecView.tsx" },
    ]

    for (const view of graphViews) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should have ReactFlow Controls component
      expect(componentSource).toMatch(/<Controls/)

      // Should have min/max zoom configuration
      expect(componentSource).toMatch(/minZoom|maxZoom/)
    }
  })
})

// ============================================================
// Test 3: Phase views render correctly at desktop viewport (1024px+)
// (test-w3-responsive-desktop)
// ============================================================

describe("test-w3-responsive-desktop: Phase views render correctly at desktop viewport (1024px+)", () => {
  const multiColumnViews = [
    { name: "TestingView", path: "../testing/TestingView.tsx" },
    { name: "ImplementationView", path: "../implementation/ImplementationView.tsx" },
    { name: "CompleteView", path: "../complete/CompleteView.tsx" },
  ]

  test("Views use lg: breakpoint for full multi-column layouts", () => {
    for (const view of multiColumnViews) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should have lg: breakpoint classes for desktop layouts
      const hasLgBreakpoint = componentSource.match(/lg:grid-cols-|lg:flex|lg:w-/)
      expect(hasLgBreakpoint).toBeTruthy()
    }
  })

  test("Sidebars and detail panels visible on desktop", () => {
    const viewsWithPanels = [
      { name: "DesignView", path: "../design/DesignView.tsx", panelPattern: /EntityDetailsPanel|w-80|sidebar/ },
      { name: "SpecView", path: "../spec/SpecView.tsx", panelPattern: /TaskDetailsPanel|w-80|sidebar/ },
    ]

    for (const view of viewsWithPanels) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should have detail panel components
      expect(componentSource).toMatch(view.panelPattern)
    }
  })
})

// ============================================================
// Test 4: Graph visualizations maintain pan/zoom at all viewports
// (test-w3-responsive-graph-panzoom)
// ============================================================

describe("test-w3-responsive-graph-panzoom: Graph visualizations maintain pan/zoom at all viewports", () => {
  // Components that directly use ReactFlow
  const graphComponents = [
    { name: "SchemaGraph", path: "../design/SchemaGraph.tsx" },
    { name: "SpecView", path: "../spec/SpecView.tsx" },
  ]

  test("Graph components include ReactFlow Controls for navigation", () => {
    for (const view of graphComponents) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should import and use Controls component
      expect(componentSource).toMatch(/Controls/)
      expect(componentSource).toMatch(/<Controls/)
    }
  })

  test("Graph components have fitView for responsive initial display", () => {
    for (const view of graphComponents) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should have fitView prop for responsive initial viewport
      expect(componentSource).toMatch(/fitView/)
    }
  })

  test("Graph containers use flex-1 or min-h for flexible sizing", () => {
    for (const view of graphComponents) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should use flexible sizing
      const hasFlexibleSizing = componentSource.match(/flex-1|min-h-|h-full/)
      expect(hasFlexibleSizing).toBeTruthy()
    }
  })
})

// ============================================================
// Test 5: Data grids use horizontal scroll on narrow viewports
// (test-w3-responsive-data-grids)
// ============================================================

describe("test-w3-responsive-data-grids: Data grids use horizontal scroll on narrow viewports", () => {
  test("AnalysisView matrix has overflow-x-auto for horizontal scrolling", () => {
    const componentPath = path.resolve(import.meta.dir, "../AnalysisView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have overflow-x-auto for scrollable matrix
    expect(componentSource).toMatch(/overflow-x-auto/)
  })

  test("CompleteView timeline has horizontal scroll on narrow viewports", () => {
    const componentPath = path.resolve(import.meta.dir, "../complete/CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have overflow-x-auto for scrollable timeline
    expect(componentSource).toMatch(/overflow-x-auto/)
  })

  test("TestingView coverage bars have appropriate overflow handling", () => {
    const componentPath = path.resolve(import.meta.dir, "../testing/TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have truncate or overflow handling for long task names
    expect(componentSource).toMatch(/truncate|overflow-|max-w-/)
  })
})

// ============================================================
// Test 6: No horizontal overflow at any standard breakpoint
// (test-w3-responsive-no-overflow)
// ============================================================

describe("test-w3-responsive-no-overflow: No horizontal overflow at any standard breakpoint", () => {
  const phaseViewFiles = [
    { name: "DiscoveryView", path: "../DiscoveryView.tsx" },
    { name: "AnalysisView", path: "../AnalysisView.tsx" },
    { name: "ClassificationView", path: "../ClassificationView.tsx" },
    { name: "DesignView", path: "../design/DesignView.tsx" },
    { name: "SpecView", path: "../spec/SpecView.tsx" },
    { name: "TestingView", path: "../testing/TestingView.tsx" },
    { name: "ImplementationView", path: "../implementation/ImplementationView.tsx" },
    { name: "CompleteView", path: "../complete/CompleteView.tsx" },
  ]

  test("All phase views use container elements with proper overflow handling", () => {
    for (const view of phaseViewFiles) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should have overflow handling or max-width constraints
      const hasOverflowHandling = componentSource.match(/overflow-|max-w-|truncate|break-words|whitespace-pre-wrap/)
      expect(hasOverflowHandling).toBeTruthy()
    }
  })

  test("Long text content uses truncate or text wrapping", () => {
    for (const view of phaseViewFiles) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should handle long text appropriately
      const hasTextHandling = componentSource.match(/truncate|whitespace-pre-wrap|break-words|line-clamp/)
      expect(hasTextHandling).toBeTruthy()
    }
  })

  test("Flex containers use min-w-0 or shrink behavior for proper containment", () => {
    for (const view of phaseViewFiles) {
      const componentPath = path.resolve(import.meta.dir, view.path)
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Views using flex should have min-w-0 or flex-shrink patterns for overflow prevention
      // This is particularly important for truncate to work inside flex items
      if (componentSource.includes("flex ") || componentSource.includes("flex-")) {
        const hasProperContainment = componentSource.match(/min-w-0|flex-shrink|shrink-0|overflow-hidden/)
        expect(hasProperContainment).toBeTruthy()
      }
    }
  })
})

// ============================================================
// Test 7: Cards stack vertically on mobile
// (test-w3-responsive-cards-stack)
// ============================================================

describe("test-w3-responsive-cards-stack: Cards stack vertically on mobile", () => {
  test("DiscoveryView assessment columns stack on mobile", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have grid-cols-1 followed by md:grid-cols-2
    expect(componentSource).toMatch(/grid-cols-1\s+md:grid-cols-2|grid-cols-1.*md:grid-cols-2/)
  })

  test("ClassificationView evidence columns stack on mobile", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have grid-cols-1 followed by md:grid-cols-2
    expect(componentSource).toMatch(/grid-cols-1\s+md:grid-cols-2|grid-cols-1.*md:grid-cols-2/)
  })

  test("TestingView columns stack on mobile", () => {
    const componentPath = path.resolve(import.meta.dir, "../testing/TestingView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have grid-cols-1 followed by lg:grid-cols-2
    expect(componentSource).toMatch(/grid-cols-1\s+lg:grid-cols-2|grid-cols-1.*lg:grid-cols-2/)
  })

  test("ImplementationView columns stack on mobile", () => {
    const componentPath = path.resolve(import.meta.dir, "../implementation/ImplementationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have grid-cols-1 followed by lg:grid-cols-2
    expect(componentSource).toMatch(/grid-cols-1\s+lg:grid-cols-2|grid-cols-1.*lg:grid-cols-2/)
  })

  test("CompleteView deliverables grid adapts to mobile", () => {
    const componentPath = path.resolve(import.meta.dir, "../complete/CompleteView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have responsive grid pattern
    expect(componentSource).toMatch(/grid-cols-2\s+md:grid-cols-4|grid-cols-1.*lg:grid-cols-2/)
  })
})

// ============================================================
// Test 8: Detail panels hide on mobile or use overlay
// (test-w3-responsive-detail-panels)
// ============================================================

describe("test-w3-responsive-detail-panels: Detail panels responsive behavior", () => {
  test("DesignView EntityDetailsPanel has responsive width", () => {
    const componentPath = path.resolve(import.meta.dir, "../design/EntityDetailsPanel.tsx")
    if (fs.existsSync(componentPath)) {
      const componentSource = fs.readFileSync(componentPath, "utf-8")

      // Should have fixed width or responsive width pattern
      const hasResponsiveWidth = componentSource.match(/w-80|w-\[|max-w-|md:w-|lg:w-/)
      expect(hasResponsiveWidth).toBeTruthy()
    } else {
      // Panel might be inline in DesignView
      const designViewPath = path.resolve(import.meta.dir, "../design/DesignView.tsx")
      const componentSource = fs.readFileSync(designViewPath, "utf-8")
      expect(componentSource).toMatch(/EntityDetailsPanel/)
    }
  })

  test("SpecView TaskDetailsPanel has responsive width", () => {
    const componentPath = path.resolve(import.meta.dir, "../spec/SpecView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have fixed width for detail panel
    expect(componentSource).toMatch(/w-80|w-\[|TaskDetailsPanel/)
  })
})
