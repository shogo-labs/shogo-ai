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

  test("Array has 51 entries (29 original + 2 for task-cbe-003 + 5 for task-cpv-003 + 4 for analysis sections + 6 for classification sections + 1 for design container + 4 for testing sections)", () => {
    expect(COMPONENT_DEFINITIONS).toHaveLength(51)
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

    // Total: 51 + 2 + 32 = 85 (includes 4 analysis + 6 classification sections + 1 design container + 4 testing sections)
    expect(allIds.length).toBe(85)
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

  test("20 section ComponentDefinitions exist (5 discovery + 4 analysis + 6 classification + 1 design + 4 testing)", () => {
    expect(sectionDefinitions).toHaveLength(20)
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

  test("Set size equals total entity count (51 + 2 + 32 + 2 + 5 = 92)", () => {
    const allIds = [
      ...COMPONENT_DEFINITIONS.map((d) => d.id),
      ...REGISTRIES.map((r) => r.id),
      ...RENDERER_BINDINGS.map((b) => b.id),
      ...LAYOUT_TEMPLATES.map((t) => t.id),
      ...COMPOSITIONS.map((c) => c.id),
    ]

    // Total: 51 components + 2 registries + 32 bindings + 2 layouts + 5 compositions = 92
    expect(allIds.length).toBe(92)
  })
})

// =============================================================================
// Analysis Phase Section ComponentDefinitions - task-analysis-007
// =============================================================================
describe("Analysis Phase Section ComponentDefinitions", () => {
  test("EvidenceBoardHeaderSection definition exists", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-evidence-board-header-section"
    )
    expect(def).toBeDefined()
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("EvidenceBoardHeaderSection")
    expect(def?.tags).toContain("analysis-phase")
  })

  test("LocationHeatBarSection definition exists", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-location-heat-bar-section"
    )
    expect(def).toBeDefined()
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("LocationHeatBarSection")
    expect(def?.tags).toContain("analysis-phase")
  })

  test("FindingMatrixSection definition exists", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-finding-matrix-section"
    )
    expect(def).toBeDefined()
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("FindingMatrixSection")
    expect(def?.tags).toContain("analysis-phase")
  })

  test("FindingListSection definition exists", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-finding-list-section"
    )
    expect(def).toBeDefined()
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("FindingListSection")
    expect(def?.tags).toContain("analysis-phase")
  })
})

// =============================================================================
// Analysis Composition - task-analysis-008
// =============================================================================
describe("Analysis Composition", () => {
  test("COMPOSITIONS array contains analysis composition", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-analysis")
    expect(composition).toBeDefined()
    expect(composition?.name).toBe("analysis")
  })

  test("Entry has layout reference to layout-phase-two-column", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-analysis")
    expect(composition?.layout).toBe("layout-phase-two-column")
  })

  test("header slot maps to EvidenceBoardHeaderSection", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-analysis")
    const headerContent = composition?.slotContent.find((s) => s.slot === "header")
    expect(headerContent).toBeDefined()
    expect(headerContent?.component).toBe("comp-def-evidence-board-header-section")
  })

  test("main slot has slot stacking (LocationHeatBar + FindingMatrix)", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-analysis")
    const mainContents = composition?.slotContent.filter((s) => s.slot === "main")
    expect(mainContents).toHaveLength(2)
    expect(mainContents?.[0].component).toBe("comp-def-location-heat-bar-section")
    expect(mainContents?.[1].component).toBe("comp-def-finding-matrix-section")
  })

  test("sidebar slot maps to FindingListSection", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-analysis")
    const sidebarContent = composition?.slotContent.find((s) => s.slot === "sidebar")
    expect(sidebarContent).toBeDefined()
    expect(sidebarContent?.component).toBe("comp-def-finding-list-section")
  })

  test("Entry has dataContext with phase='analysis'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-analysis")
    expect(composition?.dataContext).toBeDefined()
    expect(composition?.dataContext?.phase).toBe("analysis")
  })

  test("Entry has providerWrapper='AnalysisPanelProvider'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-analysis")
    expect(composition?.providerWrapper).toBe("AnalysisPanelProvider")
  })
})

