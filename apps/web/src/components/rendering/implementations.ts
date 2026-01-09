/**
 * Component Implementations Map
 * Task: task-dcb-003
 *
 * Maps implementationRef strings to their corresponding React components.
 * This bridges entity data (from Wavesmith) to code-side implementations.
 *
 * The map is used by the dynamic component builder to resolve component
 * references from RendererBinding entities to actual React components.
 */

import type { ComponentType } from "react"
import type { DisplayRendererProps } from "./types"

// Primitive display renderers
import {
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
} from "./displays"

// Domain-specific renderers
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
} from "./displays/domain"

// Visualization renderers
import {
  ProgressBar,
  DataCard,
  GraphNode,
  StatusIndicator,
} from "./displays/visualization"

/**
 * Map of implementationRef strings to React components.
 *
 * This map contains all registered display renderers:
 * - 11 primitive renderers (StringDisplay, NumberDisplay, etc.)
 * - 11 domain renderers (PriorityBadge, TaskStatusBadge, etc.)
 * - 4 visualization renderers (ProgressBar, DataCard, etc.)
 */
export const componentImplementationMap = new Map<
  string,
  ComponentType<DisplayRendererProps>
>([
  // Primitive display renderers
  ["StringDisplay", StringDisplay],
  ["NumberDisplay", NumberDisplay],
  ["BooleanDisplay", BooleanDisplay],
  ["DateTimeDisplay", DateTimeDisplay],
  ["EmailDisplay", EmailDisplay],
  ["UriDisplay", UriDisplay],
  ["EnumBadge", EnumBadge],
  ["ReferenceDisplay", ReferenceDisplay],
  ["ComputedDisplay", ComputedDisplay],
  ["ArrayDisplay", ArrayDisplay],
  ["ObjectDisplay", ObjectDisplay],

  // Domain-specific renderers
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

  // Visualization renderers
  ["ProgressBar", ProgressBar as ComponentType<DisplayRendererProps>],
  ["DataCard", DataCard as ComponentType<DisplayRendererProps>],
  ["GraphNode", GraphNode as ComponentType<DisplayRendererProps>],
  ["StatusIndicator", StatusIndicator as ComponentType<DisplayRendererProps>],
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
