/**
 * Generated from TestSpecifications for task-sdr-v2-001
 * Task: seed-data-constants-file
 *
 * Tests that the component-builder seed data exports match the expected structure:
 * - 26 COMPONENT_DEFINITIONS
 * - 2 REGISTRIES (default and studio)
 * - 28 RENDERER_BINDINGS (13 default + 15 studio)
 */

import { describe, test, expect } from "bun:test"

import {
  COMPONENT_DEFINITIONS,
  REGISTRIES,
  RENDERER_BINDINGS,
} from "../component-builder"

// =============================================================================
// test-sdr-001-01: COMPONENT_DEFINITIONS array structure
// =============================================================================
describe("Seed data file exports COMPONENT_DEFINITIONS array", () => {
  test("COMPONENT_DEFINITIONS is an array", () => {
    expect(Array.isArray(COMPONENT_DEFINITIONS)).toBe(true)
  })

  test("Array has 26 entries", () => {
    expect(COMPONENT_DEFINITIONS).toHaveLength(26)
  })

  test("Each entry has id, name, category, implementationRef fields", () => {
    for (const def of COMPONENT_DEFINITIONS) {
      expect(def).toHaveProperty("id")
      expect(typeof def.id).toBe("string")

      expect(def).toHaveProperty("name")
      expect(typeof def.name).toBe("string")

      expect(def).toHaveProperty("category")
      expect(typeof def.category).toBe("string")

      expect(def).toHaveProperty("implementationRef")
      expect(typeof def.implementationRef).toBe("string")
    }
  })
})

// =============================================================================
// test-sdr-001-02: REGISTRIES array structure
// =============================================================================
describe("Seed data file exports REGISTRIES array", () => {
  test("REGISTRIES is an array", () => {
    expect(Array.isArray(REGISTRIES)).toBe(true)
  })

  test("Array has 2 entries (default and studio)", () => {
    expect(REGISTRIES).toHaveLength(2)
  })

  test("default registry has id='default'", () => {
    const defaultRegistry = REGISTRIES.find((r) => r.id === "default")
    expect(defaultRegistry).toBeDefined()
    expect(defaultRegistry!.id).toBe("default")
    expect(defaultRegistry!.name).toBe("default")
  })

  test("studio registry has id='studio' and extends='default'", () => {
    const studioRegistry = REGISTRIES.find((r) => r.id === "studio")
    expect(studioRegistry).toBeDefined()
    expect(studioRegistry!.id).toBe("studio")
    expect(studioRegistry!.extends).toBe("default")
  })
})

// =============================================================================
// test-sdr-001-03: RENDERER_BINDINGS array structure
// =============================================================================
describe("Seed data file exports RENDERER_BINDINGS array", () => {
  test("RENDERER_BINDINGS is an array", () => {
    expect(Array.isArray(RENDERER_BINDINGS)).toBe(true)
  })

  test("Array has 27 entries (12 default + 15 studio)", () => {
    // 12 default bindings + 15 studio bindings = 27 total
    expect(RENDERER_BINDINGS).toHaveLength(27)
  })

  test("Each entry has id, registry, component, matchExpression, priority fields", () => {
    for (const binding of RENDERER_BINDINGS) {
      expect(binding).toHaveProperty("id")
      expect(typeof binding.id).toBe("string")

      expect(binding).toHaveProperty("registry")
      expect(typeof binding.registry).toBe("string")

      expect(binding).toHaveProperty("component")
      expect(typeof binding.component).toBe("string")

      expect(binding).toHaveProperty("matchExpression")
      expect(typeof binding.matchExpression).toBe("object")

      expect(binding).toHaveProperty("priority")
      expect(typeof binding.priority).toBe("number")
    }
  })
})

// =============================================================================
// test-sdr-001-04: All seed entities have unique IDs
// =============================================================================
describe("All seed entities have unique IDs", () => {
  test("No duplicate IDs exist across all entities", () => {
    const allIds = [
      ...COMPONENT_DEFINITIONS.map((d) => d.id),
      ...REGISTRIES.map((r) => r.id),
      ...RENDERER_BINDINGS.map((b) => b.id),
    ]

    const uniqueIds = new Set(allIds)
    expect(uniqueIds.size).toBe(allIds.length)
  })

  test("Set size equals total entity count", () => {
    const allIds = [
      ...COMPONENT_DEFINITIONS.map((d) => d.id),
      ...REGISTRIES.map((r) => r.id),
      ...RENDERER_BINDINGS.map((b) => b.id),
    ]

    // Total: 26 + 2 + 27 = 55
    expect(allIds.length).toBe(55)
  })
})
