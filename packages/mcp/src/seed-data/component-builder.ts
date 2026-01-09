/**
 * Component Builder Seed Data
 *
 * Seed data constants for the component-builder domain, structured for
 * insertOne() operations via Wavesmith MCP tools.
 *
 * Exports:
 * - COMPONENT_DEFINITIONS: 26 entries (display components)
 * - REGISTRIES: 2 entries (default, studio)
 * - RENDERER_BINDINGS: 27 entries (12 default + 15 studio)
 *
 * All entities have proper id fields for idempotency checks.
 * TypeScript types match component-builder schema entity types.
 *
 * Task: task-sdr-v2-001
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
  category: "display" | "input" | "layout" | "visualization"
  /** Documentation for the component's purpose */
  description: string
  /** Key mapping to code-side component registry */
  implementationRef: string
  /** Tags for categorization and search */
  tags?: string[]
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
}

// =============================================================================
// Component Definitions (26 total)
// =============================================================================

/**
 * All ComponentDefinition seed entities.
 *
 * Categories breakdown:
 * - Primitive Display (11): String, Number, Boolean, DateTime, Email, URI, Enum, Reference, Computed, Array, Object
 * - Domain-Specific Display (11): Priority, Archetype, FindingType, TaskStatus, TestType, SessionStatus, RequirementStatus, RunStatus, ExecutionStatus, TestCaseStatus, TaskRenderer
 * - Visualization (4): ProgressBar, DataCard, GraphNode, StatusIndicator
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
// Renderer Bindings (27 total: 12 default + 15 studio)
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
  },
  {
    id: "reference-display",
    name: "Reference Display Binding",
    registry: "default",
    component: "comp-reference-display",
    matchExpression: { xReferenceType: "single" },
    priority: 100,
  },
  {
    id: "reference-array-display",
    name: "Reference Array Display Binding",
    registry: "default",
    component: "comp-array-display",
    matchExpression: { xReferenceType: "array" },
    priority: 100,
  },

  // Priority 50 - Enum-based bindings
  {
    id: "enum-badge",
    name: "Enum Badge Binding",
    registry: "default",
    component: "comp-enum-badge",
    matchExpression: { enum: { $exists: true } },
    priority: 50,
  },

  // Priority 30 - Format-based bindings
  {
    id: "datetime-display",
    name: "DateTime Display Binding",
    registry: "default",
    component: "comp-datetime-display",
    matchExpression: { format: "date-time" },
    priority: 30,
  },
  {
    id: "email-display",
    name: "Email Display Binding",
    registry: "default",
    component: "comp-email-display",
    matchExpression: { format: "email" },
    priority: 30,
  },
  {
    id: "uri-display",
    name: "URI Display Binding",
    registry: "default",
    component: "comp-uri-display",
    matchExpression: { format: "uri" },
    priority: 30,
  },

  // Priority 10 - Type-based bindings
  {
    id: "number-display",
    name: "Number Display Binding",
    registry: "default",
    component: "comp-number-display",
    matchExpression: { type: "number" },
    priority: 10,
  },
  {
    id: "boolean-display",
    name: "Boolean Display Binding",
    registry: "default",
    component: "comp-boolean-display",
    matchExpression: { type: "boolean" },
    priority: 10,
  },
  {
    id: "array-display",
    name: "Array Display Binding",
    registry: "default",
    component: "comp-array-display",
    matchExpression: { type: "array" },
    priority: 10,
  },
  {
    id: "object-display",
    name: "Object Display Binding",
    registry: "default",
    component: "comp-object-display",
    matchExpression: { type: "object" },
    priority: 10,
  },
  {
    id: "string-display",
    name: "String Display Binding",
    registry: "default",
    component: "comp-string-display",
    matchExpression: { type: "string" },
    priority: 10,
  },
]

/**
 * Studio registry bindings (15 entries).
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
]

/**
 * Combined renderer bindings from both registries.
 * 12 default + 15 studio = 27 total entries.
 */
export const RENDERER_BINDINGS: RendererBindingSeed[] = [
  ...DEFAULT_BINDINGS,
  ...STUDIO_BINDINGS,
]
