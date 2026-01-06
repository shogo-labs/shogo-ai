/**
 * Tests for ComponentRegistry and related React context/hooks
 * Task: task-component-registry
 *
 * Verifies:
 * 1. ComponentRegistry cascade resolution
 * 2. createComponentRegistry factory function
 * 3. ComponentRegistryProvider wraps children
 * 4. useComponentRegistry hook returns registry
 * 5. PropertyRenderer resolves and renders components
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test"
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

import { ComponentRegistry, createComponentRegistry } from "../ComponentRegistry"
import {
  ComponentRegistryProvider,
  useComponentRegistry
} from "../ComponentRegistryContext"
import { PropertyRenderer } from "../PropertyRenderer"
import type { PropertyMetadata, DisplayRendererProps, ComponentEntry } from "../types"

// Mock display components for testing
const StringDisplay = ({ value }: DisplayRendererProps) => (
  <span data-testid="string-display">{String(value)}</span>
)

const NumberDisplay = ({ value }: DisplayRendererProps) => (
  <span data-testid="number-display">{Number(value).toLocaleString()}</span>
)

const EmailDisplay = ({ value }: DisplayRendererProps) => (
  <a data-testid="email-display" href={`mailto:${value}`}>{String(value)}</a>
)

const ComputedDisplay = ({ value }: DisplayRendererProps) => (
  <span data-testid="computed-display" className="italic">{String(value)}</span>
)

const ReferenceDisplay = ({ value }: DisplayRendererProps) => (
  <span data-testid="reference-display">[Ref: {String(value)}]</span>
)

const EnumBadge = ({ value }: DisplayRendererProps) => (
  <span data-testid="enum-badge" className="badge">{String(value)}</span>
)

const CustomRenderer = ({ value }: DisplayRendererProps) => (
  <span data-testid="custom-renderer">Custom: {String(value)}</span>
)

const FallbackDisplay = ({ value }: DisplayRendererProps) => (
  <span data-testid="fallback-display">{String(value ?? "")}</span>
)

describe("ComponentRegistry class", () => {
  let registry: ComponentRegistry

  beforeEach(() => {
    registry = new ComponentRegistry(FallbackDisplay)
  })

  test("ComponentRegistry.resolve returns component for matching metadata", () => {
    registry.register({
      id: "string-display",
      matches: (meta) => meta.type === "string",
      component: StringDisplay,
      priority: 10
    })

    const meta: PropertyMetadata = { name: "test", type: "string" }
    const Component = registry.resolve(meta)

    expect(Component).toBe(StringDisplay)
  })

  test("Cascade priority order: xRenderer > xComputed > xReferenceType > enum > format > type > fallback", () => {
    // Register components with appropriate priorities
    registry.register({
      id: "custom-renderer",
      matches: (meta) => meta.xRenderer === "custom-renderer",
      component: CustomRenderer,
      priority: 200
    })

    registry.register({
      id: "computed-display",
      matches: (meta) => meta.xComputed === true,
      component: ComputedDisplay,
      priority: 100
    })

    registry.register({
      id: "reference-display",
      matches: (meta) => meta.xReferenceType === "single",
      component: ReferenceDisplay,
      priority: 100
    })

    registry.register({
      id: "enum-badge",
      matches: (meta) => Array.isArray(meta.enum) && meta.enum.length > 0,
      component: EnumBadge,
      priority: 50
    })

    registry.register({
      id: "email-display",
      matches: (meta) => meta.format === "email",
      component: EmailDisplay,
      priority: 30
    })

    registry.register({
      id: "string-display",
      matches: (meta) => meta.type === "string",
      component: StringDisplay,
      priority: 10
    })

    // Test xRenderer wins over everything
    const xRendererMeta: PropertyMetadata = {
      name: "test",
      type: "string",
      xComputed: true,
      xRenderer: "custom-renderer"
    }
    expect(registry.resolve(xRendererMeta)).toBe(CustomRenderer)

    // Test xComputed wins over type
    const computedMeta: PropertyMetadata = {
      name: "count",
      type: "number",
      xComputed: true
    }
    expect(registry.resolve(computedMeta)).toBe(ComputedDisplay)

    // Test xReferenceType wins over type
    const referenceMeta: PropertyMetadata = {
      name: "author",
      type: "string",
      xReferenceType: "single"
    }
    expect(registry.resolve(referenceMeta)).toBe(ReferenceDisplay)

    // Test enum wins over format and type
    const enumMeta: PropertyMetadata = {
      name: "status",
      type: "string",
      format: "email",
      enum: ["active", "inactive"]
    }
    expect(registry.resolve(enumMeta)).toBe(EnumBadge)

    // Test format wins over type
    const formatMeta: PropertyMetadata = {
      name: "email",
      type: "string",
      format: "email"
    }
    expect(registry.resolve(formatMeta)).toBe(EmailDisplay)

    // Test type alone
    const typeMeta: PropertyMetadata = {
      name: "name",
      type: "string"
    }
    expect(registry.resolve(typeMeta)).toBe(StringDisplay)
  })

  test("First matching predicate at same priority wins", () => {
    registry.register({
      id: "first-match",
      matches: (meta) => meta.type === "string",
      component: StringDisplay,
      priority: 10
    })

    registry.register({
      id: "second-match",
      matches: (meta) => meta.type === "string",
      component: NumberDisplay,
      priority: 10
    })

    const meta: PropertyMetadata = { name: "test", type: "string" }
    // First registered wins when priorities are equal
    expect(registry.resolve(meta)).toBe(StringDisplay)
  })

  test("Fallback to defaultComponent when no match", () => {
    // Register something that won't match
    registry.register({
      id: "number-display",
      matches: (meta) => meta.type === "number",
      component: NumberDisplay,
      priority: 10
    })

    const meta: PropertyMetadata = { name: "test", type: "boolean" }
    expect(registry.resolve(meta)).toBe(FallbackDisplay)
  })

  test("Registry handles PropertyMetadata with missing xReferenceTarget on reference field", () => {
    registry.register({
      id: "reference-display",
      matches: (meta) => meta.xReferenceType === "single",
      component: ReferenceDisplay,
      priority: 100
    })

    // Reference field without xReferenceTarget should still match on xReferenceType
    const meta: PropertyMetadata = {
      name: "authorId",
      type: "string",
      xReferenceType: "single"
      // Note: xReferenceTarget is missing
    }
    expect(registry.resolve(meta)).toBe(ReferenceDisplay)
  })
})

describe("createComponentRegistry factory", () => {
  test("createComponentRegistry factory function creates configured registry", () => {
    const registry = createComponentRegistry({
      defaultComponent: FallbackDisplay,
      entries: [
        {
          id: "string-display",
          matches: (meta) => meta.type === "string",
          component: StringDisplay,
          priority: 10
        }
      ]
    })

    const meta: PropertyMetadata = { name: "test", type: "string" }
    expect(registry.resolve(meta)).toBe(StringDisplay)

    // Verify entries() returns the registered entries
    expect(registry.entries().length).toBe(1)
    expect(registry.entries()[0].id).toBe("string-display")
  })

  test("registry.unregister removes entry by id", () => {
    const registry = createComponentRegistry({
      defaultComponent: FallbackDisplay,
      entries: [
        {
          id: "string-display",
          matches: (meta) => meta.type === "string",
          component: StringDisplay,
          priority: 10
        }
      ]
    })

    expect(registry.entries().length).toBe(1)
    const removed = registry.unregister("string-display")
    expect(removed).toBe(true)
    expect(registry.entries().length).toBe(0)

    // Should return false for non-existent id
    const notFound = registry.unregister("non-existent")
    expect(notFound).toBe(false)
  })
})

describe("ComponentRegistryProvider", () => {
  test("ComponentRegistryProvider wraps children with context", () => {
    const registry = createComponentRegistry({
      defaultComponent: FallbackDisplay,
      entries: []
    })

    const { container } = render(
      <ComponentRegistryProvider registry={registry}>
        <div data-testid="child">Child content</div>
      </ComponentRegistryProvider>
    )

    const child = container.querySelector('[data-testid="child"]')
    expect(child).toBeDefined()
    expect(child?.textContent).toBe("Child content")
  })
})

describe("useComponentRegistry hook", () => {
  test("useComponentRegistry hook returns registry instance", () => {
    const registry = createComponentRegistry({
      defaultComponent: FallbackDisplay,
      entries: [
        {
          id: "string-display",
          matches: (meta) => meta.type === "string",
          component: StringDisplay,
          priority: 10
        }
      ]
    })

    let hookResult: any = null

    const TestComponent = () => {
      hookResult = useComponentRegistry()
      return <div>Test</div>
    }

    render(
      <ComponentRegistryProvider registry={registry}>
        <TestComponent />
      </ComponentRegistryProvider>
    )

    expect(hookResult).toBe(registry)
  })

  test("useComponentRegistry throws outside provider", () => {
    const TestComponent = () => {
      useComponentRegistry()
      return <div>Test</div>
    }

    // Suppress React error boundary warnings
    const originalError = console.error
    console.error = () => {}

    expect(() => {
      render(<TestComponent />)
    }).toThrow()

    console.error = originalError
  })
})

describe("PropertyRenderer", () => {
  test("PropertyRenderer resolves and renders correct component", () => {
    const registry = createComponentRegistry({
      defaultComponent: FallbackDisplay,
      entries: [
        {
          id: "string-display",
          matches: (meta) => meta.type === "string",
          component: StringDisplay,
          priority: 10
        },
        {
          id: "number-display",
          matches: (meta) => meta.type === "number",
          component: NumberDisplay,
          priority: 10
        }
      ]
    })

    const { container, rerender } = render(
      <ComponentRegistryProvider registry={registry}>
        <PropertyRenderer
          property={{ name: "name", type: "string" }}
          value="John Doe"
        />
      </ComponentRegistryProvider>
    )

    let stringDisplay = container.querySelector('[data-testid="string-display"]')
    expect(stringDisplay?.textContent).toBe("John Doe")

    rerender(
      <ComponentRegistryProvider registry={registry}>
        <PropertyRenderer
          property={{ name: "count", type: "number" }}
          value={1234}
        />
      </ComponentRegistryProvider>
    )

    let numberDisplay = container.querySelector('[data-testid="number-display"]')
    expect(numberDisplay?.textContent).toBe("1,234")
  })

  test("PropertyRenderer uses fallback for unknown types", () => {
    const registry = createComponentRegistry({
      defaultComponent: FallbackDisplay,
      entries: []
    })

    const { container } = render(
      <ComponentRegistryProvider registry={registry}>
        <PropertyRenderer
          property={{ name: "unknown", type: "object" }}
          value="test value"
        />
      </ComponentRegistryProvider>
    )

    const fallback = container.querySelector('[data-testid="fallback-display"]')
    expect(fallback?.textContent).toBe("test value")
  })

  test("PropertyRenderer passes depth prop to component", () => {
    const DepthAwareComponent = ({ depth }: DisplayRendererProps) => (
      <span data-testid="depth-aware">Depth: {depth ?? 0}</span>
    )

    const registry = createComponentRegistry({
      defaultComponent: DepthAwareComponent,
      entries: []
    })

    const { container } = render(
      <ComponentRegistryProvider registry={registry}>
        <PropertyRenderer
          property={{ name: "test" }}
          value="test"
          depth={2}
        />
      </ComponentRegistryProvider>
    )

    const depthAware = container.querySelector('[data-testid="depth-aware"]')
    expect(depthAware?.textContent).toBe("Depth: 2")
  })
})
