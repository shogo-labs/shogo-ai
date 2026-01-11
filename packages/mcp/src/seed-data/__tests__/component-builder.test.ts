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
  LAYOUT_TEMPLATES,
  COMPOSITIONS,
} from "../component-builder"

// =============================================================================
// test-sdr-001-01: COMPONENT_DEFINITIONS array structure
// =============================================================================
describe("Seed data file exports COMPONENT_DEFINITIONS array", () => {
  test("COMPONENT_DEFINITIONS is an array", () => {
    expect(Array.isArray(COMPONENT_DEFINITIONS)).toBe(true)
  })

  test("Array has 36 entries (29 original + 2 for task-cbe-003 + 5 for task-cpv-003)", () => {
    expect(COMPONENT_DEFINITIONS).toHaveLength(36)
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

    // Total: 36 + 2 + 32 = 70 (added 2 components + 2 bindings for task-cbe-003, + 5 sections for task-cpv-003)
    expect(allIds.length).toBe(70)
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

// =============================================================================
// test-cpv-003-01: Section ComponentDefinitions exist with category='section'
// =============================================================================
describe("Section ComponentDefinitions for composable-phase-views", () => {
  const sectionDefinitions = COMPONENT_DEFINITIONS.filter(
    (d) => d.category === "section"
  )

  test("5 section ComponentDefinitions exist", () => {
    expect(sectionDefinitions).toHaveLength(5)
  })

  test("All section definitions have category='section'", () => {
    for (const def of sectionDefinitions) {
      expect(def.category).toBe("section")
    }
  })
})

// =============================================================================
// test-cpv-003-02: IntentTerminalSection definition
// =============================================================================
describe("IntentTerminalSection ComponentDefinition", () => {
  test("Array contains entry with id 'comp-def-intent-terminal-section'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-intent-terminal-section"
    )
    expect(def).toBeDefined()
  })

  test("Entry has name 'IntentTerminalSection'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-intent-terminal-section"
    )
    expect(def?.name).toBe("IntentTerminalSection")
  })

  test("Entry has implementationRef 'IntentTerminalSection'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-intent-terminal-section"
    )
    expect(def?.implementationRef).toBe("IntentTerminalSection")
  })

  test("Entry has category 'section'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-intent-terminal-section"
    )
    expect(def?.category).toBe("section")
  })

  test("Entry has tags including 'discovery-phase'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-intent-terminal-section"
    )
    expect(def?.tags).toContain("discovery-phase")
  })
})

// =============================================================================
// test-cpv-003-03: InitialAssessmentSection definition
// =============================================================================
describe("InitialAssessmentSection ComponentDefinition", () => {
  test("Array contains entry with id 'comp-def-initial-assessment-section'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-initial-assessment-section"
    )
    expect(def).toBeDefined()
  })

  test("Entry has name 'InitialAssessmentSection'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-initial-assessment-section"
    )
    expect(def?.name).toBe("InitialAssessmentSection")
  })

  test("Entry has implementationRef 'InitialAssessmentSection'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-initial-assessment-section"
    )
    expect(def?.implementationRef).toBe("InitialAssessmentSection")
  })

  test("Entry has category 'section'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-initial-assessment-section"
    )
    expect(def?.category).toBe("section")
  })

  test("Entry has tags including 'discovery-phase'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-initial-assessment-section"
    )
    expect(def?.tags).toContain("discovery-phase")
  })
})

// =============================================================================
// test-cpv-003-04: RequirementsListSection definition
// =============================================================================
describe("RequirementsListSection ComponentDefinition", () => {
  test("Array contains entry with id 'comp-def-requirements-list-section'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-requirements-list-section"
    )
    expect(def).toBeDefined()
  })

  test("Entry has name 'RequirementsListSection'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-requirements-list-section"
    )
    expect(def?.name).toBe("RequirementsListSection")
  })

  test("Entry has implementationRef 'RequirementsListSection'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-requirements-list-section"
    )
    expect(def?.implementationRef).toBe("RequirementsListSection")
  })

  test("Entry has category 'section'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-requirements-list-section"
    )
    expect(def?.category).toBe("section")
  })

  test("Entry has tags including 'discovery-phase'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-requirements-list-section"
    )
    expect(def?.tags).toContain("discovery-phase")
  })
})

// =============================================================================
// test-cpv-003-05: SessionSummarySection definition
// =============================================================================
describe("SessionSummarySection ComponentDefinition", () => {
  test("Array contains entry with id 'comp-def-session-summary-section'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-session-summary-section"
    )
    expect(def).toBeDefined()
  })

  test("Entry has name 'SessionSummarySection'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-session-summary-section"
    )
    expect(def?.name).toBe("SessionSummarySection")
  })

  test("Entry has implementationRef 'SessionSummarySection'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-session-summary-section"
    )
    expect(def?.implementationRef).toBe("SessionSummarySection")
  })

  test("Entry has category 'section'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-session-summary-section"
    )
    expect(def?.category).toBe("section")
  })

  test("Entry has tags including 'discovery-phase'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-session-summary-section"
    )
    expect(def?.tags).toContain("discovery-phase")
  })
})

