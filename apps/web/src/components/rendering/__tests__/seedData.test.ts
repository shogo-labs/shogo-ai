/**
 * Tests for seedData module
 * Task: task-dcb-005
 *
 * Tests that seedComponentBuilderData correctly creates all required entities:
 * - ComponentDefinition for each existing renderer (26 components)
 * - 'default' Registry with fallbackComponent pointing to StringDisplay
 * - 'studio' Registry with extends pointing to 'default'
 * - RendererBinding entities for defaultRegistry entries (12 bindings)
 * - RendererBinding entities for studioRegistry entries (15 bindings)
 */

import { describe, test, expect, beforeAll } from "bun:test"

/**
 * Test store mock that captures created entities
 */
interface MockStore {
  ComponentDefinition: Map<string, any>
  Registry: Map<string, any>
  RendererBinding: Map<string, any>
  create: (collection: string, data: any) => any
}

function createMockStore(): MockStore {
  const store: MockStore = {
    ComponentDefinition: new Map(),
    Registry: new Map(),
    RendererBinding: new Map(),
    create(collection: string, data: any) {
      const map = (this as any)[collection] as Map<string, any>
      if (map) {
        map.set(data.id, data)
      }
      return data
    },
  }
  return store
}

// Import will be added when implementation exists
// import { seedComponentBuilderData, COMPONENT_DEFINITIONS, REGISTRY_DEFINITIONS, DEFAULT_BINDINGS, STUDIO_BINDINGS } from "../seedData"

