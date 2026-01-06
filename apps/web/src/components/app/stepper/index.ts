/**
 * Stepper Components Barrel Export
 * Task: task-2-3a-010
 *
 * Exports all stepper components and hooks for clean imports.
 *
 * Per design-2-3a-file-structure:
 * - All stepper components exported from this barrel
 * - Re-exported from components/app/index.ts
 *
 * Usage:
 *   import { SkillStepper, PhaseContentPanel } from '@/components/app/stepper'
 *   import { usePhaseNavigation, PhaseStatus } from '@/components/app'
 */

// Components
export { SkillStepper } from "./SkillStepper"
export type { SkillStepperProps } from "./SkillStepper"

export { PhaseNode, phaseNodeVariants } from "./PhaseNode"
export type { PhaseNodeProps } from "./PhaseNode"

export { PhaseConnector } from "./PhaseConnector"
export type { PhaseConnectorProps } from "./PhaseConnector"

export { PhaseContentPanel } from "./PhaseContentPanel"
export type { PhaseContentPanelProps, FeatureForPanel } from "./PhaseContentPanel"

export { EmptyPhaseContent, BlockedPhaseIndicator } from "./EmptyStates"
export type { EmptyPhaseContentProps, BlockedPhaseIndicatorProps } from "./EmptyStates"

export { RunPhaseButton } from "./RunPhaseButton"
export type { RunPhaseButtonProps } from "./RunPhaseButton"

// Hooks
export { usePhaseNavigation } from "./hooks/usePhaseNavigation"
export type { StepperPhase, UsePhaseNavigationResult } from "./hooks/usePhaseNavigation"

// Utilities and Types
export { getPhaseStatus, PHASE_CONFIG, StatusOrder } from "./phaseUtils"
export type { PhaseStatus, PhaseConfig } from "./phaseUtils"

// Phase View Components (Session 2.3B, 2.3C, 2.3D)
export * from "./phases"

// Card Components (Session 2.3D)
export * from "./cards"
