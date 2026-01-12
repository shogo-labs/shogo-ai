/**
 * Seed Data for Component Builder
 * Task: task-dcb-005, task-cbe-003, task-analysis-007
 *
 * Converts current defaultRegistry.ts and studioRegistry.ts entries into
 * ComponentDefinition, Registry, and RendererBinding entities.
 *
 * This module provides:
 * - COMPONENT_DEFINITIONS: 38 ComponentDefinition entries (11 primitive, 14 domain, 4 visualization, 9 section)
 * - REGISTRY_DEFINITIONS: 2 Registry entries ('default' and 'studio')
 * - DEFAULT_BINDINGS: 13 RendererBinding entries for default registry
 * - STUDIO_BINDINGS: 18 RendererBinding entries for studio registry
 * - seedComponentBuilderData(store): Function to bootstrap all entities
 *
 * Match Expression Translation:
 * | Current Predicate | MongoDB matchExpression | Priority |
 * |-------------------|-------------------------|----------|
 * | meta.xRenderer === 'specific' | {xRenderer: 'specific-id'} | 200 |
 * | meta.xComputed === true | {xComputed: true} | 100 |
 * | meta.xReferenceType === 'single' | {xReferenceType: 'single'} | 100 |
 * | Array.isArray(meta.enum) | {enum: {$exists: true}} | 50 |
 * | meta.format === 'email' | {format: 'email'} | 30 |
 * | meta.type === 'string' | {type: 'string'} | 10 |
 */

// ============================================================================
// Types
// ============================================================================

/**
 * ComponentDefinition seed data (without timestamps)
 */
interface ComponentDefinitionSeed {
  id: string
  name: string
  category: "display" | "input" | "layout" | "visualization" | "section"
  description: string
  implementationRef: string
  tags?: string[]
}

/**
 * Registry seed data (without timestamps)
 */
interface RegistrySeed {
  id: string
  name: string
  description: string
  extends?: string
  fallbackComponent?: string
}

/**
 * RendererBinding seed data (without timestamps)
 */
interface RendererBindingSeed {
  id: string
  name: string
  registry: string
  component: string
  matchExpression: object
  priority: number
}

/**
 * Store interface for seeding (minimal interface for entity creation)
 */
interface SeedableStore {
  create: (collection: string, data: Record<string, unknown>) => unknown
}

/**
 * Summary returned by seedComponentBuilderData
 */
interface SeedSummary {
  componentDefinitions: number
  registries: number
  rendererBindings: number
  layoutTemplates: number
  compositions: number
}

// ============================================================================
// Component Definitions (29 total)
// ============================================================================

/**
 * All ComponentDefinition entities.
 *
 * Categories:
 * - display (25): Primitive and domain-specific renderers
 * - visualization (4): Data visualization components
 */
