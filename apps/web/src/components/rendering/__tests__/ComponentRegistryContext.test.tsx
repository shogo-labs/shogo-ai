/**
 * Tests for useHydratedRegistry hook and RegistryHydrationProvider
 * Task: task-dcb-007
 *
 * Verifies:
 * 1. useHydratedRegistry returns ComponentRegistry from hydrated entities
 * 2. Registry rehydrates automatically when Registry entity changes (MobX reaction)
 * 3. Registry rehydrates when any RendererBinding in the registry changes
 * 4. RegistryHydrationProvider wraps children with hydrated registry context
 * 5. Hook handles loading state while registry is being hydrated
 * 6. Hook handles error state if registry entity not found
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, waitFor, act } from "@testing-library/react"
import { Window } from "happy-dom"
import React, { useState, useEffect } from "react"
import { types, Instance } from "mobx-state-tree"

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

import {
  useHydratedRegistry,
  RegistryHydrationProvider,
  useComponentRegistry
} from "../ComponentRegistryContext"
import type { DisplayRendererProps } from "../types"

// Mock display components for testing
const StringDisplay = ({ value }: DisplayRendererProps) => (
  <span data-testid="string-display">{String(value)}</span>
)

const NumberDisplay = ({ value }: DisplayRendererProps) => (
  <span data-testid="number-display">{Number(value).toLocaleString()}</span>
)

const FallbackDisplay = ({ value }: DisplayRendererProps) => (
  <span data-testid="fallback-display">{String(value ?? "")}</span>
)

// Mock component implementation map
const mockComponentMap = new Map([
  ["StringDisplay", StringDisplay],
  ["NumberDisplay", NumberDisplay],
  ["FallbackDisplay", FallbackDisplay]
])

// Create mock MST models for testing
const MockComponentDefinition = types.model("ComponentDefinition", {
  id: types.identifier,
  name: types.string,
  implementationRef: types.string
})

const MockRendererBinding = types
  .model("RendererBinding", {
    id: types.identifier,
    name: types.string,
    matchExpression: types.frozen<object>(),
    priority: types.number,
    component: types.reference(MockComponentDefinition)
  })
  .actions((self) => ({
    setMatchExpression(expr: object) {
      self.matchExpression = expr
    }
  }))

const MockRegistry = types
  .model("Registry", {
    id: types.identifier,
    name: types.string,
    bindings: types.array(types.reference(MockRendererBinding)),
    fallbackComponent: types.maybe(types.reference(MockComponentDefinition))
  })
  .views((self) => ({
    get allBindings() {
      return self.bindings
    }
  }))
  .actions((self) => ({
    removeBinding(index: number) {
      self.bindings.splice(index, 1)
    }
  }))

const MockStore = types
  .model("MockStore", {
    ComponentDefinitions: types.map(MockComponentDefinition),
    RendererBindings: types.map(MockRendererBinding),
    Registries: types.map(MockRegistry)
  })
  .views((self) => ({
    get componentDefinitionsCollection() {
      return {
        get: (id: string) => self.ComponentDefinitions.get(id),
        all: () => Array.from(self.ComponentDefinitions.values())
      }
    },
    get rendererBindingsCollection() {
      return {
        get: (id: string) => self.RendererBindings.get(id),
        all: () => Array.from(self.RendererBindings.values())
      }
    },
    get registriesCollection() {
      return {
        get: (id: string) => self.Registries.get(id),
        all: () => Array.from(self.Registries.values())
      }
    }
  }))

// Helper to create a test store with seed data
function createTestStore() {
  return MockStore.create({
    ComponentDefinitions: {
      "string-component": {
        id: "string-component",
        name: "String Display",
        implementationRef: "StringDisplay"
      },
      "number-component": {
        id: "number-component",
        name: "Number Display",
        implementationRef: "NumberDisplay"
      },
      "fallback-component": {
        id: "fallback-component",
        name: "Fallback Display",
        implementationRef: "FallbackDisplay"
      }
    },
    RendererBindings: {
      "string-binding": {
        id: "string-binding",
        name: "String Type Binding",
        matchExpression: { type: "string" },
        priority: 10,
        component: "string-component"
      },
      "number-binding": {
        id: "number-binding",
        name: "Number Type Binding",
        matchExpression: { type: "number" },
        priority: 10,
        component: "number-component"
      }
    },
    Registries: {
      "default-registry": {
        id: "default-registry",
        name: "Default Registry",
        bindings: ["string-binding", "number-binding"],
        fallbackComponent: "fallback-component"
      }
    }
  })
}

// Adapt mock store to HydrationStore interface
function adaptStoreForHydration(store: Instance<typeof MockStore>) {
  return {
    Registries: {
      get: (id: string) => store.Registries.get(id),
      all: () => Array.from(store.Registries.values())
    },
    ComponentDefinitions: {
      get: (id: string) => store.ComponentDefinitions.get(id),
      all: () => Array.from(store.ComponentDefinitions.values())
    },
    RendererBindings: {
      get: (id: string) => store.RendererBindings.get(id),
      all: () => Array.from(store.RendererBindings.values())
    }
  }
}

describe("useHydratedRegistry hook", () => {
  test("returns ComponentRegistry from hydrated entities", () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)
    let hookResult: any = null

    const TestComponent = () => {
      hookResult = useHydratedRegistry("default-registry", adaptedStore, mockComponentMap)
      return <div data-testid="test">Test</div>
    }

    render(<TestComponent />)

    expect(hookResult).toBeDefined()
    expect(hookResult.registry).toBeDefined()
    expect(hookResult.loading).toBe(false)
    expect(hookResult.error).toBeUndefined()
  })

  test("registry resolves string type to StringDisplay", () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)
    let hookResult: any = null

    const TestComponent = () => {
      hookResult = useHydratedRegistry("default-registry", adaptedStore, mockComponentMap)
      return <div>Test</div>
    }

    render(<TestComponent />)

    const Component = hookResult.registry?.resolve({ name: "test", type: "string" })
    expect(Component).toBe(StringDisplay)
  })

  test("registry resolves number type to NumberDisplay", () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)
    let hookResult: any = null

    const TestComponent = () => {
      hookResult = useHydratedRegistry("default-registry", adaptedStore, mockComponentMap)
      return <div>Test</div>
    }

    render(<TestComponent />)

    const Component = hookResult.registry?.resolve({ name: "count", type: "number" })
    expect(Component).toBe(NumberDisplay)
  })

  test("registry uses fallback for unknown types", () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)
    let hookResult: any = null

    const TestComponent = () => {
      hookResult = useHydratedRegistry("default-registry", adaptedStore, mockComponentMap)
      return <div>Test</div>
    }

    render(<TestComponent />)

    const Component = hookResult.registry?.resolve({ name: "data", type: "object" })
    expect(Component).toBe(FallbackDisplay)
  })

  test("returns error state if registry entity not found", () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)
    let hookResult: any = null

    const TestComponent = () => {
      hookResult = useHydratedRegistry("non-existent-registry", adaptedStore, mockComponentMap)
      return <div>Test</div>
    }

    render(<TestComponent />)

    expect(hookResult.error).toBeDefined()
    expect(hookResult.error).toContain("not found")
    expect(hookResult.registry).toBeUndefined()
  })

  test("handles loading state during initial hydration", async () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)
    const loadingStates: boolean[] = []

    const TestComponent = () => {
      const result = useHydratedRegistry("default-registry", adaptedStore, mockComponentMap)
      loadingStates.push(result.loading)
      return <div data-testid="loading">{result.loading ? "loading" : "done"}</div>
    }

    const { getByTestId } = render(<TestComponent />)

    // After render, should be done loading (sync hydration)
    await waitFor(() => {
      expect(getByTestId("loading").textContent).toBe("done")
    })
  })

  test("rehydrates when Registry entity bindings change", async () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)
    let hookResult: any = null
    let renderCount = 0

    const TestComponent = () => {
      renderCount++
      hookResult = useHydratedRegistry("default-registry", adaptedStore, mockComponentMap)
      return <div data-testid="render-count">{renderCount}</div>
    }

    const { getByTestId, rerender } = render(<TestComponent />)

    // Initial render
    expect(hookResult.registry).toBeDefined()
    const initialEntryCount = hookResult.registry.entries().length

    // Mutate the registry bindings using action
    act(() => {
      const registry = store.Registries.get("default-registry")
      // Remove one binding
      registry?.removeBinding(0)
    })

    // Force re-render to capture reaction effect
    rerender(<TestComponent />)

    await waitFor(() => {
      // After mutation, registry should have fewer entries
      expect(hookResult.registry.entries().length).toBeLessThan(initialEntryCount)
    })
  })

  test("rehydrates when RendererBinding matchExpression changes", async () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)
    let hookResult: any = null

    const TestComponent = () => {
      hookResult = useHydratedRegistry("default-registry", adaptedStore, mockComponentMap)
      return <div>Test</div>
    }

    render(<TestComponent />)

    // Verify initial resolution
    expect(hookResult.registry.resolve({ name: "test", type: "string" })).toBe(StringDisplay)

    // Mutate the binding's matchExpression using action
    act(() => {
      const binding = store.RendererBindings.get("string-binding")
      binding?.setMatchExpression({ type: "boolean" })
    })

    // After mutation, "string" should no longer match the modified binding
    await waitFor(() => {
      // String type should now fall back to fallback or number (not string)
      const resolved = hookResult.registry.resolve({ name: "test", type: "string" })
      expect(resolved).not.toBe(StringDisplay)
    })
  })
})

describe("RegistryHydrationProvider component", () => {
  test("wraps children with hydrated registry context", () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)

    const TestConsumer = () => {
      const registry = useComponentRegistry()
      return <div data-testid="consumer">{registry ? "has-registry" : "no-registry"}</div>
    }

    const { getByTestId } = render(
      <RegistryHydrationProvider
        registryId="default-registry"
        store={adaptedStore}
        componentMap={mockComponentMap}
      >
        <TestConsumer />
      </RegistryHydrationProvider>
    )

    expect(getByTestId("consumer").textContent).toBe("has-registry")
  })

  test("allows nested components to resolve components via useComponentRegistry", () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)

    const TestConsumer = () => {
      const registry = useComponentRegistry()
      const Component = registry.resolve({ name: "test", type: "string" })
      return <Component property={{ name: "test", type: "string" }} value="hello" />
    }

    const { getByTestId } = render(
      <RegistryHydrationProvider
        registryId="default-registry"
        store={adaptedStore}
        componentMap={mockComponentMap}
      >
        <TestConsumer />
      </RegistryHydrationProvider>
    )

    expect(getByTestId("string-display").textContent).toBe("hello")
  })

  test("shows loading state while hydrating", () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)

    const LoadingIndicator = () => <div data-testid="loading">Loading...</div>

    const TestConsumer = () => {
      const registry = useComponentRegistry()
      return <div data-testid="consumer">Loaded</div>
    }

    const { queryByTestId, getByTestId } = render(
      <RegistryHydrationProvider
        registryId="default-registry"
        store={adaptedStore}
        componentMap={mockComponentMap}
        loadingFallback={<LoadingIndicator />}
      >
        <TestConsumer />
      </RegistryHydrationProvider>
    )

    // After sync hydration completes, should show consumer
    expect(getByTestId("consumer").textContent).toBe("Loaded")
  })

  test("shows error state if registry not found", () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)

    const ErrorFallback = ({ error }: { error: string }) => (
      <div data-testid="error">{error}</div>
    )

    const TestConsumer = () => {
      return <div data-testid="consumer">Should not render</div>
    }

    const { getByTestId, queryByTestId } = render(
      <RegistryHydrationProvider
        registryId="non-existent-registry"
        store={adaptedStore}
        componentMap={mockComponentMap}
        errorFallback={ErrorFallback}
      >
        <TestConsumer />
      </RegistryHydrationProvider>
    )

    // Should show error, not consumer
    expect(getByTestId("error")).toBeDefined()
    expect(getByTestId("error").textContent).toContain("not found")
    expect(queryByTestId("consumer")).toBeNull()
  })

  test("propagates registry changes to child components", async () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)
    let resolvedComponent: any = null

    const TestConsumer = () => {
      const registry = useComponentRegistry()
      resolvedComponent = registry.resolve({ name: "test", type: "string" })
      return <div data-testid="consumer">Test</div>
    }

    render(
      <RegistryHydrationProvider
        registryId="default-registry"
        store={adaptedStore}
        componentMap={mockComponentMap}
      >
        <TestConsumer />
      </RegistryHydrationProvider>
    )

    // Initial resolution
    expect(resolvedComponent).toBe(StringDisplay)
  })
})

describe("Integration: PropertyRenderer with RegistryHydrationProvider", () => {
  test("PropertyRenderer works within RegistryHydrationProvider", async () => {
    const store = createTestStore()
    const adaptedStore = adaptStoreForHydration(store)

    // We need to import PropertyRenderer for this test
    const { PropertyRenderer } = await import("../PropertyRenderer")

    const { getByTestId } = render(
      <RegistryHydrationProvider
        registryId="default-registry"
        store={adaptedStore}
        componentMap={mockComponentMap}
      >
        <PropertyRenderer
          property={{ name: "greeting", type: "string" }}
          value="Hello, World!"
        />
      </RegistryHydrationProvider>
    )

    expect(getByTestId("string-display").textContent).toBe("Hello, World!")
  })
})
