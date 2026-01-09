/**
 * Hydration Module Tests
 *
 * Tests for the hydration module that transforms Registry/RendererBinding
 * entities into ComponentEntrySpec[].
 *
 * Task: task-dcb-004
 */

import { describe, test, expect } from "bun:test"
import {
  hydrateRegistry,
  collectBindingsWithInheritance,
  type HydrationResult
} from "../hydration"
import type { ComponentEntrySpec, PropertyMetadata } from "../types"

// ============================================================================
// Mock Data Factories
// ============================================================================

/**
 * Creates a mock ComponentDefinition entity
 */
function createMockComponentDef(
  id: string,
  name: string,
  implementationRef: string
) {
  return {
    id,
    name,
    category: "display",
    implementationRef,
    createdAt: Date.now()
  }
}

/**
 * Creates a mock RendererBinding entity
 */
function createMockBinding(
  id: string,
  name: string,
  componentDef: ReturnType<typeof createMockComponentDef>,
  matchExpression: object,
  priority: number,
  registryId: string
) {
  return {
    id,
    name,
    registry: registryId,
    component: componentDef,
    matchExpression,
    priority,
    createdAt: Date.now()
  }
}

/**
 * Mock Registry type (explicit to avoid circular reference)
 */
interface MockRegistry {
  id: string
  name: string
  extends?: MockRegistry
  fallbackComponent?: ReturnType<typeof createMockComponentDef>
  bindings: ReturnType<typeof createMockBinding>[]
  createdAt: number
}

/**
 * Creates a mock Registry entity with bindings
 */
function createMockRegistry(
  id: string,
  name: string,
  bindings: ReturnType<typeof createMockBinding>[],
  options: {
    extendsRegistry?: MockRegistry
    fallbackComponent?: ReturnType<typeof createMockComponentDef>
  } = {}
): MockRegistry {
  return {
    id,
    name,
    extends: options.extendsRegistry,
    fallbackComponent: options.fallbackComponent,
    bindings,
    createdAt: Date.now()
  }
}

/**
 * Creates a mock store with collections
 */
function createMockStore(data: {
  registries?: ReturnType<typeof createMockRegistry>[]
  componentDefinitions?: ReturnType<typeof createMockComponentDef>[]
  bindings?: ReturnType<typeof createMockBinding>[]
}) {
  const registriesMap = new Map(
    (data.registries || []).map(r => [r.id, r])
  )
  const componentDefsMap = new Map(
    (data.componentDefinitions || []).map(c => [c.id, c])
  )
  const bindingsMap = new Map(
    (data.bindings || []).map(b => [b.id, b])
  )

  return {
    Registries: {
      get: (id: string) => registriesMap.get(id),
      all: () => Array.from(registriesMap.values())
    },
    ComponentDefinitions: {
      get: (id: string) => componentDefsMap.get(id),
      all: () => Array.from(componentDefsMap.values())
    },
    RendererBindings: {
      get: (id: string) => bindingsMap.get(id),
      all: () => Array.from(bindingsMap.values())
    }
  }
}

// ============================================================================
// AC-1: hydrateRegistry(registryEntity, store) returns ComponentEntrySpec[]
// ============================================================================

describe("AC-1: hydrateRegistry returns ComponentEntrySpec[]", () => {
  test("returns an array", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const binding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    expect(Array.isArray(result.specs)).toBe(true)
  })

  test("returns ComponentEntrySpec objects with correct shape", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const binding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    expect(result.specs.length).toBe(1)

    const spec = result.specs[0]
    expect(spec).toHaveProperty("id")
    expect(spec).toHaveProperty("priority")
    expect(spec).toHaveProperty("matcher")
    expect(spec).toHaveProperty("componentRef")
  })

  test("spec.id matches binding id", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const binding = createMockBinding(
      "my-string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    expect(result.specs[0].id).toBe("my-string-binding")
  })

  test("spec.priority matches binding priority", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const binding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      42,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    expect(result.specs[0].priority).toBe(42)
  })

  test("spec.componentRef matches component.implementationRef", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const binding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    expect(result.specs[0].componentRef).toBe("StringDisplay")
  })

  test("spec.matcher is a function", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const binding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    expect(typeof result.specs[0].matcher).toBe("function")
  })
})

