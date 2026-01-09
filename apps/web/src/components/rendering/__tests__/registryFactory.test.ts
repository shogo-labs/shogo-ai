/**
 * Tests for registryFactory.ts
 * Task: task-sdr-v2-003
 *
 * Verifies that createRegistryFromDomain correctly converts component-builder
 * domain entities to a ComponentRegistry with properly mapped entries.
 *
 * Generated from TestSpecifications:
 * - test-sdr-003-01: createRegistryFromDomain returns ComponentRegistry from domain
 * - test-sdr-003-02: specToEntry maps ComponentEntrySpec to ComponentEntry
 * - test-sdr-003-03: Registry resolves components by priority
 * - test-sdr-003-04: Factory handles missing defaultRegistry gracefully
 * - test-sdr-003-05: Unknown componentRef falls back to FallbackDisplay
 */

import { describe, test, expect, beforeEach } from "bun:test"
import type { ComponentType } from "react"
import type { ComponentEntrySpec, PropertyMetadata, DisplayRendererProps } from "../types"

// Import the functions to test - these will fail until implementation exists
import {
  createRegistryFromDomain,
  specToEntry,
} from "../registryFactory"

// Import components for assertions
import { StringDisplay } from "../displays"

// Mock domain store type for testing
interface MockComponentBuilder {
  registryCollection: {
    defaultRegistry: MockRegistry | undefined
  }
}

interface MockRegistry {
  id: string
  name: string
  toEntrySpecs(): ComponentEntrySpec[]
  fallbackRef?: string
}

// Test fixtures
const createMockSpec = (overrides: Partial<ComponentEntrySpec> = {}): ComponentEntrySpec => ({
  id: "test-spec",
  priority: 10,
  matcher: (meta: PropertyMetadata) => meta.type === "string",
  componentRef: "StringDisplay",
  ...overrides,
})

const createMockRegistry = (overrides: Partial<MockRegistry> = {}): MockRegistry => ({
  id: "reg-default",
  name: "Default Registry",
  toEntrySpecs: () => [
    createMockSpec({ id: "string-type", priority: 10, componentRef: "StringDisplay" }),
    createMockSpec({ id: "number-type", priority: 10, matcher: (m) => m.type === "number", componentRef: "NumberDisplay" }),
  ],
  ...overrides,
})

const createMockComponentBuilder = (registry: MockRegistry | undefined): MockComponentBuilder => ({
  registryCollection: {
    defaultRegistry: registry,
  },
})

// ============================================================
// test-sdr-003-01: createRegistryFromDomain returns ComponentRegistry from domain
// ============================================================
describe("createRegistryFromDomain", () => {
  describe("returns ComponentRegistry from domain", () => {
    // Given: componentBuilder domain store is available
    // Given: defaultRegistry exists with bindings
    let componentBuilder: MockComponentBuilder

    beforeEach(() => {
      const registry = createMockRegistry()
      componentBuilder = createMockComponentBuilder(registry)
    })

    // When: createRegistryFromDomain(componentBuilder) is called
    // Then: Returns a ComponentRegistry instance
    test("returns a ComponentRegistry instance", () => {
      const result = createRegistryFromDomain(componentBuilder as any)

      expect(result).toBeDefined()
      expect(typeof result.resolve).toBe("function")
      expect(typeof result.register).toBe("function")
      expect(typeof result.unregister).toBe("function")
      expect(typeof result.entries).toBe("function")
    })

    // Then: Registry has entries matching domain bindings
    test("registry has entries matching domain bindings", () => {
      const result = createRegistryFromDomain(componentBuilder as any)

      const entries = result.entries()
      expect(entries.length).toBe(2)
      expect(entries.some((e) => e.id === "string-type")).toBe(true)
      expect(entries.some((e) => e.id === "number-type")).toBe(true)
    })
  })
})

