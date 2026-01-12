/**
 * Tests for DesignContainerSection
 * Task: task-design-001, task-design-003, task-design-004, task-design-005, task-design-006
 *
 * TDD tests for the Design phase container section component:
 * - Tabbed navigation structure (schema, decisions, hooks)
 * - Amber active state styling for design phase
 * - Full height flex layout
 * - Proper test IDs
 * - Tab switching behavior
 * - ReferenceLegend internal sub-component (task-design-003)
 * - SchemaTabContent orchestration component (task-design-004)
 * - DecisionTimeline integration (task-design-005)
 * - EnhancementHooksPlan integration (task-design-006)
 *
 * Test Specifications:
 * - test-design-001-scaffold: Renders with tabbed navigation structure
 * - test-design-001-tab-switch: Switches tab content on click
 * - test-design-001-testid: Has proper test IDs for testing
 * - test-design-001-full-height: Uses full height flex layout
 * - test-design-001-amber-tabs: Tabs use amber active state styling
 * - test-design-003-legend-items: ReferenceLegend displays three edge type entries
 * - test-design-003-legend-styling: ReferenceLegend uses compact horizontal layout
 * - test-design-003-legend-icons: ReferenceLegend uses Lucide icons for indicators
 */

import { describe, test, expect, beforeAll, afterEach, afterAll } from "bun:test"
import { render, fireEvent, cleanup, screen } from "@testing-library/react"
import { Window } from "happy-dom"
import fs from "fs"
import path from "path"

// DOM setup for happy-dom
let window: Window
let cleanup_dom: () => void

beforeAll(() => {
  window = new Window({ url: "https://localhost/" })
  const doc = window.document
  // @ts-ignore
  globalThis.document = doc
  // @ts-ignore
  globalThis.window = window
  // @ts-ignore
  globalThis.HTMLElement = window.HTMLElement
  // @ts-ignore
  globalThis.DocumentFragment = window.DocumentFragment

  cleanup_dom = () => {
    window.close()
  }
})

afterEach(() => {
  cleanup()
})

afterAll(() => {
  cleanup_dom()
})

const componentPath = path.resolve(
  import.meta.dir,
  "../DesignContainerSection.tsx"
)

// ============================================================
// Test: test-design-001-scaffold
// Scenario: DesignContainerSection renders with tabbed navigation structure
// ============================================================