// =============================================================================
// test-cpv-003-06: PhaseActionsSection definition
// =============================================================================
describe("PhaseActionsSection ComponentDefinition", () => {
  test("Array contains entry with id 'comp-def-phase-actions-section'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-phase-actions-section"
    )
    expect(def).toBeDefined()
  })

  test("Entry has name 'PhaseActionsSection'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-phase-actions-section"
    )
    expect(def?.name).toBe("PhaseActionsSection")
  })

  test("Entry has implementationRef 'PhaseActionsSection'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-phase-actions-section"
    )
    expect(def?.implementationRef).toBe("PhaseActionsSection")
  })

  test("Entry has category 'section'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-phase-actions-section"
    )
    expect(def?.category).toBe("section")
  })

  test("Entry has tags including 'discovery-phase'", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-phase-actions-section"
    )
    expect(def?.tags).toContain("discovery-phase")
  })
})

// =============================================================================
// test-cpv-004-01: LAYOUT_TEMPLATES exports with correct structure
// =============================================================================
describe("LAYOUT_TEMPLATES array structure", () => {
  test("LAYOUT_TEMPLATES is an array", () => {
    expect(Array.isArray(LAYOUT_TEMPLATES)).toBe(true)
  })

  test("Array has at least 1 entry", () => {
    expect(LAYOUT_TEMPLATES.length).toBeGreaterThanOrEqual(1)
  })

  test("Each entry has id, name, slots fields", () => {
    for (const template of LAYOUT_TEMPLATES) {
      expect(template).toHaveProperty("id")
      expect(typeof template.id).toBe("string")

      expect(template).toHaveProperty("name")
      expect(typeof template.name).toBe("string")

      expect(template).toHaveProperty("slots")
      expect(Array.isArray(template.slots)).toBe(true)
    }
  })
})

// =============================================================================
// test-cpv-004-02: layout-phase-two-column LayoutTemplate definition
// =============================================================================
describe("layout-phase-two-column LayoutTemplate", () => {
  test("Array contains entry with id 'layout-phase-two-column'", () => {
    const layout = LAYOUT_TEMPLATES.find(
      (t) => t.id === "layout-phase-two-column"
    )
    expect(layout).toBeDefined()
  })

  test("Entry has name 'layout-phase-two-column'", () => {
    const layout = LAYOUT_TEMPLATES.find(
      (t) => t.id === "layout-phase-two-column"
    )
    expect(layout?.name).toBe("layout-phase-two-column")
  })

  test("Entry has 4 slots defined", () => {
    const layout = LAYOUT_TEMPLATES.find(
      (t) => t.id === "layout-phase-two-column"
    )
    expect(layout?.slots).toHaveLength(4)
  })

  test("header slot exists with position='top' and required=true", () => {
    const layout = LAYOUT_TEMPLATES.find(
      (t) => t.id === "layout-phase-two-column"
    )
    const headerSlot = layout?.slots.find((s) => s.name === "header")
    expect(headerSlot).toBeDefined()
    expect(headerSlot?.position).toBe("top")
    expect(headerSlot?.required).toBe(true)
  })

  test("main slot exists with position='left' and required=true", () => {
    const layout = LAYOUT_TEMPLATES.find(
      (t) => t.id === "layout-phase-two-column"
    )
    const mainSlot = layout?.slots.find((s) => s.name === "main")
    expect(mainSlot).toBeDefined()
    expect(mainSlot?.position).toBe("left")
    expect(mainSlot?.required).toBe(true)
  })

  test("sidebar slot exists with position='right' and required=false", () => {
    const layout = LAYOUT_TEMPLATES.find(
      (t) => t.id === "layout-phase-two-column"
    )
    const sidebarSlot = layout?.slots.find((s) => s.name === "sidebar")
    expect(sidebarSlot).toBeDefined()
    expect(sidebarSlot?.position).toBe("right")
    expect(sidebarSlot?.required).toBe(false)
  })

  test("actions slot exists with position='bottom' and required=false", () => {
    const layout = LAYOUT_TEMPLATES.find(
      (t) => t.id === "layout-phase-two-column"
    )
    const actionsSlot = layout?.slots.find((s) => s.name === "actions")
    expect(actionsSlot).toBeDefined()
    expect(actionsSlot?.position).toBe("bottom")
    expect(actionsSlot?.required).toBe(false)
  })
})