export const COMPONENT_DEFINITIONS: ComponentDefinitionSeed[] = [
  // -------------------------------------------------------------------------
  // Primitive Display Renderers (11)
  // -------------------------------------------------------------------------
  {
    id: "comp-string-display",
    name: "String Display",
    category: "display",
    description: "Renders string values with optional truncation",
    implementationRef: "StringDisplay",
    tags: ["primitive", "text", "readonly"],
  },
  {
    id: "comp-number-display",
    name: "Number Display",
    category: "display",
    description: "Renders numeric values with optional formatting",
    implementationRef: "NumberDisplay",
    tags: ["primitive", "numeric", "readonly"],
  },
  {
    id: "comp-boolean-display",
    name: "Boolean Display",
    category: "display",
    description: "Renders boolean values as visual indicators",
    implementationRef: "BooleanDisplay",
    tags: ["primitive", "boolean", "readonly"],
  },
  {
    id: "comp-datetime-display",
    name: "DateTime Display",
    category: "display",
    description: "Renders date-time values with relative formatting",
    implementationRef: "DateTimeDisplay",
    tags: ["primitive", "date", "time", "readonly"],
  },
  {
    id: "comp-email-display",
    name: "Email Display",
    category: "display",
    description: "Renders email addresses as clickable mailto links",
    implementationRef: "EmailDisplay",
    tags: ["primitive", "email", "link", "readonly"],
  },
  {
    id: "comp-uri-display",
    name: "URI Display",
    category: "display",
    description: "Renders URIs as clickable external links",
    implementationRef: "UriDisplay",
    tags: ["primitive", "uri", "link", "readonly"],
  },
  {
    id: "comp-enum-badge",
    name: "Enum Badge",
    category: "display",
    description: "Renders enum values as colored badges",
    implementationRef: "EnumBadge",
    tags: ["primitive", "enum", "badge", "readonly"],
  },
  {
    id: "comp-reference-display",
    name: "Reference Display",
    category: "display",
    description: "Renders MST reference relationships",
    implementationRef: "ReferenceDisplay",
    tags: ["primitive", "reference", "relationship", "readonly"],
  },
  {
    id: "comp-computed-display",
    name: "Computed Display",
    category: "display",
    description: "Renders computed/derived property values",
    implementationRef: "ComputedDisplay",
    tags: ["primitive", "computed", "derived", "readonly"],
  },
  {
    id: "comp-array-display",
    name: "Array Display",
    category: "display",
    description: "Renders arrays with item counts and expansion",
    implementationRef: "ArrayDisplay",
    tags: ["primitive", "array", "collection", "readonly"],
  },
  {
    id: "comp-object-display",
    name: "Object Display",
    category: "display",
    description: "Renders nested object structures",
    implementationRef: "ObjectDisplay",
    tags: ["primitive", "object", "nested", "readonly"],
  },

  // -------------------------------------------------------------------------
  // Domain-Specific Display Renderers (14)
  // -------------------------------------------------------------------------
  {
    id: "comp-priority-badge",
    name: "Priority Badge",
    category: "display",
    description: "Renders priority enum values with semantic colors",
    implementationRef: "PriorityBadge",
    tags: ["domain", "priority", "badge", "readonly"],
  },
  {
    id: "comp-archetype-badge",
    name: "Archetype Badge",
    category: "display",
    description: "Renders feature archetype values with semantic colors",
    implementationRef: "ArchetypeBadge",
    tags: ["domain", "archetype", "badge", "readonly"],
  },
  {
    id: "comp-finding-type-badge",
    name: "Finding Type Badge",
    category: "display",
    description: "Renders finding type enum values with semantic colors",
    implementationRef: "FindingTypeBadge",
    tags: ["domain", "finding", "badge", "readonly"],
  },
  {
    id: "comp-task-status-badge",
    name: "Task Status Badge",
    category: "display",
    description: "Renders task status enum values with semantic colors",
    implementationRef: "TaskStatusBadge",
    tags: ["domain", "task", "status", "badge", "readonly"],
  },
  {
    id: "comp-test-type-badge",
    name: "Test Type Badge",
    category: "display",
    description: "Renders test type enum values with semantic colors",
    implementationRef: "TestTypeBadge",
    tags: ["domain", "test", "type", "badge", "readonly"],
  },
  {
    id: "comp-session-status-badge",
    name: "Session Status Badge",
    category: "display",
    description: "Renders session status enum values with semantic colors",
    implementationRef: "SessionStatusBadge",
    tags: ["domain", "session", "status", "badge", "readonly"],
  },
  {
    id: "comp-requirement-status-badge",
    name: "Requirement Status Badge",
    category: "display",
    description: "Renders requirement status enum values with semantic colors",
    implementationRef: "RequirementStatusBadge",
    tags: ["domain", "requirement", "status", "badge", "readonly"],
  },
  {
    id: "comp-run-status-badge",
    name: "Run Status Badge",
    category: "display",
    description: "Renders test run status enum values with semantic colors",
    implementationRef: "RunStatusBadge",
    tags: ["domain", "run", "status", "badge", "readonly"],
  },
  {
    id: "comp-execution-status-badge",
    name: "Execution Status Badge",
    category: "display",
    description: "Renders execution status enum values with semantic colors",
    implementationRef: "ExecutionStatusBadge",
    tags: ["domain", "execution", "status", "badge", "readonly"],
  },
  {
    id: "comp-test-case-status-badge",
    name: "Test Case Status Badge",
    category: "display",
    description: "Renders test case status enum values with semantic colors",
    implementationRef: "TestCaseStatusBadge",
    tags: ["domain", "test-case", "status", "badge", "readonly"],
  },
  {
    id: "comp-task-renderer",
    name: "Task Renderer",
    category: "display",
    description: "Renders implementation task entities with full detail",
    implementationRef: "TaskRenderer",
    tags: ["domain", "task", "entity", "readonly"],
  },
  {
    id: "comp-code-path-display",
    name: "Code Path Display",
    category: "display",
    description: "Renders file paths with syntax highlighting and copy functionality",
    implementationRef: "CodePathDisplay",
    tags: ["domain", "code", "path", "file", "readonly"],
  },
  {
    id: "comp-change-type-badge",
    name: "Change Type Badge",
    category: "display",
    description: "Renders change type enum values (add, modify, extend) with semantic colors",
    implementationRef: "ChangeTypeBadge",
    tags: ["domain", "change-type", "badge", "readonly"],
  },
  {
    id: "comp-phase-status-renderer",
    name: "Phase Status Renderer",
    category: "display",
    description: "Renders session status as interactive phase indicator with navigation",
    implementationRef: "PhaseStatusRenderer",
    tags: ["domain", "session", "status", "phase", "interactive"],
  },

  // -------------------------------------------------------------------------
  // Visualization Components (4)
  // -------------------------------------------------------------------------
  {
    id: "comp-progress-bar",
    name: "Progress Bar",
    category: "visualization",
    description: "Renders progress with segmented color-coded bars",
    implementationRef: "ProgressBar",
    tags: ["visualization", "progress", "bar", "readonly"],
  },
  {
    id: "comp-data-card",
    name: "Data Card",
    category: "visualization",
    description: "Renders data in a styled card format with variants",
    implementationRef: "DataCard",
    tags: ["visualization", "card", "container", "readonly"],
  },
  {
    id: "comp-graph-node",
    name: "Graph Node",
    category: "visualization",
    description: "Renders nodes for graph/network visualizations",
    implementationRef: "GraphNode",
    tags: ["visualization", "graph", "node", "readonly"],
  },
  {
    id: "comp-status-indicator",
    name: "Status Indicator",
    category: "visualization",
    description: "Renders multi-stage status indicators with layout options",
    implementationRef: "StatusIndicator",
    tags: ["visualization", "status", "indicator", "readonly"],
  },

  // -------------------------------------------------------------------------
  // Section Components (5) - Composable Phase Views
  // -------------------------------------------------------------------------
  {
    id: "comp-def-intent-terminal-section",
    name: "Intent Terminal Section",
    category: "section",
    description: "Displays session intent in a terminal-style format for discovery phase",
    implementationRef: "IntentTerminalSection",
    tags: ["section", "phase", "discovery", "intent"],
  },
  {
    id: "comp-def-initial-assessment-section",
    name: "Initial Assessment Section",
    category: "section",
    description: "Displays initial assessment details including archetype and indicators",
    implementationRef: "InitialAssessmentSection",
    tags: ["section", "phase", "discovery", "assessment"],
  },
  {
    id: "comp-def-requirements-list-section",
    name: "Requirements List Section",
    category: "section",
    description: "Lists requirements with status badges and priority indicators",
    implementationRef: "RequirementsListSection",
    tags: ["section", "phase", "discovery", "requirements"],
  },
  {
    id: "comp-def-session-summary-section",
    name: "Session Summary Section",
    category: "section",
    description: "Displays session summary with key metrics and status",
    implementationRef: "SessionSummarySection",
    tags: ["section", "phase", "summary"],
  },
  {
    id: "comp-def-phase-actions-section",
    name: "Phase Actions Section",
    category: "section",
    description: "Provides phase-specific action buttons and navigation",
    implementationRef: "PhaseActionsSection",
    tags: ["section", "phase", "actions", "navigation"],
  },

  // -------------------------------------------------------------------------
  // Analysis Phase Section Components (4) - task-analysis-007
  // -------------------------------------------------------------------------
  {
    id: "comp-def-evidence-board-header-section",
    name: "EvidenceBoardHeaderSection",
    category: "section",
    description: "Header for Analysis Evidence Board with finding count and view mode toggle",
    implementationRef: "EvidenceBoardHeaderSection",
    tags: ["section", "analysis-phase", "evidence-board"],
  },
  {
    id: "comp-def-location-heat-bar-section",
    name: "LocationHeatBarSection",
    category: "section",
    description: "Stacked progress bar showing finding distribution by package location",
    implementationRef: "LocationHeatBarSection",
    tags: ["section", "analysis-phase", "evidence-board", "visualization"],
  },
  {
    id: "comp-def-finding-matrix-section",
    name: "FindingMatrixSection",
    category: "section",
    description: "Type x Location grid matrix with clickable cells for filtering findings",
    implementationRef: "FindingMatrixSection",
    tags: ["section", "analysis-phase", "evidence-board", "matrix"],
  },
  {
    id: "comp-def-finding-list-section",
    name: "FindingListSection",
    category: "section",
    description: "Filtered/grouped finding cards with filter indicator and expand/collapse",
    implementationRef: "FindingListSection",
    tags: ["section", "analysis-phase", "evidence-board", "list"],
  },
]

