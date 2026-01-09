/**
 * Component Builder Seed Data Config Tests
 *
 * TDD: RED phase - Tests written before implementation
 * Tests for supportedConfig on ComponentDefinitions and defaultConfig on RendererBindings.
 */

import { describe, test, expect } from "bun:test"
import {
  COMPONENT_DEFINITIONS,
  RENDERER_BINDINGS,
  REGISTRIES
} from "../component-builder"

describe("component-builder seed data with config", () => {
  describe("COMPONENT_DEFINITIONS supportedConfig", () => {
    test("StringDisplay has supportedConfig", () => {
      const stringDisplay = COMPONENT_DEFINITIONS.find(
        (c) => c.implementationRef === "StringDisplay"
      )
      expect(stringDisplay).toBeDefined()
      expect(stringDisplay?.supportedConfig).toContain("size")
      expect(stringDisplay?.supportedConfig).toContain("truncate")
      expect(stringDisplay?.supportedConfig).toContain("variant")
    })

    test("NumberDisplay has supportedConfig", () => {
      const numberDisplay = COMPONENT_DEFINITIONS.find(
        (c) => c.implementationRef === "NumberDisplay"
      )
      expect(numberDisplay).toBeDefined()
      expect(numberDisplay?.supportedConfig).toContain("size")
    })

    test("EnumBadge has supportedConfig", () => {
      const enumBadge = COMPONENT_DEFINITIONS.find(
        (c) => c.implementationRef === "EnumBadge"
      )
      expect(enumBadge).toBeDefined()
      expect(enumBadge?.supportedConfig).toContain("variant")
      expect(enumBadge?.supportedConfig).toContain("size")
    })

    test("BooleanDisplay has supportedConfig", () => {
      const boolDisplay = COMPONENT_DEFINITIONS.find(
        (c) => c.implementationRef === "BooleanDisplay"
      )
      expect(boolDisplay).toBeDefined()
      expect(boolDisplay?.supportedConfig).toContain("size")
    })

    test("all primitive display components have supportedConfig array", () => {
      const primitiveComponents = COMPONENT_DEFINITIONS.filter((c) =>
        c.tags?.includes("primitive")
      )
      expect(primitiveComponents.length).toBeGreaterThan(0)

      for (const comp of primitiveComponents) {
        expect(
          Array.isArray(comp.supportedConfig),
          `${comp.implementationRef} should have supportedConfig array`
        ).toBe(true)
        expect(
          comp.supportedConfig!.length,
          `${comp.implementationRef} supportedConfig should not be empty`
        ).toBeGreaterThan(0)
      }
    })
  })

  describe("RENDERER_BINDINGS defaultConfig", () => {
    test("string-display binding has sensible defaults", () => {
      const stringBinding = RENDERER_BINDINGS.find(
        (b) => b.id === "string-display"
      )
      expect(stringBinding).toBeDefined()
      expect(stringBinding?.defaultConfig).toBeDefined()
      expect(stringBinding?.defaultConfig?.truncate).toBe(200)
    })

    test("enum-badge binding has emphasized variant", () => {
      const enumBinding = RENDERER_BINDINGS.find((b) => b.id === "enum-badge")
      expect(enumBinding).toBeDefined()
      expect(enumBinding?.defaultConfig?.variant).toBe("emphasized")
    })

    test("number-display binding has default size", () => {
      const numberBinding = RENDERER_BINDINGS.find(
        (b) => b.id === "number-display"
      )
      expect(numberBinding).toBeDefined()
      expect(numberBinding?.defaultConfig?.size).toBe("md")
    })

    test("boolean-display binding has default size", () => {
      const boolBinding = RENDERER_BINDINGS.find(
        (b) => b.id === "boolean-display"
      )
      expect(boolBinding).toBeDefined()
      expect(boolBinding?.defaultConfig?.size).toBe("md")
    })
  })

  describe("REGISTRIES hierarchy", () => {
    test("has default and studio registries", () => {
      const names = REGISTRIES.map((r) => r.name)
      expect(names).toContain("default")
      expect(names).toContain("studio")
    })

    test("studio extends default", () => {
      const studioReg = REGISTRIES.find((r) => r.name === "studio")
      expect(studioReg?.extends).toBe("default")
    })

    test("default has fallback component", () => {
      const defaultReg = REGISTRIES.find((r) => r.name === "default")
      expect(defaultReg?.fallbackComponent).toBe("comp-string-display")
    })
  })
})
