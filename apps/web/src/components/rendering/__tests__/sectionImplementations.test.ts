/**
 * Tests for section implementations map
 * Task: task-cpv-005
 *
 * Verifies that sectionImplementationMap correctly maps implementationRef
 * strings to their corresponding React components, and that getSectionComponent
 * returns the appropriate component or fallback.
 */

import { describe, test, expect } from "bun:test"
import type { ComponentType } from "react"
import {
  sectionImplementationMap,
  getSectionComponent,
  type SectionRendererProps,
} from "../sectionImplementations"

describe("SectionRendererProps interface", () => {
  test("accepts feature as required property", () => {
    // Type-level test: verify the interface accepts required props
    const props: SectionRendererProps = {
      feature: { id: "test-feature", name: "Test Feature" } as any,
    }
    expect(props.feature).toBeDefined()
  })

  test("accepts optional config property", () => {
    // Type-level test: verify config is optional
    const propsWithConfig: SectionRendererProps = {
      feature: { id: "test-feature" } as any,
      config: { showHeader: true, columns: 2 },
    }
    expect(propsWithConfig.config).toBeDefined()

    const propsWithoutConfig: SectionRendererProps = {
      feature: { id: "test-feature" } as any,
    }
    expect(propsWithoutConfig.config).toBeUndefined()
  })

  test("config is Record<string, unknown>", () => {
    // Type-level test: config can hold arbitrary key-value pairs
    const props: SectionRendererProps = {
      feature: { id: "test" } as any,
      config: {
        stringValue: "hello",
        numberValue: 42,
        booleanValue: true,
        nestedObject: { foo: "bar" },
        arrayValue: [1, 2, 3],
      },
    }
    expect(props.config?.stringValue).toBe("hello")
    expect(props.config?.numberValue).toBe(42)
  })
})

describe("sectionImplementationMap", () => {
  test("exports a Map with string keys", () => {
    expect(sectionImplementationMap).toBeInstanceOf(Map)

    // Verify all keys are strings (if any exist)
    for (const key of sectionImplementationMap.keys()) {
      expect(typeof key).toBe("string")
    }
  })

  test("map values are ComponentType<SectionRendererProps>", () => {
    // All values in the map should be valid React components
    // Components can be functions or MobX observer objects with render methods
    for (const [key, component] of sectionImplementationMap.entries()) {
      const isFunction = typeof component === "function"
      const isMobXObserver = typeof component === "object" && component !== null
      expect(isFunction || isMobXObserver).toBe(true)
    }
  })

  test("contains registered section components", () => {
    // The map contains section components for composable phase views
    expect(sectionImplementationMap.size).toBeGreaterThan(0)

    // Verify some known sections are registered
    expect(sectionImplementationMap.has("IntentTerminalSection")).toBe(true)
    expect(sectionImplementationMap.has("PhaseActionsSection")).toBe(true)
  })

  test("contains Analysis phase sections", () => {
    // Analysis phase sections registered for Evidence Board view
    expect(sectionImplementationMap.has("EvidenceBoardHeaderSection")).toBe(true)
    expect(sectionImplementationMap.has("LocationHeatBarSection")).toBe(true)
    expect(sectionImplementationMap.has("FindingMatrixSection")).toBe(true)
    expect(sectionImplementationMap.has("FindingListSection")).toBe(true)
  })

  test("contains Classification phase sections", () => {
    // Classification phase sections registered for Archetype Determination view
    // Task: task-classification-007
    expect(sectionImplementationMap.has("ArchetypeTransformationSection")).toBe(true)
    expect(sectionImplementationMap.has("CorrectionNoteSection")).toBe(true)
    expect(sectionImplementationMap.has("ConfidenceMetersSection")).toBe(true)
    expect(sectionImplementationMap.has("EvidenceColumnsSection")).toBe(true)
    expect(sectionImplementationMap.has("ApplicablePatternsSection")).toBe(true)
    expect(sectionImplementationMap.has("ClassificationRationaleSection")).toBe(true)
  })

  test("contains Design phase sections", () => {
    // Design phase container section registration
    // Task: task-design-008
    expect(sectionImplementationMap.has("DesignContainerSection")).toBe(true)
  })

  /**
   * Test Specification: test-testing-006-registration
   * Task: task-testing-006
   * Scenario: All 4 Testing sections registered in sectionImplementationMap
   *
   * Given: sectionImplementationMap is imported
   * When: Map entries are inspected
   * Then: Map has entry for 'TestPyramidSection'
   *       Map has entry for 'TestTypeDistributionSection'
   *       Map has entry for 'TaskCoverageBarSection'
   *       Map has entry for 'ScenarioSpotlightSection'
   */
  test("contains Testing phase sections", () => {
    // Testing phase sections registered for Test Matrix view
    // Task: task-testing-006
    expect(sectionImplementationMap.has("TestPyramidSection")).toBe(true)
    expect(sectionImplementationMap.has("TestTypeDistributionSection")).toBe(true)
    expect(sectionImplementationMap.has("TaskCoverageBarSection")).toBe(true)
    expect(sectionImplementationMap.has("ScenarioSpotlightSection")).toBe(true)
  })
})