// ============================================================================
// Registry Definitions (2 total)
// ============================================================================

/**
 * Registry entities defining the inheritance hierarchy.
 *
 * Structure:
 * - default: Base registry with fallback to StringDisplay
 * - studio: Extends default with domain-specific renderers
 */
export const REGISTRY_DEFINITIONS: RegistrySeed[] = [
  {
    id: "default",
    name: "default",
    description:
      "Base component registry with primitive display renderers. Provides type-based, format-based, and metadata-based component resolution.",
    fallbackComponent: "comp-string-display",
  },
  {
    id: "studio",
    name: "studio",
    description:
      "Extended registry for Studio App with domain-specific renderers. Inherits all default bindings and adds explicit x-renderer mappings for platform-features schema fields.",
    extends: "default",
  },
]

// ============================================================================
// Default Registry Bindings (13 total)
// ============================================================================

/**
 * Helper to build component ID from implementationRef
 */
function componentId(implementationRef: string): string {
  const component = COMPONENT_DEFINITIONS.find(
    (c) => c.implementationRef === implementationRef
  )
  if (!component) {
    throw new Error(`Component not found: ${implementationRef}`)
  }
  return component.id
}

/**
 * RendererBinding entities for the default registry.
 *
 * Priority cascade:
 * - 100: xComputed, xReferenceType (metadata-based)
 * - 50: enum (schema-based)
 * - 30: format (schema-based)
 * - 10: type (schema-based fallback)
 */