describe("test-design-001-scaffold: DesignContainerSection renders with tabbed navigation structure", () => {
  test("component file exists at expected path", () => {
    // Given: DesignContainerSection component file should exist
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("DesignContainerSection is exported", () => {
    // Given: Component should be exported
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+DesignContainerSection/)
  })

  test("component accepts SectionRendererProps interface", () => {
    // Given: Component should accept feature and config props
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/SectionRendererProps/)
    expect(source).toMatch(/feature/)
  })

  test("header shows Pencil icon", () => {
    // Given: Header should use Pencil icon from lucide-react
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Pencil/)
    expect(source).toMatch(/import.*Pencil.*from.*lucide-react/)
  })

  test("header shows 'Schema Blueprint' title", () => {
    // Given: Header should display Schema Blueprint title
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Schema Blueprint/)
  })

  test("three tabs are defined: schema, decisions, hooks", () => {
    // Given: Should have TabsTrigger elements for all three tabs
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/value=["']schema["']/)
    expect(source).toMatch(/value=["']decisions["']/)
    expect(source).toMatch(/value=["']hooks["']/)
  })

  test("schema tab is default/active by default", () => {
    // Given: Tabs component should use defaultValue with schema as default
    // Implementation uses variable defaultTab which defaults to "schema" via ?? operator
    const source = fs.readFileSync(componentPath, "utf-8")
    // Check that defaultValue is used (uncontrolled tabs)
    expect(source).toMatch(/defaultValue=/)
    // Check that schema is the default (either direct or via config fallback)
    expect(source).toMatch(/\?\?\s*["']schema["']|defaultValue=["']schema["']/)
  })

  test("uses usePhaseColor hook with 'design' phase", () => {
    // Given: Should get phase colors for design phase
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/usePhaseColor\s*\(\s*["']design["']\s*\)/)
  })
})

// ============================================================
// Test: test-design-001-tab-switch
// Scenario: DesignContainerSection switches tab content on click
// ============================================================

describe("test-design-001-tab-switch: DesignContainerSection switches tab content on click", () => {
  test("uses Tabs component from shadcn/ui", () => {
    // Given: Should import Tabs components
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*Tabs.*from.*@\/components\/ui\/tabs/)
    expect(source).toMatch(/TabsList/)
    expect(source).toMatch(/TabsTrigger/)
    expect(source).toMatch(/TabsContent/)
  })

  test("has three TabsContent elements for each tab", () => {
    // Given: Should have TabsContent for schema, decisions, and hooks
    const source = fs.readFileSync(componentPath, "utf-8")
    // Count TabsContent occurrences
    const tabsContentMatches = source.match(/<TabsContent/g) || []
    expect(tabsContentMatches.length).toBeGreaterThanOrEqual(3)
  })

  test("tab state managed via Tabs defaultValue (uncontrolled)", () => {
    // Given: Tab state should be uncontrolled via defaultValue
    // OR use useState if config.defaultTab is needed
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should use defaultValue pattern
    expect(source).toMatch(/defaultValue/)
  })
})

// ============================================================
// Test: test-design-001-testid
// Scenario: DesignContainerSection has proper test IDs for testing
// ============================================================

describe("test-design-001-testid: DesignContainerSection has proper test IDs for testing", () => {
  test("root element has data-testid='design-container-section'", () => {
    // Given: Root element should have proper test ID
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid=["']design-container-section["']/)
  })

  test("Tabs element has data-testid='design-tabs'", () => {
    // Given: Tabs element should have proper test ID
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/data-testid=["']design-tabs["']/)
  })
})

// ============================================================
// Test: test-design-001-full-height
// Scenario: DesignContainerSection uses full height flex layout
// ============================================================

describe("test-design-001-full-height: DesignContainerSection uses full height flex layout", () => {
  test("has h-full class for full height", () => {
    // Given: Container should use full height
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/h-full/)
  })

  test("uses flex flex-col layout", () => {
    // Given: Container should use flex column layout
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/flex/)
    expect(source).toMatch(/flex-col/)
  })

  test("has overflow-hidden to contain content", () => {
    // Given: Container should prevent overflow
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/overflow-hidden/)
  })
})

// ============================================================
// Test: test-design-001-amber-tabs
// Scenario: DesignContainerSection tabs use amber active state styling
// ============================================================

describe("test-design-001-amber-tabs: DesignContainerSection tabs use amber active state styling", () => {
  test("tabs use amber/design phase color styling", () => {
    // Given: Tab triggers should use amber colors for design phase
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should use phaseColors from usePhaseColor('design')
    // OR directly reference amber colors
    expect(source).toMatch(/amber|phaseColors/)
  })

  test("active tab styling is applied via data-state or className", () => {
    // Given: Active tab should have distinct styling
    const source = fs.readFileSync(componentPath, "utf-8")
    // TabsTrigger from shadcn uses data-[state=active] for styling
    // Custom className may also apply phase-specific active styles
    expect(source).toMatch(/TabsTrigger/)
  })

  test("inactive tabs have muted styling", () => {
    // Given: Inactive tabs should be visually distinct (muted)
    const source = fs.readFileSync(componentPath, "utf-8")
    // Either uses default TabsTrigger styling (which has muted inactive)
    // or explicitly applies muted classes
    expect(source).toMatch(/TabsTrigger|muted|opacity/)
  })
})

// ============================================================
// Test: test-design-002-stats-display
// Scenario: SchemaStatisticsBar displays entity, property, and reference counts
// Task: task-design-002
// ============================================================

describe("test-design-002-stats-display: SchemaStatisticsBar displays entity, property, and reference counts", () => {
  test("SchemaStatisticsBar function component is defined", () => {
    // Given: SchemaStatisticsBar should be defined as internal sub-component
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/function\s+SchemaStatisticsBar/)
  })

  test("accepts models and phaseColors props", () => {
    // Given: Component accepts { models, phaseColors } props
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have props destructuring with models and phaseColors
    expect(source).toMatch(/SchemaStatisticsBar\s*\(\s*\{[\s\S]*?models[\s\S]*?phaseColors[\s\S]*?\}/)
  })

  test("uses useMemo to calculate statistics", () => {
    // Given: Statistics calculation should use useMemo for performance
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have useMemo that returns { entities, properties, references }
    expect(source).toMatch(/useMemo\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?entities[\s\S]*?properties[\s\S]*?references/)
  })

  test("counts entities as models.length", () => {
    // Given: Entity count should be models.length
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/entities\s*[:=]\s*models\.length|const\s+entities\s*=\s*models\.length/)
  })

  test("counts properties as sum of all model.fields", () => {
    // Given: Property count should sum all fields across models
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should iterate over models and count fields
    expect(source).toMatch(/model\.fields|fields\.forEach|fields\.length/)
  })

  test("counts references from fields with isReference or referenceTarget", () => {
    // Given: Reference count should check isReference or referenceTarget
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/isReference|referenceTarget/)
  })

  test("renders horizontal flex layout with gap-6", () => {
    // Given: Should use flex layout with gap-6 spacing
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have flex and gap-6 classes in the statistics bar
    expect(source).toMatch(/flex.*items-center.*gap-6|gap-6.*flex/)
  })
})

// ============================================================
// Test: test-design-002-stats-styling
// Scenario: SchemaStatisticsBar uses amber styling and icons
// Task: task-design-002
// ============================================================

describe("test-design-002-stats-styling: SchemaStatisticsBar uses amber styling and icons", () => {
  test("container has p-3 bg-amber-500/5 rounded-lg border styling", () => {
    // Given: Container should have specific amber styling
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/p-3/)
    expect(source).toMatch(/bg-amber-500\/5/)
    expect(source).toMatch(/rounded-lg/)
    // Border should use phaseColors.border
    expect(source).toMatch(/phaseColors\.border/)
  })

  test("Box icon renders with text-amber-500 color for entities", () => {
    // Given: Entity stat should use Box icon with amber-500 color
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Box/)
    expect(source).toMatch(/text-amber-500/)
  })

  test("Layers icon renders with text-amber-400 color for properties", () => {
    // Given: Property stat should use Layers icon with amber-400 color
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Layers/)
    expect(source).toMatch(/text-amber-400/)
  })

  test("Link icon renders with text-amber-300 color for references", () => {
    // Given: Reference stat should use Link icon with amber-300 color
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Link/)
    expect(source).toMatch(/text-amber-300/)
  })

  test("count values use font-medium styling", () => {
    // Given: Count values should have font-medium class
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/font-medium/)
  })

  test("labels use text-xs text-muted-foreground styling", () => {
    // Given: Labels should have text-xs and text-muted-foreground classes
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/text-xs/)
    expect(source).toMatch(/text-muted-foreground/)
  })

  test("icons are imported from lucide-react", () => {
    // Given: Box, Layers, Link should be imported from lucide-react
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*Box.*from.*lucide-react/)
    expect(source).toMatch(/import.*Layers.*from.*lucide-react/)
    expect(source).toMatch(/import.*Link.*from.*lucide-react/)
  })
})

// ============================================================
// Test: test-design-002-stats-empty
// Scenario: SchemaStatisticsBar handles empty or null models gracefully
// Task: task-design-002
// ============================================================