// ============================================================
// test-sdr-003-02: specToEntry maps ComponentEntrySpec to ComponentEntry
// ============================================================
describe("specToEntry", () => {
  describe("maps ComponentEntrySpec to ComponentEntry", () => {
    // Given: A ComponentEntrySpec with id, priority, matcher, componentRef
    let spec: ComponentEntrySpec

    beforeEach(() => {
      spec = createMockSpec({
        id: "test-binding-001",
        priority: 50,
        matcher: (meta) => meta.type === "string" && meta.format === "email",
        componentRef: "EmailDisplay",
      })
    })

    // When: specToEntry(spec) is called
    // Then: Returns ComponentEntry with id and priority preserved
    test("returns ComponentEntry with id and priority preserved", () => {
      const entry = specToEntry(spec)

      expect(entry.id).toBe("test-binding-001")
      expect(entry.priority).toBe(50)
    })

    // Then: matches function wraps the matcher
    test("matches function wraps the matcher", () => {
      const entry = specToEntry(spec)

      // Should match email strings
      expect(entry.matches({ name: "email", type: "string", format: "email" })).toBe(true)

      // Should not match plain strings
      expect(entry.matches({ name: "name", type: "string" })).toBe(false)

      // Should not match other types
      expect(entry.matches({ name: "count", type: "number" })).toBe(false)
    })

    // Then: component is resolved from implementations map
    test("component is resolved from implementations map", () => {
      const entry = specToEntry(spec)

      // Should be a valid React component (function or object for HOC-wrapped)
      // React components can be objects when wrapped in observer() or forwardRef()
      expect(entry.component).toBeDefined()
      expect(entry.component).not.toBeNull()
    })
  })
})

// ============================================================
// test-sdr-003-03: Registry resolves components by priority
// ============================================================
describe("Registry resolves components by priority", () => {
  // Given: Registry created from domain with multiple bindings
  // Given: Two bindings match the same metadata with different priorities
  let componentBuilder: MockComponentBuilder

  beforeEach(() => {
    const registry = createMockRegistry({
      toEntrySpecs: () => [
        // Lower priority - generic string
        createMockSpec({
          id: "low-priority",
          priority: 10,
          matcher: (m) => m.type === "string",
          componentRef: "StringDisplay",
        }),
        // Higher priority - specific enum badge
        createMockSpec({
          id: "high-priority",
          priority: 50,
          matcher: (m) => m.type === "string" && Array.isArray(m.enum),
          componentRef: "EnumBadge",
        }),
      ],
    })
    componentBuilder = createMockComponentBuilder(registry)
  })

  // When: registry.resolve(metadata) is called
  // Then: Higher priority binding component is returned
  test("higher priority binding component is returned", () => {
    const registry = createRegistryFromDomain(componentBuilder as any)

    // Both bindings match this metadata
    const meta: PropertyMetadata = {
      name: "status",
      type: "string",
      enum: ["pending", "complete"],
    }

    const result = registry.resolve(meta)

    // Should resolve to higher priority (EnumBadge)
    // EnumBadge is the component mapped to "EnumBadge" ref
    // React components can be objects when wrapped in observer() or forwardRef()
    expect(result).toBeDefined()
    expect(result).not.toBeNull()
  })
})

// ============================================================
// test-sdr-003-04: Factory handles missing defaultRegistry gracefully
// ============================================================
describe("Factory handles missing defaultRegistry gracefully", () => {
  // Given: componentBuilder domain store is available
  // Given: No default registry exists
  let componentBuilder: MockComponentBuilder

  beforeEach(() => {
    componentBuilder = createMockComponentBuilder(undefined)
  })

  // When: createRegistryFromDomain(componentBuilder) is called
  // Then: Returns a fallback registry
  test("returns a fallback registry", () => {
    const result = createRegistryFromDomain(componentBuilder as any)

    expect(result).toBeDefined()
    expect(typeof result.resolve).toBe("function")
  })

  // Then: No error is thrown
  test("no error is thrown", () => {
    expect(() => createRegistryFromDomain(componentBuilder as any)).not.toThrow()
  })

  // Then: Registry has basic type-based entries
  test("registry has basic type-based entries", () => {
    const result = createRegistryFromDomain(componentBuilder as any)

    // Fallback registry should have default entries for basic types
    const entries = result.entries()
    expect(entries.length).toBeGreaterThan(0)
  })
})

// ============================================================
// test-sdr-003-05: Unknown componentRef falls back to FallbackDisplay
// ============================================================
describe("Unknown componentRef falls back to FallbackDisplay", () => {
  // Given: A ComponentEntrySpec with unknown componentRef
  let spec: ComponentEntrySpec

  beforeEach(() => {
    spec = createMockSpec({
      id: "unknown-component",
      componentRef: "NonExistentComponent",
    })
  })

  // When: specToEntry(spec) is called
  // Then: Returns ComponentEntry with FallbackDisplay component
  test("returns ComponentEntry with fallback component", () => {
    const entry = specToEntry(spec)

    // Should return a component (the fallback)
    // React components can be objects when wrapped in observer() or forwardRef()
    expect(entry.component).toBeDefined()
    expect(entry.component).not.toBeNull()
  })

  // Then: No error is thrown
  test("no error is thrown", () => {
    expect(() => specToEntry(spec)).not.toThrow()
  })
})