export const DEFAULT_BINDINGS: RendererBindingSeed[] = [
  // Priority 100 - Metadata-based bindings
  {
    id: "computed-display",
    name: "Computed Display Binding",
    registry: "default",
    component: componentId("ComputedDisplay"),
    matchExpression: { xComputed: true },
    priority: 100,
  },
  {
    id: "reference-display",
    name: "Reference Display Binding",
    registry: "default",
    component: componentId("ReferenceDisplay"),
    matchExpression: { xReferenceType: "single" },
    priority: 100,
  },
  {
    id: "reference-array-display",
    name: "Reference Array Display Binding",
    registry: "default",
    component: componentId("ArrayDisplay"),
    matchExpression: { xReferenceType: "array" },
    priority: 100,
  },

  // Priority 50 - Enum-based bindings
  {
    id: "enum-badge",
    name: "Enum Badge Binding",
    registry: "default",
    component: componentId("EnumBadge"),
    matchExpression: { enum: { $exists: true } },
    priority: 50,
  },

  // Priority 30 - Format-based bindings
  {
    id: "datetime-display",
    name: "DateTime Display Binding",
    registry: "default",
    component: componentId("DateTimeDisplay"),
    matchExpression: { format: "date-time" },
    priority: 30,
  },
  {
    id: "email-display",
    name: "Email Display Binding",
    registry: "default",
    component: componentId("EmailDisplay"),
    matchExpression: { format: "email" },
    priority: 30,
  },
  {
    id: "uri-display",
    name: "URI Display Binding",
    registry: "default",
    component: componentId("UriDisplay"),
    matchExpression: { format: "uri" },
    priority: 30,
  },

  // Priority 10 - Type-based bindings
  {
    id: "number-display",
    name: "Number Display Binding",
    registry: "default",
    component: componentId("NumberDisplay"),
    matchExpression: { type: "number" },
    priority: 10,
  },
  {
    id: "boolean-display",
    name: "Boolean Display Binding",
    registry: "default",
    component: componentId("BooleanDisplay"),
    matchExpression: { type: "boolean" },
    priority: 10,
  },
  {
    id: "array-display",
    name: "Array Display Binding",
    registry: "default",
    component: componentId("ArrayDisplay"),
    matchExpression: { type: "array" },
    priority: 10,
  },
  {
    id: "object-display",
    name: "Object Display Binding",
    registry: "default",
    component: componentId("ObjectDisplay"),
    matchExpression: { type: "object" },
    priority: 10,
  },
  {
    id: "string-display",
    name: "String Display Binding",
    registry: "default",
    component: componentId("StringDisplay"),
    matchExpression: { type: "string" },
    priority: 10,
  },
]

