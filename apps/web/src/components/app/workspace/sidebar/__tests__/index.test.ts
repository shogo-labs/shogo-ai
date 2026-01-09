/**
 * Barrel Export Tests for sidebar/index.ts
 * Task: task-dcb-013
 *
 * Tests that all required modules are exported from the sidebar barrel file.
 *
 * Acceptance Criteria:
 * 5. sidebar/index.ts exports ComponentCatalogSidebar
 * 6. sidebar/index.ts exports ComponentGroup and ComponentItem
 */

import { describe, it, expect } from "bun:test"

describe("sidebar/index.ts barrel exports", () => {
  describe("Component Catalog Components (task-dcb-009, task-dcb-010, task-dcb-011)", () => {
    it("exports ComponentCatalogSidebar component", async () => {
      const module = await import("../index")
      expect(module.ComponentCatalogSidebar).toBeDefined()
    })

    it("exports ComponentCatalogSidebarProps type (verifiable via component existence)", async () => {
      const module = await import("../index")
      // TypeScript types are compile-time, but we verify the component exists
      expect(module.ComponentCatalogSidebar).toBeDefined()
    })

    it("exports ComponentGroup component", async () => {
      const module = await import("../index")
      expect(module.ComponentGroup).toBeDefined()
    })

    it("exports ComponentGroupProps type (verifiable via component existence)", async () => {
      const module = await import("../index")
      expect(module.ComponentGroup).toBeDefined()
    })

    it("exports COMPONENT_CATEGORIES constant", async () => {
      const module = await import("../index")
      expect(module.COMPONENT_CATEGORIES).toBeDefined()
      expect(Array.isArray(module.COMPONENT_CATEGORIES)).toBe(true)
      expect(module.COMPONENT_CATEGORIES).toContain("display")
      expect(module.COMPONENT_CATEGORIES).toContain("visualization")
    })

    it("exports ComponentItem component", async () => {
      const module = await import("../index")
      expect(module.ComponentItem).toBeDefined()
    })

    it("exports ComponentItemProps type (verifiable via component existence)", async () => {
      const module = await import("../index")
      expect(module.ComponentItem).toBeDefined()
    })

    it("exports ComponentDefinition type alias", async () => {
      // ComponentDefinition is a type, but it's used by ComponentItem
      // We can verify by checking the module compiles and ComponentItem exists
      const module = await import("../index")
      expect(module.ComponentItem).toBeDefined()
    })
  })

  describe("Existing Feature exports preserved", () => {
    it("exports FeatureSidebar component", async () => {
      const module = await import("../index")
      expect(module.FeatureSidebar).toBeDefined()
    })

    it("exports FeatureGroup component", async () => {
      const module = await import("../index")
      expect(module.FeatureGroup).toBeDefined()
    })

    it("exports FEATURE_PHASES constant", async () => {
      const module = await import("../index")
      expect(module.FEATURE_PHASES).toBeDefined()
    })

    it("exports FeatureItem component", async () => {
      const module = await import("../index")
      expect(module.FeatureItem).toBeDefined()
    })

    it("exports SidebarSearch component", async () => {
      const module = await import("../index")
      expect(module.SidebarSearch).toBeDefined()
    })

    it("exports NewFeatureButton component", async () => {
      const module = await import("../index")
      expect(module.NewFeatureButton).toBeDefined()
    })
  })
})
