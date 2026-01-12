/**
 * Tests for IntegrationPointCard
 * Task: task-spec-003
 *
 * TDD tests for the IntegrationPoint internal sub-component:
 * - Accepts { integrationPoint: IntegrationPoint } props
 * - Header shows name (font-medium) and changeType badge via PropertyRenderer
 * - File path rendered via PropertyRenderer with code-path-display
 * - Description rendered via PropertyRenderer with long-text
 * - Card styling with emerald phase colors
 *
 * Test Specification: task-spec-003
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
  "../IntegrationPointCard.tsx"
)

// ============================================================
// Test: task-spec-003 - IntegrationPointCard component file structure
// Given: IntegrationPointCard component file should exist
// When: Component is imported
// Then: Component exports IntegrationPointCard function
// ============================================================

describe("task-spec-003: IntegrationPointCard component file and exports", () => {
  test("component file exists at expected path", () => {
    // Given: IntegrationPointCard component file should exist
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("IntegrationPointCard is exported", () => {
    // Given: Component should be exported
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+IntegrationPointCard/)
  })

  test("component accepts integrationPoint prop", () => {
    // Given: Component should accept integrationPoint prop
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/integrationPoint/)
    // Should have IntegrationPoint type
    expect(source).toMatch(/IntegrationPoint/)
  })
})

// ============================================================
// Test: task-spec-003 - IntegrationPoint interface
// Given: IntegrationPoint interface definition
// When: Checking interface structure
// Then: Interface has required fields (id, name, filePath, description)
// Then: Interface has optional fields (changeType, package, targetFunction)
// ============================================================

describe("task-spec-003: IntegrationPoint interface definition", () => {
  test("defines IntegrationPoint interface with required fields", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should define interface with id, name, filePath, description
    expect(source).toMatch(/interface\s+IntegrationPoint/)
    expect(source).toMatch(/id:\s*string/)
    expect(source).toMatch(/name:\s*string/)
    expect(source).toMatch(/filePath:\s*string/)
    expect(source).toMatch(/description:\s*string/)
  })

  test("defines IntegrationPoint interface with optional fields", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have optional changeType, package, targetFunction
    expect(source).toMatch(/changeType\?:\s*string/)
    expect(source).toMatch(/package\?:\s*string/)
    expect(source).toMatch(/targetFunction\?:\s*string/)
  })
})

// ============================================================
// Test: task-spec-003 - Header with name and changeType badge
// Given: IntegrationPointCard with integrationPoint data
// When: Card renders
// Then: Header shows name with font-medium class
// Then: changeType badge rendered via PropertyRenderer with changeTypeMeta
// ============================================================

describe("task-spec-003: IntegrationPointCard header with name and badge", () => {
  test("header shows name with font-medium styling", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should display name with font-medium class
    expect(source).toMatch(/font-medium/)
    // Should reference integrationPoint.name
    expect(source).toMatch(/integrationPoint\.name/)
  })

  test("uses PropertyRenderer for changeType badge", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should import PropertyRenderer
    expect(source).toMatch(/import.*PropertyRenderer/)
    // Should use PropertyRenderer with changeTypeMeta
    expect(source).toMatch(/PropertyRenderer/)
    expect(source).toMatch(/changeTypeMeta/)
  })

  test("changeTypeMeta has xRenderer: change-type-badge", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should define changeTypeMeta with correct xRenderer
    expect(source).toMatch(/changeTypeMeta/)
    expect(source).toMatch(/xRenderer:\s*["']change-type-badge["']/)
  })
})

// ============================================================
// Test: task-spec-003 - File path rendering
// Given: IntegrationPointCard with integrationPoint data
// When: Card renders
// Then: File path rendered via PropertyRenderer with filePathMeta
// Then: filePathMeta has xRenderer: code-path-display and config.truncate=50
// ============================================================

describe("task-spec-003: IntegrationPointCard file path rendering", () => {
  test("uses PropertyRenderer for file path", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should use PropertyRenderer with filePathMeta
    expect(source).toMatch(/filePathMeta/)
    // Should reference integrationPoint.filePath
    expect(source).toMatch(/integrationPoint\.filePath/)
  })

  test("filePathMeta has xRenderer: code-path-display", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should define filePathMeta with correct xRenderer
    expect(source).toMatch(/filePathMeta/)
    expect(source).toMatch(/xRenderer:\s*["']code-path-display["']/)
  })

  test("file path uses truncate config of 50", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have truncate: 50 in config
    expect(source).toMatch(/truncate:\s*50/)
  })
})

// ============================================================
// Test: task-spec-003 - Description rendering
// Given: IntegrationPointCard with integrationPoint data
// When: Card renders
// Then: Description rendered via PropertyRenderer with integrationPointDescriptionMeta
// Then: integrationPointDescriptionMeta has xRenderer: long-text and config.truncate=100
// ============================================================

describe("task-spec-003: IntegrationPointCard description rendering", () => {
  test("uses PropertyRenderer for description", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should use PropertyRenderer with integrationPointDescriptionMeta
    expect(source).toMatch(/integrationPointDescriptionMeta/)
    // Should reference integrationPoint.description
    expect(source).toMatch(/integrationPoint\.description/)
  })

  test("integrationPointDescriptionMeta has xRenderer: long-text", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should define integrationPointDescriptionMeta with correct xRenderer
    expect(source).toMatch(/integrationPointDescriptionMeta/)
    expect(source).toMatch(/xRenderer:\s*["']long-text["']/)
  })

  test("description uses truncate config of 100", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have truncate: 100 in config for description
    expect(source).toMatch(/truncate:\s*100/)
  })
})

// ============================================================
// Test: task-spec-003 - Card styling with emerald phase colors
// Given: IntegrationPointCard component
// When: Card renders
// Then: Card has p-3 padding
// Then: Card has rounded-lg border-radius
// Then: Card has border with bg-card background
// Then: Card has emerald border colors (border-emerald-500/20)
// Then: Card has hover state (hover:border-emerald-500/40)
// ============================================================

describe("task-spec-003: IntegrationPointCard card styling", () => {
  test("card has p-3 padding", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/p-3/)
  })

  test("card has rounded-lg border-radius", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/rounded-lg/)
  })

  test("card has border and bg-card background", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/border/)
    expect(source).toMatch(/bg-card/)
  })

  test("card has emerald border color border-emerald-500/20", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/border-emerald-500\/20/)
  })

  test("card has hover state hover:border-emerald-500/40", () => {
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/hover:border-emerald-500\/40/)
  })
})

// ============================================================
// Test: task-spec-003 - Rendering behavior tests
// Given: IntegrationPointCard with mock data
// When: Component renders
// Then: All expected elements are present
// ============================================================

describe("task-spec-003: IntegrationPointCard rendering behavior", () => {
  // Mock PropertyRenderer to avoid full registry dependency
  const mockPropertyRenderer = mock(() => null)

  mock.module("@/components/rendering/PropertyRenderer", () => ({
    PropertyRenderer: mockPropertyRenderer,
  }))

  test("renders card with integration point data", async () => {
    // Import after mocking
    const { IntegrationPointCard } = await import("../IntegrationPointCard")

    const mockIntegrationPoint = {
      id: "ip-001",
      name: "Test Integration Point",
      filePath: "apps/web/src/components/TestComponent.tsx",
      changeType: "add",
      description: "A test integration point for unit testing the card component",
      package: "apps/web",
      targetFunction: "TestComponent",
    }

    const { container } = render(
      <IntegrationPointCard integrationPoint={mockIntegrationPoint} />
    )

    // Card should render
    expect(container.firstChild).not.toBeNull()

    // Should contain the name
    expect(container.textContent).toContain("Test Integration Point")
  })

  test("renders without optional fields", async () => {
    const { IntegrationPointCard } = await import("../IntegrationPointCard")

    const mockIntegrationPoint = {
      id: "ip-002",
      name: "Minimal Integration Point",
      filePath: "packages/core/src/index.ts",
      description: "Minimal data point",
    }

    const { container } = render(
      <IntegrationPointCard integrationPoint={mockIntegrationPoint} />
    )

    // Card should render without errors
    expect(container.firstChild).not.toBeNull()
    expect(container.textContent).toContain("Minimal Integration Point")
  })
})