// ============================================================================
// Studio Registry Bindings (18 total)
// ============================================================================

/**
 * RendererBinding entities for the studio registry.
 *
 * All bindings at priority 200 using explicit x-renderer matching.
 * These override the generic EnumBadge (50) for domain-specific fields.
 */
export const STUDIO_BINDINGS: RendererBindingSeed[] = [
  // Domain badge bindings (11)
  {
    id: "priority-badge",
    name: "Priority Badge Binding",
    registry: "studio",
    component: componentId("PriorityBadge"),
    matchExpression: { xRenderer: "priority-badge" },
    priority: 200,
  },
  {
    id: "archetype-badge",
    name: "Archetype Badge Binding",
    registry: "studio",
    component: componentId("ArchetypeBadge"),
    matchExpression: { xRenderer: "archetype-badge" },
    priority: 200,
  },
  {
    id: "finding-type-badge",
    name: "Finding Type Badge Binding",
    registry: "studio",
    component: componentId("FindingTypeBadge"),
    matchExpression: { xRenderer: "finding-type-badge" },
    priority: 200,
  },
  {
    id: "task-status-badge",
    name: "Task Status Badge Binding",
    registry: "studio",
    component: componentId("TaskStatusBadge"),
    matchExpression: { xRenderer: "task-status-badge" },
    priority: 200,
  },
  {
    id: "test-type-badge",
    name: "Test Type Badge Binding",
    registry: "studio",
    component: componentId("TestTypeBadge"),
    matchExpression: { xRenderer: "test-type-badge" },
    priority: 200,
  },
  {
    id: "session-status-badge",
    name: "Session Status Badge Binding",
    registry: "studio",
    component: componentId("SessionStatusBadge"),
    matchExpression: { xRenderer: "session-status-badge" },
    priority: 200,
  },
  {
    id: "requirement-status-badge",
    name: "Requirement Status Badge Binding",
    registry: "studio",
    component: componentId("RequirementStatusBadge"),
    matchExpression: { xRenderer: "requirement-status-badge" },
    priority: 200,
  },
  {
    id: "run-status-badge",
    name: "Run Status Badge Binding",
    registry: "studio",
    component: componentId("RunStatusBadge"),
    matchExpression: { xRenderer: "run-status-badge" },
    priority: 200,
  },
  {
    id: "execution-status-badge",
    name: "Execution Status Badge Binding",
    registry: "studio",
    component: componentId("ExecutionStatusBadge"),
    matchExpression: { xRenderer: "execution-status-badge" },
    priority: 200,
  },
  {
    id: "test-case-status-badge",
    name: "Test Case Status Badge Binding",
    registry: "studio",
    component: componentId("TestCaseStatusBadge"),
    matchExpression: { xRenderer: "test-case-status-badge" },
    priority: 200,
  },
  {
    id: "implementation-task",
    name: "Implementation Task Binding",
    registry: "studio",
    component: componentId("TaskRenderer"),
    matchExpression: { xRenderer: "implementation-task" },
    priority: 200,
  },

  // Visualization bindings (4)
  {
    id: "progress-bar",
    name: "Progress Bar Binding",
    registry: "studio",
    component: componentId("ProgressBar"),
    matchExpression: { xRenderer: "progress-bar" },
    priority: 200,
  },
  {
    id: "data-card",
    name: "Data Card Binding",
    registry: "studio",
    component: componentId("DataCard"),
    matchExpression: { xRenderer: "data-card" },
    priority: 200,
  },
  {
    id: "graph-node",
    name: "Graph Node Binding",
    registry: "studio",
    component: componentId("GraphNode"),
    matchExpression: { xRenderer: "graph-node" },
    priority: 200,
  },
  {
    id: "status-indicator",
    name: "Status Indicator Binding",
    registry: "studio",
    component: componentId("StatusIndicator"),
    matchExpression: { xRenderer: "status-indicator" },
    priority: 200,
  },
  // New bindings for task-cbe-003
  {
    id: "code-path-display",
    name: "Code Path Display Binding",
    registry: "studio",
    component: componentId("CodePathDisplay"),
    matchExpression: { xRenderer: "code-path-display" },
    priority: 200,
  },
  {
    id: "change-type-badge",
    name: "Change Type Badge Binding",
    registry: "studio",
    component: componentId("ChangeTypeBadge"),
    matchExpression: { xRenderer: "change-type-badge" },
    priority: 200,
  },
  {
    id: "phase-status-renderer",
    name: "Phase Status Renderer Binding",
    registry: "studio",
    component: componentId("PhaseStatusRenderer"),
    matchExpression: { xRenderer: "phase-status-renderer" },
    priority: 200,
  },
]

