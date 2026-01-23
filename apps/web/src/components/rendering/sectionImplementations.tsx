/**
 * Section Implementations Map - Extended
 * Task: task-cpv-005
 *
 * Extends the base sectionImplementationMap from @shogo/composition-runtime
 * with feature-specific sections for the Shogo Studio application.
 *
 * Base sections (from composition-runtime):
 * - Generic sections: DataGridSection, FormSection, ChartSection, etc.
 * - App building sections: AppBarSection, SideNavSection, AppShellSection
 * - Dynamic sections: DynamicCompositionSection, PlanPreviewSection
 *
 * Feature-specific sections (local):
 * - Discovery phase: IntentTerminalSection, PhaseHeroSection, etc.
 * - Analysis phase: EvidenceBoardHeaderSection, FindingMatrixSection, etc.
 * - Classification phase: ArchetypeTransformationSection, etc.
 * - Spec phase: SpecContainerSection
 * - Testing phase: TestPyramidSection, TaskCoverageBarSection, etc.
 * - Implementation phase: TDDStageIndicatorSection, ProgressDashboardSection, etc.
 * - Workspace: WorkspaceBlankStateSection
 */

import type { ComponentType, ReactNode } from "react"
import { useDomains } from "@shogo/app-core"
import { observer } from "mobx-react-lite"

// Import base sections and utilities from composition-runtime
import {
  sectionImplementationMap as baseSectionMap,
  getSectionComponent as baseGetSectionComponent,
  type SectionRendererProps,
  // Re-export base sections for convenience
  DataGridSection,
  FormSection,
  ChartSection,
  AppBarSection,
  SideNavSection,
  AppShellSection,
  DynamicCompositionSection,
  PlanPreviewSection,
  SectionBrowserSection,
} from "@shogo/composition-runtime"

// Discovery phase sections (feature-specific)
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

// Analysis phase sections (feature-specific)
import {
  EvidenceBoardHeaderSection,
  LocationHeatBarSection,
  FindingMatrixSection,
  FindingListSection,
} from "./sections/analysis"

// Classification phase sections (feature-specific)
import {
  ArchetypeTransformationSection,
  CorrectionNoteSection,
  ConfidenceMetersSection,
  EvidenceColumnsSection,
  ApplicablePatternsSection,
  ClassificationRationaleSection,
} from "./sections/classification"

// Design phase sections (feature-specific)
import { DesignContainerSection } from "./sections/DesignContainerSection"

// Spec phase sections (feature-specific)
import { SpecContainerSection } from "./sections/spec/SpecContainerSection"

// Testing phase sections (feature-specific)
import {
  TestTypeDistributionSection,
  TestPyramidSection,
  TaskCoverageBarSection,
  ScenarioSpotlightSection,
} from "./sections/testing"

// Implementation phase sections (feature-specific)
import {
  TDDStageIndicatorSection,
  ProgressDashboardSection,
  TaskExecutionTimelineSection,
  LiveOutputTerminalSection,
} from "./sections/implementation"

// Workspace sections (feature-specific)
import { WorkspaceBlankStateSection } from "./sections/workspace/WorkspaceBlankStateSection"

// Re-export SectionRendererProps from composition-runtime
export type { SectionRendererProps }

/**
 * Fallback section component displayed when the requested section
 * implementation is not found in the map.
 */
function FallbackSection({ feature, config }: SectionRendererProps) {
  return (
    <div className="p-4 border border-dashed border-muted rounded">
      <p className="text-muted-foreground">Section not found</p>
    </div>
  )
}

/**
 * Extended section implementation map.
 *
 * Starts with all base sections from @shogo/composition-runtime,
 * then adds feature-specific sections for the Shogo Studio application.
 */
export const sectionImplementationMap = new Map<
  string,
  ComponentType<SectionRendererProps>