// =============================================================================
// test-cpv-004-03: COMPOSITIONS exports with correct structure
// =============================================================================
describe("COMPOSITIONS array structure", () => {
  test("COMPOSITIONS is an array", () => {
    expect(Array.isArray(COMPOSITIONS)).toBe(true)
  })

  test("Array has at least 1 entry", () => {
    expect(COMPOSITIONS.length).toBeGreaterThanOrEqual(1)
  })

  test("Each entry has id, name, layout, slotContent fields", () => {
    for (const composition of COMPOSITIONS) {
      expect(composition).toHaveProperty("id")
      expect(typeof composition.id).toBe("string")

      expect(composition).toHaveProperty("name")
      expect(typeof composition.name).toBe("string")

      expect(composition).toHaveProperty("layout")
      expect(typeof composition.layout).toBe("string")

      expect(composition).toHaveProperty("slotContent")
      expect(Array.isArray(composition.slotContent)).toBe(true)
    }
  })
})

// =============================================================================
// test-cpv-004-04: discovery Composition definition
// =============================================================================
describe("discovery Composition", () => {
  test("Array contains entry with id 'composition-discovery'", () => {
    const composition = COMPOSITIONS.find(
      (c) => c.id === "composition-discovery"
    )
    expect(composition).toBeDefined()
  })

  test("Entry has name 'discovery'", () => {
    const composition = COMPOSITIONS.find(
      (c) => c.id === "composition-discovery"
    )
    expect(composition?.name).toBe("discovery")
  })

  test("Entry references layout-phase-two-column via layout property", () => {
    const composition = COMPOSITIONS.find(
      (c) => c.id === "composition-discovery"
    )
    expect(composition?.layout).toBe("layout-phase-two-column")
  })

  test("slotContent has 4 entries", () => {
    const composition = COMPOSITIONS.find(
      (c) => c.id === "composition-discovery"
    )
    expect(composition?.slotContent).toHaveLength(4)
  })

  test("header slot maps to IntentTerminalSection", () => {
    const composition = COMPOSITIONS.find(
      (c) => c.id === "composition-discovery"
    )
    const headerContent = composition?.slotContent.find(
      (s) => s.slot === "header"
    )
    expect(headerContent).toBeDefined()
    expect(headerContent?.component).toBe("comp-def-intent-terminal-section")
  })

  test("main slot maps to RequirementsListSection", () => {
    const composition = COMPOSITIONS.find(
      (c) => c.id === "composition-discovery"
    )
    const mainContent = composition?.slotContent.find((s) => s.slot === "main")
    expect(mainContent).toBeDefined()
    expect(mainContent?.component).toBe("comp-def-requirements-list-section")
  })

  test("sidebar slot maps to InitialAssessmentSection", () => {
    const composition = COMPOSITIONS.find(
      (c) => c.id === "composition-discovery"
    )
    const sidebarContent = composition?.slotContent.find(
      (s) => s.slot === "sidebar"
    )
    expect(sidebarContent).toBeDefined()
    expect(sidebarContent?.component).toBe("comp-def-initial-assessment-section")
  })

  test("actions slot maps to PhaseActionsSection", () => {
    const composition = COMPOSITIONS.find(
      (c) => c.id === "composition-discovery"
    )
    const actionsContent = composition?.slotContent.find(
      (s) => s.slot === "actions"
    )
    expect(actionsContent).toBeDefined()
    expect(actionsContent?.component).toBe("comp-def-phase-actions-section")
  })

  test("Entry has dataContext with phase='discovery'", () => {
    const composition = COMPOSITIONS.find(
      (c) => c.id === "composition-discovery"
    )
    expect(composition?.dataContext).toBeDefined()
    expect(composition?.dataContext?.phase).toBe("discovery")
  })
})

// =============================================================================
// test-cpv-004-05: All seed entities have unique IDs (updated for new entities)
// =============================================================================
describe("All seed entities including LayoutTemplates and Compositions have unique IDs", () => {
  test("No duplicate IDs exist across all entities", () => {
    const allIds = [
      ...COMPONENT_DEFINITIONS.map((d) => d.id),
      ...REGISTRIES.map((r) => r.id),
      ...RENDERER_BINDINGS.map((b) => b.id),
      ...LAYOUT_TEMPLATES.map((t) => t.id),
      ...COMPOSITIONS.map((c) => c.id),
    ]

    const uniqueIds = new Set(allIds)
    expect(uniqueIds.size).toBe(allIds.length)
  })

  test("Set size equals total entity count (36 + 2 + 32 + 1 + 1 = 72)", () => {
    const allIds = [
      ...COMPONENT_DEFINITIONS.map((d) => d.id),
      ...REGISTRIES.map((r) => r.id),
      ...RENDERER_BINDINGS.map((b) => b.id),
      ...LAYOUT_TEMPLATES.map((t) => t.id),
      ...COMPOSITIONS.map((c) => c.id),
    ]

    // Total: 36 components + 2 registries + 32 bindings + 1 layout + 1 composition = 72
    expect(allIds.length).toBe(72)
  })
})
