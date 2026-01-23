/**
 * Component Implementations Map
 *
 * Maps implementationRef strings to their corresponding React components.
 * This bridges entity data (from Wavesmith) to code-side implementations.
 *
 * The map is used by the dynamic component builder to resolve component
 * references from RendererBinding entities to actual React components.
 *
 * Note: This package includes only generic display renderers.
 * Domain-specific renderers (PriorityBadge, TaskStatusBadge, etc.)
 * should be registered by the consuming application.
 */

import type { ComponentType } from "react"
import type { DisplayRendererProps } from "../types"

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
  StringArrayDisplay,
  LongTextDisplay,
  ImageDisplay,
} from "../displays"

// Visualization renderers
import {
  ProgressBar,
  DataCard,
  GraphNode,
  StatusIndicator,
} from "../displays/visualization"

/**
 * Map of implementationRef strings to React components.
 *
 * This map contains generic display renderers:
 * - 14 primitive renderers (StringDisplay, NumberDisplay, etc.)
 * - 4 visualization renderers (ProgressBar, DataCard, etc.)
 *
 * Domain-specific renderers are not included in this package.
 * They should be added by the consuming application via:
 * ```typescript
 * componentImplementationMap.set("PriorityBadge", PriorityBadge)
 * ```
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
  ["StringArrayDisplay", StringArrayDisplay],
  ["LongTextDisplay", LongTextDisplay],
  ["ImageDisplay", ImageDisplay],

  // Visualization renderers - cast through unknown for different prop shapes
  ["ProgressBar", ProgressBar as unknown as ComponentType<DisplayRendererProps>],
  ["DataCard", DataCard as unknown as ComponentType<DisplayRendererProps>],
  ["GraphNode", GraphNode as unknown as ComponentType<DisplayRendererProps>],
  ["StatusIndicator", StatusIndicator as unknown as ComponentType<DisplayRendererProps>],
])

/**
 * Safely retrieves a component by its implementationRef string.
 *
 * @param implementationRef - The string key to look up in the map
 * @returns The corresponding React component, or StringDisplay as fallback
 *
 * @example
 * ```typescript
 * const Component = getComponent("NumberDisplay")
 * // Returns NumberDisplay component
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
