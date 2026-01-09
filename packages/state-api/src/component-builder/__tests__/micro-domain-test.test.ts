/**
 * Micro test to validate component-builder domain enhancements work at runtime.
 * This tests the enhancement views: toEntrySpecs, allBindings, findByCategory, etc.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { componentBuilderDomain } from "../domain"
import type { ComponentEntrySpec, PropertyMetadata } from "../types"

describe("Component Builder Domain - Micro Test", () => {
  let store: any

  beforeEach(() => {
    // Create fresh store for each test
    store = componentBuilderDomain.createStore()
  })

  describe("Entity Creation", () => {
    test("can create ComponentDefinition entities", () => {
      const comp = store.componentDefinitionCollection.add({
        id: "comp-1",
        name: "TextDisplay",
        category: "display",
        implementationRef: "TextDisplay",
        createdAt: Date.now(),
      })

      expect(comp.id).toBe("comp-1")
      expect(comp.name).toBe("TextDisplay")
      expect(comp.category).toBe("display")
    })

    test("can create Registry with fallback reference", () => {
      // Create fallback component first
      store.componentDefinitionCollection.add({
        id: "comp-fallback",
        name: "FallbackDisplay",
        category: "display",
        implementationRef: "FallbackDisplay",
        createdAt: Date.now(),
      })

      // Create registry with fallback reference
      const registry = store.registryCollection.add({
        id: "reg-1",
        name: "Test Registry",
        fallbackComponent: "comp-fallback",
        createdAt: Date.now(),
      })

      expect(registry.id).toBe("reg-1")
      expect(registry.fallbackComponent?.id).toBe("comp-fallback")
    })

    test("can create RendererBinding with references", () => {
      // Setup
      store.componentDefinitionCollection.add({
        id: "comp-text",
        name: "TextDisplay",
        category: "display",
        implementationRef: "TextDisplay",
        createdAt: Date.now(),
      })

      store.registryCollection.add({
        id: "reg-1",
        name: "Test Registry",
        createdAt: Date.now(),
      })

      // Create binding
      const binding = store.rendererBindingCollection.add({
        id: "binding-1",
        name: "String → TextDisplay",
        registry: "reg-1",
        component: "comp-text",
        matchExpression: { type: "string" },
        priority: 10,
        createdAt: Date.now(),
      })

      expect(binding.id).toBe("binding-1")
      expect(binding.registry?.id).toBe("reg-1")
      expect(binding.component?.id).toBe("comp-text")
    })
  })

  describe("RendererBinding Enhancement Views", () => {
    beforeEach(() => {
      store.componentDefinitionCollection.add({
        id: "comp-text",
        name: "TextDisplay",
        category: "display",
        implementationRef: "TextDisplay",
        createdAt: Date.now(),
      })

      store.registryCollection.add({
        id: "reg-1",
        name: "Test Registry",
        createdAt: Date.now(),
      })

      store.rendererBindingCollection.add({
        id: "binding-1",
        name: "String → TextDisplay",
        registry: "reg-1",
        component: "comp-text",
        matchExpression: { type: "string" },
        priority: 10,
        createdAt: Date.now(),
      })
    })

    test("binding.matcher returns working matcher function", () => {
      const binding = store.rendererBindingCollection.all()[0]
      const matcher = binding.matcher

      expect(typeof matcher).toBe("function")

      // Test matching
      const stringMeta: PropertyMetadata = { type: "string", name: "title" }
      const numberMeta: PropertyMetadata = { type: "number", name: "count" }

      expect(matcher(stringMeta)).toBe(true)
      expect(matcher(numberMeta)).toBe(false)
    })

    test("binding.toEntrySpec() returns ComponentEntrySpec", () => {
      const binding = store.rendererBindingCollection.all()[0]
      const spec: ComponentEntrySpec = binding.toEntrySpec()

      expect(spec.id).toBe("binding-1")
      expect(spec.priority).toBe(10)
      expect(spec.componentRef).toBe("TextDisplay")
      expect(typeof spec.matcher).toBe("function")
    })
  })

  describe("Registry Enhancement Views", () => {
    beforeEach(() => {
      // Create components
      store.componentDefinitionCollection.add({
        id: "comp-text",
        name: "TextDisplay",
        category: "display",
        implementationRef: "TextDisplay",
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-badge",
        name: "StatusBadge",
        category: "display",
        implementationRef: "StatusBadge",
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-fallback",
        name: "FallbackDisplay",
        category: "display",
        implementationRef: "FallbackDisplay",
        createdAt: Date.now(),
      })

      // Create registry with fallback
      store.registryCollection.add({
        id: "reg-1",
        name: "Test Registry",
        fallbackComponent: "comp-fallback",
        createdAt: Date.now(),
      })

      // Create bindings with different priorities
      store.rendererBindingCollection.add({
        id: "binding-string",
        name: "String → TextDisplay",
        registry: "reg-1",
        component: "comp-text",
        matchExpression: { type: "string" },
        priority: 10,
        createdAt: Date.now(),
      })

      store.rendererBindingCollection.add({
        id: "binding-status",
        name: "Status → StatusBadge",
        registry: "reg-1",
        component: "comp-badge",
        matchExpression: { "x-semantic": "status" },
        priority: 100,
        createdAt: Date.now(),
      })
    })

    test("registry.bindings returns inverse relationship", () => {
      const registry = store.registryCollection.all()[0]
      const bindings = registry.bindings

      expect(Array.isArray(bindings)).toBe(true)
      expect(bindings.length).toBe(2)
    })

    test("registry.allBindings collects all bindings", () => {
      const registry = store.registryCollection.all()[0]
      const allBindings = registry.allBindings

      expect(allBindings.length).toBe(2)
    })

    test("registry.toEntrySpecs() returns sorted ComponentEntrySpec[]", () => {
      const registry = store.registryCollection.all()[0]
      const specs: ComponentEntrySpec[] = registry.toEntrySpecs()

      expect(specs.length).toBe(2)
      // Should be sorted by priority descending
      expect(specs[0].priority).toBe(100) // Status binding
      expect(specs[1].priority).toBe(10) // String binding
      expect(specs[0].componentRef).toBe("StatusBadge")
      expect(specs[1].componentRef).toBe("TextDisplay")
    })

    test("registry.fallbackRef resolves fallback component", () => {
      const registry = store.registryCollection.all()[0]
      const fallbackRef = registry.fallbackRef

      expect(fallbackRef).toBe("FallbackDisplay")
    })
  })

  describe("Registry Inheritance", () => {
    beforeEach(() => {
      // Create components
      store.componentDefinitionCollection.add({
        id: "comp-text",
        name: "TextDisplay",
        category: "display",
        implementationRef: "TextDisplay",
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-badge",
        name: "StatusBadge",
        category: "display",
        implementationRef: "StatusBadge",
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-fallback",
        name: "FallbackDisplay",
        category: "display",
        implementationRef: "FallbackDisplay",
        createdAt: Date.now(),
      })

      // Create parent registry with fallback
      store.registryCollection.add({
        id: "reg-parent",
        name: "Parent Registry",
        fallbackComponent: "comp-fallback",
        createdAt: Date.now(),
      })

      // Create child registry extending parent
      store.registryCollection.add({
        id: "reg-child",
        name: "Child Registry",
        extends: "reg-parent",
        createdAt: Date.now(),
      })

      // Binding in parent
      store.rendererBindingCollection.add({
        id: "binding-parent",
        name: "Parent Binding",
        registry: "reg-parent",
        component: "comp-text",
        matchExpression: { type: "string" },
        priority: 10,
        createdAt: Date.now(),
      })

      // Binding in child
      store.rendererBindingCollection.add({
        id: "binding-child",
        name: "Child Binding",
        registry: "reg-child",
        component: "comp-badge",
        matchExpression: { "x-semantic": "status" },
        priority: 100,
        createdAt: Date.now(),
      })
    })

    test("child registry inherits parent bindings", () => {
      const child = store.registryCollection.all().find((r: any) => r.id === "reg-child")
      const allBindings = child.allBindings

      expect(allBindings.length).toBe(2)
    })

    test("child registry resolves fallback from parent", () => {
      const child = store.registryCollection.all().find((r: any) => r.id === "reg-child")
      const fallbackRef = child.fallbackRef

      expect(fallbackRef).toBe("FallbackDisplay")
    })

    test("child bindings appear before parent bindings in toEntrySpecs", () => {
      const child = store.registryCollection.all().find((r: any) => r.id === "reg-child")
      const specs = child.toEntrySpecs()

      // After priority sort: child(100), parent(10)
      expect(specs[0].id).toBe("binding-child")
      expect(specs[1].id).toBe("binding-parent")
    })
  })

  describe("Collection Enhancement Views", () => {
    beforeEach(() => {
      store.componentDefinitionCollection.add({
        id: "comp-text",
        name: "TextDisplay",
        category: "display",
        implementationRef: "TextDisplay",
        tags: ["primitive", "text"],
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-input",
        name: "TextInput",
        category: "input",
        implementationRef: "TextInput",
        tags: ["primitive", "form"],
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-badge",
        name: "StatusBadge",
        category: "display",
        implementationRef: "StatusBadge",
        tags: ["status"],
        createdAt: Date.now(),
      })

      store.registryCollection.add({
        id: "reg-default",
        name: "Default Registry",
        createdAt: Date.now(),
      })
    })

    test("findByCategory filters components", () => {
      const displayComponents = store.componentDefinitionCollection.findByCategory("display")
      const inputComponents = store.componentDefinitionCollection.findByCategory("input")

      expect(displayComponents.length).toBe(2)
      expect(inputComponents.length).toBe(1)
    })

    test("findByImplementationRef finds component", () => {
      const comp = store.componentDefinitionCollection.findByImplementationRef("TextDisplay")

      expect(comp).toBeDefined()
      expect(comp.id).toBe("comp-text")
    })

    test("findByTag filters components", () => {
      const primitives = store.componentDefinitionCollection.findByTag("primitive")
      const statusComps = store.componentDefinitionCollection.findByTag("status")

      expect(primitives.length).toBe(2)
      expect(statusComps.length).toBe(1)
    })

    test("findByName finds registry", () => {
      const registry = store.registryCollection.findByName("Default Registry")

      expect(registry).toBeDefined()
      expect(registry.id).toBe("reg-default")
    })

    test("defaultRegistry returns Default Registry", () => {
      const registry = store.registryCollection.defaultRegistry

      expect(registry).toBeDefined()
      expect(registry.id).toBe("reg-default")
    })
  })

  describe("RootStore Enhancement Views", () => {
    beforeEach(() => {
      store.componentDefinitionCollection.add({
        id: "comp-1",
        name: "Display1",
        category: "display",
        implementationRef: "Display1",
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-2",
        name: "Input1",
        category: "input",
        implementationRef: "Input1",
        createdAt: Date.now(),
      })

      store.componentDefinitionCollection.add({
        id: "comp-3",
        name: "Display2",
        category: "display",
        implementationRef: "Display2",
        createdAt: Date.now(),
      })
    })

    test("componentCount returns total count", () => {
      expect(store.componentCount).toBe(3)
    })

    test("componentCountByCategory returns breakdown", () => {
      const counts = store.componentCountByCategory

      expect(counts.display).toBe(2)
      expect(counts.input).toBe(1)
      expect(counts.layout).toBe(0)
      expect(counts.visualization).toBe(0)
    })
  })
})
