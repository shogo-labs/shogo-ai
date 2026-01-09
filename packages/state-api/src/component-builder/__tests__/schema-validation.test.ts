/**
 * Component Builder Schema Validation Tests (TDD)
 *
 * Task: task-dcb-001 - validate-schema
 *
 * Tests that the component-builder schema at .schemas/component-builder/schema.json
 * is correctly structured for MST transformation:
 * 1. Schema loads successfully via Wavesmith
 * 2. All 5 entities have x-mst-type: identifier on id field
 * 3. Registry.extends has x-mst-type: maybe-reference pointing to Registry
 * 4. Registry.bindings has x-computed and x-inverse annotations
 * 5. RendererBinding.registry and .component have x-mst-type: reference
 * 6. Schema passes enhancedJsonSchemaToMST transformation
 */

import { describe, test, expect, beforeAll } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { enhancedJsonSchemaToMST } from "../../schematic"
import type { EnhancedJsonSchema } from "../../schematic/types"

// Path to the component-builder schema
// Using process.cwd() to get worktree root since tests run from there
const SCHEMA_PATH = join(
  process.cwd(),
  ".schemas/component-builder/schema.json"
)

// Expected entities in the component-builder schema
const EXPECTED_ENTITIES = [
  "ComponentDefinition",
  "Registry",
  "RendererBinding",
  "LayoutTemplate",
  "Composition",
]

