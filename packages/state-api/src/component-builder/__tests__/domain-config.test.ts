/**
 * Domain Config Support Tests
 *
 * TDD: RED phase - Tests written before implementation
 * Tests for defaultConfig on RendererBinding and supportedConfig on ComponentDefinition.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { componentBuilderDomain } from "../domain"
import { NullPersistence } from "../../persistence/null"
import { BackendRegistry, MemoryBackend } from "../../query"
import type { IEnvironment } from "../../environment"
import type { ComponentEntrySpec } from "../types"

/**
 * Create test environment with in-memory persistence
 */
function createTestEnv(): IEnvironment {
  const registry = new BackendRegistry()
  registry.register("memory", new MemoryBackend())
  registry.setDefault("memory")

  return {
    services: {
      persistence: new NullPersistence(),
      backendRegistry: registry,
    },
    context: {
      schemaName: "component-builder-test",
    },
  }
}

describe("component-builder domain config fields", () => {
  let store: ReturnType<typeof componentBuilderDomain.createStore>

  beforeEach(() => {
    store = componentBuilderDomain.createStore(createTestEnv())
  })

  describe("RendererBinding defaultConfig", () => {
    test("accepts defaultConfig on creation", async () => {
      // Setup: Create required related entities
      await store.componentDefinitionCollection.insertOne({
        id: "comp-string",
        name: "String Display",
        category: "display",
        implementationRef: "StringDisplay",
        createdAt: Date.now()
      })

      await store.registryCollection.insertOne({
        id: "reg-default",
        name: "Default Registry",
        createdAt: Date.now()
      })

      // Test: Create binding with defaultConfig
      const binding = await store.rendererBindingCollection.insertOne({
        id: "test-binding",
        name: "Test Binding",
        registry: "reg-default",
        component: "comp-string",
        matchExpression: { type: "string" },
        priority: 10,
        defaultConfig: { size: "lg", truncate: 100 },
        createdAt: Date.now()
      })

      expect(binding).toBeDefined()
      expect(binding?.defaultConfig).toEqual({ size: "lg", truncate: 100 })
    })

    test("defaultConfig is optional", async () => {
      await store.componentDefinitionCollection.insertOne({
        id: "comp-string",
        name: "String Display",
        category: "display",
        implementationRef: "StringDisplay",
        createdAt: Date.now()
      })

      await store.registryCollection.insertOne({
        id: "reg-default",
        name: "Default Registry",
        createdAt: Date.now()
      })

      // Create binding without defaultConfig
      const binding = await store.rendererBindingCollection.insertOne({
        id: "test-binding",
        name: "Test Binding",
        registry: "reg-default",
        component: "comp-string",
        matchExpression: { type: "string" },
        priority: 10,
        createdAt: Date.now()
      })

      expect(binding).toBeDefined()
      expect(binding?.defaultConfig).toBeUndefined()
    })
  })

  describe("ComponentDefinition supportedConfig", () => {
    test("accepts supportedConfig on creation", async () => {
      const comp = await store.componentDefinitionCollection.insertOne({
        id: "comp-test",
        name: "Test Component",
        category: "display",
        implementationRef: "TestDisplay",
        supportedConfig: ["size", "variant", "truncate"],
        createdAt: Date.now()
      })

      expect(comp).toBeDefined()
      expect(comp?.supportedConfig).toEqual(["size", "variant", "truncate"])
    })

    test("supportedConfig is optional (defaults to empty array)", async () => {
      const comp = await store.componentDefinitionCollection.insertOne({
        id: "comp-test",
        name: "Test Component",
        category: "display",
        implementationRef: "TestDisplay",
        createdAt: Date.now()
      })

      expect(comp).toBeDefined()
      // MST initializes optional arrays to empty array
      expect(comp?.supportedConfig).toEqual([])
    })
  })

  describe("toEntrySpec() includes defaultConfig", () => {
    test("toEntrySpec() returns defaultConfig when present", async () => {
      // Setup
      await store.componentDefinitionCollection.insertOne({
        id: "comp-string",
        name: "String Display",
        category: "display",
        implementationRef: "StringDisplay",
        createdAt: Date.now()
      })

      await store.registryCollection.insertOne({
        id: "reg-default",
        name: "Default Registry",
        createdAt: Date.now()
      })

      await store.rendererBindingCollection.insertOne({
        id: "string-binding",
        name: "String Type Binding",
        registry: "reg-default",
        component: "comp-string",
        matchExpression: { type: "string" },
        priority: 10,
        defaultConfig: { truncate: 200 },
        createdAt: Date.now()
      })

      // Get binding from store and call toEntrySpec
      const bindings = store.rendererBindingCollection.all()
      const binding = bindings.find((b: any) => b.id === "string-binding")
      const spec: ComponentEntrySpec = binding?.toEntrySpec()

      expect(spec).toBeDefined()
      expect(spec?.defaultConfig).toEqual({ truncate: 200 })
      expect(spec?.componentRef).toBe("StringDisplay")
    })

    test("toEntrySpec() returns undefined defaultConfig when not present", async () => {
      await store.componentDefinitionCollection.insertOne({
        id: "comp-string",
        name: "String Display",
        category: "display",
        implementationRef: "StringDisplay",
        createdAt: Date.now()
      })

      await store.registryCollection.insertOne({
        id: "reg-default",
        name: "Default Registry",
        createdAt: Date.now()
      })

      await store.rendererBindingCollection.insertOne({
        id: "string-binding",
        name: "String Type Binding",
        registry: "reg-default",
        component: "comp-string",
        matchExpression: { type: "string" },
        priority: 10,
        createdAt: Date.now()
      })

      const bindings = store.rendererBindingCollection.all()
      const binding = bindings.find((b: any) => b.id === "string-binding")
      const spec: ComponentEntrySpec = binding?.toEntrySpec()

      expect(spec).toBeDefined()
      expect(spec?.defaultConfig).toBeUndefined()
    })
  })

  describe("Registry.toEntrySpecs() preserves defaultConfig", () => {
    test("toEntrySpecs() includes defaultConfig from bindings", async () => {
      await store.componentDefinitionCollection.insertOne({
        id: "comp-string",
        name: "String Display",
        category: "display",
        implementationRef: "StringDisplay",
        createdAt: Date.now()
      })

      await store.registryCollection.insertOne({
        id: "reg-default",
        name: "Default Registry",
        createdAt: Date.now()
      })

      await store.rendererBindingCollection.insertOne({
        id: "string-binding",
        name: "String Type Binding",
        registry: "reg-default",
        component: "comp-string",
        matchExpression: { type: "string" },
        priority: 10,
        defaultConfig: { size: "md", truncate: 200 },
        createdAt: Date.now()
      })

      const registries = store.registryCollection.all()
      const registry = registries.find((r: any) => r.id === "reg-default")
      const specs: ComponentEntrySpec[] = registry?.toEntrySpecs()

      expect(specs).toHaveLength(1)
      expect(specs?.[0].defaultConfig).toEqual({ size: "md", truncate: 200 })
    })
  })
})
