/**
 * Type tests for component-builder types
 *
 * Task: task-dcb-006
 * Tests that ComponentEntrySpec and related types compile correctly
 * and are compatible with PropertyMetadata.
 */

import { describe, test, expect } from "bun:test"
import type { ComponentEntrySpec, PropertyMetadata } from "../types"

describe("ComponentEntrySpec interface", () => {
  test("can create valid ComponentEntrySpec object", () => {
    const spec: ComponentEntrySpec = {
      id: "string-display",
      priority: 10,
      matcher: (meta: PropertyMetadata) => meta.type === "string",
      componentRef: "StringDisplay",
    }

    expect(spec.id).toBe("string-display")
    expect(spec.priority).toBe(10)
    expect(typeof spec.matcher).toBe("function")
    expect(spec.componentRef).toBe("StringDisplay")
  })

  test("matcher function receives PropertyMetadata", () => {
    const spec: ComponentEntrySpec = {
      id: "enum-badge",
      priority: 50,
      matcher: (meta: PropertyMetadata) => {
        // Can access all PropertyMetadata fields
        return (
          Array.isArray(meta.enum) &&
          meta.type === "string" &&
          !meta.xComputed
        )
      },
      componentRef: "EnumBadge",
    }

    const testMeta: PropertyMetadata = {
      name: "status",
      type: "string",
      enum: ["draft", "published"],
    }

    expect(spec.matcher(testMeta)).toBe(true)
  })

  test("matcher can use xRenderer for explicit binding", () => {
    const spec: ComponentEntrySpec = {
      id: "explicit-badge",
      priority: 200,
      matcher: (meta: PropertyMetadata) => meta.xRenderer === "badge",
      componentRef: "BadgeDisplay",
    }

    const testMeta: PropertyMetadata = {
      name: "category",
      type: "string",
      xRenderer: "badge",
    }

    expect(spec.matcher(testMeta)).toBe(true)
  })

  test("matcher can use xReferenceType for reference binding", () => {
    const spec: ComponentEntrySpec = {
      id: "reference-single",
      priority: 100,
      matcher: (meta: PropertyMetadata) => meta.xReferenceType === "single",
      componentRef: "ReferenceDisplay",
    }

    const testMeta: PropertyMetadata = {
      name: "author",
      type: "string",
      xReferenceType: "single",
      xReferenceTarget: "User",
    }

    expect(spec.matcher(testMeta)).toBe(true)
  })

  test("matcher can check format for format-specific binding", () => {
    const spec: ComponentEntrySpec = {
      id: "email-display",
      priority: 30,
      matcher: (meta: PropertyMetadata) => meta.format === "email",
      componentRef: "EmailDisplay",
    }

    const testMeta: PropertyMetadata = {
      name: "email",
      type: "string",
      format: "email",
    }

    expect(spec.matcher(testMeta)).toBe(true)
  })
})

describe("PropertyMetadata interface (re-exported)", () => {
  test("PropertyMetadata has all expected fields", () => {
    const meta: PropertyMetadata = {
      name: "testField",
      type: "string",
      format: "email",
      enum: ["a", "b"],
      xReferenceType: "single",
      xReferenceTarget: "User",
      xComputed: true,
      xRenderer: "custom",
      required: true,
    }

    expect(meta.name).toBe("testField")
    expect(meta.type).toBe("string")
    expect(meta.format).toBe("email")
    expect(meta.enum).toEqual(["a", "b"])
    expect(meta.xReferenceType).toBe("single")
    expect(meta.xReferenceTarget).toBe("User")
    expect(meta.xComputed).toBe(true)
    expect(meta.xRenderer).toBe("custom")
    expect(meta.required).toBe(true)
  })

  test("PropertyMetadata fields are optional except name", () => {
    // Minimal PropertyMetadata with only required field
    const minimalMeta: PropertyMetadata = {
      name: "simpleField",
    }

    expect(minimalMeta.name).toBe("simpleField")
    expect(minimalMeta.type).toBeUndefined()
  })
})

describe("ComponentEntrySpec array for registry building", () => {
  test("can create array of specs with different priorities", () => {
    const specs: ComponentEntrySpec[] = [
      {
        id: "explicit-renderer",
        priority: 200,
        matcher: (meta) => !!meta.xRenderer,
        componentRef: "dynamic", // would be looked up
      },
      {
        id: "computed-display",
        priority: 100,
        matcher: (meta) => !!meta.xComputed,
        componentRef: "ComputedDisplay",
      },
      {
        id: "reference-single",
        priority: 100,
        matcher: (meta) => meta.xReferenceType === "single",
        componentRef: "ReferenceDisplay",
      },
      {
        id: "enum-badge",
        priority: 50,
        matcher: (meta) => Array.isArray(meta.enum),
        componentRef: "EnumBadge",
      },
      {
        id: "string-display",
        priority: 10,
        matcher: (meta) => meta.type === "string",
        componentRef: "StringDisplay",
      },
      {
        id: "fallback",
        priority: 0,
        matcher: () => true,
        componentRef: "StringDisplay",
      },
    ]

    expect(specs.length).toBe(6)

    // Verify priority sorting would work
    const sorted = [...specs].sort((a, b) => b.priority - a.priority)
    expect(sorted[0].priority).toBe(200)
    expect(sorted[sorted.length - 1].priority).toBe(0)
  })

  test("specs can be filtered by resolution order", () => {
    const specs: ComponentEntrySpec[] = [
      {
        id: "enum-badge",
        priority: 50,
        matcher: (meta) => Array.isArray(meta.enum),
        componentRef: "EnumBadge",
      },
      {
        id: "string-display",
        priority: 10,
        matcher: (meta) => meta.type === "string",
        componentRef: "StringDisplay",
      },
    ]

    const testMeta: PropertyMetadata = {
      name: "status",
      type: "string",
      enum: ["draft", "published"],
    }

    // Find first matching spec by priority order
    const sorted = [...specs].sort((a, b) => b.priority - a.priority)
    const match = sorted.find((spec) => spec.matcher(testMeta))

    expect(match?.id).toBe("enum-badge") // Higher priority matches first
    expect(match?.componentRef).toBe("EnumBadge")
  })
})
