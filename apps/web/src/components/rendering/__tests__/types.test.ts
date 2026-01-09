/**
 * Tests for component registry type definitions
 * Task: task-registry-types
 * Updated: task-dcb-006 (added HydratedComponentEntry tests)
 *
 * Verifies that all interfaces are correctly defined and exported.
 */

import { describe, test, expect } from "bun:test"
import type {
  PropertyMetadata,
  ComponentEntry,
  DisplayRendererProps,
  IComponentRegistry,
  HydratedComponentEntry,
  ComponentEntrySpec,
  ComponentDefinitionEntity,
  RegistryEntity,
  BindingEntity
} from "../types"
import type { ComponentType } from "react"

describe("PropertyMetadata interface", () => {
  test("PropertyMetadata interface has correct shape", () => {
    const meta: PropertyMetadata = {
      name: "email",
      type: "string",
      format: "email"
    }

    expect(meta.name).toBe("email")
    expect(meta.type).toBe("string")
    expect(meta.format).toBe("email")
  })

  test("PropertyMetadata supports all optional fields", () => {
    const meta: PropertyMetadata = {
      name: "status",
      type: "string",
      format: "date-time",
      enum: ["active", "inactive"],
      xReferenceType: "single",
      xReferenceTarget: "User",
      xComputed: true,
      xRenderer: "status-badge",
      required: true
    }

    expect(meta.name).toBe("status")
    expect(meta.enum).toEqual(["active", "inactive"])
    expect(meta.xReferenceType).toBe("single")
    expect(meta.xReferenceTarget).toBe("User")
    expect(meta.xComputed).toBe(true)
    expect(meta.xRenderer).toBe("status-badge")
    expect(meta.required).toBe(true)
  })

  test("PropertyMetadata type field accepts valid types", () => {
    const types: Array<PropertyMetadata["type"]> = [
      "string",
      "number",
      "boolean",
      "array",
      "object",
      undefined
    ]

    types.forEach((type) => {
      const meta: PropertyMetadata = { name: "test", type }
      expect(meta.type).toBe(type)
    })
  })
})

describe("ComponentEntry interface", () => {
  test("ComponentEntry interface has correct shape", () => {
    // Mock component
    const MockComponent = () => null

    const entry: ComponentEntry = {
      id: "string-display",
      matches: (meta) => meta.type === "string",
      component: MockComponent as ComponentType<DisplayRendererProps>
    }

    expect(entry.id).toBe("string-display")
    expect(typeof entry.matches).toBe("function")
    expect(entry.component).toBe(MockComponent)
  })

  test("ComponentEntry supports optional priority", () => {
    const MockComponent = () => null

    const entry: ComponentEntry = {
      id: "email-display",
      matches: (meta) => meta.format === "email",
      component: MockComponent as ComponentType<DisplayRendererProps>,
      priority: 30
    }

    expect(entry.priority).toBe(30)
  })

  test("ComponentEntry matches function receives PropertyMetadata", () => {
    const MockComponent = () => null
    let receivedMeta: PropertyMetadata | null = null

    const entry: ComponentEntry = {
      id: "test",
      matches: (meta) => {
        receivedMeta = meta
        return true
      },
      component: MockComponent as ComponentType<DisplayRendererProps>
    }

    const testMeta: PropertyMetadata = {
      name: "testField",
      type: "string",
      xComputed: true
    }

    entry.matches(testMeta)
    expect(receivedMeta).toEqual(testMeta)
  })
})

describe("DisplayRendererProps interface", () => {
  test("DisplayRendererProps interface has correct shape", () => {
    const props: DisplayRendererProps = {
      property: { name: "test", type: "string" },
      value: "test value"
    }

    expect(props.property.name).toBe("test")
    expect(props.value).toBe("test value")
  })

  test("DisplayRendererProps supports optional entity", () => {
    const props: DisplayRendererProps = {
      property: { name: "author", type: "string", xReferenceType: "single" },
      value: "user-123",
      entity: { id: "user-123", name: "John Doe" }
    }

    expect(props.entity?.name).toBe("John Doe")
  })

  test("DisplayRendererProps supports optional depth", () => {
    const props: DisplayRendererProps = {
      property: { name: "items", type: "array" },
      value: [1, 2, 3],
      depth: 1
    }

    expect(props.depth).toBe(1)
  })

  test("DisplayRendererProps value can be any type", () => {
    const stringProps: DisplayRendererProps = {
      property: { name: "text" },
      value: "hello"
    }
    expect(stringProps.value).toBe("hello")

    const numberProps: DisplayRendererProps = {
      property: { name: "count" },
      value: 42
    }
    expect(numberProps.value).toBe(42)

    const arrayProps: DisplayRendererProps = {
      property: { name: "items" },
      value: [1, 2, 3]
    }
    expect(arrayProps.value).toEqual([1, 2, 3])

    const objectProps: DisplayRendererProps = {
      property: { name: "config" },
      value: { key: "value" }
    }
    expect(objectProps.value).toEqual({ key: "value" })

    const nullProps: DisplayRendererProps = {
      property: { name: "empty" },
      value: null
    }
    expect(nullProps.value).toBeNull()
  })
})