describe("getSectionComponent", () => {
  test("returns fallback component for unknown implementationRef", () => {
    const FallbackComponent = getSectionComponent("NonExistentSection")
    expect(typeof FallbackComponent).toBe("function")
  })

  test("returns fallback for empty string", () => {
    const FallbackComponent = getSectionComponent("")
    expect(typeof FallbackComponent).toBe("function")
  })

  test("returns fallback for undefined", () => {
    // @ts-expect-error - testing runtime behavior with undefined
    const FallbackComponent = getSectionComponent(undefined)
    expect(typeof FallbackComponent).toBe("function")
  })

  test("returns fallback for null", () => {
    // @ts-expect-error - testing runtime behavior with null
    const FallbackComponent = getSectionComponent(null)
    expect(typeof FallbackComponent).toBe("function")
  })

  test("fallback component is a valid React component", () => {
    const Fallback = getSectionComponent("unknown-ref")
    // Verify it's a function (React component)
    expect(typeof Fallback).toBe("function")
  })

  test("fallback component can be called with SectionRendererProps", () => {
    const Fallback = getSectionComponent("unknown")
    // The component should accept SectionRendererProps
    // This is a type-level verification that the fallback matches the expected signature
    const propsCheck: ComponentType<SectionRendererProps> = Fallback
    expect(propsCheck).toBeDefined()
  })

  /**
   * Test Specification: test-design-008-registration
   * Task: task-design-008
   * Scenario: DesignContainerSection registered in sectionImplementationMap
   *
   * Given: sectionImplementationMap is imported
   * When: Map is inspected
   * Then: Map has entry for 'DesignContainerSection'
   *       getSectionComponent('DesignContainerSection') returns the component
   */
  test("returns DesignContainerSection component (not fallback)", () => {
    const Component = getSectionComponent("DesignContainerSection")
    // Component should not be the fallback (function returning div with "Section not found")
    // Verify it's a valid component (function or MobX observer)
    const isFunction = typeof Component === "function"
    const isMobXObserver = typeof Component === "object" && Component !== null
    expect(isFunction || isMobXObserver).toBe(true)

    // Verify it's specifically the DesignContainerSection, not the fallback
    // by checking it's directly from the map
    expect(sectionImplementationMap.get("DesignContainerSection")).toBe(Component)
  })
})

describe("getSectionComponent type safety", () => {
  test("return type is ComponentType<SectionRendererProps>", () => {
    const component = getSectionComponent("any-ref")
    // Type assertion - this would fail at compile time if types don't match
    const typedComponent: ComponentType<SectionRendererProps> = component
    expect(typedComponent).toBeDefined()
  })
})
