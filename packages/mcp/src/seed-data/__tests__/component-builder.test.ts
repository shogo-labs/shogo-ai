/**
 * Generated from TestSpecifications for task-sdr-v2-001
 * Task: seed-data-constants-file
 *
 * Tests that the component-builder seed data exports match the expected structure:
 * - 29 COMPONENT_DEFINITIONS (11 primitive + 14 domain + 4 visualization)
 * - 2 REGISTRIES (default and studio)
 * - 30 RENDERER_BINDINGS (12 default + 18 studio)
 */

import { describe, test, expect } from "bun:test"

import {
  COMPONENT_DEFINITIONS,
  REGISTRIES,
  RENDERER_BINDINGS,
} from "../component-builder"

// =============================================================================
// test-sdr-001-01: COMPONENT_DEFINITIONS array structure
// =============================================================================
describe("Seed data file exports COMPONENT_DEFINITIONS array", () => {
  test("COMPONENT_DEFINITIONS is an array", () => {
    expect(Array.isArray(COMPONENT_DEFINITIONS)).toBe(true)
  })

  test("Array has 31 entries (29 original + 2 for task-cbe-003)", () => {
    expect(COMPONENT_DEFINITIONS).toHaveLength(31)
  })

  test("Each entry has id, name, category, implementationRef fields", () => {
    for (const def of COMPONENT_DEFINITIONS) {
      expect(def).toHaveProperty("id")
      expect(typeof def.id).toBe("string")

      expect(def).toHaveProperty("name")
      expect(typeof def.name).toBe("string")

      expect(def).toHaveProperty("category")
      expect(typeof def.category).toBe("string")

      expect(def).toHaveProperty("implementationRef")
      expect(typeof def.implementationRef).toBe("string")
    }
  })
})

// =============================================================================
// test-sdr-001-02: REGISTRIES array structure
// =============================================================================
describe("Seed data file exports REGISTRIES array", () => {
  test("REGISTRIES is an array", () => {
    expect(Array.isArray(REGISTRIES)).toBe(true)
  })

  test("Array has 2 entries (default and studio)", () => {
    expect(REGISTRIES).toHaveLength(2)
  })

  test("default registry has id='default'", () => {
    const defaultRegistry = REGISTRIES.find((r) => r.id === "default")
    expect(defaultRegistry).toBeDefined()
    expect(defaultRegistry!.id).toBe("default")
    expect(defaultRegistry!.name).toBe("default")
  })

  test("studio registry has id='studio' and extends='default'", () => {
    const studioRegistry = REGISTRIES.find((r) => r.id === "studio")
    expect(studioRegistry).toBeDefined()
    expect(studioRegistry!.id).toBe("studio")
    expect(studioRegistry!.extends).toBe("default")
  })
})

// =============================================================================
// test-sdr-001-03: RENDERER_BINDINGS array structure
// =============================================================================
describe("Seed data file exports RENDERER_BINDINGS array", () => {
  test("RENDERER_BINDINGS is an array", () => {
    expect(Array.isArray(RENDERER_BINDINGS)).toBe(true)
  })

  test("Array has 32 entries (12 default + 20 studio)", () => {
    // 12 default bindings + 20 studio bindings = 32 total (added 2 for task-cbe-003)
    expect(RENDERER_BINDINGS).toHaveLength(32)
  })

  test("Each entry has id, registry, component, matchExpression, priority fields", () => {
    for (const binding of RENDERER_BINDINGS) {
      expect(binding).toHaveProperty("id")
      expect(typeof binding.id).toBe("string")

      expect(binding).toHaveProperty("registry")
      expect(typeof binding.registry).toBe("string")

      expect(binding).toHaveProperty("component")
      expect(typeof binding.component).toBe("string")

      expect(binding).toHaveProperty("matchExpression")
      expect(typeof binding.matchExpression).toBe("object")

      expect(binding).toHaveProperty("priority")
      expect(typeof binding.priority).toBe("number")
    }
  })
})

// =============================================================================
// test-sdr-001-04: All seed entities have unique IDs
// =============================================================================
describe("All seed entities have unique IDs", () => {
  test("No duplicate IDs exist across all entities", () => {
    const allIds = [
      ...COMPONENT_DEFINITIONS.map((d) => d.id),
      ...REGISTRIES.map((r) => r.id),
      ...RENDERER_BINDINGS.map((b) => b.id),
    ]

    const uniqueIds = new Set(allIds)
    expect(uniqueIds.size).toBe(allIds.length)
  })

  test("Set size equals total entity count", () => {
    const allIds = [
      ...COMPONENT_DEFINITIONS.map((d) => d.id),
      ...REGISTRIES.map((r) => r.id),
      ...RENDERER_BINDINGS.map((b) => b.id),
    ]

    // Total: 31 + 2 + 32 = 65 (added 2 components + 2 bindings for task-cbe-003)
    expect(allIds.length).toBe(65)
  })
})

