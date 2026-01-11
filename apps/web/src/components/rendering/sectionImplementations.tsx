/**
 * Section Implementations Map
 * Task: task-cpv-005
 *
 * Maps implementationRef strings to their corresponding React section components.
 * This bridges slotContent data (from Wavesmith) to code-side implementations.
 *
 * Section components render full sections of a phase view, receiving the current
 * feature session and optional configuration from slotContent entities.
 *
 * The map is used by the slot rendering system to resolve section references
 * from SlotContent entities to actual React components.
 */

import type { ComponentType } from "react"
import { IntentTerminalSection } from "./sections/IntentTerminalSection"
import { InitialAssessmentSection } from "./sections/InitialAssessmentSection"
import { PhaseActionsSection } from "./sections/PhaseActionsSection"
import { RequirementsListSection } from "./sections/RequirementsListSection"
import { SessionSummarySection } from "./sections/SessionSummarySection"
import { PhaseHeroSection } from "./sections/PhaseHeroSection"
import { SessionOverviewCard } from "./sections/SessionOverviewCard"
import { IntentRichPanel } from "./sections/IntentRichPanel"
import { RequirementsGridSection } from "./sections/RequirementsGridSection"
import { InsightsPanel } from "./sections/InsightsPanel"
import { ContextFooter } from "./sections/ContextFooter"

/**
 * Props passed to section renderer components.
 *
 * Section components receive:
 * - feature: The current FeatureSession data (required)
 * - config: Optional configuration from slotContent entity
 *
 * Unlike DisplayRendererProps which render individual property values,
 * SectionRendererProps provide access to the full feature context for
 * rendering complete UI sections.
 */
export interface SectionRendererProps {
  /**
   * The current feature session data.
   * Typed as 'any' to match codebase patterns for MST instance types.
   * Contains id, name, status, requirements, tasks, etc.
   */
  feature: any

  /**
   * Optional configuration from the slotContent entity.
   * Allows customization of section rendering behavior without
   * creating new component implementations.
   *
   * @example
   * ```typescript
   * // SlotContent entity might specify:
   * { showHeader: true, maxItems: 5, columns: 2 }
   * ```
   */
  config?: Record<string, unknown>
}

/**
 * Fallback section component displayed when the requested section
 * implementation is not found in the map.
 *
 * Provides a visual indicator that helps developers identify missing
 * section implementations during development.
 */
function FallbackSection({ feature, config }: SectionRendererProps) {
  return (
    <div className="p-4 border border-dashed border-muted rounded">
      <p className="text-muted-foreground">Section not found</p>
    </div>
  )
}

/**
 * Map of implementationRef strings to React section components.
 *
 * This map contains all registered section renderers.
 * Currently empty - will be populated as section components are created.
 *
 * @example
 * ```typescript
 * // Future entries might include:
 * sectionImplementationMap.set("RequirementsSection", RequirementsSection)
 * sectionImplementationMap.set("TasksSection", TasksSection)
 * sectionImplementationMap.set("ProgressSection", ProgressSection)
 * ```
 */
export const sectionImplementationMap = new Map<
  string,
  ComponentType<SectionRendererProps>
>([
  // Section components registered for composable phase views
  ["IntentTerminalSection", IntentTerminalSection],
  ["InitialAssessmentSection", InitialAssessmentSection],
  ["PhaseActionsSection", PhaseActionsSection],
  ["SessionSummarySection", SessionSummarySection],
  ["RequirementsListSection", RequirementsListSection],
  // Enhanced discovery phase sections
  ["PhaseHeroSection", PhaseHeroSection],
  ["SessionOverviewCard", SessionOverviewCard],
  ["IntentRichPanel", IntentRichPanel],
  ["RequirementsGridSection", RequirementsGridSection],
  ["InsightsPanel", InsightsPanel],
  ["ContextFooter", ContextFooter],
])

/**
 * Safely retrieves a section component by its implementationRef string.
 *
 * @param ref - The string key to look up in the map
 * @returns The corresponding React section component, or FallbackSection if not found
 *
 * @example
 * ```typescript
 * const Component = getSectionComponent("RequirementsSection")
 * // Returns RequirementsSection if registered, FallbackSection otherwise
 *
 * const Fallback = getSectionComponent("NonExistent")
 * // Returns FallbackSection
 * ```
 */
export function getSectionComponent(
  ref: string
): ComponentType<SectionRendererProps> {
  if (!ref) {
    return FallbackSection
  }
  return sectionImplementationMap.get(ref) ?? FallbackSection
}