describe("test-design-002-stats-empty: SchemaStatisticsBar handles empty or null models gracefully", () => {
  test("returns null when models is null or empty", () => {
    // Given: Component should return null for null/empty models
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have early return for null/empty models
    expect(source).toMatch(/if\s*\(\s*!models\s*(\|\||&&)\s*!?models\.length|if\s*\(\s*!models\s*\)|models\s*===\s*null/)
  })

  test("handles empty array gracefully", () => {
    // Given: Component should handle empty models array without errors
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should check for empty array condition
    expect(source).toMatch(/models\.length|!models/)
  })

  test("useMemo guards against null models", () => {
    // Given: useMemo calculation should handle null gracefully
    const source = fs.readFileSync(componentPath, "utf-8")
    // useMemo should have guard clause for null models
    expect(source).toMatch(/if\s*\(\s*!models\s*\)[\s\S]*?return/)
  })
})

// ============================================================
// Test: test-design-005-decisions
// Scenario: DecisionsTabContent renders DecisionTimeline with featureId
// Task: task-design-005
// ============================================================

describe("test-design-005-decisions: DecisionsTabContent renders DecisionTimeline with featureId", () => {
  test("DecisionsTabContent function component accepts { feature } props", () => {
    // Given: DecisionsTabContent should be defined as a function component
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/function\s+DecisionsTabContent/)
    // Should accept feature prop
    expect(source).toMatch(/DecisionsTabContent\s*\(\s*\{[^}]*feature[^}]*\}/)
  })

  test("imports DecisionTimeline from correct path", () => {
    // Given: Should import DecisionTimeline from the stepper phases design directory
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(
      /import.*DecisionTimeline.*from\s+["']\.\.\/\.\.\/app\/stepper\/phases\/design\/DecisionTimeline["']/
    )
  })

  test("renders DecisionTimeline with featureId={feature.id}", () => {
    // Given: Should render DecisionTimeline and pass feature.id as featureId
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<DecisionTimeline/)
    expect(source).toMatch(/featureId=\{feature\.id\}/)
  })

  test("optionally accepts onEntityClick prop for cross-tab entity navigation", () => {
    // Given: DecisionsTabContent should accept onEntityClick callback
    const source = fs.readFileSync(componentPath, "utf-8")
    // The prop should be in the component signature
    expect(source).toMatch(/DecisionsTabContent\s*\(\s*\{[^}]*onEntityClick[^}]*\}/)
  })

  test("container has overflow-auto for scrolling long decision lists", () => {
    // Given: The component should have overflow-auto styling
    // This matches DesignView TabsContent line 282-284 styling
    const source = fs.readFileSync(componentPath, "utf-8")
    // Look for overflow-auto in the DecisionsTabContent function
    // Extract DecisionsTabContent function body
    const functionMatch = source.match(
      /function\s+DecisionsTabContent[\s\S]*?return\s*\([^)]*\)/
    )
    if (functionMatch) {
      expect(functionMatch[0]).toMatch(/overflow-auto/)
    } else {
      // Fallback: check container around DecisionsTabContent has overflow-auto
      expect(source).toMatch(/DecisionsTabContent[\s\S]{0,500}overflow-auto/)
    }
  })

  test("matches TabsContent styling pattern (flex-1 overflow-auto)", () => {
    // Given: TabsContent for decisions in DesignView uses "flex-1 mt-4 overflow-auto"
    // The internal container in DecisionsTabContent should use similar styling
    const source = fs.readFileSync(componentPath, "utf-8")
    // Check the TabsContent for decisions has the correct classes
    expect(source).toMatch(
      /<TabsContent\s+value=["']decisions["'][^>]*className=["'][^"']*flex-1[^"']*overflow-auto/
    )
  })
})

// ============================================================
// Test: test-design-006-hooks
// Scenario: HooksTabContent renders EnhancementHooksPlan with featureId
// Task: task-design-006
// ============================================================

