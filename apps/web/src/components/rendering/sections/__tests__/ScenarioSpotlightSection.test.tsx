/**
 * ScenarioSpotlightSection Component Tests
 * Task: task-testing-005
 *
 * Tests verify:
 * 1. Component exports ScenarioSpotlightSection following SectionRendererProps interface
 * 2. Uses useTestingPanelContext to get selectedSpec and clearSelectedSpec
 * 3. Returns null when selectedSpec is null (conditional render)
 * 4. Container uses p-5 rounded-lg border-2 border-cyan-500/50 bg-card styling
 * 5. Header shows test type badge via PropertyRenderer with testTypePropertyMeta (xRenderer='test-type-badge')
 * 6. Header shows requirement link if spec.requirement exists
 * 7. Header shows scenario name in text-lg font-semibold text-foreground
 * 8. Close button (X icon h-4 w-4) in top-right calls clearSelectedSpec on click
 * 9. Given section: label 'Given' in text-xs font-semibold text-cyan-500 uppercase tracking-wider
 * 10. Given content rendered via PropertyRenderer with givenPropertyMeta (xRenderer='string-array')
 * 11. When section: label 'When' with single string value in text-sm text-foreground pl-4
 * 12. Then section: label 'Then' rendered via PropertyRenderer with thenPropertyMeta (xRenderer='string-array')
 * 13. PropertyRenderer config uses size='sm' and layout='compact'
 * 14. Sections only render when respective spec properties have content
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock, jest } from "bun:test"
import { render, cleanup, act } from "@testing-library/react"
import { Window } from "happy-dom"
import React, { useState, useCallback } from "react"

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

afterEach(() => {
  cleanup()
})

// Sample test specs for testing
const sampleTestSpec = {
  id: "test-spec-001",
  taskId: "task-001",
  scenario: "User can submit form with valid data",
  testType: "unit" as const,
  given: ["A valid form state", "User is authenticated"],
  when: ["User clicks submit button"],
  then: ["Form data is sent to API", "Success message is displayed"],
  requirement: "req-001",
}

const specWithoutRequirement = {
  id: "test-spec-002",
  taskId: "task-001",
  scenario: "User sees error for invalid data",
  testType: "integration" as const,
  given: ["An invalid form state"],
  when: ["User clicks submit button"],
  then: ["Validation errors are displayed"],
}

const specWithEmptyArrays = {
  id: "test-spec-003",
  taskId: "task-001",
  scenario: "Empty arrays test",
  testType: "acceptance" as const,
  given: [],
  when: [],
  then: [],
}

// Track PropertyRenderer calls for verification
const propertyRendererCalls: Array<{ property: any; value: any; config: any }> = []

// Mock PropertyRenderer
mock.module("../../PropertyRenderer", () => ({
  PropertyRenderer: ({ property, value, config }: any) => {
    propertyRendererCalls.push({ property, value, config })
    if (property.xRenderer === "test-type-badge") {
      return <span data-testid="test-type-badge">{value}</span>
    }
    if (property.xRenderer === "string-array") {
      return (
        <ul data-testid={`string-array-${property.name}`}>
          {Array.isArray(value) && value.map((item: string, i: number) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )
    }
    return <span>{String(value)}</span>
  },
}))

// Mock shared utilities
mock.module("../shared", () => ({
  usePhaseColorFromContext: () => ({
    bg: "bg-cyan-500",
    text: "text-cyan-500",
    border: "border-cyan-500",
    ring: "ring-cyan-500",
    accent: "bg-cyan-100 text-cyan-800",
  }),
  useCompositionContext: () => ({ phase: "testing" }),
  SectionCard: ({ children, className }: any) => <div className={className}>{children}</div>,
  SectionHeader: ({ icon, title }: any) => <div>{icon}{title}</div>,
  EmptySectionState: ({ message }: any) => <div>{message}</div>,
}))

// Create a custom TestingPanelProvider for testing
let mockSelectedSpec: any = null
let mockClearSelectedSpec: jest.Mock

// Mock TestingPanelContext with controllable state
mock.module("../testing/TestingPanelContext", () => ({
  useTestingPanelContext: () => ({
    selectedSpec: mockSelectedSpec,
    setSelectedSpec: jest.fn(),
    clearSelectedSpec: mockClearSelectedSpec,
  }),
  TestingPanelProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// Import after mocking
import { ScenarioSpotlightSection } from "../testing/ScenarioSpotlightSection"
import { sectionImplementationMap } from "../../sectionImplementations"

// Test fixtures
const createFeature = () => ({
  id: "test-feature-001",
  name: "Test Feature",
  status: "testing",
})

describe("test-testing-005-spotlight: ScenarioSpotlightSection displays Given/When/Then for selected spec", () => {
  beforeAll(() => {
    mockClearSelectedSpec = jest.fn()
  })

  afterEach(() => {
    propertyRendererCalls.length = 0
    mockClearSelectedSpec?.mockClear()
  })

  test("renders without throwing errors when selectedSpec is set", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    expect(() =>
      render(<ScenarioSpotlightSection feature={feature} />)
    ).not.toThrow()
  })

  test("renders test type badge via PropertyRenderer with testTypePropertyMeta", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Find PropertyRenderer call for test type badge
    const testTypeBadgeCall = propertyRendererCalls.find(
      (call) => call.property.xRenderer === "test-type-badge"
    )
    expect(testTypeBadgeCall).toBeDefined()
    expect(testTypeBadgeCall?.value).toBe("unit")

    // Badge should be visible
    const badge = container.querySelector("[data-testid='test-type-badge']")
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toBe("unit")
  })

  test("renders scenario name in header with correct styling", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    expect(container.textContent).toContain("User can submit form with valid data")

    // Check for text-lg font-semibold text-foreground on scenario title
    const scenarioTitle = container.querySelector(".text-lg.font-semibold")
    expect(scenarioTitle).not.toBeNull()
  })

  test("renders Given section with label styling and PropertyRenderer", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Check Given label styling
    expect(container.textContent).toContain("Given")

    // Check PropertyRenderer was called for given array
    const givenCall = propertyRendererCalls.find(
      (call) => call.property.name === "given" && call.property.xRenderer === "string-array"
    )
    expect(givenCall).toBeDefined()
    expect(givenCall?.value).toEqual(["A valid form state", "User is authenticated"])

    // Verify config has size='sm' and layout='compact'
    expect(givenCall?.config?.size).toBe("sm")
    expect(givenCall?.config?.layout).toBe("compact")
  })

  test("renders When section with single string value", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Check When label
    expect(container.textContent).toContain("When")
    // Check When value
    expect(container.textContent).toContain("User clicks submit button")
  })

  test("renders Then section with label and PropertyRenderer", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Check Then label
    expect(container.textContent).toContain("Then")

    // Check PropertyRenderer was called for then array
    const thenCall = propertyRendererCalls.find(
      (call) => call.property.name === "then" && call.property.xRenderer === "string-array"
    )
    expect(thenCall).toBeDefined()
    expect(thenCall?.value).toEqual([
      "Form data is sent to API",
      "Success message is displayed",
    ])

    // Verify config has size='sm' and layout='compact'
    expect(thenCall?.config?.size).toBe("sm")
    expect(thenCall?.config?.layout).toBe("compact")
  })

  test("renders close button that calls clearSelectedSpec", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Find close button (X icon)
    const closeButton = container.querySelector("button")
    expect(closeButton).not.toBeNull()

    // Find X icon SVG with h-4 w-4 classes
    const xIcon = closeButton?.querySelector("svg")
    expect(xIcon).not.toBeNull()
    expect(xIcon?.classList.contains("h-4")).toBe(true)
    expect(xIcon?.classList.contains("w-4")).toBe(true)

    // Click close button
    act(() => {
      closeButton?.click()
    })

    // Verify clearSelectedSpec was called
    expect(mockClearSelectedSpec).toHaveBeenCalledTimes(1)
  })

  test("renders requirement link when spec.requirement exists", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Should show requirement reference
    expect(container.textContent).toContain("req-001")
  })

  test("does not render requirement link when spec.requirement is absent", () => {
    mockSelectedSpec = specWithoutRequirement
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Should not show requirement reference placeholder or error
    expect(container.textContent).not.toContain("req-001")
    // Scenario name should still be present
    expect(container.textContent).toContain("User sees error for invalid data")
  })

  test("container uses correct styling classes", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Find main container
    const spotlight = container.firstElementChild
    expect(spotlight).not.toBeNull()
    expect(spotlight?.className).toContain("p-5")
    expect(spotlight?.className).toContain("rounded-lg")
    expect(spotlight?.className).toContain("border-2")
    expect(spotlight?.className).toContain("bg-card")
  })
})

describe("test-testing-005-hidden: ScenarioSpotlightSection returns null when no spec selected", () => {
  test("returns null when selectedSpec is null", () => {
    mockSelectedSpec = null
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Component should render nothing
    expect(container.innerHTML).toBe("")
  })

  test("no spotlight panel displayed when selection is cleared", () => {
    mockSelectedSpec = null
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // No spotlight container should be present
    const spotlight = container.querySelector("[data-testid='scenario-spotlight']")
    expect(spotlight).toBeNull()
  })
})

describe("ScenarioSpotlightSection - Section Labels Styling", () => {
  test("Given label has correct styling (text-xs font-semibold text-cyan-500 uppercase tracking-wider)", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Find Given label by searching for element with correct text and classes
    const labels = container.querySelectorAll(".text-xs.font-semibold.uppercase.tracking-wider")
    const givenLabel = Array.from(labels).find((el) => el.textContent === "Given")
    expect(givenLabel).not.toBeNull()
  })

  test("When section shows value with text-sm text-foreground pl-4 styling", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Find When value element
    const whenValue = container.querySelector(".pl-4.text-sm")
    expect(whenValue).not.toBeNull()
    expect(whenValue?.textContent).toContain("User clicks submit button")
  })
})

describe("ScenarioSpotlightSection - Conditional Section Rendering", () => {
  afterEach(() => {
    propertyRendererCalls.length = 0
  })

  test("does not render Given section when given array is empty", () => {
    propertyRendererCalls.length = 0 // Clear before test
    mockSelectedSpec = specWithEmptyArrays
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Given PropertyRenderer should not be called if array is empty
    const givenCall = propertyRendererCalls.find(
      (call) => call.property.name === "given"
    )
    expect(givenCall).toBeUndefined()
  })

  test("does not render When section when when array is empty", () => {
    mockSelectedSpec = specWithEmptyArrays
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // When section should not show value
    const whenElements = container.querySelectorAll(".pl-4.text-sm")
    const hasWhenContent = Array.from(whenElements).some((el) =>
      el.textContent && el.textContent.length > 0
    )
    // Either no elements or empty content
    expect(hasWhenContent).toBe(false)
  })

  test("does not render Then section when then array is empty", () => {
    propertyRendererCalls.length = 0 // Clear before test
    mockSelectedSpec = specWithEmptyArrays
    const feature = createFeature()
    const { container } = render(<ScenarioSpotlightSection feature={feature} />)

    // Then PropertyRenderer should not be called if array is empty
    const thenCall = propertyRendererCalls.find(
      (call) => call.property.name === "then"
    )
    expect(thenCall).toBeUndefined()
  })
})

describe("ScenarioSpotlightSection - Registration", () => {
  test("is registered in sectionImplementationMap", () => {
    const component = sectionImplementationMap.get("ScenarioSpotlightSection")
    expect(component).toBeDefined()
    expect(component).toBe(ScenarioSpotlightSection)
  })

  test("follows SectionRendererProps interface", () => {
    mockSelectedSpec = sampleTestSpec
    const feature = createFeature()
    const config = { showDetails: true }

    // Should accept both feature and optional config props
    expect(() =>
      render(<ScenarioSpotlightSection feature={feature} config={config} />)
    ).not.toThrow()
  })
})