// =============================================================================
// Classification Phase Section ComponentDefinitions - task-classification-007
// =============================================================================
describe("Classification Phase Section ComponentDefinitions", () => {
  test("ArchetypeTransformationSection definition exists", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-archetype-transformation-section"
    )
    expect(def).toBeDefined()
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("ArchetypeTransformationSection")
    expect(def?.tags).toContain("classification-phase")
  })

  test("CorrectionNoteSection definition exists", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-correction-note-section"
    )
    expect(def).toBeDefined()
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("CorrectionNoteSection")
    expect(def?.tags).toContain("classification-phase")
  })

  test("ConfidenceMetersSection definition exists", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-confidence-meters-section"
    )
    expect(def).toBeDefined()
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("ConfidenceMetersSection")
    expect(def?.tags).toContain("classification-phase")
  })

  test("EvidenceColumnsSection definition exists", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-evidence-columns-section"
    )
    expect(def).toBeDefined()
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("EvidenceColumnsSection")
    expect(def?.tags).toContain("classification-phase")
  })

  test("ApplicablePatternsSection definition exists", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-applicable-patterns-section"
    )
    expect(def).toBeDefined()
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("ApplicablePatternsSection")
    expect(def?.tags).toContain("classification-phase")
  })

  test("ClassificationRationaleSection definition exists", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-classification-rationale-section"
    )
    expect(def).toBeDefined()
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("ClassificationRationaleSection")
    expect(def?.tags).toContain("classification-phase")
  })
})

// =============================================================================
// Classification Composition - task-classification-008
// =============================================================================
describe("Classification Composition", () => {
  test("COMPOSITIONS array contains classification composition", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-classification")
    expect(composition).toBeDefined()
    expect(composition?.name).toBe("classification")
  })

  test("Entry has layout reference to layout-phase-two-column", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-classification")
    expect(composition?.layout).toBe("layout-phase-two-column")
  })

  test("header slot maps to ArchetypeTransformationSection", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-classification")
    const headerContent = composition?.slotContent.find((s) => s.slot === "header")
    expect(headerContent).toBeDefined()
    expect(headerContent?.component).toBe("comp-def-archetype-transformation-section")
  })

  test("main slot has slot stacking (6 sections total)", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-classification")
    const mainContents = composition?.slotContent.filter((s) => s.slot === "main")
    // CorrectionNote + ConfidenceMeters + EvidenceColumns + ApplicablePatterns + ClassificationRationale = 5 in main
    expect(mainContents?.length).toBeGreaterThanOrEqual(5)
  })

  test("Entry has dataContext with phase='classification'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-classification")
    expect(composition?.dataContext).toBeDefined()
    expect(composition?.dataContext?.phase).toBe("classification")
  })

  test("Entry has NO providerWrapper (pure slot composition)", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-classification")
    // Classification uses pure slot composition - no React Context provider
    expect(composition?.providerWrapper).toBeUndefined()
  })
})

// =============================================================================
// test-design-009-seed: DesignContainerSection ComponentDefinition
// =============================================================================
describe("DesignContainerSection ComponentDefinition", () => {
  test("Array contains entry with id 'comp-design-container'", () => {
    const def = COMPONENT_DEFINITIONS.find((d) => d.id === "comp-design-container")
    expect(def).toBeDefined()
  })

  test("Entry has name 'DesignContainerSection'", () => {
    const def = COMPONENT_DEFINITIONS.find((d) => d.id === "comp-design-container")
    expect(def?.name).toBe("DesignContainerSection")
  })

  test("Entry has category 'section'", () => {
    const def = COMPONENT_DEFINITIONS.find((d) => d.id === "comp-design-container")
    expect(def?.category).toBe("section")
  })

  test("Entry has implementationRef 'DesignContainerSection' matching sectionImplementationMap key", () => {
    const def = COMPONENT_DEFINITIONS.find((d) => d.id === "comp-design-container")
    expect(def?.implementationRef).toBe("DesignContainerSection")
  })

  test("Entry has description documenting container section pattern and internal tab navigation", () => {
    const def = COMPONENT_DEFINITIONS.find((d) => d.id === "comp-design-container")
    expect(def?.description).toBeDefined()
    expect(typeof def?.description).toBe("string")
    // Should mention container pattern and/or tab navigation
    expect(
      def?.description?.toLowerCase().includes("container") ||
        def?.description?.toLowerCase().includes("tab")
    ).toBe(true)
  })

  test("Entry has tags including 'design-phase'", () => {
    const def = COMPONENT_DEFINITIONS.find((d) => d.id === "comp-design-container")
    expect(def?.tags).toContain("design-phase")
  })
})

