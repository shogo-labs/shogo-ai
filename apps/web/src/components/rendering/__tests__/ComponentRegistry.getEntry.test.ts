/**
 * ComponentRegistry.getEntry() Tests
 *
 * TDD: RED phase - Tests written before implementation
 * Tests for the getEntry() method that returns the matched entry (not just component).
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { ComponentRegistry } from "../ComponentRegistry"
import type { PropertyMetadata, ComponentEntry } from "../types"

// Simple fallback component for testing
const FallbackComponent = () => null

describe("ComponentRegistry.getEntry", () => {
  let registry: ComponentRegistry

  beforeEach(() => {
    registry = new ComponentRegistry(FallbackComponent)
  })

  test("returns undefined when no entries match", () => {
    const property: PropertyMetadata = { name: "test", type: "string" }
    const entry = registry.getEntry(property)
    expect(entry).toBeUndefined()
  })

  test("returns matching entry with defaultConfig", () => {
    const mockComponent = () => null
    registry.register({
      id: "string-display",
      priority: 10,
      matches: (meta) => meta.type === "string",
      component: mockComponent,
      defaultConfig: { size: "md", truncate: 200 }
    })

    const property: PropertyMetadata = { name: "title", type: "string" }
    const entry = registry.getEntry(property)

    expect(entry).toBeDefined()
    expect(entry?.id).toBe("string-display")
    expect(entry?.defaultConfig).toEqual({ size: "md", truncate: 200 })
  })

  test("returns highest priority matching entry", () => {
    const mockComponent = () => null
    registry.register({
      id: "generic-string",
      priority: 10,
      matches: (meta) => meta.type === "string",
      component: mockComponent,
      defaultConfig: { size: "sm" }
    })
    registry.register({
      id: "enum-badge",
      priority: 50,
      matches: (meta) => meta.type === "string" && !!meta.enum,
      component: mockComponent,
      defaultConfig: { variant: "emphasized" }
    })

    const enumProperty: PropertyMetadata = {
      name: "status",
      type: "string",
      enum: ["active", "inactive"]
    }
    const entry = registry.getEntry(enumProperty)

    expect(entry?.id).toBe("enum-badge")
    expect(entry?.defaultConfig).toEqual({ variant: "emphasized" })
  })

  test("returns entry without defaultConfig if not defined", () => {
    const mockComponent = () => null
    registry.register({
      id: "no-config",
      priority: 10,
      matches: (meta) => meta.type === "boolean",
      component: mockComponent
      // No defaultConfig
    })

    const property: PropertyMetadata = { name: "active", type: "boolean" }
    const entry = registry.getEntry(property)

    expect(entry).toBeDefined()
    expect(entry?.id).toBe("no-config")
    expect(entry?.defaultConfig).toBeUndefined()
  })

  test("returns same entry as what resolve() would use", () => {
    const stringComponent = () => null
    const numberComponent = () => null

    registry.register({
      id: "string-display",
      priority: 10,
      matches: (meta) => meta.type === "string",
      component: stringComponent
    })
    registry.register({
      id: "number-display",
      priority: 10,
      matches: (meta) => meta.type === "number",
      component: numberComponent
    })

    const stringProp: PropertyMetadata = { name: "title", type: "string" }
    const entry = registry.getEntry(stringProp)
    const component = registry.resolve(stringProp)

    expect(entry?.component).toBe(component)
  })
})
