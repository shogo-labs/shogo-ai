/**
 * Tests for ProjectDashboard Component
 * Task: task-2-2-007
 *
 * TDD tests for the project dashboard shown when no feature is selected.
 *
 * Test Specifications:
 * - test-2-2-007-001: ProjectDashboard renders when no feature selected
 * - test-2-2-007-002: ProjectDashboard renders StatsCards grid
 * - test-2-2-007-003: ProjectDashboard has Create Feature quick action
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from "bun:test"
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
// Test 1: ProjectDashboard renders when no feature selected
// (test-2-2-007-001)
// ============================================================

describe("test-2-2-007-001: ProjectDashboard renders when no feature selected", () => {
  test("ProjectDashboard is rendered with project name as heading", async () => {
    const { ProjectDashboard } = await import("../ProjectDashboard")

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
      root.render(
        <ProjectDashboard
          projectName="Test Project"
          featuresByPhase={mockFeaturesByPhase}
          onNewFeature={() => {}}
        />
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Find the dashboard root element
    const dashboard = container.querySelector('[data-testid="project-dashboard"]')
    expect(dashboard).not.toBeNull()

    // Project name should be displayed as heading
    const heading = container.querySelector("h1, h2")
    expect(heading).not.toBeNull()
    expect(heading?.textContent).toContain("Test Project")
  })

  test("Dashboard shows project name heading correctly", async () => {
    const { ProjectDashboard } = await import("../ProjectDashboard")

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
      root.render(
        <ProjectDashboard
          projectName="My Awesome Project"
          featuresByPhase={mockFeaturesByPhase}
          onNewFeature={() => {}}
        />
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const heading = container.querySelector('[data-testid="project-name"]')
    expect(heading).not.toBeNull()
    expect(heading?.textContent).toBe("My Awesome Project")
  })
})

// ============================================================
// Test 2: ProjectDashboard renders StatsCards grid
// (test-2-2-007-002)
// ============================================================

describe("test-2-2-007-002: ProjectDashboard renders StatsCards grid", () => {
  test("StatsCards component is rendered within ProjectDashboard", async () => {
    const { ProjectDashboard } = await import("../ProjectDashboard")

    const mockFeaturesByPhase = {
      discovery: [{ id: "f1", name: "Feature 1" }],
      analysis: [],
      classification: [],
      design: [{ id: "f2", name: "Feature 2" }],
      spec: [],
      testing: [],
      implementation: [],
      complete: [],
    }

    await act(async () => {
      root.render(
        <ProjectDashboard
          projectName="Test Project"
          featuresByPhase={mockFeaturesByPhase}
          onNewFeature={() => {}}
        />
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Stats grid should be visible
    const statsGrid = container.querySelector('[data-testid="stats-cards"]')
    expect(statsGrid).not.toBeNull()
  })

  test("Stats grid is visible with stats cards", async () => {
    const { ProjectDashboard } = await import("../ProjectDashboard")

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
      root.render(
        <ProjectDashboard
          projectName="Test Project"
          featuresByPhase={mockFeaturesByPhase}
          onNewFeature={() => {}}
        />
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Stats grid should have stat cards
    const statCards = container.querySelectorAll('[data-testid^="stat-card-"]')
    expect(statCards.length).toBeGreaterThan(0)
  })
})

// ============================================================
// Test 3: ProjectDashboard has Create Feature quick action
// (test-2-2-007-003)
// ============================================================

describe("test-2-2-007-003: ProjectDashboard has Create Feature quick action", () => {
  test("Create Feature button is rendered", async () => {
    const { ProjectDashboard } = await import("../ProjectDashboard")

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
      root.render(
        <ProjectDashboard
          projectName="Test Project"
          featuresByPhase={mockFeaturesByPhase}
          onNewFeature={() => {}}
        />
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Create Feature button should exist
    const createButton = container.querySelector('[data-testid="create-feature-button"]')
    expect(createButton).not.toBeNull()
    expect(createButton?.textContent?.toLowerCase()).toContain("create")
  })

  test("onNewFeature callback is called when button is clicked", async () => {
    const { ProjectDashboard } = await import("../ProjectDashboard")

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

    let callbackCalled = false
    const mockOnNewFeature = () => {
      callbackCalled = true
    }

    await act(async () => {
      root.render(
        <ProjectDashboard
          projectName="Test Project"
          featuresByPhase={mockFeaturesByPhase}
          onNewFeature={mockOnNewFeature}
        />
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Click the Create Feature button
    const createButton = container.querySelector(
      '[data-testid="create-feature-button"]'
    ) as HTMLButtonElement
    expect(createButton).not.toBeNull()

    await act(async () => {
      createButton?.click()
    })

    expect(callbackCalled).toBe(true)
  })
})

// ============================================================
// Test: Clean break - ProjectDashboard in /components/app/workspace/dashboard/
// (test-2-2-007-007 partial)
// ============================================================

describe("test-2-2-007-007: Clean break - ProjectDashboard file structure", () => {
  test("File located at apps/web/src/components/app/workspace/dashboard/", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../ProjectDashboard.tsx")

    // File should exist
    expect(fs.existsSync(componentPath)).toBe(true)

    // Path should be in /components/app/workspace/dashboard/
    expect(componentPath).toMatch(
      /components\/app\/workspace\/dashboard\/ProjectDashboard\.tsx$/
    )
  })

  test("Zero imports from /components/Studio/", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../ProjectDashboard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should NOT import from /components/Studio/
    expect(componentSource).not.toMatch(/from ['"].*\/Studio\//)
    expect(componentSource).not.toMatch(/from ['"].*\/components\/Studio/)
  })

  test("Uses Tailwind utilities only (no inline styles)", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../ProjectDashboard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should NOT have style={{ ... }} inline styles
    expect(componentSource).not.toMatch(/style=\{\{/)
  })
})
