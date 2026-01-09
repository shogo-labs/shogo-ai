/**
 * Tests for component implementations map
 * Task: task-dcb-003
 *
 * Verifies that componentImplementationMap correctly maps implementationRef
 * strings to their corresponding React components.
 */

import { describe, test, expect } from "bun:test"
import {
  componentImplementationMap,
  getComponent,
} from "../implementations"

// Import actual components for reference comparison
import {
  StringDisplay,
  NumberDisplay,
  BooleanDisplay,
  DateTimeDisplay,
  EmailDisplay,
  UriDisplay,
  EnumBadge,
  ReferenceDisplay,
  ComputedDisplay,
  ArrayDisplay,
  ObjectDisplay,
} from "../displays"

import {
  PriorityBadge,
  ArchetypeBadge,
  FindingTypeBadge,
  TaskStatusBadge,
  TestTypeBadge,
  SessionStatusBadge,
  RequirementStatusBadge,
  RunStatusBadge,
  ExecutionStatusBadge,
  TestCaseStatusBadge,
  TaskRenderer,
} from "../displays/domain"

import {
  ProgressBar,
  DataCard,
  GraphNode,
  StatusIndicator,
} from "../displays/visualization"

describe("componentImplementationMap", () => {
  test("exports a Map with string keys", () => {
    expect(componentImplementationMap).toBeInstanceOf(Map)

    // Verify all keys are strings
    for (const key of componentImplementationMap.keys()) {
      expect(typeof key).toBe("string")
    }
  })

  describe("primitive renderers", () => {
    test("maps StringDisplay", () => {
      expect(componentImplementationMap.get("StringDisplay")).toBe(StringDisplay)
    })

    test("maps NumberDisplay", () => {
      expect(componentImplementationMap.get("NumberDisplay")).toBe(NumberDisplay)
    })

    test("maps BooleanDisplay", () => {
      expect(componentImplementationMap.get("BooleanDisplay")).toBe(BooleanDisplay)
    })

    test("maps DateTimeDisplay", () => {
      expect(componentImplementationMap.get("DateTimeDisplay")).toBe(DateTimeDisplay)
    })

    test("maps EmailDisplay", () => {
      expect(componentImplementationMap.get("EmailDisplay")).toBe(EmailDisplay)
    })

    test("maps UriDisplay", () => {
      expect(componentImplementationMap.get("UriDisplay")).toBe(UriDisplay)
    })

    test("maps EnumBadge", () => {
      expect(componentImplementationMap.get("EnumBadge")).toBe(EnumBadge)
    })

    test("maps ReferenceDisplay", () => {
      expect(componentImplementationMap.get("ReferenceDisplay")).toBe(ReferenceDisplay)
    })

    test("maps ComputedDisplay", () => {
      expect(componentImplementationMap.get("ComputedDisplay")).toBe(ComputedDisplay)
    })

    test("maps ArrayDisplay", () => {
      expect(componentImplementationMap.get("ArrayDisplay")).toBe(ArrayDisplay)
    })

    test("maps ObjectDisplay", () => {
      expect(componentImplementationMap.get("ObjectDisplay")).toBe(ObjectDisplay)
    })

    test("all 11 primitive renderers are mapped", () => {
      const primitiveRefs = [
        "StringDisplay",
        "NumberDisplay",
        "BooleanDisplay",
        "DateTimeDisplay",
        "EmailDisplay",
        "UriDisplay",
        "EnumBadge",
        "ReferenceDisplay",
        "ComputedDisplay",
        "ArrayDisplay",
        "ObjectDisplay",
      ]

      for (const ref of primitiveRefs) {
        expect(componentImplementationMap.has(ref)).toBe(true)
      }
    })
  })

  describe("domain renderers", () => {
    test("maps PriorityBadge", () => {
      expect(componentImplementationMap.get("PriorityBadge")).toBe(PriorityBadge)
    })

    test("maps ArchetypeBadge", () => {
      expect(componentImplementationMap.get("ArchetypeBadge")).toBe(ArchetypeBadge)
    })

    test("maps FindingTypeBadge", () => {
      expect(componentImplementationMap.get("FindingTypeBadge")).toBe(FindingTypeBadge)
    })

    test("maps TaskStatusBadge", () => {
      expect(componentImplementationMap.get("TaskStatusBadge")).toBe(TaskStatusBadge)
    })

    test("maps TestTypeBadge", () => {
      expect(componentImplementationMap.get("TestTypeBadge")).toBe(TestTypeBadge)
    })

    test("maps SessionStatusBadge", () => {
      expect(componentImplementationMap.get("SessionStatusBadge")).toBe(SessionStatusBadge)
    })

    test("maps RequirementStatusBadge", () => {
      expect(componentImplementationMap.get("RequirementStatusBadge")).toBe(RequirementStatusBadge)
    })

    test("maps RunStatusBadge", () => {
      expect(componentImplementationMap.get("RunStatusBadge")).toBe(RunStatusBadge)
    })

    test("maps ExecutionStatusBadge", () => {
      expect(componentImplementationMap.get("ExecutionStatusBadge")).toBe(ExecutionStatusBadge)
    })

    test("maps TestCaseStatusBadge", () => {
      expect(componentImplementationMap.get("TestCaseStatusBadge")).toBe(TestCaseStatusBadge)
    })

    test("maps TaskRenderer", () => {
      expect(componentImplementationMap.get("TaskRenderer")).toBe(TaskRenderer)
    })

    test("all 11 domain renderers are mapped", () => {
      const domainRefs = [
        "PriorityBadge",
        "ArchetypeBadge",
        "FindingTypeBadge",
        "TaskStatusBadge",
        "TestTypeBadge",
        "SessionStatusBadge",
        "RequirementStatusBadge",
        "RunStatusBadge",
        "ExecutionStatusBadge",
        "TestCaseStatusBadge",
        "TaskRenderer",
      ]

      for (const ref of domainRefs) {
        expect(componentImplementationMap.has(ref)).toBe(true)
      }
    })
  })

  describe("visualization renderers", () => {
    test("maps ProgressBar", () => {
      expect(componentImplementationMap.get("ProgressBar")).toBe(ProgressBar)
    })

    test("maps DataCard", () => {
      expect(componentImplementationMap.get("DataCard")).toBe(DataCard)
    })

    test("maps GraphNode", () => {
      expect(componentImplementationMap.get("GraphNode")).toBe(GraphNode)
    })

    test("maps StatusIndicator", () => {
      expect(componentImplementationMap.get("StatusIndicator")).toBe(StatusIndicator)
    })

    test("all 4 visualization renderers are mapped", () => {
      const visualizationRefs = [
        "ProgressBar",
        "DataCard",
        "GraphNode",
        "StatusIndicator",
      ]

      for (const ref of visualizationRefs) {
        expect(componentImplementationMap.has(ref)).toBe(true)
      }
    })
  })
})

describe("getComponent", () => {
  test("returns the component for a valid implementationRef", () => {
    expect(getComponent("StringDisplay")).toBe(StringDisplay)
    expect(getComponent("PriorityBadge")).toBe(PriorityBadge)
    expect(getComponent("ProgressBar")).toBe(ProgressBar)
  })

  test("returns StringDisplay as fallback for unknown implementationRef", () => {
    expect(getComponent("NonExistentComponent")).toBe(StringDisplay)
    expect(getComponent("")).toBe(StringDisplay)
    expect(getComponent("random-string")).toBe(StringDisplay)
  })

  test("returns StringDisplay as fallback for undefined", () => {
    // @ts-expect-error - testing runtime behavior with undefined
    expect(getComponent(undefined)).toBe(StringDisplay)
  })

  test("returns StringDisplay as fallback for null", () => {
    // @ts-expect-error - testing runtime behavior with null
    expect(getComponent(null)).toBe(StringDisplay)
  })
})
