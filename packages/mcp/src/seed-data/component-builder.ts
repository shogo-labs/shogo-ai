/**
 * Component Builder Seed Data
 *
 * Seed data constants for the component-builder domain, structured for
 * insertOne() operations via Wavesmith MCP tools.
 *
 * Exports:
 * - COMPONENT_DEFINITIONS: 67 entries (display, visualization, section components)
 * - REGISTRIES: 2 entries (default, studio)
 * - RENDERER_BINDINGS: 32 entries (12 default + 20 studio)
 * - LAYOUT_TEMPLATES: 7 entries (layout-phase-two-column, layout-single-column, layout-two-column-compact, layout-workspace-flexible, layout-workspace-split-h, layout-workspace-split-v, layout-discovery-enhanced)
 * - COMPOSITIONS: 9 entries (discovery-basic, discovery, analysis, classification, design, spec, testing, implementation, workspace)
 *
 * All entities have proper id fields for idempotency checks.
 * TypeScript types match component-builder schema entity types.
 *
 * Tasks: task-sdr-v2-001, smart-component-expansion; task-cbe-003; task-cpv-003; task-cpv-004;
 *        task-analysis-007, task-analysis-008, task-prephase-005, task-design-009, task-design-010,
 *        task-testing-007, task-testing-008, task-spec-009, task-spec-010,
 *        task-implementation-007, task-implementation-008, virtual-tools-domain
 */

// =============================================================================
// TypeScript Types (matching component-builder schema)
// =============================================================================

/**
 * Seed data for ComponentDefinition entity.
 * Matches component-builder schema $defs.ComponentDefinition
 */
export interface ComponentDefinitionSeed {
  /** Unique identifier (x-mst-type: identifier) */
  id: string
  /** Human-readable component name */
  name: string
  /** Component category for organization */
  category: "display" | "input" | "layout" | "visualization" | "section"
  /** Documentation for the component's purpose */
  description: string
  /** Key mapping to code-side component registry */
  implementationRef: string
  /** Tags for categorization and search */
  tags?: string[]
  /** Config keys this component supports (e.g., ['variant', 'size', 'truncate']) */
  supportedConfig?: string[]
}

/**
 * Seed data for Registry entity.
 * Matches component-builder schema $defs.Registry
 */
export interface RegistrySeed {
  /** Unique identifier (x-mst-type: identifier) */
  id: string
  /** Registry name */
  name: string
  /** Documentation for the registry's purpose */
  description: string
  /** Parent registry for inheritance (x-mst-type: maybe-reference) */
  extends?: string
  /** Component used when no bindings match (x-mst-type: maybe-reference) */
  fallbackComponent?: string
}

/**
 * XRendererConfig for defaultConfig on bindings.
 * Matches state-api XRendererConfig interface.
 */
export interface XRendererConfigSeed {
  variant?: "default" | "muted" | "emphasized" | "warning" | "success" | "error"
  size?: "xs" | "sm" | "md" | "lg" | "xl"
  layout?: "inline" | "block" | "compact"
  truncate?: boolean | number
  expandable?: boolean
  clickable?: boolean
  customProps?: Record<string, unknown>
}

/**
 * Seed data for RendererBinding entity.
 * Matches component-builder schema $defs.RendererBinding
 */
export interface RendererBindingSeed {
  /** Unique identifier (x-mst-type: identifier) */
  id: string
  /** Descriptive binding name */
  name: string
  /** Registry this binding belongs to (x-mst-type: reference) */
  registry: string
  /** Component to render when matched (x-mst-type: reference) */
  component: string
  /** MongoDB-style query against PropertyMetadata */
  matchExpression: Record<string, unknown>
  /** Resolution priority (higher wins) */
  priority: number
  /** Default XRendererConfig applied when this binding matches */
  defaultConfig?: XRendererConfigSeed
}

/**
 * Slot definition for LayoutTemplate.
 * Matches component-builder schema $defs.LayoutTemplate.slots.items
 */
export interface SlotSeed {
  /** Slot identifier (e.g., 'header', 'main', 'sidebar') */
  name: string
  /** Layout position hint (e.g., 'top', 'left', 'right', 'bottom', 'center') */
  position: string
  /** Whether this slot must have content assigned */
  required?: boolean
}

/**
 * Seed data for LayoutTemplate entity.
 * Matches component-builder schema $defs.LayoutTemplate
 */
export interface LayoutTemplateSeed {
  /** Unique identifier (x-mst-type: identifier) */
  id: string
  /** Layout name (e.g., 'two-column', 'dashboard-grid', 'detail-panel') */
  name: string
  /** Documentation for the layout's structure and intended use */
  description?: string
  /** Slot definitions specifying available placement areas */
  slots: SlotSeed[]
  /** Default slot-to-component mappings as {slotName: componentId} */
  defaultBindings?: Record<string, string>
}

/**
 * Slot content definition for Composition.
 * Matches component-builder schema $defs.Composition.slotContent.items
 */
export interface SlotContentSeed {
  /** Slot name this content fills (must match a slot in the layout) */
  slot: string
  /** ComponentDefinition id to render in this slot (x-mst-type: reference) */
  component: string
  /** Optional configuration passed to the component */
  config?: Record<string, unknown>
}

/**
 * Seed data for Composition entity.
 * Matches component-builder schema $defs.Composition
 */
