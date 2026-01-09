/**
 * Tests for useComponentBuilderStore Hook
 * Task: task-dcb-008
 *
 * TDD tests for the component builder store hook that provides typed access
 * to the component-builder schema store.
 *
 * Acceptance Criteria:
 * 1. useComponentBuilderStore() returns typed store with collections
 * 2. Hook handles async schema loading with loading/error states
 * 3. Returns componentDefinitions, registries, rendererBindings collections
 * 4. Collections support .all(), .get(id) operations
 * 5. Hook is reactive via MobX observer pattern
 * 6. Works with existing WavesmithMetaStoreContext pattern
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock, spyOn } from "bun:test"
import React, { useEffect, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { Window } from "happy-dom"
import { cleanup } from "@testing-library/react"
import { EnvironmentProvider, createEnvironment } from "../../../../../contexts/EnvironmentContext"
import { WavesmithMetaStoreProvider } from "../../../../../contexts/WavesmithMetaStoreContext"

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
  cleanup()
})

// ============================================================
// Mock Persistence for Testing
// ============================================================

// Use valid UUIDs for test data
const TEST_SCHEMA_ID = "550e8400-e29b-41d4-a716-446655440000"
const COMP_ID_1 = "550e8400-e29b-41d4-a716-446655440001"
const COMP_ID_2 = "550e8400-e29b-41d4-a716-446655440002"
const REG_ID_1 = "550e8400-e29b-41d4-a716-446655440003"
const BIND_ID_1 = "550e8400-e29b-41d4-a716-446655440004"
const BIND_ID_2 = "550e8400-e29b-41d4-a716-446655440005"

const mockSchema = {
  id: TEST_SCHEMA_ID,
  name: "component-builder",
  models: [
    { name: "ComponentDefinition" },
    { name: "Registry" },
    { name: "RendererBinding" },
  ],
}

const mockComponentDefinitions = [
  { id: COMP_ID_1, name: "StringDisplay", category: "display", implementationRef: "StringDisplay", createdAt: Date.now() },
  { id: COMP_ID_2, name: "NumberDisplay", category: "display", implementationRef: "NumberDisplay", createdAt: Date.now() },
]

const mockRegistries = [
  { id: REG_ID_1, name: "default", createdAt: Date.now() },
]

const mockRendererBindings = [
  { id: BIND_ID_1, name: "string-type", registry: REG_ID_1, component: COMP_ID_1, matchExpression: { type: "string" }, priority: 10, createdAt: Date.now() },
  { id: BIND_ID_2, name: "number-type", registry: REG_ID_1, component: COMP_ID_2, matchExpression: { type: "number" }, priority: 10, createdAt: Date.now() },
]

// Enhanced JSON Schema for component-builder (shared between tests)
const mockEnhancedSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "component-builder",
  $defs: {
    ComponentDefinition: {
      type: "object",
      properties: {
        id: { type: "string", "x-mst-type": "identifier" },
        name: { type: "string" },
        category: { type: "string" },
        implementationRef: { type: "string" },
        createdAt: { type: "number" },
      },
      required: ["id", "name", "category", "implementationRef", "createdAt"],
    },
    Registry: {
      type: "object",
      properties: {
        id: { type: "string", "x-mst-type": "identifier" },
        name: { type: "string" },
        createdAt: { type: "number" },
      },
      required: ["id", "name", "createdAt"],
    },
    RendererBinding: {
      type: "object",
      properties: {
        id: { type: "string", "x-mst-type": "identifier" },
        name: { type: "string" },
        registry: { type: "string", "x-mst-type": "reference", "x-reference-target": "Registry" },
        component: { type: "string", "x-mst-type": "reference", "x-reference-target": "ComponentDefinition" },
        matchExpression: { type: "object" },
        priority: { type: "number" },
        createdAt: { type: "number" },
      },
      required: ["id", "name", "registry", "component", "matchExpression", "priority", "createdAt"],
    },
  },
}

// Create a configurable mock persistence
function createMockPersistence(options: { shouldFail?: boolean; delay?: number } = {}) {
  const { shouldFail = false, delay = 0 } = options

  return {
    loadCollection: async (context: any) => {
      if (shouldFail) throw new Error("Load collection failed")
      if (delay > 0) await new Promise(r => setTimeout(r, delay))

      const modelName = context?.modelName || context
      if (modelName === "ComponentDefinition") return { items: Object.fromEntries(mockComponentDefinitions.map(c => [c.id, c])) }
      if (modelName === "Registry") return { items: Object.fromEntries(mockRegistries.map(r => [r.id, r])) }
      if (modelName === "RendererBinding") return { items: Object.fromEntries(mockRendererBindings.map(b => [b.id, b])) }
      return { items: {} }
    },
    saveCollection: async () => {},
    loadEntity: async () => null,
    saveEntity: async () => {},
    loadSchema: async (name: string) => {
      if (shouldFail) throw new Error("Load schema failed")
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      if (name === "component-builder") {
        // Return the correct format: { metadata, enhanced }
        return {
          metadata: {
            name: "component-builder",
            id: mockSchema.id,
          },
          enhanced: mockEnhancedSchema,
        }
      }
      return null
    },
    listSchemas: async () => ["component-builder"],
  }
}

// ============================================================
// Test 1: Hook exports required interface
// ============================================================

describe("task-dcb-008-001: useComponentBuilderStore returns typed store with collections", () => {
  test("Hook returns loading state initially", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence({ delay: 100 })
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("loading")
    expect(typeof hookResult!.loading).toBe("boolean")
  })

  test("Hook returns error state", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("error")
    // error should be Error | null
    expect(hookResult!.error === null || hookResult!.error instanceof Error).toBe(true)
  })

  test("Hook returns store object or null", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("store")
    // store should be object | null
    expect(hookResult!.store === null || typeof hookResult!.store === "object").toBe(true)
  })
})

// ============================================================
// Test 2: Hook handles async schema loading
// ============================================================

describe("task-dcb-008-002: Hook handles async schema loading with loading/error states", () => {
  test("Hook shows loading=true while schema loads", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence({ delay: 200 })
    const env = createEnvironment({ persistence: mockPersistence })

    const loadingStates: boolean[] = []

    const TestComponent: React.FC = () => {
      const result = useComponentBuilderStore()
      loadingStates.push(result.loading)
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Initial render should have loading=true
    expect(loadingStates[0]).toBe(true)
  })

  test("Hook shows loading=false after schema loads", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence({ delay: 50 })
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.loading).toBe(false)
  })

  test("Hook sets error when schema load fails", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence({ shouldFail: true })
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for error to propagate
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.error).toBeInstanceOf(Error)
    expect(hookResult!.loading).toBe(false)
  })
})

// ============================================================
// Test 3: Hook returns correct collections
// ============================================================

describe("task-dcb-008-003: Returns componentDefinitions, registries, rendererBindings collections", () => {
  test("Store has componentDefinitions collection", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.store).not.toBeNull()
    expect(hookResult!.store).toHaveProperty("componentDefinitions")
  })

  test("Store has registries collection", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.store).not.toBeNull()
    expect(hookResult!.store).toHaveProperty("registries")
  })

  test("Store has rendererBindings collection", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.store).not.toBeNull()
    expect(hookResult!.store).toHaveProperty("rendererBindings")
  })
})

// ============================================================
// Test 4: Collections support .all() and .get(id) operations
// ============================================================

describe("task-dcb-008-004: Collections support .all(), .get(id) operations", () => {
  test("componentDefinitions.all() returns array", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.store).not.toBeNull()
    expect(typeof hookResult!.store!.componentDefinitions.all).toBe("function")
    expect(Array.isArray(hookResult!.store!.componentDefinitions.all())).toBe(true)
  })

  test("componentDefinitions.get(id) returns entity or undefined", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.store).not.toBeNull()
    expect(typeof hookResult!.store!.componentDefinitions.get).toBe("function")
    // Should return undefined for non-existent id
    const result = hookResult!.store!.componentDefinitions.get("non-existent")
    expect(result === undefined || result === null || typeof result === "object").toBe(true)
  })

  test("registries.all() returns array", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.store).not.toBeNull()
    expect(typeof hookResult!.store!.registries.all).toBe("function")
    expect(Array.isArray(hookResult!.store!.registries.all())).toBe(true)
  })

  test("registries.get(id) returns entity or undefined", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.store).not.toBeNull()
    expect(typeof hookResult!.store!.registries.get).toBe("function")
  })

  test("rendererBindings.all() returns array", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.store).not.toBeNull()
    expect(typeof hookResult!.store!.rendererBindings.all).toBe("function")
    expect(Array.isArray(hookResult!.store!.rendererBindings.all())).toBe(true)
  })

  test("rendererBindings.get(id) returns entity or undefined", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.store).not.toBeNull()
    expect(typeof hookResult!.store!.rendererBindings.get).toBe("function")
  })

  test("rendererBindings.forRegistry(registryId) returns filtered array", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <WavesmithMetaStoreProvider>
            <TestComponent />
          </WavesmithMetaStoreProvider>
        </EnvironmentProvider>
      )
    })

    // Wait for schema to load
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    expect(hookResult).not.toBeNull()
    expect(hookResult!.store).not.toBeNull()
    expect(typeof hookResult!.store!.rendererBindings.forRegistry).toBe("function")
    expect(Array.isArray(hookResult!.store!.rendererBindings.forRegistry("some-registry-id"))).toBe(true)
  })
})

// ============================================================
// Test 5: Hook uses WavesmithMetaStoreContext pattern
// ============================================================

describe("task-dcb-008-005: Works with existing WavesmithMetaStoreContext pattern", () => {
  test("Hook uses useOptionalWavesmithMetaStore internally", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useComponentBuilderStore.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should import and use useOptionalWavesmithMetaStore (graceful fallback pattern)
    expect(hookSource).toMatch(/useOptionalWavesmithMetaStore/)
  })

  test("Hook loads component-builder schema by name", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useComponentBuilderStore.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should load schema with name "component-builder"
    expect(hookSource).toMatch(/component-builder/)
  })

  test("Hook returns null store when used outside WavesmithMetaStoreProvider", async () => {
    const { useComponentBuilderStore } = await import("../useComponentBuilderStore")

    const mockPersistence = createMockPersistence()
    const env = createEnvironment({ persistence: mockPersistence })

    let hookResult: ReturnType<typeof useComponentBuilderStore> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useComponentBuilderStore()
      return null
    }

    // Render without WavesmithMetaStoreProvider - should gracefully return null store
    await act(async () => {
      root.render(
        <EnvironmentProvider env={env}>
          <TestComponent />
        </EnvironmentProvider>
      )
    })

    // Hook should return gracefully (not throw)
    expect(hookResult).not.toBeNull()
    expect(hookResult!.loading).toBe(false)
    expect(hookResult!.error).toBeNull()
    expect(hookResult!.store).toBeNull()
  })
})

// ============================================================
// Test 6: Interface type definitions
// ============================================================

describe("task-dcb-008-006: Hook exports correct TypeScript interface", () => {
  test("Hook file exports ComponentBuilderStoreResult type", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useComponentBuilderStore.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should export ComponentBuilderStoreResult type
    expect(hookSource).toMatch(/export\s+(interface|type)\s+ComponentBuilderStoreResult/)
  })

  test("ComponentBuilderStoreResult has loading property", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useComponentBuilderStore.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Interface should have loading: boolean
    expect(hookSource).toMatch(/loading:\s*boolean/)
  })

  test("ComponentBuilderStoreResult has error property", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useComponentBuilderStore.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Interface should have error: Error | null
    expect(hookSource).toMatch(/error:\s*Error\s*\|\s*null/)
  })

  test("ComponentBuilderStoreResult has store property", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useComponentBuilderStore.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Interface should have store property
    expect(hookSource).toMatch(/store:/)
  })
})