// ============================================================================
// AC-2: collectBindingsWithInheritance recursively collects from extends chain
// ============================================================================

describe("AC-2: collectBindingsWithInheritance recursive collection", () => {
  test("collects bindings from single registry without extends", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const binding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef],
      bindings: [binding]
    })

    const bindings = collectBindingsWithInheritance(registry, store)
    expect(bindings.length).toBe(1)
    expect(bindings[0].id).toBe("string-binding")
  })

  test("collects bindings from parent registry via extends", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const numberDef = createMockComponentDef("number-display", "Number Display", "NumberDisplay")

    const parentBinding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "base"
    )
    const childBinding = createMockBinding(
      "number-binding",
      "Number Type Binding",
      numberDef,
      { type: "number" },
      10,
      "custom"
    )

    const parentRegistry = createMockRegistry("base", "Base Registry", [parentBinding])
    const childRegistry = createMockRegistry("custom", "Custom Registry", [childBinding], {
      extendsRegistry: parentRegistry
    })

    const store = createMockStore({
      registries: [parentRegistry, childRegistry],
      componentDefinitions: [stringDef, numberDef],
      bindings: [parentBinding, childBinding]
    })

    const bindings = collectBindingsWithInheritance(childRegistry, store)
    expect(bindings.length).toBe(2)
    // Should contain both bindings
    const ids = bindings.map(b => b.id)
    expect(ids).toContain("string-binding")
    expect(ids).toContain("number-binding")
  })

  test("collects bindings from multi-level inheritance chain", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const numberDef = createMockComponentDef("number-display", "Number Display", "NumberDisplay")
    const booleanDef = createMockComponentDef("boolean-display", "Boolean Display", "BooleanDisplay")

    const grandparentBinding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "grandparent"
    )
    const parentBinding = createMockBinding(
      "number-binding",
      "Number Type Binding",
      numberDef,
      { type: "number" },
      10,
      "parent"
    )
    const childBinding = createMockBinding(
      "boolean-binding",
      "Boolean Type Binding",
      booleanDef,
      { type: "boolean" },
      10,
      "child"
    )

    const grandparentRegistry = createMockRegistry("grandparent", "Grandparent Registry", [grandparentBinding])
    const parentRegistry = createMockRegistry("parent", "Parent Registry", [parentBinding], {
      extendsRegistry: grandparentRegistry
    })
    const childRegistry = createMockRegistry("child", "Child Registry", [childBinding], {
      extendsRegistry: parentRegistry
    })

    const store = createMockStore({
      registries: [grandparentRegistry, parentRegistry, childRegistry],
      componentDefinitions: [stringDef, numberDef, booleanDef],
      bindings: [grandparentBinding, parentBinding, childBinding]
    })

    const bindings = collectBindingsWithInheritance(childRegistry, store)
    expect(bindings.length).toBe(3)
    const ids = bindings.map(b => b.id)
    expect(ids).toContain("string-binding")
    expect(ids).toContain("number-binding")
    expect(ids).toContain("boolean-binding")
  })
})

// ============================================================================
// AC-3: Child registry bindings appear before parent bindings (child-first)
// ============================================================================