export interface CompositionSeed {
  /** Unique identifier (x-mst-type: identifier) */
  id: string
  /** Composition name (e.g., 'Feature Session Detail View', 'User Dashboard') */
  name: string
  /** The LayoutTemplate id this composition uses (x-mst-type: reference) */
  layout: string
  /** Content placed in each slot */
  slotContent: SlotContentSeed[]
  /** Shared data source definitions available to all slot components */
  dataContext?: Record<string, unknown>
  /** Optional provider wrapper component key to wrap the slot layout */
  providerWrapper?: string
  /** Optional configuration passed to the provider wrapper component */
  providerConfig?: Record<string, unknown>
}

// =============================================================================
// Component Definitions (40 total)
// =============================================================================

/**
 * All ComponentDefinition seed entities.
 *
 * Categories breakdown:
 * - Primitive Display (14): String, Number, Boolean, DateTime, Email, URI, Enum, Reference, Computed, Array, Object, StringArray, CodePath, LongText
 * - Domain-Specific Display (13): Priority, Archetype, FindingType, TaskStatus, TestType, SessionStatus, RequirementStatus, RunStatus, ExecutionStatus, TestCaseStatus, TaskRenderer, ChangeTypeBadge, PhaseStatusRenderer
 * - Visualization (4): ProgressBar, DataCard, GraphNode, StatusIndicator
 * - Section - Discovery (5): IntentTerminalSection, InitialAssessmentSection, RequirementsListSection, SessionSummarySection, PhaseActionsSection
 * - Section - Analysis (4): EvidenceBoardHeaderSection, LocationHeatBarSection, FindingMatrixSection, FindingListSection
 */