// =============================================================================
// test-prephase-005-seed-template: layout-single-column LayoutTemplate
// =============================================================================
describe("layout-single-column LayoutTemplate", () => {
  test("Contains entry with id 'layout-single-column'", () => {
    const layout = LAYOUT_TEMPLATES.find((t) => t.id === "layout-single-column")
    expect(layout).toBeDefined()
  })

  test("Has single slot with name 'main' and position 'center'", () => {
    const layout = LAYOUT_TEMPLATES.find((t) => t.id === "layout-single-column")
    expect(layout?.slots).toHaveLength(1)
    const mainSlot = layout?.slots.find((s) => s.name === "main")
    expect(mainSlot).toBeDefined()
    expect(mainSlot?.position).toBe("center")
  })

  test("Slot is marked as required: true", () => {
    const layout = LAYOUT_TEMPLATES.find((t) => t.id === "layout-single-column")
    const mainSlot = layout?.slots.find((s) => s.name === "main")
    expect(mainSlot?.required).toBe(true)
  })

  test("Has description documenting container section use case", () => {
    const layout = LAYOUT_TEMPLATES.find((t) => t.id === "layout-single-column")
    expect(layout?.description).toBeDefined()
    expect(typeof layout?.description).toBe("string")
    expect(layout?.description?.length).toBeGreaterThan(0)
  })
})

// =============================================================================
// test-design-010-composition: Design Composition uses single-column layout
// =============================================================================
describe("Design Composition", () => {
  test("COMPOSITIONS array contains design composition with id 'composition-design'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-design")
    expect(composition).toBeDefined()
  })

  test("Entry has name 'design'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-design")
    expect(composition?.name).toBe("design")
  })

  test("Entry has layout reference to 'layout-single-column'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-design")
    expect(composition?.layout).toBe("layout-single-column")
  })

  test("slotContent has single entry for main slot", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-design")
    expect(composition?.slotContent).toHaveLength(1)
    const mainContent = composition?.slotContent.find((s) => s.slot === "main")
    expect(mainContent).toBeDefined()
  })

  test("main slot maps to DesignContainerSection component", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-design")
    const mainContent = composition?.slotContent.find((s) => s.slot === "main")
    expect(mainContent?.component).toBe("comp-design-container")
  })

  test("SlotContent.config includes defaultTab: 'schema'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-design")
    const mainContent = composition?.slotContent.find((s) => s.slot === "main")
    expect(mainContent?.config).toBeDefined()
    expect(mainContent?.config?.defaultTab).toBe("schema")
  })

  test("Entry has dataContext with phase='design'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-design")
    expect(composition?.dataContext).toBeDefined()
    expect(composition?.dataContext?.phase).toBe("design")
  })

  test("Entry has NO providerWrapper (internal React state via container section)", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-design")
    // Design phase uses container section pattern with internal state - no React Context provider needed
    expect(composition?.providerWrapper).toBeUndefined()
  })
})

