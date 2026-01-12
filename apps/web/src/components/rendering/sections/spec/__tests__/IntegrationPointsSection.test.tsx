/**
 * Tests for IntegrationPointsSection
 * Task: task-spec-004
 *
 * TDD tests for the IntegrationPointsSection internal sub-component:
 * - Accepts { integrationPoints: IntegrationPoint[] } props
 * - Returns null when integrationPoints is empty or undefined
 * - Header with Link2 icon, 'Integration Points' label, and count badge
 * - Renders IntegrationPointCard for each integration point in space-y-2 container
 * - Uses emerald icon color (text-emerald-500)
 *
 * Test Specification: task-spec-004
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { Window } from "happy-dom"
import fs from "fs"
import path from "path"

// DOM setup for happy-dom
let window: Window
let cleanup_dom: () => void

beforeAll(() => {
  window = new Window({ url: "https://localhost/" })
  const doc = window.document
  // @ts-ignore
  globalThis.document = doc
  // @ts-ignore
  globalThis.window = window
  // @ts-ignore
  globalThis.HTMLElement = window.HTMLElement
  // @ts-ignore
  globalThis.DocumentFragment = window.DocumentFragment

  cleanup_dom = () => {
    window.close()
  }
})

afterAll(() => {
  cleanup_dom()
})

afterEach(() => {
  cleanup()
})

const componentPath = path.resolve(
  import.meta.dir,
  "../IntegrationPointsSection.tsx"
)

// ============================================================
// Test: task-spec-004 - IntegrationPointsSection component file structure
// Given: IntegrationPointsSection component file should exist
// When: Component is imported
// Then: Component exports IntegrationPointsSection function
// ============================================================

describe("task-spec-004: IntegrationPointsSection component file and exports", () => {
  test("component file exists at expected path", () => {
    // Given: IntegrationPointsSection component file should exist
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("IntegrationPointsSection is exported", () => {
    // Given: Component should be exported
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+IntegrationPointsSection/)
  })

  test("component accepts integrationPoints array prop", () => {
    // Given: Component should accept integrationPoints prop
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have integrationPoints prop
    expect(source).toMatch(/integrationPoints/)
    // Should reference IntegrationPoint type (array)
    expect(source).toMatch(/IntegrationPoint\[\]/)
  })
})

// ============================================================
// Test: task-spec-004 - IntegrationPointsSectionProps interface
// Given: IntegrationPointsSectionProps interface definition
// When: Checking interface structure
// Then: Interface has integrationPoints field as IntegrationPoint[]
// ============================================================

describe("task-spec-004: IntegrationPointsSectionProps interface definition", () => {
  test("defines IntegrationPointsSectionProps interface", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/interface\s+IntegrationPointsSectionProps/)
  })

  test("integrationPoints prop is IntegrationPoint[]", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have integrationPoints as IntegrationPoint array
    expect(source).toMatch(/integrationPoints:\s*IntegrationPoint\[\]/)
  })
})

// ============================================================
// Test: task-spec-004 - Returns null when empty or undefined
// Given: IntegrationPointsSection with empty or undefined integrationPoints
// When: Component renders
// Then: Component returns null (does not render anything)
// ============================================================

describe("task-spec-004: IntegrationPointsSection returns null when empty", () => {
  test("component checks for empty array", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have early return for empty/undefined
    expect(source).toMatch(/return\s+null/)
    // Should check length or isEmpty
    expect(source).toMatch(/\.length|!integrationPoints/)
  })

  test("component handles undefined integrationPoints", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should handle undefined case (falsy check or optional chaining)
    expect(source).toMatch(/!integrationPoints|integrationPoints\?/)
  })
})

// ============================================================
// Test: task-spec-004 - Header with Link2 icon and label
// Given: IntegrationPointsSection with integration points data
// When: Component renders
// Then: Header displays Link2 icon from lucide-react
// Then: Header shows 'Integration Points' label (uppercase, tracking-wider)
// Then: Header shows count badge with number of integration points
// ============================================================

describe("task-spec-004: IntegrationPointsSection header", () => {
  test("imports Link2 icon from lucide-react", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*Link2.*from\s*["']lucide-react["']/)
  })

  test("uses Link2 icon in header", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<Link2/)
  })

  test("header label is uppercase tracking-wider", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have uppercase class
    expect(source).toMatch(/uppercase/)
    // Should have tracking-wider class
    expect(source).toMatch(/tracking-wider/)
  })

  test("header displays Integration Points text", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have the label text
    expect(source).toMatch(/Integration Points/i)
  })

  test("header shows count badge", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should display count with integrationPoints.length
    expect(source).toMatch(/integrationPoints\.length/)
  })
})

// ============================================================
// Test: task-spec-004 - Uses emerald icon color
// Given: IntegrationPointsSection component
// When: Component renders
// Then: Link2 icon uses text-emerald-500 class
// ============================================================

describe("task-spec-004: IntegrationPointsSection emerald icon color", () => {
  test("Link2 icon has text-emerald-500 class", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Icon should have emerald color
    expect(source).toMatch(/text-emerald-500/)
  })
})

// ============================================================
// Test: task-spec-004 - Renders IntegrationPointCard for each item
// Given: IntegrationPointsSection with integration points array
// When: Component renders
// Then: IntegrationPointCard is imported from same directory
// Then: Each integration point renders IntegrationPointCard
// Then: Container has space-y-2 for vertical spacing
// ============================================================

describe("task-spec-004: IntegrationPointsSection renders IntegrationPointCard list", () => {
  test("imports IntegrationPointCard", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*IntegrationPointCard/)
  })

  test("maps over integrationPoints to render cards", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should map over integrationPoints
    expect(source).toMatch(/integrationPoints\.map/)
    // Should render IntegrationPointCard
    expect(source).toMatch(/<IntegrationPointCard/)
  })

  test("container has space-y-2 for vertical spacing", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/space-y-2/)
  })

  test("passes integrationPoint prop to each card", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should pass integrationPoint prop
    expect(source).toMatch(/integrationPoint=/)
  })
})

// ============================================================
// Test: task-spec-004 - Rendering behavior tests
// Given: IntegrationPointsSection with mock data
// When: Component renders
// Then: All expected elements are present
// ============================================================

describe("task-spec-004: IntegrationPointsSection rendering behavior", () => {
  // Mock IntegrationPointCard to avoid PropertyRenderer registry dependency
  mock.module("../IntegrationPointCard", () => ({
    IntegrationPointCard: ({ integrationPoint }: { integrationPoint: { name: string } }) => (
      <div data-testid="mock-card">{integrationPoint.name}</div>
    ),
  }))

  test("renders null when integrationPoints is empty array", async () => {
    const { IntegrationPointsSection } = await import("../IntegrationPointsSection")

    const { container } = render(
      <IntegrationPointsSection integrationPoints={[]} />
    )

    // Should render nothing (null)
    expect(container.firstChild).toBeNull()
  })

  test("renders null when integrationPoints is undefined", async () => {
    const { IntegrationPointsSection } = await import("../IntegrationPointsSection")

    const { container } = render(
      // @ts-ignore - testing undefined case
      <IntegrationPointsSection integrationPoints={undefined} />
    )

    // Should render nothing (null)
    expect(container.firstChild).toBeNull()
  })

  test("renders header and cards when integrationPoints has items", async () => {
    const { IntegrationPointsSection } = await import("../IntegrationPointsSection")

    const mockIntegrationPoints = [
      {
        id: "ip-001",
        name: "First Integration Point",
        filePath: "apps/web/src/Test1.tsx",
        description: "First test integration point",
      },
      {
        id: "ip-002",
        name: "Second Integration Point",
        filePath: "apps/web/src/Test2.tsx",
        description: "Second test integration point",
      },
    ]

    const { container } = render(
      <IntegrationPointsSection integrationPoints={mockIntegrationPoints} />
    )

    // Should render something
    expect(container.firstChild).not.toBeNull()

    // Should contain the label text
    expect(container.textContent).toMatch(/Integration Points/i)

    // Should show count (2)
    expect(container.textContent).toContain("2")
  })
})