describe("Component Builder Schema Validation (task-dcb-001)", () => {
  let schema: EnhancedJsonSchema & { $defs: Record<string, any> }

  beforeAll(() => {
    // Load the schema from disk
    const schemaContent = readFileSync(SCHEMA_PATH, "utf-8")
    schema = JSON.parse(schemaContent)
  })

  // ============================================================================
  // Test: test-dcb-001-schema-load
  // Component-builder schema loads successfully via Wavesmith
  // ============================================================================
  describe("test-dcb-001-schema-load", () => {
    test("schema file exists and can be parsed", () => {
      expect(schema).toBeDefined()
      expect(schema.$defs).toBeDefined()
    })

    test("schema has all 5 expected entities", () => {
      const entityNames = Object.keys(schema.$defs)
      for (const expected of EXPECTED_ENTITIES) {
        expect(entityNames).toContain(expected)
      }
      expect(entityNames.length).toBe(5)
    })

    test("schema has correct format identifier", () => {
      expect(schema.format || (schema as any).format).toBe("enhanced-json-schema")
    })

    test("schema has name set to component-builder", () => {
      expect((schema as any).name).toBe("component-builder")
    })
  })

  // ============================================================================
  // Test: test-dcb-001-identifier-fields
  // All entities have x-mst-type: identifier on id field
  // ============================================================================
  describe("test-dcb-001-identifier-fields", () => {
    for (const entityName of EXPECTED_ENTITIES) {
      test(`${entityName}.id has x-mst-type: identifier`, () => {
        const entity = schema.$defs[entityName]
        expect(entity).toBeDefined()
        expect(entity.properties).toBeDefined()
        expect(entity.properties.id).toBeDefined()
        expect(entity.properties.id["x-mst-type"]).toBe("identifier")
      })
    }
  })

  // ============================================================================
  // Test: test-dcb-001-registry-extends
  // Registry.extends has x-mst-type: maybe-reference pointing to Registry
  // ============================================================================
  describe("test-dcb-001-registry-extends", () => {
    test("Registry.extends exists and is optional", () => {
      const registry = schema.$defs.Registry
      expect(registry.properties.extends).toBeDefined()
      // Should NOT be in required array
      expect(registry.required || []).not.toContain("extends")
    })

    test("Registry.extends has x-mst-type: maybe-reference", () => {
      const extendsField = schema.$defs.Registry.properties.extends
      expect(extendsField["x-mst-type"]).toBe("maybe-reference")
    })

    test("Registry.extends has x-reference-type: single", () => {
      const extendsField = schema.$defs.Registry.properties.extends
      expect(extendsField["x-reference-type"]).toBe("single")
    })

    test("Registry.extends has x-reference-target: Registry", () => {
      const extendsField = schema.$defs.Registry.properties.extends
      expect(extendsField["x-reference-target"]).toBe("Registry")
    })
  })

  // ============================================================================
  // Test: test-dcb-001-bindings-computed
  // Registry.bindings has x-computed and x-inverse annotations
  // ============================================================================
  describe("test-dcb-001-bindings-computed", () => {
    test("Registry.bindings exists", () => {
      const registry = schema.$defs.Registry
      expect(registry.properties.bindings).toBeDefined()
    })

    test("Registry.bindings has x-computed: true", () => {
      const bindings = schema.$defs.Registry.properties.bindings
      expect(bindings["x-computed"]).toBe(true)
    })

    test("Registry.bindings has x-inverse: RendererBinding.registry", () => {
      const bindings = schema.$defs.Registry.properties.bindings
      expect(bindings["x-inverse"]).toBe("RendererBinding.registry")
    })

    test("Registry.bindings is an array type", () => {
      const bindings = schema.$defs.Registry.properties.bindings
      expect(bindings.type).toBe("array")
    })
  })

  // ============================================================================
  // Test: test-dcb-001-binding-references
  // RendererBinding.registry and .component have x-mst-type: reference
  // ============================================================================
  describe("test-dcb-001-binding-references", () => {
    test("RendererBinding.registry exists and is required", () => {
      const binding = schema.$defs.RendererBinding
      expect(binding.properties.registry).toBeDefined()
      expect(binding.required).toContain("registry")
    })

    test("RendererBinding.registry has x-mst-type: reference", () => {
      const registryField = schema.$defs.RendererBinding.properties.registry
      expect(registryField["x-mst-type"]).toBe("reference")
    })

    test("RendererBinding.registry has x-reference-type: single", () => {
      const registryField = schema.$defs.RendererBinding.properties.registry
      expect(registryField["x-reference-type"]).toBe("single")
    })

    test("RendererBinding.registry has x-reference-target: Registry", () => {
      const registryField = schema.$defs.RendererBinding.properties.registry
      expect(registryField["x-reference-target"]).toBe("Registry")
    })

    test("RendererBinding.component exists and is required", () => {
      const binding = schema.$defs.RendererBinding
      expect(binding.properties.component).toBeDefined()
      expect(binding.required).toContain("component")
    })

    test("RendererBinding.component has x-mst-type: reference", () => {
      const componentField = schema.$defs.RendererBinding.properties.component
      expect(componentField["x-mst-type"]).toBe("reference")
    })

    test("RendererBinding.component has x-reference-type: single", () => {
      const componentField = schema.$defs.RendererBinding.properties.component
      expect(componentField["x-reference-type"]).toBe("single")
    })

    test("RendererBinding.component has x-reference-target: ComponentDefinition", () => {
      const componentField = schema.$defs.RendererBinding.properties.component
      expect(componentField["x-reference-target"]).toBe("ComponentDefinition")
    })
  })

  // ============================================================================
  // Test: test-dcb-001-mst-transform
  // Schema passes enhancedJsonSchemaToMST transformation
  // ============================================================================
  describe("test-dcb-001-mst-transform", () => {
    test("schema transforms to MST without errors", () => {
      // Add x-original-name if missing (required for transformation)
      const schemaForTransform = JSON.parse(JSON.stringify(schema))
      for (const [name, def] of Object.entries(schemaForTransform.$defs)) {
        if (!(def as any)["x-original-name"]) {
          (def as any)["x-original-name"] = name
        }
      }

      expect(() => {
        const result = enhancedJsonSchemaToMST(schemaForTransform)
        expect(result).toBeDefined()
      }).not.toThrow()
    })

    test("transformation produces models for all 5 entities", () => {
      const schemaForTransform = JSON.parse(JSON.stringify(schema))
      for (const [name, def] of Object.entries(schemaForTransform.$defs)) {
        if (!(def as any)["x-original-name"]) {
          (def as any)["x-original-name"] = name
        }
      }

      const result = enhancedJsonSchemaToMST(schemaForTransform)

      for (const entityName of EXPECTED_ENTITIES) {
        expect(result.models[entityName]).toBeDefined()
      }
    })

    test("transformation produces collection models for all 5 entities", () => {
      const schemaForTransform = JSON.parse(JSON.stringify(schema))
      for (const [name, def] of Object.entries(schemaForTransform.$defs)) {
        if (!(def as any)["x-original-name"]) {
          (def as any)["x-original-name"] = name
        }
      }

      const result = enhancedJsonSchemaToMST(schemaForTransform)

      for (const entityName of EXPECTED_ENTITIES) {
        expect(result.collectionModels[`${entityName}Collection`]).toBeDefined()
      }
    })

    test("transformation produces working createStore factory", () => {
      const schemaForTransform = JSON.parse(JSON.stringify(schema))
      for (const [name, def] of Object.entries(schemaForTransform.$defs)) {
        if (!(def as any)["x-original-name"]) {
          (def as any)["x-original-name"] = name
        }
      }

      const result = enhancedJsonSchemaToMST(schemaForTransform)

      expect(typeof result.createStore).toBe("function")

      // Create store and verify it works
      const store = result.createStore()
      expect(store).toBeDefined()
      expect(store.componentDefinitionCollection).toBeDefined()
      expect(store.registryCollection).toBeDefined()
      expect(store.rendererBindingCollection).toBeDefined()
      expect(store.layoutTemplateCollection).toBeDefined()
      expect(store.compositionCollection).toBeDefined()
    })

    test("store can add entities with valid data", () => {
      const schemaForTransform = JSON.parse(JSON.stringify(schema))
      for (const [name, def] of Object.entries(schemaForTransform.$defs)) {
        if (!(def as any)["x-original-name"]) {
          (def as any)["x-original-name"] = name
        }
      }

      const result = enhancedJsonSchemaToMST(schemaForTransform)
      const store = result.createStore()

      // Add a ComponentDefinition
      const component = store.componentDefinitionCollection.add({
        id: "comp-001",
        name: "String Display",
        category: "display",
        implementationRef: "StringDisplay",
        createdAt: Date.now(),
      })
      expect(component.id).toBe("comp-001")
      expect(component.name).toBe("String Display")

      // Add a Registry
      const registry = store.registryCollection.add({
        id: "reg-001",
        name: "default",
        createdAt: Date.now(),
      })
      expect(registry.id).toBe("reg-001")
      expect(registry.name).toBe("default")

      // Add a RendererBinding with references
      const binding = store.rendererBindingCollection.add({
        id: "bind-001",
        name: "string-renderer",
        registry: "reg-001",
        component: "comp-001",
        matchExpression: { type: "string" },
        priority: 10,
        createdAt: Date.now(),
      })
      expect(binding.id).toBe("bind-001")
      expect(binding.registry?.id).toBe("reg-001")
      expect(binding.component?.id).toBe("comp-001")
    })
  })

  // ============================================================================
  // Additional Validation: Composition.layout reference
  // ============================================================================
  describe("additional-validation-composition-layout", () => {
    test("Composition.layout has x-mst-type: reference", () => {
      const layoutField = schema.$defs.Composition.properties.layout
      expect(layoutField["x-mst-type"]).toBe("reference")
    })

    test("Composition.layout has x-reference-target: LayoutTemplate", () => {
      const layoutField = schema.$defs.Composition.properties.layout
      expect(layoutField["x-reference-target"]).toBe("LayoutTemplate")
    })
  })

  // ============================================================================
  // Additional Validation: Registry.fallbackComponent reference
  // ============================================================================
  describe("additional-validation-registry-fallback", () => {
    test("Registry.fallbackComponent has x-mst-type: maybe-reference", () => {
      const fallbackField = schema.$defs.Registry.properties.fallbackComponent
      expect(fallbackField["x-mst-type"]).toBe("maybe-reference")
    })

    test("Registry.fallbackComponent has x-reference-target: ComponentDefinition", () => {
      const fallbackField = schema.$defs.Registry.properties.fallbackComponent
      expect(fallbackField["x-reference-target"]).toBe("ComponentDefinition")
    })
  })
})
