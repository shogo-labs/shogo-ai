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

import type { ComponentType, ReactNode } from "react"
import { useDomains } from "@/contexts/DomainProvider"
import { observer } from "mobx-react-lite"
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
// Workspace sections
import { WorkspaceBlankStateSection } from "./sections/workspace/WorkspaceBlankStateSection"
// Component Builder sections
import { ComponentBuilderSection } from "./sections/component-builder"
import { DynamicCompositionSection } from "./sections/DynamicCompositionSection"
import { PropertyFieldSection } from "./sections/PropertyFieldSection"
// View Builder sections
import { PlanPreviewSection } from "./sections/PlanPreviewSection"
// Data Grid section
import { DataGridSection } from "./sections/DataGridSection"
// Chart section
import { ChartSection } from "./sections/ChartSection"

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
  // Workspace sections
  ["WorkspaceBlankStateSection", WorkspaceBlankStateSection],
  // Component Builder sections
  ["ComponentBuilderSection", ComponentBuilderSection],
  // Dynamic composition rendering (enables hot registration)
  ["DynamicCompositionSection", DynamicCompositionSection],
  // Property field rendering (bridges Section pipeline to PropertyRenderer)
  ["PropertyFieldSection", PropertyFieldSection],
  // View Builder sections
  ["PlanPreviewSection", PlanPreviewSection],
  // Data Grid section (generic collection renderer)
  ["DataGridSection", DataGridSection],
  // Chart section (D3-based visualizations)
  ["ChartSection", ChartSection],
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

/**
 * Result from useDynamicSection hook
 */
export interface DynamicSectionResult {
  /** The resolved section component (always defined - returns FallbackSection if not found) */
  component: ComponentType<SectionRendererProps>
  /** Config to merge with existing config (e.g., compositionId for DynamicCompositionSection) */
  additionalConfig?: Record<string, unknown>
  /** Whether this was resolved via hot registration (dynamic lookup) */
  isHotRegistered: boolean
}

/**
 * Hook for resolving sections with hot registration fallback.
 * Task: task-cb-ui-hot-registration
 *
 * Resolution order:
 * 1. First checks static sectionImplementationMap (fast path)
 * 2. Falls back to componentBuilder.componentDefinitionCollection.findByName()
 * 3. If found with implementationRef='DynamicCompositionSection', returns that
 *    component with the compositionId from the ComponentDefinition
 *
 * This enables Claude to use user-created components by name (e.g., 'KanbanRequirements')
 * without needing manual mapping updates.
 *
 * @param sectionName - The section name to resolve (e.g., 'RequirementsListSection' or 'KanbanRequirements')
 * @returns Object with component, optional additionalConfig, and isHotRegistered flag
 *
 * @example
 * ```tsx
 * function MyComponent({ sectionName, feature, config }) {
 *   const { component: SectionComponent, additionalConfig, isHotRegistered } = useDynamicSection(sectionName)
 *   const mergedConfig = { ...config, ...additionalConfig }
 *   return <SectionComponent feature={feature} config={mergedConfig} />
 * }
 * ```
 */
export function useDynamicSection(sectionName: string): DynamicSectionResult {
  // Access componentBuilder domain for hot registration fallback
  const domains = useDomains()
  const componentBuilder = domains?.componentBuilder

  // Fast path: Check static map first
  const staticComponent = sectionImplementationMap.get(sectionName)
  if (staticComponent) {
    return {
      component: staticComponent,
      isHotRegistered: false,
    }
  }

  // Hot registration fallback: Look up in componentBuilder
  if (componentBuilder?.componentDefinitionCollection?.findByName) {
    const componentDef = componentBuilder.componentDefinitionCollection.findByName(sectionName)

    if (componentDef && componentDef.implementationRef === "DynamicCompositionSection") {
      // User-created component that uses DynamicCompositionSection
      // The ComponentDefinition should have a linked Composition
      // We need to find the Composition by matching name or via stored reference

      // Try to find a Composition with matching name
      const composition = componentBuilder.compositionCollection?.findByName?.(sectionName)
      const compositionId = composition?.id

      return {
        component: DynamicCompositionSection,
        additionalConfig: compositionId ? { compositionId } : undefined,
        isHotRegistered: true,
      }
    }

    // If found but not DynamicCompositionSection, check if implementationRef maps to a static component
    if (componentDef?.implementationRef) {
      const resolvedComponent = sectionImplementationMap.get(componentDef.implementationRef)
      if (resolvedComponent) {
        return {
          component: resolvedComponent,
          isHotRegistered: true,
        }
      }
    }
  }

  // Not found anywhere
  return {
    component: FallbackSection,
    isHotRegistered: false,
  }
}

/**
 * Props for DynamicSectionRenderer
 */
export interface DynamicSectionRendererProps {
  /** Section name to resolve (can be static or hot-registered) */
  sectionName: string
  /** The current feature session data */
  feature: any
  /** Optional configuration from slotContent */
  config?: Record<string, unknown>
}

/**
 * DynamicSectionRenderer - Wrapper component that enables hot registration in loops
 * Task: task-cb-ui-hot-registration
 *
 * Use this component instead of calling getSectionComponent directly when you need
 * hot registration support. This allows the hook to be called correctly (not in a loop).
 *
 * @example
 * ```tsx
 * // Instead of:
 * for (const spec of slotSpecs) {
 *   const Component = getSectionComponent(spec.sectionRef)  // No hot registration
 *   elements.push(<Component ... />)
 * }
 *
 * // Use:
 * for (const spec of slotSpecs) {
 *   elements.push(
 *     <DynamicSectionRenderer
 *       key={spec.sectionRef}
 *       sectionName={spec.sectionRef}
 *       feature={feature}
 *       config={spec.config}
 *     />
 *   )
 * }
 * ```
 */
export const DynamicSectionRenderer = observer(function DynamicSectionRenderer({
  sectionName,
  feature,
  config,
}: DynamicSectionRendererProps): ReactNode {
  const { component: SectionComponent, additionalConfig } = useDynamicSection(sectionName)

  // Merge config: slotContent config takes precedence, additionalConfig fills in gaps
  const mergedConfig = additionalConfig
    ? { ...additionalConfig, ...config }
    : config

  return <SectionComponent feature={feature} config={mergedConfig} />
})