>([
  // Start with base sections from composition-runtime
  ...baseSectionMap,

  // Discovery phase sections (feature-specific)
  ["IntentTerminalSection", IntentTerminalSection],
  ["InitialAssessmentSection", InitialAssessmentSection],
  ["PhaseActionsSection", PhaseActionsSection],
  ["SessionSummarySection", SessionSummarySection],
  ["RequirementsListSection", RequirementsListSection],
  ["PhaseHeroSection", PhaseHeroSection],
  ["SessionOverviewCard", SessionOverviewCard],
  ["IntentRichPanel", IntentRichPanel],
  ["RequirementsGridSection", RequirementsGridSection],
  ["InsightsPanel", InsightsPanel],
  ["ContextFooter", ContextFooter],

  // Analysis phase sections (feature-specific)
  ["EvidenceBoardHeaderSection", EvidenceBoardHeaderSection],
  ["LocationHeatBarSection", LocationHeatBarSection],
  ["FindingMatrixSection", FindingMatrixSection],
  ["FindingListSection", FindingListSection],

  // Classification phase sections (feature-specific)
  ["ArchetypeTransformationSection", ArchetypeTransformationSection],
  ["CorrectionNoteSection", CorrectionNoteSection],
  ["ConfidenceMetersSection", ConfidenceMetersSection],
  ["EvidenceColumnsSection", EvidenceColumnsSection],
  ["ApplicablePatternsSection", ApplicablePatternsSection],
  ["ClassificationRationaleSection", ClassificationRationaleSection],

  // Design phase sections (feature-specific)
  ["DesignContainerSection", DesignContainerSection],

  // Spec phase sections (feature-specific)
  ["SpecContainerSection", SpecContainerSection],

  // Testing phase sections (feature-specific)
  ["TestTypeDistributionSection", TestTypeDistributionSection],
  ["TestPyramidSection", TestPyramidSection],
  ["TaskCoverageBarSection", TaskCoverageBarSection],
  ["ScenarioSpotlightSection", ScenarioSpotlightSection],

  // Implementation phase sections (feature-specific)
  ["TDDStageIndicatorSection", TDDStageIndicatorSection],
  ["ProgressDashboardSection", ProgressDashboardSection],
  ["TaskExecutionTimelineSection", TaskExecutionTimelineSection],
  ["LiveOutputTerminalSection", LiveOutputTerminalSection],

  // Workspace sections (feature-specific)
  ["WorkspaceBlankStateSection", WorkspaceBlankStateSection],
])

/**
 * Safely retrieves a section component by its implementationRef string.
 *
 * @param ref - The string key to look up in the map
 * @returns The corresponding React section component, or FallbackSection if not found
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
  /** The resolved section component */
  component: ComponentType<SectionRendererProps>
  /** Config to merge with existing config (e.g., compositionId for DynamicCompositionSection) */
  additionalConfig?: Record<string, unknown>
  /** Whether this was resolved via hot registration (dynamic lookup) */
  isHotRegistered: boolean
}

/**
 * Hook for resolving sections with hot registration fallback.
 *
 * Resolution order:
 * 1. First checks static sectionImplementationMap (fast path)
 * 2. Falls back to componentBuilder.componentDefinitionCollection.findByName()
 * 3. If found with implementationRef='DynamicCompositionSection', returns that
 *    component with the compositionId from the ComponentDefinition
 */
export function useDynamicSection(sectionName: string): DynamicSectionResult {
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
      const composition = componentBuilder.compositionCollection?.findByName?.(sectionName)
      const compositionId = composition?.id

      return {
        component: DynamicCompositionSection,
        additionalConfig: compositionId ? { compositionId } : undefined,
        isHotRegistered: true,
      }
    }

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

  return {
    component: FallbackSection,
    isHotRegistered: false,
  }
}

/**
 * Props for DynamicSectionRenderer
 */
export interface DynamicSectionRendererProps {
  sectionName: string
  feature: any
  config?: Record<string, unknown>
}

/**
 * DynamicSectionRenderer - Wrapper component that enables hot registration in loops
 */
export const DynamicSectionRenderer = observer(function DynamicSectionRenderer({
  sectionName,
  feature,
  config,
}: DynamicSectionRendererProps): ReactNode {
  const { component: SectionComponent, additionalConfig } = useDynamicSection(sectionName)

  const mergedConfig = additionalConfig
    ? { ...additionalConfig, ...config }
    : config

  return <SectionComponent feature={feature} config={mergedConfig} />
})