describe("IComponentRegistry interface", () => {
  test("IComponentRegistry interface has correct shape", () => {
    // Create a mock registry that implements the interface
    const MockComponent = () => null

    const mockRegistry: IComponentRegistry = {
      register: (entry: ComponentEntry) => {},
      unregister: (id: string) => true,
      resolve: (property: PropertyMetadata) =>
        MockComponent as ComponentType<DisplayRendererProps>,
      entries: () => []
    }

    expect(typeof mockRegistry.register).toBe("function")
    expect(typeof mockRegistry.unregister).toBe("function")
    expect(typeof mockRegistry.resolve).toBe("function")
    expect(typeof mockRegistry.entries).toBe("function")
  })
})

describe("Types module exports", () => {
  test("Interfaces exported from components/rendering/types.ts", async () => {
    // This test verifies the module exports exist
    const types = await import("../types")

    // The module should export (types are erased at runtime, but we can check the module loads)
    expect(types).toBeDefined()
  })
})

/**
 * Task: task-dcb-006
 * Tests for HydratedComponentEntry and re-exported types from state-api
 */
describe("HydratedComponentEntry interface", () => {
  test("HydratedComponentEntry extends ComponentEntry with entityId", () => {
    const MockComponent = () => null

    const entry: HydratedComponentEntry = {
      id: "string-display",
      matches: (meta) => meta.type === "string",
      component: MockComponent as ComponentType<DisplayRendererProps>,
      priority: 10,
      entityId: "binding-string-display-001"
    }

    // Has all ComponentEntry fields
    expect(entry.id).toBe("string-display")
    expect(typeof entry.matches).toBe("function")
    expect(entry.component).toBe(MockComponent)
    expect(entry.priority).toBe(10)

    // Plus entityId field
    expect(entry.entityId).toBe("binding-string-display-001")
  })

  test("HydratedComponentEntry is assignable to ComponentEntry", () => {
    const MockComponent = () => null

    const hydrated: HydratedComponentEntry = {
      id: "test",
      matches: () => true,
      component: MockComponent as ComponentType<DisplayRendererProps>,
      entityId: "entity-123"
    }

    // Should be assignable to ComponentEntry (subtype compatibility)
    const entry: ComponentEntry = hydrated
    expect(entry.id).toBe("test")
  })

  test("HydratedComponentEntry can be used in arrays with ComponentEntry", () => {
    const MockComponent = () => null

    const entries: ComponentEntry[] = [
      // Regular ComponentEntry
      {
        id: "fallback",
        matches: () => true,
        component: MockComponent as ComponentType<DisplayRendererProps>,
        priority: 0
      },
      // HydratedComponentEntry (is a subtype of ComponentEntry)
      {
        id: "string-display",
        matches: (meta) => meta.type === "string",
        component: MockComponent as ComponentType<DisplayRendererProps>,
        priority: 10,
        entityId: "binding-123"
      } as HydratedComponentEntry
    ]

    expect(entries.length).toBe(2)
  })
})

describe("Re-exported types from state-api", () => {
  test("ComponentEntrySpec interface (isomorphic, no React)", () => {
    // ComponentEntrySpec uses componentRef (string) instead of component (React.ComponentType)
    const spec: ComponentEntrySpec = {
      id: "string-display",
      priority: 10,
      matcher: (meta) => meta.type === "string",
      componentRef: "StringDisplay"
    }

    expect(spec.id).toBe("string-display")
    expect(spec.priority).toBe(10)
    expect(typeof spec.matcher).toBe("function")
    expect(spec.componentRef).toBe("StringDisplay")
  })

  test("ComponentEntrySpec matcher is compatible with PropertyMetadata", () => {
    const spec: ComponentEntrySpec = {
      id: "enum-badge",
      priority: 50,
      matcher: (meta) => {
        // Can access PropertyMetadata fields
        return (
          meta.type === "string" &&
          Array.isArray(meta.enum) &&
          !meta.xComputed
        )
      },
      componentRef: "EnumBadge"
    }

    const testMeta: PropertyMetadata = {
      name: "status",
      type: "string",
      enum: ["active", "inactive"]
    }

    expect(spec.matcher(testMeta)).toBe(true)
  })

  test("Entity type aliases are exported (any types for MST instances)", () => {
    // These are 'any' type aliases for MST entity instances
    // We just verify they can be used without type errors

    const componentDef: ComponentDefinitionEntity = {
      id: "string-display",
      name: "String Display",
      category: "display",
      implementationRef: "StringDisplay"
    }
    expect(componentDef.id).toBe("string-display")

    const registry: RegistryEntity = {
      id: "default",
      name: "Default Registry",
      bindings: []
    }
    expect(registry.id).toBe("default")

    const binding: BindingEntity = {
      id: "binding-001",
      name: "String Type Binding",
      registry: "default",
      component: "string-display",
      matchExpression: { type: "string" },
      priority: 10
    }
    expect(binding.id).toBe("binding-001")
  })
})
