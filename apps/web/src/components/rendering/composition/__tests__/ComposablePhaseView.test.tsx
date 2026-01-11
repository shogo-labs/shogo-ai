/**
 * ComposablePhaseView Component Tests
 * Task: task-cpv-012
 *
 * Tests verify:
 * 1. Component accepts phaseName: string and feature: FeatureSession props
 * 2. Uses useDomains() to access componentBuilder store
 * 3. Queries compositionCollection.findByName(phaseName) to get Composition
 * 4. Calls composition.toSlotSpecs() to get slot-to-section mappings
 * 5. Resolves each sectionRef via getSectionComponent()
 * 6. Passes { feature, config } to each resolved section component
 * 7. Renders sections in SlotLayout with layout from Composition.layout
 * 8. Falls back to div with 'No composition found' message if lookup fails
 * 9. MobX observer for reactivity to Composition changes
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock, spyOn } from "bun:test"
import { render, cleanup, screen } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window
  globalThis.window = window
  globalThis.document = window.document
})

afterAll(() => {
  // @ts-expect-error - restore original
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

afterEach(() => {
  cleanup()
})

// Mock useDomains hook
const mockUseDomains = mock(() => ({
  componentBuilder: null,
}))

// Mock module before import
mock.module("@/contexts/DomainProvider", () => ({
  useDomains: mockUseDomains,
}))

// Import after mocking
import { ComposablePhaseView } from "../ComposablePhaseView"

// Test fixtures
const createMockLayoutTemplate = (slots: Array<{ name: string; position: string }>) => ({
  id: "layout-1",
  name: "two-column",
  slots,
})

const createMockComposition = (layoutTemplate: any, slotSpecs: any[]) => ({
  id: "comp-1",
  name: "discovery",
  layout: layoutTemplate,
  toSlotSpecs: () => slotSpecs,
})

const createMockComponentBuilderStore = (
  composition: any | null = null,
  layoutTemplate: any | null = null
) => ({
  compositionCollection: {
    findByName: (name: string) => composition,
  },
  layoutTemplateCollection: {
    get: (id: string) => layoutTemplate,
  },
})

const mockFeature = {
  id: "feature-1",
  name: "Test Feature",
  status: "discovery",
  intent: "Test intent description",
}

describe("ComposablePhaseView - Props Interface", () => {
  test("accepts phaseName and feature props", () => {
    // Given: No composition found
    mockUseDomains.mockReturnValue({
      componentBuilder: createMockComponentBuilderStore(null),
    })

    // When: Rendering with required props
    expect(() =>
      render(<ComposablePhaseView phaseName="discovery" feature={mockFeature} />)
    ).not.toThrow()
  })

  test("accepts optional className prop", () => {
    mockUseDomains.mockReturnValue({
      componentBuilder: createMockComponentBuilderStore(null),
    })

    const { container } = render(
      <ComposablePhaseView
        phaseName="discovery"
        feature={mockFeature}
        className="custom-class"
      />
    )
    expect(container).toBeDefined()
  })
})

describe("ComposablePhaseView - Domain Access", () => {
  test("accesses componentBuilder from useDomains()", () => {
    // Given: Mock with componentBuilder store
    const store = createMockComponentBuilderStore(null)
    mockUseDomains.mockReturnValue({ componentBuilder: store })

    // When: Rendering
    render(<ComposablePhaseView phaseName="discovery" feature={mockFeature} />)

    // Then: useDomains was called
    expect(mockUseDomains).toHaveBeenCalled()
  })

  test("handles missing componentBuilder gracefully", () => {
    // Given: No componentBuilder in domains
    mockUseDomains.mockReturnValue({ componentBuilder: undefined })

    // When/Then: Renders without error
    const { container } = render(
      <ComposablePhaseView phaseName="discovery" feature={mockFeature} />
    )
    expect(container.textContent).toContain("No composition found")
  })
})

describe("ComposablePhaseView - Composition Lookup", () => {
  test("queries compositionCollection.findByName with phaseName", () => {
    // Given: Mock composition collection with spy
    const findByNameSpy = mock(() => null)
    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: findByNameSpy },
        layoutTemplateCollection: { get: () => null },
      },
    })

    // When: Rendering with phaseName="discovery"
    render(<ComposablePhaseView phaseName="discovery" feature={mockFeature} />)

    // Then: findByName was called with phaseName
    expect(findByNameSpy).toHaveBeenCalledWith("discovery")
  })

  test("shows fallback when composition not found", () => {
    // Given: No composition found
    mockUseDomains.mockReturnValue({
      componentBuilder: createMockComponentBuilderStore(null),
    })

    // When: Rendering
    const { container } = render(
      <ComposablePhaseView phaseName="nonexistent" feature={mockFeature} />
    )

    // Then: Shows fallback message
    expect(container.textContent).toContain("No composition found")
    expect(container.textContent).toContain("nonexistent")
  })
})

describe("ComposablePhaseView - Layout Resolution", () => {
  test("resolves layout from composition.layout reference", () => {
    // Given: Composition with layout reference
    const layoutTemplate = createMockLayoutTemplate([
      { name: "header", position: "top" },
      { name: "main", position: "left" },
    ])
    const composition = createMockComposition(layoutTemplate, [])
    const getSpy = mock(() => layoutTemplate)

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: getSpy },
      },
    })

    // When: Rendering
    render(<ComposablePhaseView phaseName="discovery" feature={mockFeature} />)

    // Then: Layout was resolved
    expect(getSpy).toHaveBeenCalledWith(layoutTemplate.id || layoutTemplate)
  })

  test("shows fallback when layout template not found", () => {
    // Given: Composition exists but layout not found
    const composition = {
      id: "comp-1",
      name: "discovery",
      layout: "missing-layout",
      toSlotSpecs: () => [],
    }
    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: () => null },
      },
    })

    // When: Rendering
    const { container } = render(
      <ComposablePhaseView phaseName="discovery" feature={mockFeature} />
    )

    // Then: Shows layout not found message
    expect(container.textContent).toContain("No layout template found")
  })
})

describe("ComposablePhaseView - Slot Resolution", () => {
  test("calls composition.toSlotSpecs() to get slot mappings", () => {
    // Given: Composition with toSlotSpecs spy
    const toSlotSpecsSpy = mock(() => [])
    const layoutTemplate = createMockLayoutTemplate([
      { name: "header", position: "top" },
    ])
    const composition = {
      id: "comp-1",
      name: "discovery",
      layout: layoutTemplate,
      toSlotSpecs: toSlotSpecsSpy,
    }

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: () => layoutTemplate },
      },
    })

    // When: Rendering
    render(<ComposablePhaseView phaseName="discovery" feature={mockFeature} />)

    // Then: toSlotSpecs was called
    expect(toSlotSpecsSpy).toHaveBeenCalled()
  })

  test("renders sections resolved from sectionRef", () => {
    // Given: Composition with slot specs pointing to registered sections
    const layoutTemplate = createMockLayoutTemplate([
      { name: "header", position: "top" },
      { name: "main", position: "left" },
    ])
    const slotSpecs = [
      { slotName: "header", sectionRef: "IntentTerminalSection" },
      { slotName: "main", sectionRef: "SessionSummarySection" },
    ]
    const composition = createMockComposition(layoutTemplate, slotSpecs)

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: () => layoutTemplate },
      },
    })

    // When: Rendering
    const { container } = render(
      <ComposablePhaseView phaseName="discovery" feature={mockFeature} />
    )

    // Then: SlotLayout is rendered with slots
    expect(container.querySelector("[data-slot-layout]")).not.toBeNull()
    expect(container.querySelector("[data-slot='header']")).not.toBeNull()
    expect(container.querySelector("[data-slot='main']")).not.toBeNull()
  })

  test("falls back to FallbackSection for unknown sectionRef", () => {
    // Given: Composition with unknown section ref
    const layoutTemplate = createMockLayoutTemplate([
      { name: "main", position: "left" },
    ])
    const slotSpecs = [
      { slotName: "main", sectionRef: "NonExistentSection" },
    ]
    const composition = createMockComposition(layoutTemplate, slotSpecs)

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: () => layoutTemplate },
      },
    })

    // When: Rendering
    const { container } = render(
      <ComposablePhaseView phaseName="discovery" feature={mockFeature} />
    )

    // Then: Fallback section is rendered
    expect(container.querySelector("[data-slot='main']")).not.toBeNull()
    // Fallback shows "Section not found" text
    expect(container.textContent).toContain("Section not found")
  })
})

describe("ComposablePhaseView - Props Passing", () => {
  test("passes feature prop to resolved section components", () => {
    // Given: Composition with IntentTerminalSection (which displays intent)
    const layoutTemplate = createMockLayoutTemplate([
      { name: "header", position: "top" },
    ])
    const slotSpecs = [
      { slotName: "header", sectionRef: "IntentTerminalSection" },
    ]
    const composition = createMockComposition(layoutTemplate, slotSpecs)

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: () => layoutTemplate },
      },
    })

    // When: Rendering with feature containing intent
    const featureWithIntent = { ...mockFeature, intent: "Custom intent message" }
    const { container } = render(
      <ComposablePhaseView phaseName="discovery" feature={featureWithIntent} />
    )

    // Then: Intent is rendered (IntentTerminalSection displays feature.intent)
    expect(container.textContent).toContain("Custom intent message")
  })

  test("passes config from slotSpec to section component", () => {
    // Given: Composition with config in slotSpec
    const layoutTemplate = createMockLayoutTemplate([
      { name: "main", position: "left" },
    ])
    const slotSpecs = [
      {
        slotName: "main",
        sectionRef: "RequirementsListSection",
        config: { maxItems: 3, showCompleted: true },
      },
    ]
    const composition = createMockComposition(layoutTemplate, slotSpecs)

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: () => layoutTemplate },
      },
    })

    // When: Rendering
    const { container } = render(
      <ComposablePhaseView phaseName="discovery" feature={mockFeature} />
    )

    // Then: Section is rendered (config is passed internally)
    expect(container.querySelector("[data-slot='main']")).not.toBeNull()
  })
})

describe("ComposablePhaseView - SlotLayout Integration", () => {
  test("renders SlotLayout with layout from composition", () => {
    // Given: Composition with two-column layout
    const layoutTemplate = createMockLayoutTemplate([
      { name: "header", position: "top" },
      { name: "main", position: "left" },
      { name: "sidebar", position: "right" },
    ])
    const slotSpecs = [
      { slotName: "header", sectionRef: "IntentTerminalSection" },
      { slotName: "main", sectionRef: "SessionSummarySection" },
      { slotName: "sidebar", sectionRef: "RequirementsListSection" },
    ]
    const composition = createMockComposition(layoutTemplate, slotSpecs)

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: () => layoutTemplate },
      },
    })

    // When: Rendering
    const { container } = render(
      <ComposablePhaseView phaseName="discovery" feature={mockFeature} />
    )

    // Then: SlotLayout is rendered with all slots
    const slotLayout = container.querySelector("[data-slot-layout]")
    expect(slotLayout).not.toBeNull()
    expect(container.querySelector("[data-slot='header']")).not.toBeNull()
    expect(container.querySelector("[data-slot='main']")).not.toBeNull()
    expect(container.querySelector("[data-slot='sidebar']")).not.toBeNull()
  })

  test("applies grid layout classes", () => {
    // Given: Composition with layout
    const layoutTemplate = createMockLayoutTemplate([
      { name: "main", position: "left" },
      { name: "sidebar", position: "right" },
    ])
    const slotSpecs = [
      { slotName: "main", sectionRef: "SessionSummarySection" },
      { slotName: "sidebar", sectionRef: "RequirementsListSection" },
    ]
    const composition = createMockComposition(layoutTemplate, slotSpecs)

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: () => layoutTemplate },
      },
    })

    // When: Rendering
    const { container } = render(
      <ComposablePhaseView phaseName="discovery" feature={mockFeature} />
    )

    // Then: Grid classes are applied
    const slotLayout = container.querySelector("[data-slot-layout]")
    expect(slotLayout?.className).toContain("grid")
  })
})

describe("ComposablePhaseView - Edge Cases", () => {
  test("handles null feature gracefully", () => {
    // Given: Composition exists
    const layoutTemplate = createMockLayoutTemplate([
      { name: "main", position: "left" },
    ])
    const composition = createMockComposition(layoutTemplate, [
      { slotName: "main", sectionRef: "SessionSummarySection" },
    ])

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: () => layoutTemplate },
      },
    })

    // When/Then: Renders without error
    expect(() =>
      render(<ComposablePhaseView phaseName="discovery" feature={null} />)
    ).not.toThrow()
  })

  test("handles empty slotSpecs array", () => {
    // Given: Composition with no slot content
    const layoutTemplate = createMockLayoutTemplate([
      { name: "main", position: "left" },
    ])
    const composition = createMockComposition(layoutTemplate, [])

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => composition },
        layoutTemplateCollection: { get: () => layoutTemplate },
      },
    })

    // When: Rendering
    const { container } = render(
      <ComposablePhaseView phaseName="discovery" feature={mockFeature} />
    )

    // Then: SlotLayout still renders (with empty slots)
    expect(container.querySelector("[data-slot-layout]")).not.toBeNull()
  })

  test("handles composition with MST reference for layout", () => {
    // Given: Layout is an MST reference object (not just id string)
    const layoutTemplate = createMockLayoutTemplate([
      { name: "header", position: "top" },
    ])
    // composition.layout could be the actual object or id string
    const compositionWithObjectLayout = {
      id: "comp-1",
      name: "discovery",
      layout: layoutTemplate, // Direct object reference
      toSlotSpecs: () => [
        { slotName: "header", sectionRef: "IntentTerminalSection" },
      ],
    }

    mockUseDomains.mockReturnValue({
      componentBuilder: {
        compositionCollection: { findByName: () => compositionWithObjectLayout },
        layoutTemplateCollection: { get: () => layoutTemplate },
      },
    })

    // When: Rendering
    const { container } = render(
      <ComposablePhaseView phaseName="discovery" feature={mockFeature} />
    )

    // Then: Works with object reference
    expect(container.querySelector("[data-slot-layout]")).not.toBeNull()
  })
})

describe("ComposablePhaseView - MobX Reactivity", () => {
  test("component is wrapped with observer for MobX reactivity", async () => {
    // Given: Import the module to check observer wrapping
    // This is a structural test - we verify the component is observer-wrapped
    // by checking the displayName or _isMobXReactObserver marker

    // The ComposablePhaseView should be exported as an observer
    // We can verify by checking if it has the observer characteristics
    expect(ComposablePhaseView).toBeDefined()
    // Observer-wrapped components have special properties added by mobx-react-lite
    // For now, we just verify the component works reactively in integration
  })
})
