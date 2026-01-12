/**
 * Schema Validation Tests for Composable Phase Views
 * Task: task-cpv-001
 *
 * Tests the schema modifications to support:
 * - 'section' category for ComponentDefinition
 * - LayoutTemplate.slots items schema (name, position, required)
 * - Composition.slotContent items schema (slot, component reference, config)
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { componentBuilderDomain } from "../domain"

describe("Component Builder Schema Validation - Composable Views", () => {
  let store: any

  beforeEach(() => {
    store = componentBuilderDomain.createStore()
  })

  describe("task-cpv-001: ComponentDefinition.category includes 'section'", () => {
    test("ComponentDefinition can be created with category='section'", () => {
      // Given: component-builder domain is loaded
      // When: ComponentDefinition is created with category='section'
      const comp = store.componentDefinitionCollection.add({
        id: "comp-section-test",
        name: "Test Section",
        category: "section",
        implementationRef: "TestSection",
        createdAt: Date.now(),
      })

      // Then: Entity creation succeeds and category equals 'section'
      expect(comp.id).toBe("comp-section-test")
      expect(comp.category).toBe("section")
    })
  })

  describe("task-cpv-001: LayoutTemplate.slots validates items schema", () => {
    test("LayoutTemplate can be created with properly structured slots array", () => {
      // Given: component-builder domain is loaded
      // When: LayoutTemplate is created with slots containing name, position, required
      const layout = store.layoutTemplateCollection.add({
        id: "layout-test",
        name: "Test Layout",
        slots: [
          { name: "header", position: "top", required: true },
          { name: "main", position: "left", required: true },
          { name: "sidebar", position: "right", required: false },
          { name: "actions", position: "bottom", required: false },
        ],
        createdAt: Date.now(),
      })

      // Then: Entity creation succeeds with valid slot items
      expect(layout.id).toBe("layout-test")
      expect(layout.slots).toHaveLength(4)
      expect(layout.slots[0]).toEqual({ name: "header", position: "top", required: true })
      expect(layout.slots[1]).toEqual({ name: "main", position: "left", required: true })
      expect(layout.slots[2]).toEqual({ name: "sidebar", position: "right", required: false })
      expect(layout.slots[3]).toEqual({ name: "actions", position: "bottom", required: false })
    })

    test("LayoutTemplate slots have required string properties", () => {
      const layout = store.layoutTemplateCollection.add({
        id: "layout-test-2",
        name: "Test Layout 2",
        slots: [
          { name: "main", position: "center", required: true },
        ],
        createdAt: Date.now(),
      })

      // Verify the slot item structure
      const slot = layout.slots[0]
      expect(typeof slot.name).toBe("string")
      expect(typeof slot.position).toBe("string")
      expect(typeof slot.required).toBe("boolean")
    })
  })

  describe("task-cpv-001: Composition.slotContent validates items schema", () => {
    test("Composition can be created with slotContent array containing component references", () => {
      // Given: Component and Layout exist
      const comp = store.componentDefinitionCollection.add({
        id: "comp-for-slot",
        name: "Slot Component",
        category: "section",
        implementationRef: "SlotComponent",
        createdAt: Date.now(),
      })

      const layout = store.layoutTemplateCollection.add({
        id: "layout-for-composition",
        name: "Layout for Composition",
        slots: [{ name: "main", position: "left", required: true }],
        createdAt: Date.now(),
      })

      // When: Composition is created with slotContent
      const composition = store.compositionCollection.add({
        id: "comp-test-composition",
        name: "Test Composition",
        layout: layout.id,
        slotContent: [
          { slot: "main", component: comp.id },
        ],
        createdAt: Date.now(),
      })

      // Then: Entity creation succeeds
      expect(composition.id).toBe("comp-test-composition")
      expect(composition.slotContent).toHaveLength(1)
      expect(composition.slotContent[0].slot).toBe("main")
      expect(composition.slotContent[0].component).toBe(comp.id)
    })

    test("Composition slotContent supports optional config object", () => {
      // Setup
      store.componentDefinitionCollection.add({
        id: "comp-configurable",
        name: "Configurable Section",
        category: "section",
        implementationRef: "ConfigurableSection",
        createdAt: Date.now(),
      })

      store.layoutTemplateCollection.add({
        id: "layout-config-test",
        name: "Config Test Layout",
        slots: [{ name: "main", position: "left", required: true }],
        createdAt: Date.now(),
      })

      // Create composition with config
      const composition = store.compositionCollection.add({
        id: "comp-with-config",
        name: "Composition with Config",
        layout: "layout-config-test",
        slotContent: [
          {
            slot: "main",
            component: "comp-configurable",
            config: { variant: "compact", showTitle: false },
          },
        ],
        createdAt: Date.now(),
      })

      // Verify config is preserved
      expect(composition.slotContent[0].config).toEqual({
        variant: "compact",
        showTitle: false,
      })
    })
  })

  describe("task-cpv-001: Schema loads without validation errors", () => {
    test("domain creates store successfully", () => {
      // The store creation in beforeEach already validates schema loading
      // This test explicitly verifies the success
      expect(store).toBeDefined()
      expect(store.componentDefinitionCollection).toBeDefined()
      expect(store.layoutTemplateCollection).toBeDefined()
      expect(store.compositionCollection).toBeDefined()
    })

    test("all entity types are queryable after schema load", () => {
      // Verify we can query all collection types
      expect(store.componentDefinitionCollection.all()).toBeDefined()
      expect(store.layoutTemplateCollection.all()).toBeDefined()
      expect(store.compositionCollection.all()).toBeDefined()
      expect(store.registryCollection.all()).toBeDefined()
      expect(store.rendererBindingCollection.all()).toBeDefined()
    })
  })
})