describe("AC-3: Child-first binding priority", () => {
  test("child bindings appear before parent bindings in collected array", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const customStringDef = createMockComponentDef("custom-string", "Custom String", "CustomStringDisplay")

    const parentBinding = createMockBinding(
      "parent-string-binding",
      "Parent String Binding",
      stringDef,
      { type: "string" },
      10,
      "base"
    )
    const childBinding = createMockBinding(
      "child-string-binding",
      "Child String Binding",
      customStringDef,
      { type: "string" },
      10,
      "custom"
    )

    const parentRegistry = createMockRegistry("base", "Base Registry", [parentBinding])
    const childRegistry = createMockRegistry("custom", "Custom Registry", [childBinding], {
      extendsRegistry: parentRegistry
    })

    const store = createMockStore({
      registries: [parentRegistry, childRegistry],
      componentDefinitions: [stringDef, customStringDef],
      bindings: [parentBinding, childBinding]
    })

    const bindings = collectBindingsWithInheritance(childRegistry, store)

    // Child binding should appear first
    expect(bindings[0].id).toBe("child-string-binding")
    expect(bindings[1].id).toBe("parent-string-binding")
  })

  test("hydrated specs maintain child-first order for equal priorities", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const customStringDef = createMockComponentDef("custom-string", "Custom String", "CustomStringDisplay")

    const parentBinding = createMockBinding(
      "parent-string-binding",
      "Parent String Binding",
      stringDef,
      { type: "string" },
      10,
      "base"
    )
    const childBinding = createMockBinding(
      "child-string-binding",
      "Child String Binding",
      customStringDef,
      { type: "string" },
      10,
      "custom"
    )

    const parentRegistry = createMockRegistry("base", "Base Registry", [parentBinding])
    const childRegistry = createMockRegistry("custom", "Custom Registry", [childBinding], {
      extendsRegistry: parentRegistry
    })

    const store = createMockStore({
      registries: [parentRegistry, childRegistry],
      componentDefinitions: [stringDef, customStringDef],
      bindings: [parentBinding, childBinding]
    })

    const result = hydrateRegistry(childRegistry, store)

    // Same priority bindings: child first
    expect(result.specs[0].id).toBe("child-string-binding")
    expect(result.specs[1].id).toBe("parent-string-binding")
  })

  test("higher priority bindings override child-first order", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const customStringDef = createMockComponentDef("custom-string", "Custom String", "CustomStringDisplay")

    const parentBinding = createMockBinding(
      "parent-high-priority",
      "Parent High Priority",
      stringDef,
      { type: "string" },
      100, // Higher priority
      "base"
    )
    const childBinding = createMockBinding(
      "child-low-priority",
      "Child Low Priority",
      customStringDef,
      { type: "string" },
      10, // Lower priority
      "custom"
    )

    const parentRegistry = createMockRegistry("base", "Base Registry", [parentBinding])
    const childRegistry = createMockRegistry("custom", "Custom Registry", [childBinding], {
      extendsRegistry: parentRegistry
    })

    const store = createMockStore({
      registries: [parentRegistry, childRegistry],
      componentDefinitions: [stringDef, customStringDef],
      bindings: [parentBinding, childBinding]
    })

    const result = hydrateRegistry(childRegistry, store)

    // Higher priority wins regardless of child-first
    expect(result.specs[0].id).toBe("parent-high-priority")
    expect(result.specs[1].id).toBe("child-low-priority")
  })
})

// ============================================================================
// AC-4: Matcher created from createMatcherFromExpression
// ============================================================================

