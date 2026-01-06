/**
 * Design Phase Barrel Export
 * Task: task-2-3c-015
 *
 * Exports all Design phase components for the Studio App stepper.
 *
 * Per design-2-3c-012:
 * - Design view with tabbed interface (Schema, Decisions, Hooks Plan)
 * - ReactFlow-based schema visualization
 * - Decision list and enhancement hooks display
 *
 * Usage:
 *   import { DesignView, SchemaGraph } from '@/components/app/stepper/phases/design'
 */

// Main container component
export { DesignView } from "./DesignView"
export type { DesignViewProps } from "./DesignView"

// Graph visualization components
export { SchemaGraph } from "./SchemaGraph"
export type { SchemaGraphProps } from "./SchemaGraph"

export { EntityNode, entityNodeVariants } from "./EntityNode"
export type { EntityNodeProps } from "./EntityNode"

export { ReferenceEdge } from "./ReferenceEdge"

export { EntityDetailsPanel } from "./EntityDetailsPanel"
export type { EntityDetailsPanelProps } from "./EntityDetailsPanel"

// Decision components
export { DesignDecisionCard } from "./DesignDecisionCard"
export type { DesignDecisionCardProps, DesignDecision } from "./DesignDecisionCard"

export { DesignDecisionsList } from "./DesignDecisionsList"
export type { DesignDecisionsListProps } from "./DesignDecisionsList"

export { EnhancementHooksPlan } from "./EnhancementHooksPlan"
export type { EnhancementHooksPlanProps } from "./EnhancementHooksPlan"

// Empty/loading state components
export { SchemaEmptyState, SchemaLoadingSkeleton } from "./SchemaEmptyStates"
export type { SchemaEmptyStateProps } from "./SchemaEmptyStates"

// Hooks
export { useSchemaData } from "./hooks/useSchemaData"
export type {
  SchemaModel,
  SchemaField,
  UseSchemaDataResult,
} from "./hooks/useSchemaData"

// Types from utils
export type {
  EntityNodeData,
  ReferenceEdgeData,
  TransformResult,
} from "./utils/schemaTransform"

// Utility functions (if needed externally)
export {
  transformSchemaToGraph,
  applyDagreLayout,
} from "./utils/schemaTransform"
