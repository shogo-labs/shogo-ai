/**
 * Provider Implementation Map Tests
 * Task: task-testing-009
 *
 * Tests verify:
 * 1. TestingPanelProvider is registered in providerImplementationMap
 * 2. getProviderComponent retrieves TestingPanelProvider correctly
 * 3. Provider wrapper pattern works with ComposablePhaseView
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup } from "@testing-library/react"
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

// Import the module under test
import {
  providerImplementationMap,
  getProviderComponent,
  type ProviderWrapperProps,
} from "../providerImplementationMap"
import { TestingPanelProvider } from "../../sections/testing/TestingPanelContext"
import { AnalysisPanelProvider } from "../../sections/analysis/AnalysisPanelContext"

describe("providerImplementationMap - Registration", () => {
  test("TestingPanelProvider is registered in the map", () => {
    // Given: The provider implementation map
    // When: Looking up TestingPanelProvider
    const registered = providerImplementationMap.get("TestingPanelProvider")

    // Then: It should be the TestingPanelProvider component
    expect(registered).toBeDefined()
    expect(registered).toBe(TestingPanelProvider)
  })

  test("AnalysisPanelProvider is registered in the map", () => {
    // Given: The provider implementation map
    // When: Looking up AnalysisPanelProvider
    const registered = providerImplementationMap.get("AnalysisPanelProvider")

    // Then: It should be the AnalysisPanelProvider component
    expect(registered).toBeDefined()
    expect(registered).toBe(AnalysisPanelProvider)
  })

  test("map contains both Testing and Analysis providers", () => {
    // Given: The provider implementation map
    // When: Checking registered keys
    const keys = Array.from(providerImplementationMap.keys())

    // Then: Should include both phase providers
    expect(keys).toContain("TestingPanelProvider")
    expect(keys).toContain("AnalysisPanelProvider")
  })
})

describe("getProviderComponent - Lookup", () => {
  test("returns TestingPanelProvider for 'TestingPanelProvider' key", () => {
    // Given: The getProviderComponent helper
    // When: Looking up TestingPanelProvider
    const provider = getProviderComponent("TestingPanelProvider")

    // Then: Should return the TestingPanelProvider component
    expect(provider).toBe(TestingPanelProvider)
  })

  test("returns AnalysisPanelProvider for 'AnalysisPanelProvider' key", () => {
    // Given: The getProviderComponent helper
    // When: Looking up AnalysisPanelProvider
    const provider = getProviderComponent("AnalysisPanelProvider")

    // Then: Should return the AnalysisPanelProvider component
    expect(provider).toBe(AnalysisPanelProvider)
  })

  test("returns null for empty string", () => {
    // Given: The getProviderComponent helper
    // When: Looking up with empty string
    const provider = getProviderComponent("")

    // Then: Should return null
    expect(provider).toBeNull()
  })

  test("returns null for unregistered provider name", () => {
    // Given: The getProviderComponent helper
    // When: Looking up non-existent provider
    const provider = getProviderComponent("NonExistentProvider")

    // Then: Should return null
    expect(provider).toBeNull()
  })
})

describe("TestingPanelProvider - Wrapper Rendering", () => {
  const mockFeature = {
    id: "feature-1",
    name: "Test Feature",
    status: "testing",
  }

  test("TestingPanelProvider renders children", () => {
    // Given: TestingPanelProvider from the map
    const Provider = getProviderComponent("TestingPanelProvider")!

    // When: Rendering with children
    const { container } = render(
      <Provider feature={mockFeature} config={{}}>
        <div data-testid="child-content">Child Content</div>
      </Provider>
    )

    // Then: Children should be rendered
    expect(container.querySelector("[data-testid='child-content']")).not.toBeNull()
    expect(container.textContent).toContain("Child Content")
  })

  test("TestingPanelProvider adds data-provider-wrapper attribute", () => {
    // Given: TestingPanelProvider from the map
    const Provider = getProviderComponent("TestingPanelProvider")!

    // When: Rendering
    const { container } = render(
      <Provider feature={mockFeature} config={{}}>
        <div>Content</div>
      </Provider>
    )

    // Then: Should have data-provider-wrapper attribute
    const wrapper = container.querySelector("[data-provider-wrapper='TestingPanelProvider']")
    expect(wrapper).not.toBeNull()
  })

  test("TestingPanelProvider can be used as ComposablePhaseView wrapper", () => {
    // Given: A mock composition with providerWrapper set to TestingPanelProvider
    const Provider = getProviderComponent("TestingPanelProvider")!

    // When: Rendering similar to how ComposablePhaseView would wrap content
    const { container } = render(
      <Provider feature={mockFeature} config={{ someConfig: "value" }}>
        <div data-slot-layout>
          <div data-slot="main">Main Content</div>
          <div data-slot="sidebar">Sidebar Content</div>
        </div>
      </Provider>
    )

    // Then: SlotLayout content should be wrapped by the provider
    const providerWrapper = container.querySelector("[data-provider-wrapper]")
    const slotLayout = container.querySelector("[data-slot-layout]")

    expect(providerWrapper).not.toBeNull()
    expect(slotLayout).not.toBeNull()
    // SlotLayout should be inside the provider wrapper
    expect(providerWrapper?.contains(slotLayout)).toBe(true)
  })
})

describe("ProviderWrapperProps Interface", () => {
  test("TestingPanelProvider accepts feature prop", () => {
    // Given: TestingPanelProvider
    const Provider = getProviderComponent("TestingPanelProvider")!
    const feature = { id: "feat-1", name: "Feature", testSpecifications: [] }

    // When: Rendering with feature prop
    const { container } = render(
      <Provider feature={feature} config={{}}>
        <div>Content</div>
      </Provider>
    )

    // Then: Should render without error
    expect(container.textContent).toContain("Content")
  })

  test("TestingPanelProvider accepts optional config prop", () => {
    // Given: TestingPanelProvider
    const Provider = getProviderComponent("TestingPanelProvider")!
    const feature = { id: "feat-1", name: "Feature" }
    const config = { customSetting: true }

    // When: Rendering with config prop
    const { container } = render(
      <Provider feature={feature} config={config}>
        <div>Content</div>
      </Provider>
    )

    // Then: Should render without error
    expect(container.textContent).toContain("Content")
  })
})