describe("AC-4: Matcher function from matchExpression", () => {
  test("matcher correctly matches type: string", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const binding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    const matcher = result.specs[0].matcher

    const stringMeta: PropertyMetadata = { name: "title", type: "string" }
    const numberMeta: PropertyMetadata = { name: "count", type: "number" }

    expect(matcher(stringMeta)).toBe(true)
    expect(matcher(numberMeta)).toBe(false)
  })

  test("matcher correctly matches format: email", () => {
    const emailDef = createMockComponentDef("email-display", "Email Display", "EmailDisplay")
    const binding = createMockBinding(
      "email-binding",
      "Email Format Binding",
      emailDef,
      { format: "email" },
      30,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [emailDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    const matcher = result.specs[0].matcher

    const emailMeta: PropertyMetadata = { name: "email", type: "string", format: "email" }
    const plainMeta: PropertyMetadata = { name: "name", type: "string" }

    expect(matcher(emailMeta)).toBe(true)
    expect(matcher(plainMeta)).toBe(false)
  })

  test("matcher correctly matches $exists operator", () => {
    const enumDef = createMockComponentDef("enum-badge", "Enum Badge", "EnumBadge")
    const binding = createMockBinding(
      "enum-binding",
      "Enum Binding",
      enumDef,
      { enum: { $exists: true } },
      50,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [enumDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    const matcher = result.specs[0].matcher

    const enumMeta: PropertyMetadata = { name: "status", type: "string", enum: ["active", "inactive"] }
    const plainMeta: PropertyMetadata = { name: "name", type: "string" }

    expect(matcher(enumMeta)).toBe(true)
    expect(matcher(plainMeta)).toBe(false)
  })

  test("matcher correctly matches xReferenceType", () => {
    const refDef = createMockComponentDef("ref-display", "Reference Display", "ReferenceDisplay")
    const binding = createMockBinding(
      "ref-binding",
      "Reference Binding",
      refDef,
      { xReferenceType: "single" },
      100,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [refDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    const matcher = result.specs[0].matcher

    const refMeta: PropertyMetadata = { name: "author", xReferenceType: "single", xReferenceTarget: "User" }
    const plainMeta: PropertyMetadata = { name: "name", type: "string" }

    expect(matcher(refMeta)).toBe(true)
    expect(matcher(plainMeta)).toBe(false)
  })

  test("matcher correctly matches complex $and expression", () => {
    const computedEnumDef = createMockComponentDef("computed-enum", "Computed Enum", "ComputedEnumDisplay")
    const binding = createMockBinding(
      "computed-enum-binding",
      "Computed Enum Binding",
      computedEnumDef,
      {
        $and: [
          { xComputed: true },
          { enum: { $exists: true } }
        ]
      },
      100,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [computedEnumDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    const matcher = result.specs[0].matcher

    const computedEnumMeta: PropertyMetadata = { name: "status", xComputed: true, enum: ["a", "b"] }
    const computedOnlyMeta: PropertyMetadata = { name: "fullName", xComputed: true }
    const enumOnlyMeta: PropertyMetadata = { name: "status", enum: ["a", "b"] }

    expect(matcher(computedEnumMeta)).toBe(true)
    expect(matcher(computedOnlyMeta)).toBe(false)
    expect(matcher(enumOnlyMeta)).toBe(false)
  })
})

// ============================================================================
// AC-5: Fallback component resolved from registry.fallbackComponent
// ============================================================================

describe("AC-5: Fallback component resolution", () => {
  test("result includes fallbackRef when registry has fallbackComponent", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const fallbackDef = createMockComponentDef("fallback-display", "Fallback", "FallbackDisplay")

    const binding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding], {
      fallbackComponent: fallbackDef
    })
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef, fallbackDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    expect(result.fallbackRef).toBe("FallbackDisplay")
  })

  test("result has undefined fallbackRef when registry has no fallbackComponent", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")

    const binding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "default"
    )
    const registry = createMockRegistry("default", "Default Registry", [binding])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef],
      bindings: [binding]
    })

    const result = hydrateRegistry(registry, store)
    expect(result.fallbackRef).toBeUndefined()
  })

  test("fallback is inherited from parent registry", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const fallbackDef = createMockComponentDef("fallback-display", "Fallback", "FallbackDisplay")
    const childDef = createMockComponentDef("number-display", "Number Display", "NumberDisplay")

    const parentBinding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "base"
    )
    const childBinding = createMockBinding(
      "number-binding",
      "Number Type Binding",
      childDef,
      { type: "number" },
      10,
      "custom"
    )

    const parentRegistry = createMockRegistry("base", "Base Registry", [parentBinding], {
      fallbackComponent: fallbackDef
    })
    // Child registry does NOT define fallback
    const childRegistry = createMockRegistry("custom", "Custom Registry", [childBinding], {
      extendsRegistry: parentRegistry
    })

    const store = createMockStore({
      registries: [parentRegistry, childRegistry],
      componentDefinitions: [stringDef, fallbackDef, childDef],
      bindings: [parentBinding, childBinding]
    })

    const result = hydrateRegistry(childRegistry, store)
    // Should inherit fallback from parent
    expect(result.fallbackRef).toBe("FallbackDisplay")
  })

  test("child fallback overrides parent fallback", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const parentFallbackDef = createMockComponentDef("parent-fallback", "Parent Fallback", "ParentFallback")
    const childFallbackDef = createMockComponentDef("child-fallback", "Child Fallback", "ChildFallback")
    const childDef = createMockComponentDef("number-display", "Number Display", "NumberDisplay")

    const parentBinding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "base"
    )
    const childBinding = createMockBinding(
      "number-binding",
      "Number Type Binding",
      childDef,
      { type: "number" },
      10,
      "custom"
    )

    const parentRegistry = createMockRegistry("base", "Base Registry", [parentBinding], {
      fallbackComponent: parentFallbackDef
    })
    const childRegistry = createMockRegistry("custom", "Custom Registry", [childBinding], {
      extendsRegistry: parentRegistry,
      fallbackComponent: childFallbackDef
    })

    const store = createMockStore({
      registries: [parentRegistry, childRegistry],
      componentDefinitions: [stringDef, parentFallbackDef, childFallbackDef, childDef],
      bindings: [parentBinding, childBinding]
    })

    const result = hydrateRegistry(childRegistry, store)
    // Child fallback should win
    expect(result.fallbackRef).toBe("ChildFallback")
  })
})