// =============================================================================
// test-testing-007-seed: Testing Phase ComponentDefinitions exist in seed data
// =============================================================================
describe("Testing Phase Section ComponentDefinitions", () => {
  test("4 ComponentDefinitions found for Testing sections", () => {
    const testingDefs = COMPONENT_DEFINITIONS.filter(
      (d) => d.tags?.includes("testing-phase")
    )
    expect(testingDefs).toHaveLength(4)
  })

  test("Each has category='section'", () => {
    const testingDefs = COMPONENT_DEFINITIONS.filter(
      (d) => d.tags?.includes("testing-phase")
    )
    for (const def of testingDefs) {
      expect(def.category).toBe("section")
    }
  })

  test("Each has tags containing 'testing-phase'", () => {
    const testingDefs = COMPONENT_DEFINITIONS.filter(
      (d) => d.tags?.includes("testing-phase")
    )
    for (const def of testingDefs) {
      expect(def.tags).toContain("testing-phase")
    }
  })

  test("TestPyramidSection definition exists with correct properties", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-test-pyramid-section"
    )
    expect(def).toBeDefined()
    expect(def?.name).toBe("TestPyramidSection")
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("TestPyramidSection")
    expect(def?.tags).toContain("section")
    expect(def?.tags).toContain("testing-phase")
  })

  test("TestTypeDistributionSection definition exists with correct properties", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-test-type-distribution-section"
    )
    expect(def).toBeDefined()
    expect(def?.name).toBe("TestTypeDistributionSection")
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("TestTypeDistributionSection")
    expect(def?.tags).toContain("section")
    expect(def?.tags).toContain("testing-phase")
  })

  test("TaskCoverageBarSection definition exists with correct properties", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-task-coverage-bar-section"
    )
    expect(def).toBeDefined()
    expect(def?.name).toBe("TaskCoverageBarSection")
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("TaskCoverageBarSection")
    expect(def?.tags).toContain("section")
    expect(def?.tags).toContain("testing-phase")
  })

  test("ScenarioSpotlightSection definition exists with correct properties", () => {
    const def = COMPONENT_DEFINITIONS.find(
      (d) => d.id === "comp-def-scenario-spotlight-section"
    )
    expect(def).toBeDefined()
    expect(def?.name).toBe("ScenarioSpotlightSection")
    expect(def?.category).toBe("section")
    expect(def?.implementationRef).toBe("ScenarioSpotlightSection")
    expect(def?.tags).toContain("section")
    expect(def?.tags).toContain("testing-phase")
  })
})

// =============================================================================
// test-testing-008-composition: Testing Composition uses providerWrapper for context coordination
// =============================================================================
describe("Testing Composition", () => {
  test("COMPOSITIONS array contains testing composition with id 'composition-testing'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-testing")
    expect(composition).toBeDefined()
  })

  test("Entry has name 'testing'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-testing")
    expect(composition?.name).toBe("testing")
  })

  test("Entry has layout reference to 'layout-phase-two-column'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-testing")
    expect(composition?.layout).toBe("layout-phase-two-column")
  })

  test("slotContent has 4 entries for Testing sections", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-testing")
    expect(composition?.slotContent).toHaveLength(4)
  })

  test("main slot[0] maps to TestPyramidSection", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-testing")
    const mainContents = composition?.slotContent.filter((s) => s.slot === "main")
    expect(mainContents?.[0]?.component).toBe("comp-def-test-pyramid-section")
  })

  test("main slot[1] maps to TestTypeDistributionSection", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-testing")
    const mainContents = composition?.slotContent.filter((s) => s.slot === "main")
    expect(mainContents?.[1]?.component).toBe("comp-def-test-type-distribution-section")
  })

  test("sidebar slot[0] maps to TaskCoverageBarSection", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-testing")
    const sidebarContents = composition?.slotContent.filter((s) => s.slot === "sidebar")
    expect(sidebarContents?.[0]?.component).toBe("comp-def-task-coverage-bar-section")
  })

  test("sidebar slot[1] maps to ScenarioSpotlightSection", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-testing")
    const sidebarContents = composition?.slotContent.filter((s) => s.slot === "sidebar")
    expect(sidebarContents?.[1]?.component).toBe("comp-def-scenario-spotlight-section")
  })

  test("Entry has dataContext with phase='testing'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-testing")
    expect(composition?.dataContext).toBeDefined()
    expect(composition?.dataContext?.phase).toBe("testing")
  })

  test("Entry has providerWrapper='TestingPanelProvider'", () => {
    const composition = COMPOSITIONS.find((c) => c.id === "composition-testing")
    expect(composition?.providerWrapper).toBe("TestingPanelProvider")
  })
})