// ============================================================================
// Layout Templates - Composable Phase Views
// ============================================================================

/**
 * Slot definition type for LayoutTemplate
 */
interface SlotDefinitionSeed {
  name: string
  position: string
  required?: boolean
}

/**
 * LayoutTemplate seed data (without timestamps)
 */
interface LayoutTemplateSeed {
  id: string
  name: string
  description?: string
  slots: SlotDefinitionSeed[]
}

/**
 * Layout templates for composable phase views.
 */
export const LAYOUT_TEMPLATES: LayoutTemplateSeed[] = [
  {
    id: "layout-phase-two-column",
    name: "Phase Two Column",
    description: "Two-column layout with header, main content, sidebar, and actions footer",
    slots: [
      { name: "header", position: "top", required: true },
      { name: "main", position: "left", required: true },
      { name: "sidebar", position: "right", required: false },
      { name: "actions", position: "bottom", required: false },
    ],
  },
]

// ============================================================================
// Compositions - Composable Phase Views
// ============================================================================

/**
 * Slot content entry type for Composition
 */
interface SlotContentEntrySeed {
  slot: string
  component: string
  config?: Record<string, unknown>
}

/**
 * Composition seed data (without timestamps)
 */
interface CompositionSeed {
  id: string
  name: string
  description?: string
  layout: string
  slotContent: SlotContentEntrySeed[]
  dataContext?: Record<string, unknown>
  providerWrapper?: string
}

/**
 * Compositions for phase views.
 */