// ============================================================================
// AC-6: Circular reference detection prevents infinite loops
// ============================================================================

describe("AC-6: Circular reference detection", () => {
  test("detects self-referential extends (A extends A)", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const binding = createMockBinding(
      "string-binding",
      "String Type Binding",
      stringDef,
      { type: "string" },
      10,
      "loop"
    )

    // Create registry that extends itself (manually creating circular reference)
    const selfRefRegistry: any = {
      id: "loop",
      name: "Self-Referencing Registry",
      bindings: [binding],
      createdAt: Date.now()
    }
    selfRefRegistry.extends = selfRefRegistry // Self-reference

    const store = createMockStore({
      registries: [selfRefRegistry],
      componentDefinitions: [stringDef],
      bindings: [binding]
    })

    // Should not throw, should terminate gracefully
    const bindings = collectBindingsWithInheritance(selfRefRegistry, store)
    expect(bindings.length).toBe(1) // Only the direct binding
  })

  test("detects 2-node cycle (A extends B, B extends A)", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const numberDef = createMockComponentDef("number-display", "Number Display", "NumberDisplay")

    const bindingA = createMockBinding(
      "binding-a",
      "Binding A",
      stringDef,
      { type: "string" },
      10,
      "registry-a"
    )
    const bindingB = createMockBinding(
      "binding-b",
      "Binding B",
      numberDef,
      { type: "number" },
      10,
      "registry-b"
    )

    // Create mutual reference cycle
    const registryA: any = {
      id: "registry-a",
      name: "Registry A",
      bindings: [bindingA],
      createdAt: Date.now()
    }
    const registryB: any = {
      id: "registry-b",
      name: "Registry B",
      bindings: [bindingB],
      createdAt: Date.now()
    }
    registryA.extends = registryB
    registryB.extends = registryA

    const store = createMockStore({
      registries: [registryA, registryB],
      componentDefinitions: [stringDef, numberDef],
      bindings: [bindingA, bindingB]
    })

    // Should not throw, should terminate with both bindings
    const bindings = collectBindingsWithInheritance(registryA, store)
    expect(bindings.length).toBe(2)
    const ids = bindings.map(b => b.id)
    expect(ids).toContain("binding-a")
    expect(ids).toContain("binding-b")
  })

  test("detects 3-node cycle (A extends B, B extends C, C extends A)", () => {
    const defA = createMockComponentDef("def-a", "Def A", "CompA")
    const defB = createMockComponentDef("def-b", "Def B", "CompB")
    const defC = createMockComponentDef("def-c", "Def C", "CompC")

    const bindingA = createMockBinding("binding-a", "Binding A", defA, { name: "a" }, 10, "registry-a")
    const bindingB = createMockBinding("binding-b", "Binding B", defB, { name: "b" }, 10, "registry-b")
    const bindingC = createMockBinding("binding-c", "Binding C", defC, { name: "c" }, 10, "registry-c")

    // Create 3-node cycle
    const registryA: any = { id: "registry-a", name: "Registry A", bindings: [bindingA], createdAt: Date.now() }
    const registryB: any = { id: "registry-b", name: "Registry B", bindings: [bindingB], createdAt: Date.now() }
    const registryC: any = { id: "registry-c", name: "Registry C", bindings: [bindingC], createdAt: Date.now() }
    registryA.extends = registryB
    registryB.extends = registryC
    registryC.extends = registryA // Completes the cycle

    const store = createMockStore({
      registries: [registryA, registryB, registryC],
      componentDefinitions: [defA, defB, defC],
      bindings: [bindingA, bindingB, bindingC]
    })

    // Should not throw, should terminate with all 3 bindings
    const bindings = collectBindingsWithInheritance(registryA, store)
    expect(bindings.length).toBe(3)
    const ids = bindings.map(b => b.id)
    expect(ids).toContain("binding-a")
    expect(ids).toContain("binding-b")
    expect(ids).toContain("binding-c")
  })
})