export const COMPONENT_DEFINITIONS: ComponentDefinitionSeed[] = [
  // ---------------------------------------------------------------------------
  // Primitive Display Renderers (11)
  // ---------------------------------------------------------------------------
  {
    id: "comp-string-display",
    name: "String Display",
    category: "display",
    description: "Renders string values with optional truncation",
    implementationRef: "StringDisplay",
    tags: ["primitive", "text", "readonly"],
    supportedConfig: ["size", "variant", "truncate", "layout"],
  },
  {
    id: "comp-number-display",
    name: "Number Display",
    category: "display",
    description: "Renders numeric values with optional formatting",
    implementationRef: "NumberDisplay",
    tags: ["primitive", "numeric", "readonly"],
    supportedConfig: ["size", "variant"],
  },
  {
    id: "comp-boolean-display",
    name: "Boolean Display",
    category: "display",
    description: "Renders boolean values as visual indicators",
    implementationRef: "BooleanDisplay",
    tags: ["primitive", "boolean", "readonly"],
    supportedConfig: ["size", "variant"],
  },
  {
    id: "comp-datetime-display",
    name: "DateTime Display",
    category: "display",
    description: "Renders date-time values with relative formatting",
    implementationRef: "DateTimeDisplay",
    tags: ["primitive", "date", "time", "readonly"],
    supportedConfig: ["size", "variant"],
  },
  {
    id: "comp-email-display",
    name: "Email Display",
    category: "display",
    description: "Renders email addresses as clickable mailto links",
    implementationRef: "EmailDisplay",
    tags: ["primitive", "email", "link", "readonly"],
    supportedConfig: ["size", "variant", "clickable"],
  },
  {
    id: "comp-uri-display",
    name: "URI Display",
    category: "display",
    description: "Renders URIs as clickable external links",
    implementationRef: "UriDisplay",
    tags: ["primitive", "uri", "link", "readonly"],
    supportedConfig: ["size", "variant", "truncate", "clickable"],
  },
  {
    id: "comp-enum-badge",
    name: "Enum Badge",
    category: "display",
    description: "Renders enum values as colored badges",
    implementationRef: "EnumBadge",
    tags: ["primitive", "enum", "badge", "readonly"],
    supportedConfig: ["size", "variant"],
  },
  {
    id: "comp-reference-display",
    name: "Reference Display",
    category: "display",
    description: "Renders MST reference relationships",
    implementationRef: "ReferenceDisplay",
    tags: ["primitive", "reference", "relationship", "readonly"],
    supportedConfig: ["size", "variant", "clickable"],
  },
  {
    id: "comp-computed-display",
    name: "Computed Display",
    category: "display",
    description: "Renders computed/derived property values",
    implementationRef: "ComputedDisplay",
    tags: ["primitive", "computed", "derived", "readonly"],
    supportedConfig: ["size", "variant", "layout"],
  },
  {
    id: "comp-array-display",
    name: "Array Display",
    category: "display",
    description: "Renders arrays with item counts and expansion",
    implementationRef: "ArrayDisplay",
    tags: ["primitive", "array", "collection", "readonly"],
    supportedConfig: ["size", "variant", "expandable", "layout"],
  },
  {
    id: "comp-object-display",
    name: "Object Display",
    category: "display",
    description: "Renders nested object structures",
    implementationRef: "ObjectDisplay",
    tags: ["primitive", "object", "nested", "readonly"],
    supportedConfig: ["size", "variant", "expandable", "layout"],
  },
  {
    id: "comp-string-array-display",
    name: "String Array Display",
    category: "display",
    description: "Renders string arrays as styled lists (bulleted, numbered, or inline)",
    implementationRef: "StringArrayDisplay",
    tags: ["primitive", "array", "list", "readonly"],
    supportedConfig: ["size", "variant", "layout", "expandable"],
  },
  {
    id: "comp-code-path-display",
    name: "Code Path Display",
    category: "display",
    description: "Renders file paths with monospace font and optional truncation",
    implementationRef: "CodePathDisplay",
    tags: ["domain", "code", "path", "readonly"],
    supportedConfig: ["size", "truncate", "clickable"],
  },
  {
    id: "comp-long-text-display",
    name: "Long Text Display",
    category: "display",
    description: "Renders long text with line clamping and expand/collapse",
    implementationRef: "LongTextDisplay",
    tags: ["primitive", "text", "readonly"],
    supportedConfig: ["size", "variant", "truncate", "expandable"],
  },

  // ---------------------------------------------------------------------------
  // Domain-Specific Display Renderers (11)
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Visualization Components (4)
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Section Components for Composable Phase Views (5) - task-cpv-003
  // ---------------------------------------------------------------------------
  {
    id: "comp-def-intent-terminal-section",
    name: "IntentTerminalSection",
    category: "section",
    description: "Renders session intent in terminal-style display",
    implementationRef: "IntentTerminalSection",
    tags: ["section", "discovery-phase"],
  },
  {
    id: "comp-def-initial-assessment-section",
    name: "InitialAssessmentSection",
    category: "section",
    description: "Renders initial assessment with archetype and priority badges",
    implementationRef: "InitialAssessmentSection",
    tags: ["section", "discovery-phase"],
  },
  {
    id: "comp-def-requirements-list-section",
    name: "RequirementsListSection",
    category: "section",
    description: "Renders requirements as an interactive checklist",
    implementationRef: "RequirementsListSection",
    tags: ["section", "discovery-phase"],
  },
  {
    id: "comp-def-session-summary-section",
    name: "SessionSummarySection",
    category: "section",
    description: "Renders session metadata summary with key information",
    implementationRef: "SessionSummarySection",
    tags: ["section", "discovery-phase"],
  },
  {
    id: "comp-def-phase-actions-section",
    name: "PhaseActionsSection",
    category: "section",
    description: "Renders phase-specific action buttons for navigation and transitions",
    implementationRef: "PhaseActionsSection",
    tags: ["section", "discovery-phase"],
  },

  // ---------------------------------------------------------------------------
  // Analysis Phase Section Components (4) - task-analysis-007
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Classification Phase Section Components (6) - task-classification-008
  // ---------------------------------------------------------------------------
  {
    id: "comp-def-archetype-transformation-section",
    name: "ArchetypeTransformationSection",
    category: "section",
    description:
      "Phase header with initial->validated archetype transformation visual and animated arrow. Shows 'Archetype Determination' title with pink theme.",
    implementationRef: "ArchetypeTransformationSection",
    tags: ["section", "classification-phase", "header"],
  },
  {
    id: "comp-def-correction-note-section",
    name: "CorrectionNoteSection",
    category: "section",
    description:
      "Conditional correction notice when archetype was changed during classification. Amber-styled with AlertTriangle icon.",
    implementationRef: "CorrectionNoteSection",
    tags: ["section", "classification-phase", "conditional"],
  },
  {
    id: "comp-def-confidence-meters-section",
    name: "ConfidenceMetersSection",
    category: "section",
    description:
      "Archetype confidence percentages using ProgressBar visualization. Shows all 4 archetypes with validated one highlighted.",
    implementationRef: "ConfidenceMetersSection",
    tags: ["section", "classification-phase", "visualization"],
  },
  {
    id: "comp-def-evidence-columns-section",
    name: "EvidenceColumnsSection",
    category: "section",
    description:
      "Dual columns for supporting (Check icons) and opposing (X icons) evidence analysis from evidenceChecklist.",
    implementationRef: "EvidenceColumnsSection",
    tags: ["section", "classification-phase", "evidence"],
  },
  {
    id: "comp-def-applicable-patterns-section",
    name: "ApplicablePatternsSection",
    category: "section",
    description:
      "Displays applicable patterns as chips using PatternChips shared component. Conditional - returns null when no patterns.",
    implementationRef: "ApplicablePatternsSection",
    tags: ["section", "classification-phase", "conditional"],
  },
  {
    id: "comp-def-classification-rationale-section",
    name: "ClassificationRationaleSection",
    category: "section",
    description:
      "Classification rationale text in a styled card with pink theme border. Shows decision.rationale with whitespace-pre-wrap.",
    implementationRef: "ClassificationRationaleSection",
    tags: ["section", "classification-phase", "rationale"],
  },

  // ---------------------------------------------------------------------------
  // Design Phase Section Components (1) - task-design-009
  // ---------------------------------------------------------------------------
  {
    id: "comp-design-container",
    name: "DesignContainerSection",
    category: "section",
    description:
      "Container section for Design phase with internal tab navigation. Manages Schema, Graph, and Tasks tabs with their own state. Uses single-column layout pattern where the container handles all internal layout structure.",
    implementationRef: "DesignContainerSection",
    tags: ["section", "design-phase", "container", "tabbed"],
  },

  // ---------------------------------------------------------------------------
  // Spec Phase Section Components (1) - task-spec-009
  // ---------------------------------------------------------------------------
  {
    id: "comp-spec-container",
    name: "SpecContainerSection",
    category: "section",
    description:
      "Container section for Spec phase with ReactFlow dependency graph and internal task selection state. Displays implementation tasks as nodes with dependency edges. Manages selected task state internally for detail panel display. Uses single-column layout pattern where the container handles all internal layout structure.",
    implementationRef: "SpecContainerSection",
    tags: ["section", "spec-phase", "container", "graph"],
  },

  // ---------------------------------------------------------------------------
  // Testing Phase Section Components (4) - task-testing-007
  // ---------------------------------------------------------------------------
  {
    id: "comp-def-test-pyramid-section",
    name: "TestPyramidSection",
    category: "section",
    description:
      "Visual pyramid showing test distribution across unit, integration, and e2e layers. Data sourced from TestSpecifications grouped by testType.",
    implementationRef: "TestPyramidSection",
    tags: ["section", "testing-phase"],
  },
  {
    id: "comp-def-test-type-distribution-section",
    name: "TestTypeDistributionSection",
    category: "section",
    description:
      "Horizontal bar chart showing test count distribution by type (unit, integration, e2e). Data sourced from TestSpecifications aggregate counts.",
    implementationRef: "TestTypeDistributionSection",
    tags: ["section", "testing-phase"],
  },
  {
    id: "comp-def-task-coverage-bar-section",
    name: "TaskCoverageBarSection",
    category: "section",
    description:
      "Stacked progress bar showing test coverage per implementation task. Data sourced from ImplementationTasks with linked TestSpecifications.",
    implementationRef: "TaskCoverageBarSection",
    tags: ["section", "testing-phase"],
  },
  {
    id: "comp-def-scenario-spotlight-section",
    name: "ScenarioSpotlightSection",
    category: "section",
    description:
      "Featured test scenario card showing Given/When/Then details for selected test. Data sourced from individual TestSpecification entity.",
    implementationRef: "ScenarioSpotlightSection",
    tags: ["section", "testing-phase"],
  },

  // ---------------------------------------------------------------------------
  // Implementation Phase Section Components (4) - task-implementation-007
  // ---------------------------------------------------------------------------
  {
    id: "comp-def-tdd-stage-indicator-section",
    name: "TDDStageIndicatorSection",
    category: "section",
    description:
      "Visual badge showing current TDD stage (idle, pending, RED, GREEN, complete, failed) with color-coded styling. Reads currentTDDStage from ImplementationPanelContext.",
    implementationRef: "TDDStageIndicatorSection",
    tags: ["section", "implementation-phase", "tdd"],
  },
  {
    id: "comp-def-progress-dashboard-section",
    name: "ProgressDashboardSection",
    category: "section",
    description:
      "Shows overall implementation progress with ProgressBar, 3-column stats grid (completed/in-progress/failed), and current task indicator. Data sourced from ImplementationTasks and TaskExecutions.",
    implementationRef: "ProgressDashboardSection",
    tags: ["section", "implementation-phase", "progress"],
  },
  {
    id: "comp-def-task-execution-timeline-section",
    name: "TaskExecutionTimelineSection",
    category: "section",
    description:
      "Vertical timeline of task executions with status dots and selection interaction. Clicking an execution selects it for display in LiveOutputTerminalSection. Data sourced from TaskExecutions.",
    implementationRef: "TaskExecutionTimelineSection",
    tags: ["section", "implementation-phase", "timeline"],
  },
  {
    id: "comp-def-live-output-terminal-section",
    name: "LiveOutputTerminalSection",
    category: "section",
    description:
      "Terminal-style display showing test output for selected execution. Output colored red for failing tests, green for passing. Shows file paths (test/impl) when available. Reads selectedExecutionId from context.",
    implementationRef: "LiveOutputTerminalSection",
    tags: ["section", "implementation-phase", "terminal"],
  },

  // ---------------------------------------------------------------------------
  // Workspace Section Components (3) - req-wpp-layout-refactor, task-cb-ui
  // ---------------------------------------------------------------------------
  {
    id: "comp-def-workspace-blank-state-section",
    name: "WorkspaceBlankStateSection",
    category: "section",
    description:
      "Empty state displayed when workspace has no active content. Shows welcome message and guidance for using virtual tools. Replaced dynamically when show_schema or similar tools are invoked.",
    implementationRef: "WorkspaceBlankStateSection",
    tags: ["section", "workspace", "empty-state"],
  },
  {
    id: "comp-dynamic-composition",
    name: "DynamicCompositionSection",
    category: "section",
    description:
      "Renders any saved Composition by ID. Used for hot registration of user-created components. Takes compositionId in config and renders the composition using ComposablePhaseView pattern.",
    implementationRef: "DynamicCompositionSection",
    tags: ["section", "dynamic", "composition", "workspace"],
  },

  // ---------------------------------------------------------------------------
  // Plan Preview Section Component (view-builder planning) - view-builder-spec
  // ---------------------------------------------------------------------------
  {
    id: "comp-plan-preview-section",
    name: "PlanPreviewSection",
    category: "section",
    description:
      "Flexible wireframe renderer that displays ComponentSpec visually during planning. Shows spec name, intent, type badge, layout approximation based on componentType, data binding annotations, and status indicator. Used by view-builder skill to show evolving plans before implementation.",
    implementationRef: "PlanPreviewSection",
    tags: ["section", "view-builder", "planning", "preview", "wireframe"],
  },

  // ---------------------------------------------------------------------------
  // Data Grid Section Component (generic collection renderer) - view-builder-implementation
  // ---------------------------------------------------------------------------
  {
    id: "comp-data-grid-section",
    name: "DataGridSection",
    category: "section",
    description:
      "Generic data grid/table component that renders any Wavesmith collection in tabular format. Supports configurable columns, sorting, row selection, and uses PropertyRenderer for type-aware cell display. Works with any schema/model combination via config.",
    implementationRef: "DataGridSection",
    tags: ["section", "data-grid", "table", "collection", "generic", "workspace"],
    supportedConfig: ["schema", "model", "columns", "title", "stickyFirstColumn", "onRowSelect"],
  },

  // ---------------------------------------------------------------------------
  // Enhanced Discovery Phase Section Components (6) - virtual-tools-domain
  // ---------------------------------------------------------------------------
  {
    id: "comp-def-phase-hero-section",
    name: "PhaseHeroSection",
    category: "section",
    description:
      "Hero section for phase views with dramatic styling and phase title. Displays session name, status badge, and progress indicator.",
    implementationRef: "PhaseHeroSection",
    tags: ["section", "discovery-phase", "enhanced", "hero"],
  },
  {
    id: "comp-def-session-overview-card",
    name: "SessionOverviewCard",
    category: "section",
    description:
      "Session overview card displaying key metrics and session metadata including created date, updated date, and package count.",
    implementationRef: "SessionOverviewCard",
    tags: ["section", "discovery-phase", "enhanced", "overview"],
  },
  {
    id: "comp-def-intent-rich-panel",
    name: "IntentRichPanel",
    category: "section",
    description:
      "Rich panel for displaying session intent with enhanced styling and formatting.",
    implementationRef: "IntentRichPanel",
    tags: ["section", "discovery-phase", "enhanced", "intent"],
  },
  {
    id: "comp-def-requirements-grid-section",
    name: "RequirementsGridSection",
    category: "section",
    description:
      "Grid layout for requirements with card-based display. Shows requirement status and descriptions.",
    implementationRef: "RequirementsGridSection",
    tags: ["section", "discovery-phase", "enhanced", "requirements"],
  },
  {
    id: "comp-def-insights-panel",
    name: "InsightsPanel",
    category: "section",
    description:
      "Panel displaying AI-generated insights including archetype classification and priority assessment.",
    implementationRef: "InsightsPanel",
    tags: ["section", "discovery-phase", "enhanced", "insights"],
  },
  {
    id: "comp-def-context-footer",
    name: "ContextFooter",
    category: "section",
    description:
      "Footer section with contextual information including applicable patterns, requirement count, and task count.",
    implementationRef: "ContextFooter",
    tags: ["section", "discovery-phase", "enhanced", "footer"],
  },
]

