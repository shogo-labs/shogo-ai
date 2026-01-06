/**
 * Tests for component registry type definitions
 * Task: task-registry-types
 *
 * Verifies that all interfaces are correctly defined and exported.
 */

import { describe, test, expect } from "bun:test"
import type {
  PropertyMetadata,
  ComponentEntry,
  DisplayRendererProps,
  IComponentRegistry
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
