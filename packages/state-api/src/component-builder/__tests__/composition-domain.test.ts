/**
 * Composition Domain Enhancements Tests
 *
 * Tests for Composition and LayoutTemplate domain enhancements:
 * - Composition.toSlotSpecs() model view
 * - CompositionCollection.findByName() collection view
 * - LayoutTemplateCollection.findByName() collection view
 *
 * Task: task-cpv-002
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { componentBuilderDomain } from "../domain"
import type { SlotSpec } from "../types"

describe("Composition Domain Enhancements - task-cpv-002", () => {
  let store: any

  beforeEach(() => {
    // Create fresh store for each test
    store = componentBuilderDomain.createStore()
  })

  describe("AC-1: Composition.toSlotSpecs() model view", () => {
    beforeEach(() => {
      // Create section components
      store.componentDefinitionCollection.add({
        id: "comp-header-section",
        name: "Header Section",
        category: "section",
        implementationRef: "HeaderSection",
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-content-section",
        name: "Content Section",
        category: "section",
        implementationRef: "ContentSection",
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-sidebar-section",
        name: "Sidebar Section",
        category: "section",
        implementationRef: "SidebarSection",
        createdAt: Date.now(),
      })

      // Create a layout template
      store.layoutTemplateCollection.add({
        id: "layout-two-column",
        name: "Two Column Layout",
        slots: [
          { name: "header", position: "top", required: true },
          { name: "main", position: "left", required: true },
          { name: "sidebar", position: "right", required: false },
        ],
        createdAt: Date.now(),
      })

      // Create a composition using the layout
      store.compositionCollection.add({
        id: "composition-discovery-view",
        name: "Discovery View",
        layout: "layout-two-column",
        slotContent: [
          { slot: "header", component: "comp-header-section" },
          { slot: "main", component: "comp-content-section", config: { variant: "compact" } },
          { slot: "sidebar", component: "comp-sidebar-section" },
        ],
        createdAt: Date.now(),
      })
    })

    test("toSlotSpecs() returns an array", () => {
      const composition = store.compositionCollection.all()[0]
      const specs = composition.toSlotSpecs()

      expect(Array.isArray(specs)).toBe(true)
    })

    test("toSlotSpecs() returns SlotSpec objects with correct shape", () => {
      const composition = store.compositionCollection.all()[0]
      const specs: SlotSpec[] = composition.toSlotSpecs()

      expect(specs.length).toBe(3)

      for (const spec of specs) {
        expect(spec).toHaveProperty("slotName")
        expect(spec).toHaveProperty("sectionRef")
        expect(typeof spec.slotName).toBe("string")
        expect(typeof spec.sectionRef).toBe("string")
      }
    })

    test("toSlotSpecs() slotName matches slot content slot name", () => {
      const composition = store.compositionCollection.all()[0]
      const specs: SlotSpec[] = composition.toSlotSpecs()

      const slotNames = specs.map(s => s.slotName)
      expect(slotNames).toContain("header")
      expect(slotNames).toContain("main")
      expect(slotNames).toContain("sidebar")
    })

    test("toSlotSpecs() sectionRef matches component implementationRef", () => {
      const composition = store.compositionCollection.all()[0]
      const specs: SlotSpec[] = composition.toSlotSpecs()

      const headerSpec = specs.find(s => s.slotName === "header")
      const mainSpec = specs.find(s => s.slotName === "main")
      const sidebarSpec = specs.find(s => s.slotName === "sidebar")

      expect(headerSpec?.sectionRef).toBe("HeaderSection")
      expect(mainSpec?.sectionRef).toBe("ContentSection")
      expect(sidebarSpec?.sectionRef).toBe("SidebarSection")
    })

    test("toSlotSpecs() includes config when present", () => {
      const composition = store.compositionCollection.all()[0]
      const specs: SlotSpec[] = composition.toSlotSpecs()

      const mainSpec = specs.find(s => s.slotName === "main")
      expect(mainSpec?.config).toEqual({ variant: "compact" })
    })

    test("toSlotSpecs() config is undefined when not present", () => {
      const composition = store.compositionCollection.all()[0]
      const specs: SlotSpec[] = composition.toSlotSpecs()

      const headerSpec = specs.find(s => s.slotName === "header")
      expect(headerSpec?.config).toBeUndefined()
    })

    test("toSlotSpecs() returns empty array for composition with no slot content", () => {
      // Create a composition with empty slotContent
      store.compositionCollection.add({
        id: "composition-empty",
        name: "Empty Composition",
        layout: "layout-two-column",
        slotContent: [],
        createdAt: Date.now(),
      })

      const composition = store.compositionCollection.all().find((c: any) => c.id === "composition-empty")
      const specs: SlotSpec[] = composition.toSlotSpecs()

      expect(specs).toEqual([])
    })

    test("toSlotSpecs() handles missing component reference gracefully", () => {
      // Create composition with invalid component reference
      store.compositionCollection.add({
        id: "composition-invalid-ref",
        name: "Invalid Ref Composition",
        layout: "layout-two-column",
        slotContent: [
          { slot: "header", component: "nonexistent-component" },
        ],
        createdAt: Date.now(),
      })

      const composition = store.compositionCollection.all().find((c: any) => c.id === "composition-invalid-ref")
      const specs: SlotSpec[] = composition.toSlotSpecs()

      // Should still return spec but with fallback sectionRef
      expect(specs.length).toBe(1)
      expect(specs[0].slotName).toBe("header")
      // Fallback when component not resolved
      expect(specs[0].sectionRef).toBe("FallbackSection")
    })
  })

  describe("AC-1b: toSlotSpecs() with section field (direct section name)", () => {
    beforeEach(() => {
      // Create a layout template
      store.layoutTemplateCollection.add({
        id: "layout-flexible",
        name: "Flexible Layout",
        slots: [
          { name: "main", position: "center", required: true },
          { name: "sidebar", position: "right", required: false },
        ],
        createdAt: Date.now(),
      })

      // Create a ComponentDefinition for backward compat tests
      store.componentDefinitionCollection.add({
        id: "comp-legacy-section",
        name: "Legacy Section",
        category: "section",
        implementationRef: "LegacySection",
        createdAt: Date.now(),
      })
    })

    test("toSlotSpecs() returns section name directly when section field present", () => {
      // New pattern: section field stores section name directly
      store.compositionCollection.add({
        id: "composition-section-field",
        name: "Section Field Test",
        layout: "layout-flexible",
        slotContent: [
          { slot: "main", section: "DirectSection" },
        ],
        createdAt: Date.now(),
      })

      const composition = store.compositionCollection.get("composition-section-field")
      const specs: SlotSpec[] = composition.toSlotSpecs()

      expect(specs.length).toBe(1)
      expect(specs[0].slotName).toBe("main")
      expect(specs[0].sectionRef).toBe("DirectSection")
    })

    test("toSlotSpecs() prefers section field over component field when both present", () => {
      // Migration scenario: both fields present
      store.compositionCollection.add({
        id: "composition-both-fields",
        name: "Both Fields Test",
        layout: "layout-flexible",
        slotContent: [
          { slot: "main", section: "NewSection", component: "comp-legacy-section" },
        ],
        createdAt: Date.now(),
      })

      const composition = store.compositionCollection.get("composition-both-fields")
      const specs: SlotSpec[] = composition.toSlotSpecs()

      expect(specs.length).toBe(1)
      expect(specs[0].sectionRef).toBe("NewSection") // section field wins
    })

    test("toSlotSpecs() falls back to component lookup when section field not present", () => {
      // Backward compat: old pattern still works
      store.compositionCollection.add({
        id: "composition-legacy",
        name: "Legacy Composition",
        layout: "layout-flexible",
        slotContent: [
          { slot: "main", component: "comp-legacy-section" },
        ],
        createdAt: Date.now(),
      })

      const composition = store.compositionCollection.get("composition-legacy")
      const specs: SlotSpec[] = composition.toSlotSpecs()

      expect(specs.length).toBe(1)
      expect(specs[0].sectionRef).toBe("LegacySection") // resolved via ComponentDefinition
    })

    test("toSlotSpecs() includes config when using section field", () => {
      store.compositionCollection.add({
        id: "composition-section-with-config",
        name: "Section With Config",
        layout: "layout-flexible",
        slotContent: [
          { slot: "main", section: "ConfiguredSection", config: { variant: "compact", showHeader: true } },
        ],
        createdAt: Date.now(),
      })

      const composition = store.compositionCollection.get("composition-section-with-config")
      const specs: SlotSpec[] = composition.toSlotSpecs()

      expect(specs[0].sectionRef).toBe("ConfiguredSection")
      expect(specs[0].config).toEqual({ variant: "compact", showHeader: true })
    })

    test("toSlotSpecs() handles mixed section and component fields in same composition", () => {
      store.compositionCollection.add({
        id: "composition-mixed",
        name: "Mixed Composition",
        layout: "layout-flexible",
        slotContent: [
          { slot: "main", section: "NewMainSection" },
          { slot: "sidebar", component: "comp-legacy-section" },
        ],
        createdAt: Date.now(),
      })

      const composition = store.compositionCollection.get("composition-mixed")
      const specs: SlotSpec[] = composition.toSlotSpecs()

      expect(specs.length).toBe(2)

      const mainSpec = specs.find(s => s.slotName === "main")
      const sidebarSpec = specs.find(s => s.slotName === "sidebar")

      expect(mainSpec?.sectionRef).toBe("NewMainSection") // direct section field
      expect(sidebarSpec?.sectionRef).toBe("LegacySection") // via component lookup
    })
  })

  describe("AC-2: CompositionCollection.findByName() view", () => {
    beforeEach(() => {
      // Create a layout template first
      store.layoutTemplateCollection.add({
        id: "layout-basic",
        name: "Basic Layout",
        slots: [{ name: "main", position: "center", required: true }],
        createdAt: Date.now(),
      })

      // Create compositions
      store.compositionCollection.add({
        id: "composition-1",
        name: "Discovery View",
        layout: "layout-basic",
        slotContent: [],
        createdAt: Date.now(),
      })

      store.compositionCollection.add({
        id: "composition-2",
        name: "Analysis View",
        layout: "layout-basic",
        slotContent: [],
        createdAt: Date.now(),
      })

      store.compositionCollection.add({
        id: "composition-3",
        name: "Design View",
        layout: "layout-basic",
        slotContent: [],
        createdAt: Date.now(),
      })
    })

    test("findByName returns composition when name matches", () => {
      const composition = store.compositionCollection.findByName("Discovery View")

      expect(composition).toBeDefined()
      expect(composition.id).toBe("composition-1")
      expect(composition.name).toBe("Discovery View")
    })

    test("findByName returns undefined when name does not match", () => {
      const composition = store.compositionCollection.findByName("Nonexistent View")

      expect(composition).toBeUndefined()
    })

    test("findByName returns first match when multiple could match", () => {
      // Add another composition with similar naming
      store.compositionCollection.add({
        id: "composition-4",
        name: "Discovery View",
        layout: "layout-basic",
        slotContent: [],
        createdAt: Date.now(),
      })

      const composition = store.compositionCollection.findByName("Discovery View")

      // Should return first match (composition-1)
      expect(composition).toBeDefined()
      expect(composition.id).toBe("composition-1")
    })

    test("findByName is case-sensitive", () => {
      const composition = store.compositionCollection.findByName("discovery view")

      expect(composition).toBeUndefined()
    })
  })

  describe("AC-3: LayoutTemplateCollection.findByName() view", () => {
    beforeEach(() => {
      store.layoutTemplateCollection.add({
        id: "layout-1",
        name: "Two Column Layout",
        slots: [
          { name: "left", position: "left", required: true },
          { name: "right", position: "right", required: false },
        ],
        createdAt: Date.now(),
      })

      store.layoutTemplateCollection.add({
        id: "layout-2",
        name: "Three Column Layout",
        slots: [
          { name: "left", position: "left", required: true },
          { name: "center", position: "center", required: true },
          { name: "right", position: "right", required: false },
        ],
        createdAt: Date.now(),
      })

      store.layoutTemplateCollection.add({
        id: "layout-3",
        name: "Dashboard Grid",
        slots: [
          { name: "header", position: "top", required: true },
          { name: "main", position: "center", required: true },
          { name: "footer", position: "bottom", required: false },
        ],
        createdAt: Date.now(),
      })
    })

    test("findByName returns layout template when name matches", () => {
      const layout = store.layoutTemplateCollection.findByName("Two Column Layout")

      expect(layout).toBeDefined()
      expect(layout.id).toBe("layout-1")
      expect(layout.name).toBe("Two Column Layout")
    })

    test("findByName returns undefined when name does not match", () => {
      const layout = store.layoutTemplateCollection.findByName("Nonexistent Layout")

      expect(layout).toBeUndefined()
    })

    test("findByName returns first match when multiple could match", () => {
      // Add duplicate name
      store.layoutTemplateCollection.add({
        id: "layout-4",
        name: "Two Column Layout",
        slots: [],
        createdAt: Date.now(),
      })

      const layout = store.layoutTemplateCollection.findByName("Two Column Layout")

      expect(layout).toBeDefined()
      expect(layout.id).toBe("layout-1")
    })

    test("findByName is case-sensitive", () => {
      const layout = store.layoutTemplateCollection.findByName("two column layout")

      expect(layout).toBeUndefined()
    })
  })

  describe("AC-4: 'section' category in componentCountByCategory", () => {
    beforeEach(() => {
      store.componentDefinitionCollection.add({
        id: "comp-1",
        name: "Display Component",
        category: "display",
        implementationRef: "DisplayComp",
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-2",
        name: "Section Component",
        category: "section",
        implementationRef: "SectionComp",
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-3",
        name: "Another Section",
        category: "section",
        implementationRef: "AnotherSection",
        createdAt: Date.now(),
      })
    })

    test("componentCountByCategory includes section category", () => {
      const counts = store.componentCountByCategory

      expect(counts).toHaveProperty("section")
      expect(counts.section).toBe(2)
    })

    test("findByCategory works with section category", () => {
      const sections = store.componentDefinitionCollection.findByCategory("section")

      expect(sections.length).toBe(2)
      expect(sections.every((c: any) => c.category === "section")).toBe(true)
    })
  })

  describe("AC-5: RootStore Composition CRUD via standard collection methods", () => {
    beforeEach(() => {
      // Create a layout template first
      store.layoutTemplateCollection.add({
        id: "layout-basic",
        name: "Basic Layout",
        slots: [{ name: "main", position: "center", required: true }],
        createdAt: Date.now(),
      })
    })

    test("compositionCollection.add creates composition", () => {
      const composition = store.compositionCollection.add({
        id: "new-composition",
        name: "New Composition",
        layout: "layout-basic",
        slotContent: [],
        createdAt: Date.now(),
      })

      expect(composition.id).toBe("new-composition")
      expect(composition.name).toBe("New Composition")
      expect(store.compositionCollection.all().length).toBe(1)
    })

    test("compositionCollection.get retrieves composition by id", () => {
      store.compositionCollection.add({
        id: "composition-to-get",
        name: "Composition To Get",
        layout: "layout-basic",
        slotContent: [],
        createdAt: Date.now(),
      })

      const composition = store.compositionCollection.get("composition-to-get")

      expect(composition).toBeDefined()
      expect(composition.name).toBe("Composition To Get")
    })

    test("compositionCollection supports standard collection operations", () => {
      // Add multiple compositions
      store.compositionCollection.add({
        id: "composition-a",
        name: "Composition A",
        layout: "layout-basic",
        slotContent: [],
        createdAt: Date.now(),
      })

      store.compositionCollection.add({
        id: "composition-b",
        name: "Composition B",
        layout: "layout-basic",
        slotContent: [],
        createdAt: Date.now(),
      })

      // Verify all() returns both
      expect(store.compositionCollection.all().length).toBe(2)

      // Verify get() works for each
      expect(store.compositionCollection.get("composition-a")).toBeDefined()
      expect(store.compositionCollection.get("composition-b")).toBeDefined()
    })

    test("layoutTemplateCollection supports standard collection operations", () => {
      // Already have one from beforeEach
      expect(store.layoutTemplateCollection.all().length).toBe(1)

      // Add another
      store.layoutTemplateCollection.add({
        id: "layout-new",
        name: "New Layout",
        slots: [],
        createdAt: Date.now(),
      })

      expect(store.layoutTemplateCollection.all().length).toBe(2)

      // Get both
      const basicLayout = store.layoutTemplateCollection.get("layout-basic")
      const newLayout = store.layoutTemplateCollection.get("layout-new")

      expect(basicLayout).toBeDefined()
      expect(basicLayout.name).toBe("Basic Layout")
      expect(newLayout).toBeDefined()
      expect(newLayout.name).toBe("New Layout")
    })
  })
})