// =============================================================================
// test-cbe-003-01: COMPONENT_DEFINITIONS includes ChangeTypeBadge entry
// =============================================================================
describe("COMPONENT_DEFINITIONS includes ChangeTypeBadge entry", () => {
  test("Array contains entry with id 'comp-change-type-badge'", () => {
    const changeTypeBadge = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-change-type-badge"
    )
    expect(changeTypeBadge).toBeDefined()
  })

  test("Entry has name 'Change Type Badge'", () => {
    const changeTypeBadge = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-change-type-badge"
    )
    expect(changeTypeBadge?.name).toBe("Change Type Badge")
  })

  test("Entry has implementationRef 'ChangeTypeBadge'", () => {
    const changeTypeBadge = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-change-type-badge"
    )
    expect(changeTypeBadge?.implementationRef).toBe("ChangeTypeBadge")
  })

  test("Entry has category 'display'", () => {
    const changeTypeBadge = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-change-type-badge"
    )
    expect(changeTypeBadge?.category).toBe("display")
  })
})

// =============================================================================
// test-cbe-003-02: COMPONENT_DEFINITIONS includes PhaseStatusRenderer entry
// =============================================================================
describe("COMPONENT_DEFINITIONS includes PhaseStatusRenderer entry", () => {
  test("Array contains entry with id 'comp-phase-status-renderer'", () => {
    const phaseStatusRenderer = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-phase-status-renderer"
    )
    expect(phaseStatusRenderer).toBeDefined()
  })

  test("Entry has name 'Phase Status Renderer'", () => {
    const phaseStatusRenderer = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-phase-status-renderer"
    )
    expect(phaseStatusRenderer?.name).toBe("Phase Status Renderer")
  })

  test("Entry has implementationRef 'PhaseStatusRenderer'", () => {
    const phaseStatusRenderer = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-phase-status-renderer"
    )
    expect(phaseStatusRenderer?.implementationRef).toBe("PhaseStatusRenderer")
  })

  test("Entry has category 'display'", () => {
    const phaseStatusRenderer = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-phase-status-renderer"
    )
    expect(phaseStatusRenderer?.category).toBe("display")
  })

  test("Entry has tags including 'interactive'", () => {
    const phaseStatusRenderer = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-phase-status-renderer"
    )
    expect(phaseStatusRenderer?.tags).toContain("interactive")
  })
})

// =============================================================================
// test-cbe-003-03: STUDIO_BINDINGS includes change-type-badge binding
// =============================================================================
describe("STUDIO_BINDINGS includes change-type-badge binding", () => {
  const studioBindings = RENDERER_BINDINGS.filter((b) => b.registry === "studio")

  test("Array contains entry with id 'change-type-badge'", () => {
    const changeTypeBadgeBinding = studioBindings.find(
      (b) => b.id === "change-type-badge"
    )
    expect(changeTypeBadgeBinding).toBeDefined()
  })

  test("Entry has matchExpression { xRenderer: 'change-type-badge' }", () => {
    const changeTypeBadgeBinding = studioBindings.find(
      (b) => b.id === "change-type-badge"
    )
    expect(changeTypeBadgeBinding?.matchExpression).toEqual({
      xRenderer: "change-type-badge",
    })
  })

  test("Entry has priority 200", () => {
    const changeTypeBadgeBinding = studioBindings.find(
      (b) => b.id === "change-type-badge"
    )
    expect(changeTypeBadgeBinding?.priority).toBe(200)
  })

  test("Entry references comp-change-type-badge component", () => {
    const changeTypeBadgeBinding = studioBindings.find(
      (b) => b.id === "change-type-badge"
    )
    expect(changeTypeBadgeBinding?.component).toBe("comp-change-type-badge")
  })
})

// =============================================================================
// test-cbe-003-04: STUDIO_BINDINGS includes phase-status-renderer binding
// =============================================================================
describe("STUDIO_BINDINGS includes phase-status-renderer binding", () => {
  const studioBindings = RENDERER_BINDINGS.filter((b) => b.registry === "studio")

  test("Array contains entry with id 'phase-status-renderer'", () => {
    const phaseStatusBinding = studioBindings.find(
      (b) => b.id === "phase-status-renderer"
    )
    expect(phaseStatusBinding).toBeDefined()
  })

  test("Entry has matchExpression { xRenderer: 'phase-status-renderer' }", () => {
    const phaseStatusBinding = studioBindings.find(
      (b) => b.id === "phase-status-renderer"
    )
    expect(phaseStatusBinding?.matchExpression).toEqual({
      xRenderer: "phase-status-renderer",
    })
  })

  test("Entry has priority 200", () => {
    const phaseStatusBinding = studioBindings.find(
      (b) => b.id === "phase-status-renderer"
    )
    expect(phaseStatusBinding?.priority).toBe(200)
  })

  test("Entry references comp-phase-status-renderer component", () => {
    const phaseStatusBinding = studioBindings.find(
      (b) => b.id === "phase-status-renderer"
    )
    expect(phaseStatusBinding?.component).toBe("comp-phase-status-renderer")
  })
})
