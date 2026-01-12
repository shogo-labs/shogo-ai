/**
 * PhaseContentPanel Component
 * Tasks: task-2-3a-008, task-2-3b-011, task-2-3d-phase-content-panel, task-3-1-008, task-cpv-013
 *
 * Smart component that uses usePhaseNavigation hook and renders SkillStepper
 * plus content area. This is the data-fetching boundary per design-2-3a-component-hierarchy.
 *
 * Per design-2-3a-component-hierarchy:
 * - Smart component that uses usePhaseNavigation hook internally
 * - Passes data down to SkillStepper (presentational)
 * - Content area renders phase-specific views (2.3B: discovery, analysis, classification)
 *
 * Per design-2-3a-enhancement-hooks-plan:
 * - Extension points for 2.3C/D phase views via renderPhaseContent switch
 *
 * Per design-2-3a-clean-break:
 * - Built fresh in /components/app/stepper/
 * - Zero imports from /components/Studio/
 *
 * Session 2.3D: Added SpecView, TestingView, ImplementationView, CompleteView
 *
 * Session 3.1 (task-3-1-008): Added LoadingOverlay for subtle loading states
 * - Uses isPolling from ChatContext to show loading indicator during data refresh
 * - Optimistic rendering - existing content visible while refreshing
 *
 * Session CPV (task-cpv-013): Integrated ComposablePhaseView for discovery phase
 * - Discovery phase now uses data-driven composition via ComposablePhaseView
 * - Other phases remain unchanged using hardcoded view components
 * - ComposablePhaseView handles fallback when composition not found
 */

import { useMemo } from "react"
import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import { SkillStepper } from "./SkillStepper"
import { EmptyPhaseContent } from "./EmptyStates"
import { BlockedPhaseIndicator } from "./EmptyStates"
import { LoadingOverlay } from "./LoadingOverlay"
import { usePhaseNavigation } from "./hooks/usePhaseNavigation"
import { getPhaseStatus, PHASE_CONFIG } from "./phaseUtils"
import { useChatContextSafe } from "../chat/ChatContext"
// Composable phase view for data-driven phase composition (Session CPV)
import { ComposablePhaseView } from "@/components/rendering/composition/ComposablePhaseView"
// Phase view components (Session 2.3B, 2.3C, 2.3D)
import { DiscoveryView, AnalysisView, ClassificationView } from "./phases"
import { SpecView } from "./phases/spec/SpecView"
import { TestingView } from "./phases/testing/TestingView"
import { ImplementationView } from "./phases/implementation/ImplementationView"
import { CompleteView } from "./phases/complete/CompleteView"

/**
 * Feature session type (subset of FeatureSession for typing)
 * Extended in 2.3B to include properties needed by phase views
 * Extended in 2.3C to include schemaName for DesignView
 * Extended in 2.3D to include updatedAt for CompleteView
 */
export interface FeatureForPanel {
  id: string
  name: string
  status: string
  // Properties for DiscoveryView (2.3B)
  intent?: string
  initialAssessment?: {
    likelyArchetype?: "domain" | "service" | "infrastructure" | "hybrid"
    indicators?: string[]
    uncertainties?: string[]
  }
  // Properties for ClassificationView (2.3B)
  applicablePatterns?: string[]
  // Properties for DesignView (2.3C) - schema name for loading schema data
  schemaName?: string
  // Properties for CompleteView (2.3D) - completion timestamp
  updatedAt?: number
}

/**
 * Props for PhaseContentPanel component
 */
export interface PhaseContentPanelProps {
  /** Feature session to display phases for */
  feature: FeatureForPanel
}

/**
 * PhaseContentPanel Component
 *
 * Smart component that manages phase navigation and renders the stepper
 * with content area for the selected phase.
 *
 * Extension Points:
 * - 2.3B: DiscoveryView, AnalysisView in content area
 * - 2.3C: DesignView, SpecView in content area
 * - 2.3D: Run phase callback for EmptyPhaseContent
 */