// ============================================================================
// Integration Tests: Full hydration scenarios
// ============================================================================

describe("Integration: Full hydration scenarios", () => {
  test("hydrates a complete registry with multiple bindings sorted by priority", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const enumDef = createMockComponentDef("enum-badge", "Enum Badge", "EnumBadge")
    const emailDef = createMockComponentDef("email-display", "Email Display", "EmailDisplay")

    const stringBinding = createMockBinding(
      "string-binding",
      "String Type",
      stringDef,
      { type: "string" },
      10, // Lowest priority
      "default"
    )
    const enumBinding = createMockBinding(
      "enum-binding",
      "Enum Type",
      enumDef,
      { enum: { $exists: true } },
      50, // Medium priority
      "default"
    )
    const emailBinding = createMockBinding(
      "email-binding",
      "Email Format",
      emailDef,
      { format: "email" },
      30, // Lower-medium priority
      "default"
    )

    const registry = createMockRegistry("default", "Default", [
      stringBinding,
      enumBinding,
      emailBinding
    ])
    const store = createMockStore({
      registries: [registry],
      componentDefinitions: [stringDef, enumDef, emailDef],
      bindings: [stringBinding, enumBinding, emailBinding]
    })

    const result = hydrateRegistry(registry, store)

    // Should be sorted by priority (highest first)
    expect(result.specs.length).toBe(3)
    expect(result.specs[0].id).toBe("enum-binding") // priority 50
    expect(result.specs[1].id).toBe("email-binding") // priority 30
    expect(result.specs[2].id).toBe("string-binding") // priority 10
  })

  test("hydrates registry with inheritance and preserves resolution order", () => {
    const stringDef = createMockComponentDef("string-display", "String Display", "StringDisplay")
    const customStringDef = createMockComponentDef("custom-string", "Custom String", "CustomStringDisplay")
    const enumDef = createMockComponentDef("enum-badge", "Enum Badge", "EnumBadge")
    const fallbackDef = createMockComponentDef("fallback", "Fallback", "FallbackDisplay")

    // Parent has string (priority 10) and enum (priority 50)
    const parentStringBinding = createMockBinding(
      "parent-string",
      "Parent String",
      stringDef,
      { type: "string" },
      10,
      "base"
    )
    const parentEnumBinding = createMockBinding(
      "parent-enum",
      "Parent Enum",
      enumDef,
      { enum: { $exists: true } },
      50,
      "base"
    )

    // Child overrides string with custom (same priority)
    const childStringBinding = createMockBinding(
      "child-string",
      "Child String",
      customStringDef,
      { type: "string" },
      10,
      "custom"
    )

    const parentRegistry = createMockRegistry("base", "Base", [parentStringBinding, parentEnumBinding], {
      fallbackComponent: fallbackDef
    })
    const childRegistry = createMockRegistry("custom", "Custom", [childStringBinding], {
      extendsRegistry: parentRegistry
    })

    const store = createMockStore({
      registries: [parentRegistry, childRegistry],
      componentDefinitions: [stringDef, customStringDef, enumDef, fallbackDef],
      bindings: [parentStringBinding, parentEnumBinding, childStringBinding]
    })

    const result = hydrateRegistry(childRegistry, store)

    // Expected order: enum (50), child-string (10, child-first), parent-string (10)
    expect(result.specs.length).toBe(3)
    expect(result.specs[0].id).toBe("parent-enum") // Highest priority
    expect(result.specs[1].id).toBe("child-string") // Same priority, child-first
    expect(result.specs[2].id).toBe("parent-string") // Same priority, parent second

    // Fallback inherited from parent
    expect(result.fallbackRef).toBe("FallbackDisplay")
  })

  test("empty registry returns empty specs array", () => {
    const registry = createMockRegistry("empty", "Empty Registry", [])
    const store = createMockStore({ registries: [registry] })

    const result = hydrateRegistry(registry, store)
    expect(result.specs).toEqual([])
    expect(result.fallbackRef).toBeUndefined()
  })
})