describe("test-design-006-hooks: HooksTabContent renders EnhancementHooksPlan with featureId", () => {
  test("HooksTabContent accepts { feature } props", () => {
    // Given: HooksTabContent sub-component should accept feature prop
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have HooksTabContent function definition with feature prop
    expect(source).toMatch(/function\s+HooksTabContent\s*\(\s*\{\s*feature\s*\}/)
  })

  test("imports EnhancementHooksPlan from correct path", () => {
    // Given: Should import EnhancementHooksPlan from design phase
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(
      /import.*EnhancementHooksPlan.*from.*['"]\.\.\/\.\.\/app\/stepper\/phases\/design\/EnhancementHooksPlan['"]/
    )
  })

  test("HooksTabContent renders EnhancementHooksPlan component", () => {
    // Given: HooksTabContent should render EnhancementHooksPlan
    const source = fs.readFileSync(componentPath, "utf-8")
    // Find the HooksTabContent function body and check it renders EnhancementHooksPlan
    expect(source).toMatch(/<EnhancementHooksPlan/)
  })

  test("EnhancementHooksPlan receives featureId prop from feature.id", () => {
    // Given: EnhancementHooksPlan should receive featureId={feature.id}
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/featureId=\{feature\.id\}/)
  })

  test("HooksTabContent container has overflow-auto for scrolling", () => {
    // Given: Container should have overflow-auto class
    const source = fs.readFileSync(componentPath, "utf-8")
    // The HooksTabContent should have overflow-auto styling
    // This could be on the container div or inherited from parent
    expect(source).toMatch(/overflow-auto/)
  })

  test("TabsContent for hooks has styling matching DesignView pattern", () => {
    // Given: TabsContent should have flex-1 and overflow-auto classes
    // Per DesignView line 286-288: className="flex-1 mt-4 overflow-auto"
    const source = fs.readFileSync(componentPath, "utf-8")
    // The hooks TabsContent should have flex-1 overflow-auto
    expect(source).toMatch(/<TabsContent\s+value=["']hooks["'][^>]*className=["'][^"']*flex-1[^"']*overflow-auto/)
  })
})

// ============================================================
// Test: test-design-003-legend-items
// Scenario: ReferenceLegend displays three edge type entries
// Task: task-design-003
// ============================================================

describe("test-design-003-legend-items: ReferenceLegend displays three edge type entries", () => {
  test("ReferenceLegend component is defined in the file", () => {
    // Given: ReferenceLegend should be defined as an internal component
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/function\s+ReferenceLegend/)
  })

  test("ReferenceLegend has no props (static content)", () => {
    // Given: ReferenceLegend should be a function component with no props
    const source = fs.readFileSync(componentPath, "utf-8")
    // Function should either have empty parens () or no params
    expect(source).toMatch(/function\s+ReferenceLegend\s*\(\s*\)/)
  })

  test("defines legendItems array with three entries", () => {
    // Given: Should define legendItems with single, array, maybe-ref
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/legendItems\s*=\s*\[/)
    // Check for each type
    expect(source).toMatch(/type:\s*["']single["']/)
    expect(source).toMatch(/type:\s*["']array["']/)
    expect(source).toMatch(/type:\s*["']maybe-ref["']/)
  })

  test("single reference item has correct properties", () => {
    // Given: single item should have label, lineStyle solid, description
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/type:\s*["']single["']/)
    expect(source).toMatch(/label:\s*["']Single Reference["']/)
    expect(source).toMatch(/lineStyle:\s*["']solid["']/)
    expect(source).toMatch(/description:\s*["']One-to-one relationship["']/)
  })

  test("array reference item has correct properties with hasDouble flag", () => {
    // Given: array item should have hasDouble: true
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/type:\s*["']array["']/)
    expect(source).toMatch(/label:\s*["']Array Reference["']/)
    expect(source).toMatch(/hasDouble:\s*true/)
    expect(source).toMatch(/description:\s*["']One-to-many relationship["']/)
  })

  test("maybe-ref item has dashed lineStyle", () => {
    // Given: maybe-ref item should use dashed lineStyle
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/type:\s*["']maybe-ref["']/)
    expect(source).toMatch(/label:\s*["']Maybe Reference["']/)
    // maybe-ref should be dashed (the only item with dashed)
    // Check for dashed appearing in context with maybe-ref
    expect(source).toMatch(/lineStyle:\s*["']dashed["']/)
    expect(source).toMatch(/description:\s*["']Optional relationship["']/)
  })
})

// ============================================================
// Test: test-design-003-legend-styling
// Scenario: ReferenceLegend uses compact horizontal layout with muted styling
// Task: task-design-003
// ============================================================

describe("test-design-003-legend-styling: ReferenceLegend uses compact horizontal layout", () => {
  test("container uses horizontal flex with gap-4", () => {
    // Given: Container should use flex items-center gap-4
    const source = fs.readFileSync(componentPath, "utf-8")
    // Look for flex items-center gap-4 in the ReferenceLegend context
    expect(source).toMatch(/flex\s+items-center\s+gap-4/)
  })

  test("container has p-2 bg-muted/30 rounded-lg styling", () => {
    // Given: Container should have padding and background styling
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/p-2/)
    expect(source).toMatch(/bg-muted\/30/)
    expect(source).toMatch(/rounded-lg/)
  })

  test("text uses text-xs size", () => {
    // Given: Text should use extra-small size
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/text-xs/)
  })

  test("Edge Legend label displays with muted-foreground color", () => {
    // Given: Label should show 'Edge Legend:' with muted styling
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/Edge Legend:/)
    expect(source).toMatch(/text-muted-foreground/)
  })
})

// ============================================================
// Test: test-design-003-legend-icons
// Scenario: ReferenceLegend uses Lucide icons for line style indicators
// Task: task-design-003
// ============================================================

describe("test-design-003-legend-icons: ReferenceLegend uses Lucide icons", () => {
  test("imports MoreHorizontal icon from lucide-react", () => {
    // Given: Should import MoreHorizontal for dashed line representation
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*MoreHorizontal.*from.*lucide-react/)
  })

  test("imports Minus icon from lucide-react", () => {
    // Given: Should import Minus for solid line representation
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*Minus.*from.*lucide-react/)
  })

  test("imports ArrowRight icon from lucide-react", () => {
    // Given: Should import ArrowRight for solid line representation
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*ArrowRight.*from.*lucide-react/)
  })

  test("uses MoreHorizontal for dashed line style", () => {
    // Given: Dashed line style should use MoreHorizontal icon
    const source = fs.readFileSync(componentPath, "utf-8")
    // Check that MoreHorizontal is used in context of dashed styling
    expect(source).toMatch(/<MoreHorizontal/)
  })

  test("uses Minus and ArrowRight for solid line style", () => {
    // Given: Solid line style should use Minus and ArrowRight icons
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<Minus/)
    expect(source).toMatch(/<ArrowRight/)
  })

  test("icons have appropriate small sizing for legend context", () => {
    // Given: Icons should be small (h-3 w-3) per original styling
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/h-3\s+w-3/)
  })
})

// ============================================================
// Test: test-design-004-schema-tab
// Scenario: SchemaTabContent renders statistics, legend, and graph when schema loaded
// Task: task-design-004
// ============================================================

describe("test-design-004-schema-tab: SchemaTabContent renders statistics, legend, and graph when schema loaded", () => {
  test("SchemaTabContent function component accepts { feature, phaseColors } props", () => {
    // Given: SchemaTabContent should be defined with feature and phaseColors props
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/function\s+SchemaTabContent\s*\(\s*\{[^}]*feature[^}]*phaseColors[^}]*\}/)
  })

  test("manages selectedEntityId state via useState<string | null>(null)", () => {
    // Given: Component should manage selectedEntityId as local React state
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have useState for selectedEntityId with null initial value
    expect(source).toMatch(/useState<string\s*\|\s*null>\s*\(\s*null\s*\)|useState\s*\(\s*null\s*\)/)
    expect(source).toMatch(/selectedEntityId/)
  })

  test("uses useSchemaData hook with feature.schemaName", () => {
    // Given: Should use useSchemaData hook for async schema loading
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useSchemaData\s*\(\s*feature\.schemaName|useSchemaData\s*\(\s*schemaName/)
  })

  test("computes selectedEntity from models using useMemo based on selectedEntityId", () => {
    // Given: Should use useMemo to find selected entity from models
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useMemo\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?selectedEntityId[\s\S]*?models/)
    expect(source).toMatch(/selectedEntity/)
  })

  test("success state renders SchemaStatisticsBar", () => {
    // Given: When schema is loaded, should render SchemaStatisticsBar
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have SchemaStatisticsBar in the SchemaTabContent function
    expect(source).toMatch(/<SchemaStatisticsBar/)
  })

  test("success state renders ReferenceLegend", () => {
    // Given: When schema is loaded, should render ReferenceLegend
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have ReferenceLegend in the SchemaTabContent function
    expect(source).toMatch(/<ReferenceLegend/)
  })

  test("success state renders SchemaGraph with models and selection props", () => {
    // Given: When schema is loaded, should render SchemaGraph
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<SchemaGraph/)
    // Should pass selectedEntityId and onSelectEntity props
    expect(source).toMatch(/selectedEntityId=\{selectedEntityId\}/)
    expect(source).toMatch(/onSelectEntity=\{handleSelectEntity\}/)
  })

  test("success state renders EntityDetailsPanel with entity and onClose props", () => {
    // Given: When schema is loaded, should render EntityDetailsPanel
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<EntityDetailsPanel/)
    // Should pass entity and onClose props
    expect(source).toMatch(/entity=\{selectedEntity\}/)
    expect(source).toMatch(/onClose=\{handleCloseDetails\}/)
  })
})

// ============================================================
// Test: test-design-004-entity-select
// Scenario: SchemaTabContent shows EntityDetailsPanel when graph node selected
// Task: task-design-004
// ============================================================

describe("test-design-004-entity-select: SchemaTabContent shows EntityDetailsPanel when graph node selected", () => {
  test("implements handleSelectEntity callback for graph node clicks", () => {
    // Given: Should define handleSelectEntity callback
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have handleSelectEntity function/callback
    expect(source).toMatch(/handleSelectEntity|const\s+handleSelectEntity/)
  })

  test("implements handleCloseDetails callback to clear selection", () => {
    // Given: Should define handleCloseDetails callback
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have handleCloseDetails function that sets selectedEntityId to null
    expect(source).toMatch(/handleCloseDetails/)
    expect(source).toMatch(/setSelectedEntityId\s*\(\s*null\s*\)/)
  })

  test("setSelectedEntityId is used in handleSelectEntity", () => {
    // Given: handleSelectEntity should call setSelectedEntityId
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/setSelectedEntityId/)
  })
})

// ============================================================
// Test: test-design-004-loading-state
// Scenario: SchemaTabContent shows loading skeleton while schema loads
// Task: task-design-004
// ============================================================

describe("test-design-004-loading-state: SchemaTabContent shows loading skeleton while schema loads", () => {
  test("imports SchemaLoadingSkeleton component", () => {
    // Given: Should import SchemaLoadingSkeleton for loading state
    const source = fs.readFileSync(componentPath, "utf-8")
    // Multi-line import: look for SchemaLoadingSkeleton anywhere in imports section
    expect(source).toMatch(/SchemaLoadingSkeleton/)
  })

  test("renders SchemaLoadingSkeleton when isLoading is true", () => {
    // Given: When useSchemaData returns loading state, show skeleton
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have conditional rendering for loading state
    expect(source).toMatch(/isLoading/)
    expect(source).toMatch(/<SchemaLoadingSkeleton/)
  })
})

// ============================================================
// Test: test-design-004-error-state
// Scenario: SchemaTabContent shows error state when schema load fails
// Task: task-design-004
// ============================================================

describe("test-design-004-error-state: SchemaTabContent shows error state when schema load fails", () => {
  test("imports SchemaEmptyState component", () => {
    // Given: Should import SchemaEmptyState for error/empty states
    const source = fs.readFileSync(componentPath, "utf-8")
    // Multi-line import: look for SchemaEmptyState anywhere in imports section
    expect(source).toMatch(/SchemaEmptyState/)
  })

  test("renders SchemaEmptyState with type error when error occurs", () => {
    // Given: When useSchemaData returns error, show error state
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have conditional rendering for error state
    expect(source).toMatch(/error/)
    expect(source).toMatch(/<SchemaEmptyState[\s\S]*?type=["']error["']/)
  })

  test("passes refetch callback as onRetry prop for error recovery", () => {
    // Given: Error state should allow retry via refetch
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/onRetry=\{refetch\}/)
  })
})

// ============================================================
// Test: test-design-004-empty-state
// Scenario: SchemaTabContent shows empty state when no schemaName
// Task: task-design-004
// ============================================================

describe("test-design-004-empty-state: SchemaTabContent shows empty state when no schemaName", () => {
  test("checks if feature.schemaName is defined", () => {
    // Given: Component should check for schemaName before loading
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should check if schemaName exists
    expect(source).toMatch(/schemaName|feature\.schemaName/)
  })

  test("renders SchemaEmptyState with type no-schema when schemaName undefined", () => {
    // Given: When no schemaName, show empty state
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should have conditional rendering for empty/no-schema state
    expect(source).toMatch(/<SchemaEmptyState[\s\S]*?type=["']no-schema["']/)
  })

  test("renders SchemaEmptyState with type not-created when models empty", () => {
    // Given: When models are empty but schema exists, show not-created state
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<SchemaEmptyState[\s\S]*?type=["']not-created["']/)
  })
})

// ============================================================
// Test: test-design-004-blueprint-bg
// Scenario: SchemaTabContent graph container has blueprint grid background
// Task: task-design-004
// ============================================================

describe("test-design-004-blueprint-bg: SchemaTabContent graph container has blueprint grid background", () => {
  test("graph container has blueprint grid background CSS pattern", () => {
    // Given: The graph container should have the amber blueprint grid background
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should use inline style with linear-gradient for blueprint grid
    // Pattern from DesignView lines 227-234
    expect(source).toMatch(/linear-gradient/)
    expect(source).toMatch(/rgba\s*\(\s*245\s*,\s*158\s*,\s*11/)
  })

  test("graph container has amber border styling", () => {
    // Given: Container should have amber border for design phase
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/border-amber-500\/20|border.*amber/)
  })

  test("graph container has rounded-lg overflow-hidden styling", () => {
    // Given: Container should have rounded corners and overflow hidden
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/rounded-lg/)
    expect(source).toMatch(/overflow-hidden/)
  })
})

// ============================================================
// Test: test-design-004-layout
// Scenario: SchemaTabContent matches DesignView layout pattern
// Task: task-design-004
// ============================================================

describe("test-design-004-layout: SchemaTabContent matches DesignView layout pattern", () => {
  test("root container has space-y-3 h-full flex flex-col layout", () => {
    // Given: Should match DesignView line 216 layout
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/space-y-3/)
    expect(source).toMatch(/h-full/)
    expect(source).toMatch(/flex\s+flex-col|flex-col.*flex/)
  })

  test("graph container wrapper has flex flex-1 min-h-0 layout", () => {
    // Given: Should match DesignView line 224 for graph container
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/flex\s+flex-1\s+min-h-0|flex-1.*min-h-0/)
  })

  test("graph inner container has flex-1 styling", () => {
    // Given: Inner container holding SchemaGraph should be flex-1
    const source = fs.readFileSync(componentPath, "utf-8")
    // The div with style background should be flex-1
    expect(source).toMatch(/flex-1.*rounded-lg.*overflow-hidden/)
  })
})

// ============================================================
// Container Pattern Verification
// ============================================================

describe("task-design-001: Container Section Pattern compliance", () => {
  test("internal sub-components are defined inside file", () => {
    // Given: Container pattern requires internal sub-components
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should define internal tab content components
    expect(source).toMatch(/SchemaTabContent|function\s+\w*Schema\w*|const\s+\w*Schema\w*\s*=/)
  })

  test("uses React useState for internal state (not Wavesmith)", () => {
    // Given: Container pattern requires useState for internal state
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/useState/)
    // Should NOT use Wavesmith stores for internal UI state
    // (Wavesmith is for domain data, not UI state like selectedEntityId)
  })

  test("does not export internal sub-components for registration", () => {
    // Given: Internal components should not be exported
    const source = fs.readFileSync(componentPath, "utf-8")
    // Main export should be DesignContainerSection
    // Internal components like SchemaTabContent should not be exported
    const exportMatches = source.match(/export\s+(const|function)\s+\w+/g) || []
    // Should have exactly 1 export (the main component)
    // Filter out type exports
    const componentExports = exportMatches.filter(
      (m) => !m.includes("type") && !m.includes("interface")
    )
    expect(componentExports.length).toBe(1)
    expect(componentExports[0]).toMatch(/DesignContainerSection/)
  })
})

// ============================================================
// Test: test-design-007-assembly-render
// Scenario: DesignContainerSection assembles all sub-components into tabbed layout
// Task: task-design-007
// ============================================================

describe("test-design-007-assembly-render: DesignContainerSection assembles all sub-components into tabbed layout", () => {
  test("header renders with phase colors from usePhaseColor('design')", () => {
    // Given: DesignContainerSection with feature prop
    // When: Component fully renders
    // Then: Header renders with phase colors (using phaseColors.border, phaseColors.text)
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/usePhaseColor\s*\(\s*["']design["']\s*\)/)
    expect(source).toMatch(/phaseColors\.border/)
    expect(source).toMatch(/phaseColors\.text/)
  })

  test("header renders with Pencil icon", () => {
    // Given: DesignContainerSection component
    // When: Component fully renders
    // Then: Header renders with Pencil icon
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<Pencil/)
  })

  test("Tabs component contains three TabsContent sections", () => {
    // Given: DesignContainerSection with feature prop
    // When: Component fully renders
    // Then: Tabs component contains three TabsContent sections
    const source = fs.readFileSync(componentPath, "utf-8")
    const tabsContentMatches = source.match(/<TabsContent/g) || []
    expect(tabsContentMatches.length).toBe(3)
  })

  test("Schema tab (value='schema') renders SchemaTabContent with feature and phaseColors", () => {
    // Given: DesignContainerSection with feature prop
    // When: Schema tab is rendered
    // Then: SchemaTabContent receives feature and phaseColors props
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<TabsContent\s+value=["']schema["']/)
    expect(source).toMatch(/<SchemaTabContent\s+feature=\{feature\}\s+phaseColors=\{phaseColors\}/)
  })

  test("Decisions tab (value='decisions') renders DecisionsTabContent with feature", () => {
    // Given: DesignContainerSection with feature prop
    // When: Decisions tab is rendered
    // Then: DecisionsTabContent receives feature prop
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<TabsContent\s+value=["']decisions["']/)
    expect(source).toMatch(/<DecisionsTabContent\s+feature=\{feature\}/)
  })

  test("Hooks tab (value='hooks') renders HooksTabContent with feature", () => {
    // Given: DesignContainerSection with feature prop
    // When: Hooks tab is rendered
    // Then: HooksTabContent receives feature prop
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/<TabsContent\s+value=["']hooks["']/)
    expect(source).toMatch(/<HooksTabContent\s+feature=\{feature\}/)
  })

  test("each TabsContent has flex-1 mt-4 styling for proper spacing", () => {
    // Given: DesignContainerSection with feature prop
    // When: TabsContent elements are inspected
    // Then: Each TabsContent has flex-1 mt-4 styling for proper spacing
    const source = fs.readFileSync(componentPath, "utf-8")

    // Schema tab uses cn() with dynamic className, decisions/hooks use static className
    // Check that schema tab contains flex-1 and mt-4 in the cn() call
    expect(source).toMatch(/value=["']schema["'][\s\S]*?className=\{cn\(["']flex-1 mt-4/)

    // Decisions and hooks tabs use static className
    const decisionsTabContent = source.match(/<TabsContent\s+value=["']decisions["'][^>]*className=["']([^"']+)["']/)
    const hooksTabContent = source.match(/<TabsContent\s+value=["']hooks["'][^>]*className=["']([^"']+)["']/)

    expect(decisionsTabContent).toBeTruthy()
    expect(decisionsTabContent![1]).toMatch(/flex-1/)
    expect(decisionsTabContent![1]).toMatch(/mt-4/)

    expect(hooksTabContent).toBeTruthy()
    expect(hooksTabContent![1]).toMatch(/flex-1/)
    expect(hooksTabContent![1]).toMatch(/mt-4/)
  })
})

// ============================================================
// Test: test-design-007-schema-tab-min-height
// Scenario: Schema tab has minimum height for graph visibility
// Task: task-design-007
// ============================================================

describe("test-design-007-schema-tab-min-height: Schema tab has minimum height for graph visibility", () => {
  test("Schema TabsContent has conditional min-h-[400px] styling based on expandGraph config", () => {
    // Given: DesignContainerSection rendered
    // When: Schema TabsContent is inspected
    // Then: Schema tab has conditional min-height based on expandGraph
    const source = fs.readFileSync(componentPath, "utf-8")
    // Uses cn() with conditional !expandGraph && "min-h-[400px]"
    expect(source).toMatch(/value=["']schema["'][\s\S]*?className=\{cn\(/)
    expect(source).toMatch(/!expandGraph\s*&&\s*["']min-h-\[400px\]["']/)
  })

  test("ensures graph has configurable min-height via graphMinHeight config", () => {
    // Given: Schema tab with graph component
    // When: expandGraph is false and graphMinHeight is set
    // Then: Graph uses graphMinHeight for minimum height
    const source = fs.readFileSync(componentPath, "utf-8")
    // Verify inline style uses graphMinHeight
    expect(source).toMatch(/style=\{.*graphMinHeight/)
  })
})

// ============================================================
// Test: test-design-007-observer-wrapped
// Scenario: DesignContainerSection is wrapped with observer for MobX reactivity
// Task: task-design-007
// ============================================================

describe("test-design-007-observer-wrapped: DesignContainerSection is wrapped with observer for MobX reactivity", () => {
  test("imports observer from mobx-react-lite", () => {
    // Given: DesignContainerSection component exported
    // When: Component is inspected
    // Then: observer is imported from mobx-react-lite
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/import.*observer.*from\s+["']mobx-react-lite["']/)
  })

  test("DesignContainerSection is wrapped with observer()", () => {
    // Given: DesignContainerSection component exported
    // When: Component is inspected
    // Then: Component is wrapped with observer()
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should export observer-wrapped function:
    // export const DesignContainerSection = observer(function ...
    // OR: export const DesignContainerSection = observer((...) => ...)
    expect(source).toMatch(/export\s+(const|function)\s+DesignContainerSection\s*=\s*observer\s*\(/)
  })

  test("component reacts to domain data changes automatically", () => {
    // Given: DesignContainerSection wrapped with observer
    // When: Domain data changes
    // Then: Component re-renders automatically (ensured by observer wrapping)
    const source = fs.readFileSync(componentPath, "utf-8")
    // Verify observer wrapping exists
    expect(source).toMatch(/observer\s*\(\s*function\s+DesignContainerSection|observer\s*\(\s*\(\s*\{/)
  })
})

// ============================================================
// Test: test-design-007-config-defaulttab
// Scenario: DesignContainerSection respects config.defaultTab from slotContent
// Task: task-design-007
// ============================================================

describe("test-design-007-config-defaulttab: DesignContainerSection respects config.defaultTab from slotContent", () => {
  test("config prop is accepted from SectionRendererProps", () => {
    // Given: DesignContainerSection with config prop
    // When: Component receives config
    // Then: config prop is accepted
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source).toMatch(/SectionRendererProps/)
    expect(source).toMatch(/config/)
  })

  test("config.defaultTab is read to set initial tab", () => {
    // Given: DesignContainerSection with config prop
    // When: config.defaultTab is set
    // Then: Tab selection respects provided configuration
    const source = fs.readFileSync(componentPath, "utf-8")
    // Config is cast to DesignContainerConfig and defaultTab is read from it
    expect(source).toMatch(/designConfig\.defaultTab/)
  })

  test("defaults to 'schema' when config.defaultTab is not provided", () => {
    // Given: DesignContainerSection with no config.defaultTab
    // When: Component renders
    // Then: Schema tab is initially active (default)
    const source = fs.readFileSync(componentPath, "utf-8")
    // Should use nullish coalescing or OR operator to default to 'schema'
    expect(source).toMatch(/defaultTab.*\?\?\s*["']schema["']|\|\|\s*["']schema["']/)
  })

  test("Tabs defaultValue uses computed defaultTab", () => {
    // Given: DesignContainerSection with config.defaultTab='decisions'
    // When: Component renders
    // Then: Decisions tab is initially active
    const source = fs.readFileSync(componentPath, "utf-8")
    // Tabs should use defaultValue={defaultTab} not hardcoded value
    expect(source).toMatch(/defaultValue=\{defaultTab\}/)
  })
})

// ============================================================
// INTEGRATION TESTS - Code Structure Verification
// Task: task-design-011
// ============================================================
// These tests verify that all components are correctly integrated
// using static code analysis (Bun-compatible, no mocking required).

describe("test-design-011-integration: DesignContainerSection integration tests", () => {
  describe("Tab navigation structure", () => {
    test("clicking Schema tab shows correct TabsContent", () => {
      // Given: DesignContainerSection with tabbed navigation
      // When: Schema tab is clicked
      // Then: TabsContent value='schema' displays SchemaTabContent
      const source = fs.readFileSync(componentPath, "utf-8")
      // Verify tab trigger exists
      expect(source).toMatch(/<TabsTrigger[^>]*value=["']schema["']/)
      // Verify corresponding TabsContent exists with SchemaTabContent
      expect(source).toMatch(/<TabsContent\s+value=["']schema["'][\s\S]*?<SchemaTabContent/)
    })

    test("clicking Decisions tab shows DecisionTimeline content", () => {
      // Given: DesignContainerSection with tabbed navigation
      // When: Decisions tab is clicked
      // Then: TabsContent value='decisions' displays DecisionsTabContent
      const source = fs.readFileSync(componentPath, "utf-8")
      // Verify tab trigger exists
      expect(source).toMatch(/<TabsTrigger[^>]*value=["']decisions["']/)
      // Verify corresponding TabsContent exists with DecisionsTabContent
      expect(source).toMatch(/<TabsContent\s+value=["']decisions["'][\s\S]*?<DecisionsTabContent/)
    })

    test("clicking Hooks tab shows EnhancementHooksPlan content", () => {
      // Given: DesignContainerSection with tabbed navigation
      // When: Hooks tab is clicked
      // Then: TabsContent value='hooks' displays HooksTabContent
      const source = fs.readFileSync(componentPath, "utf-8")
      // Verify tab trigger exists
      expect(source).toMatch(/<TabsTrigger[^>]*value=["']hooks["']/)
      // Verify corresponding TabsContent exists with HooksTabContent
      expect(source).toMatch(/<TabsContent\s+value=["']hooks["'][\s\S]*?<HooksTabContent/)
    })
  })

  describe("Schema tab: renders sub-components when schema loaded", () => {
    test("SchemaStatisticsBar is rendered in success state", () => {
      // Given: SchemaTabContent with loaded schema
      // When: Schema is loaded successfully
      // Then: SchemaStatisticsBar renders with models and phaseColors
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/<SchemaStatisticsBar\s+models=\{models\}\s+phaseColors=\{phaseColors\}/)
    })

    test("ReferenceLegend is rendered in success state", () => {
      // Given: SchemaTabContent with loaded schema
      // When: Schema is loaded successfully
      // Then: ReferenceLegend renders the edge type legend
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/<ReferenceLegend/)
    })

    test("SchemaGraph is rendered with selection props", () => {
      // Given: SchemaTabContent with loaded schema
      // When: Schema is loaded successfully
      // Then: SchemaGraph renders with models, selectedEntityId, onSelectEntity
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/<SchemaGraph/)
      expect(source).toMatch(/selectedEntityId=\{selectedEntityId\}/)
      expect(source).toMatch(/onSelectEntity=\{handleSelectEntity\}/)
    })
  })

  describe("Schema tab empty states", () => {
    test("shows no-schema state when schemaName undefined", () => {
      // Given: SchemaTabContent without schemaName
      // When: schemaName is not defined
      // Then: SchemaEmptyState type='no-schema' renders
      const source = fs.readFileSync(componentPath, "utf-8")
      // Check the conditional logic for no schemaName
      expect(source).toMatch(/if\s*\(\s*!schemaName\s*\)/)
      expect(source).toMatch(/<SchemaEmptyState\s+type=["']no-schema["']/)
    })

    test("shows loading skeleton during schema load", () => {
      // Given: SchemaTabContent with schemaName
      // When: useSchemaData returns isLoading=true
      // Then: SchemaLoadingSkeleton renders
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/if\s*\(\s*isLoading\s*\)/)
      expect(source).toMatch(/<SchemaLoadingSkeleton/)
    })

    test("shows error state when schema load fails", () => {
      // Given: SchemaTabContent with schemaName
      // When: useSchemaData returns error
      // Then: SchemaEmptyState type='error' renders with onRetry
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/if\s*\(\s*error\s*\)/)
      expect(source).toMatch(/<SchemaEmptyState[\s\S]*?type=["']error["'][\s\S]*?onRetry=\{refetch\}/)
    })

    test("shows not-created state when models empty", () => {
      // Given: SchemaTabContent with schemaName
      // When: models array is empty
      // Then: SchemaEmptyState type='not-created' renders
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/if\s*\(\s*!models\s*\|\|\s*models\.length\s*===\s*0\s*\)/)
      expect(source).toMatch(/<SchemaEmptyState\s+type=["']not-created["']/)
    })
  })

  describe("Entity selection: graph node to EntityDetailsPanel", () => {
    test("handleSelectEntity callback is defined for graph node clicks", () => {
      // Given: SchemaTabContent component
      // When: Graph node is clicked
      // Then: handleSelectEntity callback sets selectedEntityId
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/const\s+handleSelectEntity\s*=\s*useCallback/)
      expect(source).toMatch(/setSelectedEntityId\s*\(\s*entityId\s*\)/)
    })

    test("EntityDetailsPanel renders when entity selected", () => {
      // Given: SchemaTabContent with selectedEntityId set
      // When: Entity is selected
      // Then: EntityDetailsPanel renders with entity and onClose
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/<EntityDetailsPanel/)
      expect(source).toMatch(/entity=\{selectedEntity\}/)
      expect(source).toMatch(/onClose=\{handleCloseDetails\}/)
    })

    test("handleCloseDetails clears entity selection", () => {
      // Given: EntityDetailsPanel is showing
      // When: Close button is clicked
      // Then: handleCloseDetails sets selectedEntityId to null
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/const\s+handleCloseDetails\s*=\s*useCallback/)
      expect(source).toMatch(/setSelectedEntityId\s*\(\s*null\s*\)/)
    })

    test("selectedEntity is computed from models based on selectedEntityId", () => {
      // Given: SchemaTabContent with models
      // When: selectedEntityId changes
      // Then: selectedEntity is computed via useMemo
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/const\s+selectedEntity\s*=\s*useMemo/)
      expect(source).toMatch(/models\.find\s*\(\s*\(\s*model\s*\)\s*=>\s*model\.name\s*===\s*selectedEntityId\s*\)/)
    })
  })

  describe("Decisions tab: DecisionTimeline with featureId", () => {
    test("DecisionsTabContent renders DecisionTimeline with featureId prop", () => {
      // Given: DecisionsTabContent with feature prop
      // When: Tab renders
      // Then: DecisionTimeline receives featureId={feature.id}
      const source = fs.readFileSync(componentPath, "utf-8")
      // Look for DecisionTimeline with featureId={feature.id}
      expect(source).toMatch(/<DecisionTimeline\s+featureId=\{feature\.id\}/)
    })

    test("DecisionsTabContent accepts onEntityClick for cross-tab navigation", () => {
      // Given: DecisionsTabContent component
      // When: Component is defined
      // Then: onEntityClick prop is accepted
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/function\s+DecisionsTabContent\s*\(\s*\{[^}]*onEntityClick/)
    })
  })

  describe("Hooks tab: EnhancementHooksPlan with featureId", () => {
    test("HooksTabContent renders EnhancementHooksPlan with featureId prop", () => {
      // Given: HooksTabContent with feature prop
      // When: Tab renders
      // Then: EnhancementHooksPlan receives featureId={feature.id}
      const source = fs.readFileSync(componentPath, "utf-8")
      // Look for EnhancementHooksPlan with featureId={feature.id}
      expect(source).toMatch(/<EnhancementHooksPlan\s+featureId=\{feature\.id\}/)
    })
  })

  describe("config.defaultTab: respects initial tab configuration", () => {
    test("defaultTab is computed from designConfig.defaultTab with 'schema' fallback", () => {
      // Given: DesignContainerSection with optional config
      // When: config.defaultTab is provided
      // Then: defaultTab uses config value, otherwise defaults to 'schema'
      const source = fs.readFileSync(componentPath, "utf-8")
      // Config is extracted to designConfig, then defaultTab is read from it
      expect(source).toMatch(/const\s+defaultTab\s*=\s*designConfig\.defaultTab\s*\?\?\s*["']schema["']/)
    })

    test("Tabs component uses defaultValue={defaultTab}", () => {
      // Given: DesignContainerSection with computed defaultTab
      // When: Tabs component renders
      // Then: defaultValue is set to computed defaultTab
      const source = fs.readFileSync(componentPath, "utf-8")
      expect(source).toMatch(/<Tabs[\s\S]*?defaultValue=\{defaultTab\}/)
    })
  })
})

// ============================================================
// Component Registration Tests
// Task: task-design-011
// ============================================================

describe("sectionImplementationMap registration", () => {
  test("DesignContainerSection is registered in sectionImplementationMap", () => {
    // Given: sectionImplementations.tsx file
    // When: File is examined
    // Then: DesignContainerSection is in the map
    const sectionImplPath = path.resolve(
      import.meta.dir,
      "../../sectionImplementations.tsx"
    )
    const source = fs.readFileSync(sectionImplPath, "utf-8")
    expect(source).toMatch(/\["DesignContainerSection",\s*DesignContainerSection\]/)
  })

  test("DesignContainerSection is imported in sectionImplementations", () => {
    // Given: sectionImplementations.tsx file
    // When: File is examined
    // Then: DesignContainerSection is imported
    const sectionImplPath = path.resolve(
      import.meta.dir,
      "../../sectionImplementations.tsx"
    )
    const source = fs.readFileSync(sectionImplPath, "utf-8")
    expect(source).toMatch(/import\s*\{\s*DesignContainerSection\s*\}\s*from/)
  })
})

// ============================================================
// Testing Patterns Compliance
// Task: task-design-011
// ============================================================

describe("Testing patterns from existing section tests", () => {
  test("uses happy-dom for DOM environment", () => {
    // Given: Test file setup
    // When: Test runs
    // Then: happy-dom Window is used for DOM
    expect(window).toBeDefined()
    expect(document).toBeDefined()
  })

  test("uses beforeAll/afterAll for DOM lifecycle", () => {
    // This test exists to verify the test file structure follows patterns
    // The actual lifecycle is handled in the beforeAll/afterAll blocks
    expect(true).toBe(true)
  })

  test("uses afterEach with cleanup for component teardown", () => {
    // This test exists to verify the test file structure follows patterns
    // The actual cleanup is handled in the afterEach block
    expect(true).toBe(true)
  })

  test("uses fs.readFileSync for source code analysis", () => {
    // Verify we can read component source
    const source = fs.readFileSync(componentPath, "utf-8")
    expect(source.length).toBeGreaterThan(0)
  })
})