export const COMPOSITIONS: CompositionSeed[] = [
  {
    id: "composition-discovery",
    name: "discovery",
    description: "Discovery phase view composition",
    layout: "layout-phase-two-column",
    slotContent: [
      { slot: "header", component: "comp-def-intent-terminal-section" },
      { slot: "main", component: "comp-def-requirements-list-section" },
      { slot: "sidebar", component: "comp-def-initial-assessment-section" },
      { slot: "actions", component: "comp-def-phase-actions-section" },
    ],
    dataContext: { phase: "discovery" },
  },
  // Analysis phase composition - task-analysis-008
  {
    id: "composition-analysis",
    name: "analysis",
    description: "Analysis phase view composition",
    layout: "layout-phase-two-column",
    slotContent: [
      // Header slot: Evidence Board header with view toggle
      { slot: "header", component: "comp-def-evidence-board-header-section" },
      // Main slot: Location heat bar + Finding matrix (stacked via prephase-002)
      { slot: "main", component: "comp-def-location-heat-bar-section" },
      { slot: "main", component: "comp-def-finding-matrix-section" },
      // Sidebar slot: Finding list (filtered/grouped)
      { slot: "sidebar", component: "comp-def-finding-list-section" },
      // Actions slot: Phase actions
      { slot: "actions", component: "comp-def-phase-actions-section" },
    ],
    dataContext: { phase: "analysis" },
    providerWrapper: "AnalysisPanelProvider",
  },
  // Classification phase composition - no provider needed (pure slot composition)
  {
    id: "composition-classification",
    name: "classification",
    description: "Classification phase view composition",
    layout: "layout-phase-two-column",
    slotContent: [
      // Header slot: Archetype transformation visualization
      { slot: "header", component: "comp-def-archetype-transformation-section" },
      // Main slot: 5 sections stacked via slot stacking (prephase-002)
      { slot: "main", component: "comp-def-correction-note-section" },
      { slot: "main", component: "comp-def-confidence-meters-section" },
      { slot: "main", component: "comp-def-evidence-columns-section" },
      { slot: "main", component: "comp-def-applicable-patterns-section" },
      { slot: "main", component: "comp-def-classification-rationale-section" },
    ],
    dataContext: { phase: "classification" },
  },
  // Design phase composition - container section pattern (single slot)
  // Config options enable MCP-driven UI customization
  {
    id: "composition-design",
    name: "design",
    description: "Design phase view composition with container section",
    layout: "layout-single-column",
    slotContent: [
      {
        slot: "main",
        component: "comp-design-container",
        config: {
          defaultTab: "schema",
          expandGraph: true, // Graph expands to fill available space
          showStatistics: true,
          showLegend: true,
          graphMinHeight: 400,
        },
      },
    ],
    dataContext: { phase: "design" },
  },
]

// ============================================================================
// Seed Function
// ============================================================================

/**
 * Seeds the component builder store with all required entities.
 *
 * Creates:
 * - 38 ComponentDefinition entities (11 primitive, 14 domain, 4 visualization, 9 section)
 * - 2 Registry entities ('default' and 'studio')
 * - 30 RendererBinding entities (12 default, 18 studio)
 * - 1 LayoutTemplate entity
 * - 4 Composition entities (discovery, analysis, classification, design)
 *
 * @param store - A store with a create(collection, data) method
 * @returns Summary of created entities
 *
 * @example
 * ```typescript
 * const store = createComponentBuilderStore()
 * const summary = seedComponentBuilderData(store)
 * console.log(summary)
 * // { componentDefinitions: 34, registries: 2, rendererBindings: 31, layoutTemplates: 1, compositions: 1 }
 * ```
 */
export function seedComponentBuilderData(store: SeedableStore): SeedSummary {
  const now = Date.now()

  // Create ComponentDefinition entities
  for (const def of COMPONENT_DEFINITIONS) {
    store.create("ComponentDefinition", {
      ...def,
      createdAt: now,
    })
  }

  // Create Registry entities
  for (const reg of REGISTRY_DEFINITIONS) {
    store.create("Registry", {
      ...reg,
      createdAt: now,
    })
  }

  // Create default RendererBinding entities
  for (const binding of DEFAULT_BINDINGS) {
    store.create("RendererBinding", {
      ...binding,
      createdAt: now,
    })
  }

  // Create studio RendererBinding entities
  for (const binding of STUDIO_BINDINGS) {
    store.create("RendererBinding", {
      ...binding,
      createdAt: now,
    })
  }

  // Create LayoutTemplate entities
  for (const layout of LAYOUT_TEMPLATES) {
    store.create("LayoutTemplate", {
      ...layout,
      createdAt: now,
    })
  }

  // Create Composition entities
  for (const comp of COMPOSITIONS) {
    store.create("Composition", {
      ...comp,
      createdAt: now,
    })
  }

  return {
    componentDefinitions: COMPONENT_DEFINITIONS.length,
    registries: REGISTRY_DEFINITIONS.length,
    rendererBindings: DEFAULT_BINDINGS.length + STUDIO_BINDINGS.length,
    layoutTemplates: LAYOUT_TEMPLATES.length,
    compositions: COMPOSITIONS.length,
  }
}
