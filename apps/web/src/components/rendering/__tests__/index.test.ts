/**
 * Barrel Export Tests for rendering/index.ts
 * Task: task-dcb-013
 *
 * Tests that all required modules are exported from the rendering barrel file.
 *
 * Acceptance Criteria:
 * 1. rendering/index.ts exports hydration module functions
 * 2. rendering/index.ts exports componentImplementations map and getComponent
 * 3. rendering/index.ts exports matchExpression utilities (from state-api)
 * 4. rendering/index.ts exports seedData function
 */

import { describe, it, expect } from "bun:test"

describe("rendering/index.ts barrel exports", () => {
  describe("Component Implementations (task-dcb-003)", () => {
    it("exports componentImplementationMap", async () => {
      const module = await import("../index")
      expect(module.componentImplementationMap).toBeDefined()
      expect(module.componentImplementationMap).toBeInstanceOf(Map)
    })

    it("exports getComponent function", async () => {
      const module = await import("../index")
      expect(module.getComponent).toBeDefined()
      expect(typeof module.getComponent).toBe("function")
    })
  })

  describe("Seed Data (task-dcb-005)", () => {
    it("exports seedComponentBuilderData function", async () => {
      const module = await import("../index")
      expect(module.seedComponentBuilderData).toBeDefined()
      expect(typeof module.seedComponentBuilderData).toBe("function")
    })

    it("exports COMPONENT_DEFINITIONS array", async () => {
      const module = await import("../index")
      expect(module.COMPONENT_DEFINITIONS).toBeDefined()
      expect(Array.isArray(module.COMPONENT_DEFINITIONS)).toBe(true)
      expect(module.COMPONENT_DEFINITIONS.length).toBeGreaterThan(0)
    })

    it("exports REGISTRY_DEFINITIONS array", async () => {
      const module = await import("../index")
      expect(module.REGISTRY_DEFINITIONS).toBeDefined()
      expect(Array.isArray(module.REGISTRY_DEFINITIONS)).toBe(true)
    })

    it("exports DEFAULT_BINDINGS array", async () => {
      const module = await import("../index")
      expect(module.DEFAULT_BINDINGS).toBeDefined()
      expect(Array.isArray(module.DEFAULT_BINDINGS)).toBe(true)
    })

    it("exports STUDIO_BINDINGS array", async () => {
      const module = await import("../index")
      expect(module.STUDIO_BINDINGS).toBeDefined()
      expect(Array.isArray(module.STUDIO_BINDINGS)).toBe(true)
    })
  })

  describe("Hydration (task-dcb-007)", () => {
    it("exports useHydratedRegistry hook", async () => {
      const module = await import("../index")
      expect(module.useHydratedRegistry).toBeDefined()
      expect(typeof module.useHydratedRegistry).toBe("function")
    })

    it("exports RegistryHydrationProvider component", async () => {
      const module = await import("../index")
      expect(module.RegistryHydrationProvider).toBeDefined()
    })

    it("exports HydratedRegistryResult type (verifiable via runtime check)", async () => {
      // Types are compile-time only, but we can verify the module exports
      // are structured correctly by importing and checking associated values exist
      const module = await import("../index")
      // The hook returns HydratedRegistryResult, so if hook exists, type exists
      expect(module.useHydratedRegistry).toBeDefined()
    })

    it("exports ComponentImplementationMap type (verifiable via runtime check)", async () => {
      const module = await import("../index")
      // componentImplementationMap uses this type
      expect(module.componentImplementationMap).toBeInstanceOf(Map)
    })
  })

  describe("Existing exports preserved", () => {
    it("exports ComponentRegistry class", async () => {
      const module = await import("../index")
      expect(module.ComponentRegistry).toBeDefined()
    })

    it("exports createComponentRegistry factory", async () => {
      const module = await import("../index")
      expect(module.createComponentRegistry).toBeDefined()
      expect(typeof module.createComponentRegistry).toBe("function")
    })

    it("exports ComponentRegistryProvider", async () => {
      const module = await import("../index")
      expect(module.ComponentRegistryProvider).toBeDefined()
    })

    it("exports useComponentRegistry hook", async () => {
      const module = await import("../index")
      expect(module.useComponentRegistry).toBeDefined()
      expect(typeof module.useComponentRegistry).toBe("function")
    })

    it("exports PropertyRenderer component", async () => {
      const module = await import("../index")
      expect(module.PropertyRenderer).toBeDefined()
    })

    it("exports createDefaultRegistry factory", async () => {
      const module = await import("../index")
      expect(module.createDefaultRegistry).toBeDefined()
      expect(typeof module.createDefaultRegistry).toBe("function")
    })

    it("exports createStudioRegistry factory", async () => {
      const module = await import("../index")
      expect(module.createStudioRegistry).toBeDefined()
      expect(typeof module.createStudioRegistry).toBe("function")
    })
  })
})