describe("seedData module", () => {
  describe("COMPONENT_DEFINITIONS constant", () => {
    test("defines 38 ComponentDefinition entries (34 original + 4 analysis sections)", async () => {
      const { COMPONENT_DEFINITIONS } = await import("../seedData")
      expect(COMPONENT_DEFINITIONS.length).toBe(38)
    })

    describe("primitive display components (11)", () => {
      test("includes StringDisplay", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const stringDisplay = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "StringDisplay"
        )
        expect(stringDisplay).toBeDefined()
        expect(stringDisplay?.name).toBe("String Display")
        expect(stringDisplay?.category).toBe("display")
      })

      test("includes NumberDisplay", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const numberDisplay = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "NumberDisplay"
        )
        expect(numberDisplay).toBeDefined()
        expect(numberDisplay?.category).toBe("display")
      })

      test("includes BooleanDisplay", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const booleanDisplay = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "BooleanDisplay"
        )
        expect(booleanDisplay).toBeDefined()
        expect(booleanDisplay?.category).toBe("display")
      })

      test("includes DateTimeDisplay", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const datetimeDisplay = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "DateTimeDisplay"
        )
        expect(datetimeDisplay).toBeDefined()
        expect(datetimeDisplay?.category).toBe("display")
      })

      test("includes EmailDisplay", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const emailDisplay = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "EmailDisplay"
        )
        expect(emailDisplay).toBeDefined()
        expect(emailDisplay?.category).toBe("display")
      })

      test("includes UriDisplay", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const uriDisplay = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "UriDisplay"
        )
        expect(uriDisplay).toBeDefined()
        expect(uriDisplay?.category).toBe("display")
      })

      test("includes EnumBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const enumBadge = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "EnumBadge"
        )
        expect(enumBadge).toBeDefined()
        expect(enumBadge?.category).toBe("display")
      })

      test("includes ReferenceDisplay", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const referenceDisplay = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "ReferenceDisplay"
        )
        expect(referenceDisplay).toBeDefined()
        expect(referenceDisplay?.category).toBe("display")
      })

      test("includes ComputedDisplay", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const computedDisplay = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "ComputedDisplay"
        )
        expect(computedDisplay).toBeDefined()
        expect(computedDisplay?.category).toBe("display")
      })

      test("includes ArrayDisplay", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const arrayDisplay = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "ArrayDisplay"
        )
        expect(arrayDisplay).toBeDefined()
        expect(arrayDisplay?.category).toBe("display")
      })

      test("includes ObjectDisplay", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const objectDisplay = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "ObjectDisplay"
        )
        expect(objectDisplay).toBeDefined()
        expect(objectDisplay?.category).toBe("display")
      })

      test("all 11 primitive display components exist", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
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
          const component = COMPONENT_DEFINITIONS.find(
            (c) => c.implementationRef === ref
          )
          expect(component).toBeDefined()
        }
      })
    })

    describe("domain components (11)", () => {
      test("includes PriorityBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "PriorityBadge"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("includes ArchetypeBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "ArchetypeBadge"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("includes FindingTypeBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "FindingTypeBadge"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("includes TaskStatusBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "TaskStatusBadge"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("includes TestTypeBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "TestTypeBadge"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("includes SessionStatusBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "SessionStatusBadge"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("includes RequirementStatusBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "RequirementStatusBadge"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("includes RunStatusBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "RunStatusBadge"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("includes ExecutionStatusBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "ExecutionStatusBadge"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("includes TestCaseStatusBadge", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "TestCaseStatusBadge"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("includes TaskRenderer", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "TaskRenderer"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("display")
      })

      test("all 11 domain components exist", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
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
          const component = COMPONENT_DEFINITIONS.find(
            (c) => c.implementationRef === ref
          )
          expect(component).toBeDefined()
        }
      })
    })

    describe("visualization components (4)", () => {
      test("includes ProgressBar", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "ProgressBar"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("visualization")
      })

      test("includes DataCard", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "DataCard"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("visualization")
      })

      test("includes GraphNode", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "GraphNode"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("visualization")
      })

      test("includes StatusIndicator", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const component = COMPONENT_DEFINITIONS.find(
          (c) => c.implementationRef === "StatusIndicator"
        )
        expect(component).toBeDefined()
        expect(component?.category).toBe("visualization")
      })

      test("all 4 visualization components exist", async () => {
        const { COMPONENT_DEFINITIONS } = await import("../seedData")
        const vizRefs = ["ProgressBar", "DataCard", "GraphNode", "StatusIndicator"]
        for (const ref of vizRefs) {
          const component = COMPONENT_DEFINITIONS.find(
            (c) => c.implementationRef === ref
          )
          expect(component).toBeDefined()
        }
      })
    })

    test("each definition has required fields", async () => {
      const { COMPONENT_DEFINITIONS } = await import("../seedData")
      for (const def of COMPONENT_DEFINITIONS) {
        expect(def.id).toBeDefined()
        expect(typeof def.id).toBe("string")
        expect(def.name).toBeDefined()
        expect(typeof def.name).toBe("string")
        expect(def.category).toBeDefined()
        expect(["display", "input", "layout", "visualization", "section"]).toContain(
          def.category
        )
        expect(def.implementationRef).toBeDefined()
        expect(typeof def.implementationRef).toBe("string")
      }
    })
  })

  describe("REGISTRY_DEFINITIONS constant", () => {
    test("defines exactly 2 Registry entries", async () => {
      const { REGISTRY_DEFINITIONS } = await import("../seedData")
      expect(REGISTRY_DEFINITIONS.length).toBe(2)
    })

    test("defines 'default' registry with fallbackComponent pointing to StringDisplay", async () => {
      const { REGISTRY_DEFINITIONS, COMPONENT_DEFINITIONS } = await import(
        "../seedData"
      )
      const defaultRegistry = REGISTRY_DEFINITIONS.find(
        (r) => r.name === "default"
      )
      expect(defaultRegistry).toBeDefined()
      expect(defaultRegistry?.id).toBe("default")

      // Find the StringDisplay component ID
      const stringDisplay = COMPONENT_DEFINITIONS.find(
        (c) => c.implementationRef === "StringDisplay"
      )
      expect(defaultRegistry?.fallbackComponent).toBe(stringDisplay?.id)
    })

    test("defines 'studio' registry with extends pointing to 'default'", async () => {
      const { REGISTRY_DEFINITIONS } = await import("../seedData")
      const studioRegistry = REGISTRY_DEFINITIONS.find((r) => r.name === "studio")
      expect(studioRegistry).toBeDefined()
      expect(studioRegistry?.id).toBe("studio")
      expect(studioRegistry?.extends).toBe("default")
    })

    test("default registry has no extends field", async () => {
      const { REGISTRY_DEFINITIONS } = await import("../seedData")
      const defaultRegistry = REGISTRY_DEFINITIONS.find(
        (r) => r.name === "default"
      )
      expect(defaultRegistry?.extends).toBeUndefined()
    })
  })

  describe("DEFAULT_BINDINGS constant", () => {
    test("defines 12 RendererBinding entries", async () => {
      const { DEFAULT_BINDINGS } = await import("../seedData")
      // 12 entries: xComputed(1), xReferenceType(2), enum(1), format(3), type(5)
      expect(DEFAULT_BINDINGS.length).toBe(12)
    })

    test("all bindings reference 'default' registry", async () => {
      const { DEFAULT_BINDINGS } = await import("../seedData")
      for (const binding of DEFAULT_BINDINGS) {
        expect(binding.registry).toBe("default")
      }
    })

    describe("match expressions and priorities", () => {
      test("computed-display: xComputed true at priority 100", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "computed-display")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ xComputed: true })
        expect(binding?.priority).toBe(100)
      })

      test("reference-display: xReferenceType single at priority 100", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "reference-display")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ xReferenceType: "single" })
        expect(binding?.priority).toBe(100)
      })

      test("reference-array-display: xReferenceType array at priority 100", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find(
          (b) => b.id === "reference-array-display"
        )
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ xReferenceType: "array" })
        expect(binding?.priority).toBe(100)
      })

      test("enum-badge: enum exists at priority 50", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "enum-badge")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ enum: { $exists: true } })
        expect(binding?.priority).toBe(50)
      })

      test("datetime-display: format date-time at priority 30", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "datetime-display")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ format: "date-time" })
        expect(binding?.priority).toBe(30)
      })

      test("email-display: format email at priority 30", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "email-display")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ format: "email" })
        expect(binding?.priority).toBe(30)
      })

      test("uri-display: format uri at priority 30", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "uri-display")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ format: "uri" })
        expect(binding?.priority).toBe(30)
      })

      test("number-display: type number at priority 10", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "number-display")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ type: "number" })
        expect(binding?.priority).toBe(10)
      })

      test("boolean-display: type boolean at priority 10", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "boolean-display")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ type: "boolean" })
        expect(binding?.priority).toBe(10)
      })

      test("array-display: type array at priority 10", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "array-display")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ type: "array" })
        expect(binding?.priority).toBe(10)
      })

      test("object-display: type object at priority 10", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "object-display")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ type: "object" })
        expect(binding?.priority).toBe(10)
      })

      test("string-display: type string at priority 10", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        const binding = DEFAULT_BINDINGS.find((b) => b.id === "string-display")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ type: "string" })
        expect(binding?.priority).toBe(10)
      })

      test("all bindings have required fields", async () => {
        const { DEFAULT_BINDINGS } = await import("../seedData")
        for (const binding of DEFAULT_BINDINGS) {
          expect(binding.id).toBeDefined()
          expect(typeof binding.id).toBe("string")
          expect(binding.name).toBeDefined()
          expect(typeof binding.name).toBe("string")
          expect(binding.registry).toBe("default")
          expect(binding.component).toBeDefined()
          expect(binding.matchExpression).toBeDefined()
          expect(typeof binding.matchExpression).toBe("object")
          expect(typeof binding.priority).toBe("number")
        }
      })
    })
  })

  describe("STUDIO_BINDINGS constant", () => {
    test("defines 18 RendererBinding entries", async () => {
      const { STUDIO_BINDINGS } = await import("../seedData")
      expect(STUDIO_BINDINGS.length).toBe(18)
    })

    test("all bindings reference 'studio' registry", async () => {
      const { STUDIO_BINDINGS } = await import("../seedData")
      for (const binding of STUDIO_BINDINGS) {
        expect(binding.registry).toBe("studio")
      }
    })

    describe("domain badge bindings at priority 200", () => {
      test("priority-badge: xRenderer priority-badge", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "priority-badge")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ xRenderer: "priority-badge" })
        expect(binding?.priority).toBe(200)
      })

      test("archetype-badge: xRenderer archetype-badge", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "archetype-badge")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ xRenderer: "archetype-badge" })
        expect(binding?.priority).toBe(200)
      })

      test("finding-type-badge: xRenderer finding-type-badge", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "finding-type-badge")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({
          xRenderer: "finding-type-badge",
        })
        expect(binding?.priority).toBe(200)
      })

      test("task-status-badge: xRenderer task-status-badge", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "task-status-badge")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({
          xRenderer: "task-status-badge",
        })
        expect(binding?.priority).toBe(200)
      })

      test("test-type-badge: xRenderer test-type-badge", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "test-type-badge")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ xRenderer: "test-type-badge" })
        expect(binding?.priority).toBe(200)
      })

      test("session-status-badge: xRenderer session-status-badge", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find(
          (b) => b.id === "session-status-badge"
        )
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({
          xRenderer: "session-status-badge",
        })
        expect(binding?.priority).toBe(200)
      })

      test("requirement-status-badge: xRenderer requirement-status-badge", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find(
          (b) => b.id === "requirement-status-badge"
        )
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({
          xRenderer: "requirement-status-badge",
        })
        expect(binding?.priority).toBe(200)
      })

      test("run-status-badge: xRenderer run-status-badge", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "run-status-badge")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({
          xRenderer: "run-status-badge",
        })
        expect(binding?.priority).toBe(200)
      })

      test("execution-status-badge: xRenderer execution-status-badge", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find(
          (b) => b.id === "execution-status-badge"
        )
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({
          xRenderer: "execution-status-badge",
        })
        expect(binding?.priority).toBe(200)
      })

      test("test-case-status-badge: xRenderer test-case-status-badge", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find(
          (b) => b.id === "test-case-status-badge"
        )
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({
          xRenderer: "test-case-status-badge",
        })
        expect(binding?.priority).toBe(200)
      })

      test("implementation-task: xRenderer implementation-task", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "implementation-task")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({
          xRenderer: "implementation-task",
        })
        expect(binding?.priority).toBe(200)
      })
    })

    describe("visualization bindings at priority 200", () => {
      test("progress-bar: xRenderer progress-bar", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "progress-bar")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ xRenderer: "progress-bar" })
        expect(binding?.priority).toBe(200)
      })

      test("data-card: xRenderer data-card", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "data-card")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ xRenderer: "data-card" })
        expect(binding?.priority).toBe(200)
      })

      test("graph-node: xRenderer graph-node", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "graph-node")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({ xRenderer: "graph-node" })
        expect(binding?.priority).toBe(200)
      })

      test("status-indicator: xRenderer status-indicator", async () => {
        const { STUDIO_BINDINGS } = await import("../seedData")
        const binding = STUDIO_BINDINGS.find((b) => b.id === "status-indicator")
        expect(binding).toBeDefined()
        expect(binding?.matchExpression).toEqual({
          xRenderer: "status-indicator",
        })
        expect(binding?.priority).toBe(200)
      })
    })

    test("all bindings have required fields", async () => {
      const { STUDIO_BINDINGS } = await import("../seedData")
      for (const binding of STUDIO_BINDINGS) {
        expect(binding.id).toBeDefined()
        expect(typeof binding.id).toBe("string")
        expect(binding.name).toBeDefined()
        expect(typeof binding.name).toBe("string")
        expect(binding.registry).toBe("studio")
        expect(binding.component).toBeDefined()
        expect(binding.matchExpression).toBeDefined()
        expect(typeof binding.matchExpression).toBe("object")
        expect(typeof binding.priority).toBe("number")
      }
    })
  })

  describe("seedComponentBuilderData function", () => {
    test("exports seedComponentBuilderData function", async () => {
      const { seedComponentBuilderData } = await import("../seedData")
      expect(typeof seedComponentBuilderData).toBe("function")
    })

    test("creates all ComponentDefinition entities", async () => {
      const { seedComponentBuilderData, COMPONENT_DEFINITIONS } = await import(
        "../seedData"
      )
      const store = createMockStore()
      seedComponentBuilderData(store)

      expect(store.ComponentDefinition.size).toBe(COMPONENT_DEFINITIONS.length)
      expect(store.ComponentDefinition.size).toBe(38)
    })

    test("creates all Registry entities", async () => {
      const { seedComponentBuilderData, REGISTRY_DEFINITIONS } = await import(
        "../seedData"
      )
      const store = createMockStore()
      seedComponentBuilderData(store)

      expect(store.Registry.size).toBe(REGISTRY_DEFINITIONS.length)
      expect(store.Registry.size).toBe(2)
    })

    test("creates all RendererBinding entities", async () => {
      const { seedComponentBuilderData, DEFAULT_BINDINGS, STUDIO_BINDINGS } =
        await import("../seedData")
      const store = createMockStore()
      seedComponentBuilderData(store)

      const expectedCount = DEFAULT_BINDINGS.length + STUDIO_BINDINGS.length
      expect(store.RendererBinding.size).toBe(expectedCount)
      expect(store.RendererBinding.size).toBe(30) // 12 + 18
    })

    test("creates entities with createdAt timestamps", async () => {
      const { seedComponentBuilderData } = await import("../seedData")
      const store = createMockStore()
      const beforeTime = Date.now()
      seedComponentBuilderData(store)
      const afterTime = Date.now()

      // Check ComponentDefinition timestamps
      for (const [, entity] of store.ComponentDefinition) {
        expect(entity.createdAt).toBeGreaterThanOrEqual(beforeTime)
        expect(entity.createdAt).toBeLessThanOrEqual(afterTime)
      }

      // Check Registry timestamps
      for (const [, entity] of store.Registry) {
        expect(entity.createdAt).toBeGreaterThanOrEqual(beforeTime)
        expect(entity.createdAt).toBeLessThanOrEqual(afterTime)
      }

      // Check RendererBinding timestamps
      for (const [, entity] of store.RendererBinding) {
        expect(entity.createdAt).toBeGreaterThanOrEqual(beforeTime)
        expect(entity.createdAt).toBeLessThanOrEqual(afterTime)
      }
    })

    test("default registry fallbackComponent references StringDisplay component", async () => {
      const { seedComponentBuilderData } = await import("../seedData")
      const store = createMockStore()
      seedComponentBuilderData(store)

      const defaultRegistry = store.Registry.get("default")
      expect(defaultRegistry).toBeDefined()
      expect(defaultRegistry.fallbackComponent).toBeDefined()

      // Verify the fallback component is the StringDisplay
      const fallbackComponent = store.ComponentDefinition.get(
        defaultRegistry.fallbackComponent
      )
      expect(fallbackComponent).toBeDefined()
      expect(fallbackComponent.implementationRef).toBe("StringDisplay")
    })

    test("studio registry extends default registry", async () => {
      const { seedComponentBuilderData } = await import("../seedData")
      const store = createMockStore()
      seedComponentBuilderData(store)

      const studioRegistry = store.Registry.get("studio")
      expect(studioRegistry).toBeDefined()
      expect(studioRegistry.extends).toBe("default")
    })

    test("bindings reference correct component IDs", async () => {
      const { seedComponentBuilderData } = await import("../seedData")
      const store = createMockStore()
      seedComponentBuilderData(store)

      // Verify each binding references an existing component
      for (const [, binding] of store.RendererBinding) {
        const component = store.ComponentDefinition.get(binding.component)
        expect(component).toBeDefined()
      }
    })

    test("returns summary of created entities", async () => {
      const { seedComponentBuilderData } = await import("../seedData")
      const store = createMockStore()
      const result = seedComponentBuilderData(store)

      expect(result).toBeDefined()
      expect(result.componentDefinitions).toBe(38)
      expect(result.registries).toBe(2)
      expect(result.rendererBindings).toBe(30) // 12 default + 18 studio
    })
  })

  describe("component-to-binding references", () => {
    test("default bindings reference correct component IDs", async () => {
      const { DEFAULT_BINDINGS, COMPONENT_DEFINITIONS } = await import(
        "../seedData"
      )

      // Build a map of implementationRef to id
      const refToId = new Map(
        COMPONENT_DEFINITIONS.map((c) => [c.implementationRef, c.id])
      )

      // Verify computed-display references ComputedDisplay
      const computedBinding = DEFAULT_BINDINGS.find(
        (b) => b.id === "computed-display"
      )
      expect(computedBinding?.component).toBe(refToId.get("ComputedDisplay"))

      // Verify enum-badge references EnumBadge
      const enumBinding = DEFAULT_BINDINGS.find((b) => b.id === "enum-badge")
      expect(enumBinding?.component).toBe(refToId.get("EnumBadge"))

      // Verify string-display references StringDisplay
      const stringBinding = DEFAULT_BINDINGS.find(
        (b) => b.id === "string-display"
      )
      expect(stringBinding?.component).toBe(refToId.get("StringDisplay"))
    })

    test("studio bindings reference correct component IDs", async () => {
      const { STUDIO_BINDINGS, COMPONENT_DEFINITIONS } = await import(
        "../seedData"
      )

      // Build a map of implementationRef to id
      const refToId = new Map(
        COMPONENT_DEFINITIONS.map((c) => [c.implementationRef, c.id])
      )

      // Verify priority-badge references PriorityBadge
      const priorityBinding = STUDIO_BINDINGS.find(
        (b) => b.id === "priority-badge"
      )
      expect(priorityBinding?.component).toBe(refToId.get("PriorityBadge"))

      // Verify progress-bar references ProgressBar
      const progressBinding = STUDIO_BINDINGS.find((b) => b.id === "progress-bar")
      expect(progressBinding?.component).toBe(refToId.get("ProgressBar"))
    })
  })
})