export const PhaseContentPanel = observer(function PhaseContentPanel({ feature }: PhaseContentPanelProps) {
  // Use the phase navigation hook with feature status
  const { phase, setPhase, phases } = usePhaseNavigation(feature.status)

  // Get polling state from ChatContext for loading overlay (task-3-1-008)
  // Uses safe version to gracefully handle missing context
  const chatContext = useChatContextSafe()
  const isPolling = chatContext?.isPolling ?? false

  // Find the selected phase's status from phases array
  const selectedPhaseStatus = useMemo(() => {
    return phases.find((p) => p.name === phase)?.status ?? "pending"
  }, [phases, phase])

  // Find the previous phase for blocked indicator
  const previousPhase = useMemo(() => {
    const currentIndex = phases.findIndex((p) => p.name === phase)
    if (currentIndex > 0) {
      return phases[currentIndex - 1].name
    }
    return null
  }, [phases, phase])

  // Get phase label for display
  const phaseLabel = PHASE_CONFIG[phase]?.label ?? phase

  /**
   * Render phase content based on status and phase type
   *
   * Phase views implemented:
   * - 2.3B: DiscoveryView, AnalysisView, ClassificationView
   *
   * Extension Points for future sessions:
   * - 2.3C: DesignView, SpecView
   * - 2.3D: Add onRunPhase callback to EmptyPhaseContent
   */
  const renderPhaseContent = () => {
    // Check if phase is blocked (selected phase is ahead of current status)
    if (selectedPhaseStatus === "blocked" || selectedPhaseStatus === "pending") {
      // If selected phase is pending, check if there's a previous incomplete phase
      const selectedIndex = phases.findIndex((p) => p.name === phase)
      const currentStatusIndex = phases.findIndex((p) => p.status === "current")

      if (selectedIndex > currentStatusIndex && currentStatusIndex >= 0) {
        const blockingPhase = phases[currentStatusIndex].name
        return <BlockedPhaseIndicator blockedBy={blockingPhase} />
      }
    }

    // Render phase-specific views based on selected phase
    switch (phase) {
      // Discovery uses data-driven composition via ComposablePhaseView (task-cpv-013)
      case "discovery":
        return <ComposablePhaseView phaseName="discovery" feature={feature} />

      // Analysis uses data-driven composition via ComposablePhaseView (task-analysis-009)
      case "analysis":
        return <ComposablePhaseView phaseName="analysis" feature={feature} />

      // Classification uses data-driven composition via ComposablePhaseView (task-classification-010)
      case "classification":
        return <ComposablePhaseView phaseName="classification" feature={feature} />

      // Design uses data-driven composition via ComposablePhaseView (task-design-migration)
      case "design":
        return <ComposablePhaseView phaseName="design" feature={feature} />

      // Spec uses data-driven composition via ComposablePhaseView (task-spec-010)
      case "spec":
        return <ComposablePhaseView phaseName="spec" feature={feature} />

      // Testing uses data-driven composition via ComposablePhaseView (task-testing-010)
      case "testing":
        return <ComposablePhaseView phaseName="testing" feature={feature} />

      // Implementation uses data-driven composition via ComposablePhaseView (task-implementation-010)
      case "implementation":
        return <ComposablePhaseView phaseName="implementation" feature={feature} />

      case "complete":
        return <CompleteView feature={feature} />

      default:
        // Fallback for any unimplemented phases
        return (
          <EmptyPhaseContent
            phaseName={phase}
          />
        )
    }
  }

  return (
    <div
      data-testid="phase-content-panel"
      className="flex flex-col h-full gap-4"
    >
      {/* Stepper at top */}
      <SkillStepper
        phases={phases}
        selectedPhase={phase}
        onPhaseClick={setPhase}
      />

      {/* Content area below with flex-1 for fill */}
      {/* LoadingOverlay provides subtle loading indicator during data refresh (task-3-1-008) */}
      <LoadingOverlay isLoading={isPolling} className="flex-1 overflow-auto min-h-0">
        <div
          data-testid="phase-content-area"
          className={cn(
            "h-full overflow-auto",
            "bg-card rounded-lg border p-4"
          )}
        >
          {/* Header showing current phase */}
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-foreground">
              Phase: {phaseLabel}
            </h2>
          </div>

          {/* Phase-specific content */}
          {renderPhaseContent()}
        </div>
      </LoadingOverlay>
    </div>
  )
})