// =============================================================================
// Registry Definitions (2 total)
// =============================================================================

/**
 * Registry seed entities defining the inheritance hierarchy.
 *
 * Structure:
 * - default: Base registry with fallback to StringDisplay
 * - studio: Extends default with domain-specific renderers
 */
export const REGISTRIES: RegistrySeed[] = [
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

// =============================================================================
// Renderer Bindings (32 total: 12 default + 20 studio)
// =============================================================================

/**
 * Default registry bindings (12 entries).
 *
 * Priority cascade:
 * - 100: xComputed, xReferenceType (metadata-based)
 * - 50: enum (schema-based)
 * - 30: format (schema-based)
 * - 10: type (schema-based fallback)
 */
const DEFAULT_BINDINGS: RendererBindingSeed[] = [
  // Priority 100 - Metadata-based bindings
  {
    id: "computed-display",
    name: "Computed Display Binding",
    registry: "default",
    component: "comp-computed-display",
    matchExpression: { xComputed: true },
    priority: 100,
    defaultConfig: { variant: "muted", size: "sm" },
  },
  {
    id: "reference-display",
    name: "Reference Display Binding",
    registry: "default",
    component: "comp-reference-display",
    matchExpression: { xReferenceType: "single" },
    priority: 100,
    defaultConfig: { size: "md", clickable: true },
  },
  {
    id: "reference-array-display",
    name: "Reference Array Display Binding",
    registry: "default",
    component: "comp-array-display",
    matchExpression: { xReferenceType: "array" },
    priority: 100,
    defaultConfig: { size: "md", expandable: true },
  },

  // Priority 50 - Enum-based bindings
  {
    id: "enum-badge",
    name: "Enum Badge Binding",
    registry: "default",
    component: "comp-enum-badge",
    matchExpression: { enum: { $exists: true } },
    priority: 50,
    defaultConfig: { variant: "emphasized", size: "sm" },
  },

  // Priority 30 - Format-based bindings
  {
    id: "datetime-display",
    name: "DateTime Display Binding",
    registry: "default",
    component: "comp-datetime-display",
    matchExpression: { format: "date-time" },
    priority: 30,
    defaultConfig: { size: "sm", variant: "muted" },
  },
  {
    id: "email-display",
    name: "Email Display Binding",
    registry: "default",
    component: "comp-email-display",
    matchExpression: { format: "email" },
    priority: 30,
    defaultConfig: { size: "md", clickable: true },
  },
  {
    id: "uri-display",
    name: "URI Display Binding",
    registry: "default",
    component: "comp-uri-display",
    matchExpression: { format: "uri" },
    priority: 30,
    defaultConfig: { size: "md", truncate: 50, clickable: true },
  },

  // Priority 10 - Type-based bindings
  {
    id: "number-display",
    name: "Number Display Binding",
    registry: "default",
    component: "comp-number-display",
    matchExpression: { type: "number" },
    priority: 10,
    defaultConfig: { size: "md" },
  },
  {
    id: "boolean-display",
    name: "Boolean Display Binding",
    registry: "default",
    component: "comp-boolean-display",
    matchExpression: { type: "boolean" },
    priority: 10,
    defaultConfig: { size: "md" },
  },
  {
    id: "array-display",
    name: "Array Display Binding",
    registry: "default",
    component: "comp-array-display",
    matchExpression: { type: "array" },
    priority: 10,
    defaultConfig: { size: "md", expandable: true },
  },
  {
    id: "object-display",
    name: "Object Display Binding",
    registry: "default",
    component: "comp-object-display",
    matchExpression: { type: "object" },
    priority: 10,
    defaultConfig: { size: "md", expandable: true },
  },
  {
    id: "string-display",
    name: "String Display Binding",
    registry: "default",
    component: "comp-string-display",
    matchExpression: { type: "string" },
    priority: 10,
    defaultConfig: { size: "md", truncate: 200 },
  },
]

/**
 * Studio registry bindings (20 entries).
 *
 * All bindings at priority 200 using explicit x-renderer matching.
 * These override the generic EnumBadge (50) for domain-specific fields.
 */
const STUDIO_BINDINGS: RendererBindingSeed[] = [
  // Domain badge bindings (11)
  {
    id: "priority-badge",
    name: "Priority Badge Binding",
    registry: "studio",
    component: "comp-priority-badge",
    matchExpression: { xRenderer: "priority-badge" },
    priority: 200,
  },
  {
    id: "archetype-badge",
    name: "Archetype Badge Binding",
    registry: "studio",
    component: "comp-archetype-badge",
    matchExpression: { xRenderer: "archetype-badge" },
    priority: 200,
  },
  {
    id: "finding-type-badge",
    name: "Finding Type Badge Binding",
    registry: "studio",
    component: "comp-finding-type-badge",
    matchExpression: { xRenderer: "finding-type-badge" },
    priority: 200,
  },
  {
    id: "task-status-badge",
    name: "Task Status Badge Binding",
    registry: "studio",
    component: "comp-task-status-badge",
    matchExpression: { xRenderer: "task-status-badge" },
    priority: 200,
  },
  {
    id: "test-type-badge",
    name: "Test Type Badge Binding",
    registry: "studio",
    component: "comp-test-type-badge",
    matchExpression: { xRenderer: "test-type-badge" },
    priority: 200,
  },
  {
    id: "session-status-badge",
    name: "Session Status Badge Binding",
    registry: "studio",
    component: "comp-session-status-badge",
    matchExpression: { xRenderer: "session-status-badge" },
    priority: 200,
  },
  {
    id: "requirement-status-badge",
    name: "Requirement Status Badge Binding",
    registry: "studio",
    component: "comp-requirement-status-badge",
    matchExpression: { xRenderer: "requirement-status-badge" },
    priority: 200,
  },
  {
    id: "run-status-badge",
    name: "Run Status Badge Binding",
    registry: "studio",
    component: "comp-run-status-badge",
    matchExpression: { xRenderer: "run-status-badge" },
    priority: 200,
  },
  {
    id: "execution-status-badge",
    name: "Execution Status Badge Binding",
    registry: "studio",
    component: "comp-execution-status-badge",
    matchExpression: { xRenderer: "execution-status-badge" },
    priority: 200,
  },
  {
    id: "test-case-status-badge",
    name: "Test Case Status Badge Binding",
    registry: "studio",
    component: "comp-test-case-status-badge",
    matchExpression: { xRenderer: "test-case-status-badge" },
    priority: 200,
  },
  {
    id: "implementation-task",
    name: "Implementation Task Binding",
    registry: "studio",
    component: "comp-task-renderer",
    matchExpression: { xRenderer: "implementation-task" },
    priority: 200,
  },

  // Visualization bindings (4)
  {
    id: "progress-bar",
    name: "Progress Bar Binding",
    registry: "studio",
    component: "comp-progress-bar",
    matchExpression: { xRenderer: "progress-bar" },
    priority: 200,
  },
  {
    id: "data-card",
    name: "Data Card Binding",
    registry: "studio",
    component: "comp-data-card",
    matchExpression: { xRenderer: "data-card" },
    priority: 200,
  },
  {
    id: "graph-node",
    name: "Graph Node Binding",
    registry: "studio",
    component: "comp-graph-node",
    matchExpression: { xRenderer: "graph-node" },
    priority: 200,
  },
  {
    id: "status-indicator",
    name: "Status Indicator Binding",
    registry: "studio",
    component: "comp-status-indicator",
    matchExpression: { xRenderer: "status-indicator" },
    priority: 200,
  },

  // New specialized renderers (3)
  {
    id: "string-array-display",
    name: "String Array Display Binding",
    registry: "studio",
    component: "comp-string-array-display",
    matchExpression: { xRenderer: "string-array" },
    priority: 200,
    defaultConfig: { size: "sm", layout: "compact" },
  },
  {
    id: "code-path-display",
    name: "Code Path Display Binding",
    registry: "studio",
    component: "comp-code-path-display",
    matchExpression: { xRenderer: "code-path" },
    priority: 200,
    defaultConfig: { size: "xs", truncate: 60 },
  },
  {
    id: "long-text-display",
    name: "Long Text Display Binding",
    registry: "studio",
    component: "comp-long-text-display",
    matchExpression: { xRenderer: "long-text" },
    priority: 200,
    defaultConfig: { truncate: 150, expandable: true },
  },

  // New bindings for task-cbe-003
  {
    id: "change-type-badge",
    name: "Change Type Badge Binding",
    registry: "studio",
    component: "comp-change-type-badge",
    matchExpression: { xRenderer: "change-type-badge" },
    priority: 200,
  },
  {
    id: "phase-status-renderer",
    name: "Phase Status Renderer Binding",
    registry: "studio",
    component: "comp-phase-status-renderer",
    matchExpression: { xRenderer: "phase-status-renderer" },
    priority: 200,
  },
]

/**
 * Combined renderer bindings from both registries.
 * 12 default + 20 studio = 32 total entries.
 */
export const RENDERER_BINDINGS: RendererBindingSeed[] = [
  ...DEFAULT_BINDINGS,
  ...STUDIO_BINDINGS,
]

// =============================================================================
// Layout Templates (2 total) - task-cpv-004, task-prephase-005
// =============================================================================

/**
 * LayoutTemplate seed entities defining slot-based layouts.
 *
 * Structure:
 * - layout-phase-two-column: Two-column layout for phase views with header and actions areas
 * - layout-single-column: Single-column full-width layout for container section phases
 * - layout-two-column-compact: Compact two-column layout without header/actions rows
 */
export const LAYOUT_TEMPLATES: LayoutTemplateSeed[] = [
  {
    id: "layout-phase-two-column",
    name: "layout-phase-two-column",
    description: "Two-column layout for phase views with header and actions areas",
    slots: [
      { name: "header", position: "top", required: true },
      { name: "main", position: "left", required: true },
      { name: "sidebar", position: "right", required: false },
      { name: "actions", position: "bottom", required: false },
    ],
    defaultBindings: {},
  },
  {
    id: "layout-single-column",
    name: "layout-single-column",
    description:
      "Single-column full-width layout for container section phases (Design, Spec). Ideal for phases that render their own internal layout structure, such as tabbed views, graph editors, or complex nested components.",
    slots: [{ name: "main", position: "center", required: true }],
    defaultBindings: {},
  },
  {
    id: "layout-two-column-compact",
    name: "layout-two-column-compact",
    description:
      "Compact two-column layout without header/actions rows. Main content on left, sidebar on right. Ideal for phases that don't need header/footer areas.",
    slots: [
      { name: "main", position: "left", required: true },
      { name: "sidebar", position: "right", required: false },
    ],
    defaultBindings: {},
  },
  // Workspace layout for advanced-chat dynamic workspace - task-wpp
  {
    id: "layout-workspace-flexible",
    name: "layout-workspace-flexible",
    description:
      "Flexible single-slot layout for dynamic workspace composition. Content is controlled by virtual tools modifying the Composition entity. Supports future expansion to multi-slot layouts.",
    slots: [{ name: "main", position: "center", required: false }],
    defaultBindings: {},
  },
  // Horizontal split workspace layout for v2 virtual tools
  {
    id: "layout-workspace-split-h",
    name: "layout-workspace-split-h",
    description:
      "Horizontal split layout for workspace with left and right panels. Used by set_workspace virtual tool for side-by-side views.",
    slots: [
      { name: "left", position: "left", required: false },
      { name: "right", position: "right", required: false },
    ],
    defaultBindings: {},
  },
  // Vertical split workspace layout for v2 virtual tools
  {
    id: "layout-workspace-split-v",
    name: "layout-workspace-split-v",
    description:
      "Vertical split layout for workspace with top and bottom panels. Used by set_workspace virtual tool for stacked views.",
    slots: [
      { name: "top", position: "top", required: false },
      { name: "bottom", position: "bottom", required: false },
    ],
    defaultBindings: {},
  },
  // Enhanced discovery layout for 3-column grid with hero - virtual-tools-domain
  {
    id: "layout-discovery-enhanced",
    name: "layout-discovery-enhanced",
    description:
      "Enhanced 3-column grid layout for discovery phase with hero section, main content area, sidebar insights, and action footer. Provides dramatic visual presentation.",
    slots: [
      { name: "hero", position: "top-full", required: true },
      { name: "overview", position: "left-top", required: true },
      { name: "intent", position: "left-main", required: true },
      { name: "requirements", position: "center-main", required: true },
      { name: "insights", position: "right-sidebar", required: false },
      { name: "context", position: "right-footer", required: false },
      { name: "actions", position: "bottom-full", required: true },
    ],
    defaultBindings: {},
  },
]

// =============================================================================
// Compositions (7 total) - task-cpv-004, task-analysis-008, task-classification-009, task-design-010, task-spec-010, task-testing-008, task-implementation-008
// =============================================================================

/**
 * Composition seed entities defining concrete page/view compositions.
 *
 * Structure:
 * - discovery: Discovery phase view composition with slot-to-section mappings
 * - analysis: Analysis phase with AnalysisPanelProvider context wrapper
 * - classification: Classification phase with pure slot composition (no provider)
 * - design: Design phase with single-column layout and container section pattern
 * - spec: Spec phase with single-column layout and container section pattern
 * - testing: Testing phase with TestingPanelProvider context wrapper
 */
export const COMPOSITIONS: CompositionSeed[] = [
  // Basic discovery composition (original) - renamed to discovery-basic
  {
    id: "composition-discovery",
    name: "discovery-basic",
    layout: "layout-phase-two-column",
    slotContent: [
      { slot: "header", component: "comp-def-intent-terminal-section" },
      { slot: "main", component: "comp-def-requirements-list-section" },
      { slot: "sidebar", component: "comp-def-initial-assessment-section" },
      { slot: "actions", component: "comp-def-phase-actions-section" },
    ],
    dataContext: { phase: "discovery" },
  },
  // Enhanced discovery composition with dramatic styling - virtual-tools-domain
  // This is now the default "discovery" view
  {
    id: "composition-discovery-enhanced",
    name: "discovery",
    layout: "layout-discovery-enhanced",
    slotContent: [
      { slot: "hero", component: "comp-def-phase-hero-section" },
      { slot: "overview", component: "comp-def-session-overview-card" },
      { slot: "intent", component: "comp-def-intent-rich-panel" },
      { slot: "requirements", component: "comp-def-requirements-grid-section" },
      { slot: "insights", component: "comp-def-insights-panel" },
      { slot: "context", component: "comp-def-context-footer" },
      { slot: "actions", component: "comp-def-phase-actions-section" },
    ],
    dataContext: {
      phase: "discovery",
      theme: "midnight-neon",
      style: {
        glassCards: true,
        glowingBorders: true,
        dramaticEffects: true,
      },
    },
  },
  // Analysis phase composition - task-analysis-008
  // Uses compact layout (no header/actions rows) for better space utilization
  {
    id: "composition-analysis",
    name: "analysis",
    layout: "layout-two-column-compact",
    slotContent: [
      // Main slot: Evidence Board header + Location heat bar + Finding matrix (stacked)
      { slot: "main", component: "comp-def-evidence-board-header-section" },
      { slot: "main", component: "comp-def-location-heat-bar-section" },
      { slot: "main", component: "comp-def-finding-matrix-section" },
      // Sidebar slot: Finding list (filtered/grouped)
      { slot: "sidebar", component: "comp-def-finding-list-section" },
    ],
    dataContext: { phase: "analysis" },
    providerWrapper: "AnalysisPanelProvider",
  },
  // Classification phase composition - task-classification-009
  // Pattern: Pure slot composition - NO providerWrapper needed
  // Each section reads directly from useDomains() hook
  // Uses compact layout (no header/actions rows) for better space utilization
  {
    id: "composition-classification",
    name: "classification",
    layout: "layout-two-column-compact",
    slotContent: [
      // Main slot: All 6 sections stacked vertically (archetype transformation at top)
      { slot: "main", component: "comp-def-archetype-transformation-section" },
      { slot: "main", component: "comp-def-correction-note-section" },
      { slot: "main", component: "comp-def-confidence-meters-section" },
      { slot: "main", component: "comp-def-evidence-columns-section" },
      { slot: "main", component: "comp-def-applicable-patterns-section" },
      { slot: "main", component: "comp-def-classification-rationale-section" },
    ],
    dataContext: { phase: "classification" },
    // NO providerWrapper - validates pure slot composition without React Context
  },
  // Design phase composition - task-design-010
  // Pattern: Container section with internal React state (no shared context)
  // Single-column layout with DesignContainerSection managing its own tabs
  {
    id: "composition-design",
    name: "design",
    layout: "layout-single-column",
    slotContent: [
      // Main slot: Container section with internal tab navigation
      { slot: "main", component: "comp-design-container", config: { defaultTab: "schema" } },
    ],
    dataContext: { phase: "design" },
    // NO providerWrapper - Design uses container section pattern with internal React state
  },
  // Spec phase composition - task-spec-010
  // Pattern: Container section with internal React state (no shared context)
  // Single-column layout with SpecContainerSection managing ReactFlow graph and task selection
  {
    id: "composition-spec",
    name: "spec",
    layout: "layout-single-column",
    slotContent: [
      // Main slot: Container section with ReactFlow dependency graph and internal task selection
      { slot: "main", component: "comp-spec-container" },
    ],
    dataContext: { phase: "spec" },
    // NO providerWrapper - Spec uses container section pattern with internal React state (not shared context)
  },
  // Testing phase composition - task-testing-008
  // Pattern: Provider-wrapped composition for shared context coordination
  // Uses TestingPanelProvider to share selected test/task state across sections
  // Uses compact layout (no header/actions rows) for better space utilization
  {
    id: "composition-testing",
    name: "testing",
    layout: "layout-two-column-compact",
    slotContent: [
      // Main slot: Test pyramid + distribution visualizations (stacked)
      { slot: "main", component: "comp-def-test-pyramid-section" },
      { slot: "main", component: "comp-def-test-type-distribution-section" },
      // Sidebar slot: Task coverage + scenario spotlight (stacked)
      { slot: "sidebar", component: "comp-def-task-coverage-bar-section" },
      { slot: "sidebar", component: "comp-def-scenario-spotlight-section" },
    ],
    dataContext: { phase: "testing" },
    providerWrapper: "TestingPanelProvider",
  },
  // Implementation phase composition - task-implementation-008
  // Pattern: Provider-wrapped composition for shared context coordination
  // Uses ImplementationPanelProvider to share selectedExecutionId, latestRun, sortedExecutions, currentTDDStage
  // Uses compact layout (no header/actions rows) for better space utilization
  {
    id: "composition-implementation",
    name: "implementation",
    layout: "layout-two-column-compact",
    slotContent: [
      // Main slot: TDD stage + Progress dashboard + execution timeline (stacked)
      { slot: "main", component: "comp-def-tdd-stage-indicator-section" },
      { slot: "main", component: "comp-def-progress-dashboard-section" },
      { slot: "main", component: "comp-def-task-execution-timeline-section" },
      // Sidebar slot: Live terminal output
      { slot: "sidebar", component: "comp-def-live-output-terminal-section" },
    ],
    dataContext: { phase: "implementation" },
    providerWrapper: "ImplementationPanelProvider",
  },
  // Workspace composition for advanced-chat - req-wpp-layout-refactor
  // Pattern: Provider-wrapped with blank state that gets replaced by virtual tools
  // Virtual tools (show_schema, etc.) replace slotContent to add actual sections
  // MobX reactivity triggers re-render when Composition entity changes
  {
    id: "composition-workspace-blank",
    name: "workspace",
    layout: "layout-workspace-flexible",
    slotContent: [
      // Default blank state - replaced when virtual tools add actual content
      { slot: "main", component: "comp-def-workspace-blank-state-section" },
    ],
    dataContext: { context: "workspace" },
    providerWrapper: "WorkspaceProvider",
  },
]
