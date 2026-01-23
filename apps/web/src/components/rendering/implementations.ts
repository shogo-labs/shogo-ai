/**
 * Component Implementations Map - Extended
 * Task: task-dcb-003
 *
 * Extends the base componentImplementationMap from @shogo/composition-runtime
 * with domain-specific renderers for the Shogo Studio application.
 *
 * Base components (from composition-runtime):
 * - 14 primitive renderers (StringDisplay, NumberDisplay, etc.)
 * - 4 visualization renderers (ProgressBar, DataCard, etc.)
 *
 * Domain-specific renderers (local):
 * - 14 domain renderers (PriorityBadge, TaskStatusBadge, etc.)
 */

import type { ComponentType } from "react"
import type { DisplayRendererProps } from "@shogo/composition-runtime"

// Import base map and getComponent from composition-runtime
import {
  componentImplementationMap as baseComponentMap,
  getComponent as baseGetComponent,
  // Re-export primitive displays so consumers don't need to import from two places
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
  StringArrayDisplay,
  LongTextDisplay,
  ImageDisplay,
  // Visualization displays
  ProgressBar,
  DataCard,
  GraphNode,
  StatusIndicator,
} from "@shogo/composition-runtime"

// Domain-specific renderers (these stay local - feature-specific)
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
  CodePathDisplay,
  ChangeTypeBadge,
  PhaseStatusRenderer,
} from "./displays/domain"

/**
 * Extended component implementation map.
 *
 * Starts with all base components from @shogo/composition-runtime,
 * then adds domain-specific renderers for the Shogo Studio application.
 */
export const componentImplementationMap = new Map<
  string,
  ComponentType<DisplayRendererProps>
>([
  // Start with base components from composition-runtime
  ...baseComponentMap,

  // Domain-specific renderers (feature-specific, stay in apps/web)
  ["PriorityBadge", PriorityBadge],
  ["ArchetypeBadge", ArchetypeBadge],
  ["FindingTypeBadge", FindingTypeBadge],
  ["TaskStatusBadge", TaskStatusBadge],
  ["TestTypeBadge", TestTypeBadge],
  ["SessionStatusBadge", SessionStatusBadge],
  ["RequirementStatusBadge", RequirementStatusBadge],
  ["RunStatusBadge", RunStatusBadge],
  ["ExecutionStatusBadge", ExecutionStatusBadge],
  ["TestCaseStatusBadge", TestCaseStatusBadge],
  ["TaskRenderer", TaskRenderer],
  ["CodePathDisplay", CodePathDisplay],
  ["ChangeTypeBadge", ChangeTypeBadge],
  ["PhaseStatusRenderer", PhaseStatusRenderer],
])

/**
 * Safely retrieves a component by its implementationRef string.
 *
 * @param implementationRef - The string key to look up in the map
 * @returns The corresponding React component, or StringDisplay as fallback
 *
 * @example
 * ```typescript
 * const Component = getComponent("PriorityBadge")
 * // Returns PriorityBadge component
 *
 * const Fallback = getComponent("NonExistent")
 * // Returns StringDisplay as fallback
 * ```
 */
export function getComponent(
  implementationRef: string
): ComponentType<DisplayRendererProps> {
  if (!implementationRef) {
    return StringDisplay
  }
  return componentImplementationMap.get(implementationRef) ?? StringDisplay
}

// Re-export types for convenience
export type { DisplayRendererProps }
