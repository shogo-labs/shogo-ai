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
// Analysis phase sections
import {
  EvidenceBoardHeaderSection,
  LocationHeatBarSection,
  FindingMatrixSection,
  FindingListSection,
} from "./sections/analysis"
// Classification phase sections
import {
  ArchetypeTransformationSection,
  CorrectionNoteSection,
  ConfidenceMetersSection,
  EvidenceColumnsSection,
  ApplicablePatternsSection,
  ClassificationRationaleSection,
} from "./sections/classification"
// Design phase sections
import { DesignContainerSection } from "./sections/DesignContainerSection"
// Spec phase sections
import { SpecContainerSection } from "./sections/spec/SpecContainerSection"
// Testing phase sections
import { TestTypeDistributionSection, TestPyramidSection, TaskCoverageBarSection, ScenarioSpotlightSection } from "./sections/testing"
// Implementation phase sections
import {
  TDDStageIndicatorSection,
  ProgressDashboardSection,
  TaskExecutionTimelineSection,
  LiveOutputTerminalSection,
} from "./sections/implementation"

// Re-export SectionRendererProps from types.ts to avoid circular dependencies
// (Analysis section components import from types.ts, not from this file)
export type { SectionRendererProps } from "./types"
import type { SectionRendererProps } from "./types"

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
 * This map contains all registered section renderers for composable phase views.
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
  // Analysis phase sections
  ["EvidenceBoardHeaderSection", EvidenceBoardHeaderSection],
  ["LocationHeatBarSection", LocationHeatBarSection],
  ["FindingMatrixSection", FindingMatrixSection],
  ["FindingListSection", FindingListSection],
  // Classification phase sections
  ["ArchetypeTransformationSection", ArchetypeTransformationSection],
  ["CorrectionNoteSection", CorrectionNoteSection],
  ["ConfidenceMetersSection", ConfidenceMetersSection],
  ["EvidenceColumnsSection", EvidenceColumnsSection],
  ["ApplicablePatternsSection", ApplicablePatternsSection],
  ["ClassificationRationaleSection", ClassificationRationaleSection],
  // Design phase sections
  ["DesignContainerSection", DesignContainerSection],
  // Spec phase sections
  ["SpecContainerSection", SpecContainerSection],
  // Testing phase sections
  ["TestTypeDistributionSection", TestTypeDistributionSection],
  ["TestPyramidSection", TestPyramidSection],
  ["TaskCoverageBarSection", TaskCoverageBarSection],
  ["ScenarioSpotlightSection", ScenarioSpotlightSection],
  // Implementation phase sections
  ["TDDStageIndicatorSection", TDDStageIndicatorSection],
  ["ProgressDashboardSection", ProgressDashboardSection],
  ["TaskExecutionTimelineSection", TaskExecutionTimelineSection],
  ["LiveOutputTerminalSection", LiveOutputTerminalSection],
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
