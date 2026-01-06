/**
 * Phase Views Barrel Export
 * Tasks: task-2-3b-010, task-2-3c-015
 *
 * Exports all phase view components for the Studio App stepper.
 *
 * Per design-2-3b-component-hierarchy:
 * - Phase views in /components/app/stepper/phases/
 * - Re-exported from /components/app/stepper/index.ts
 *
 * Usage:
 *   import { DiscoveryView, AnalysisView, ClassificationView, DesignView } from '@/components/app/stepper/phases'
 */

// Phase View Components (Session 2.3B)
export { DiscoveryView } from "./DiscoveryView"
export type { DiscoveryViewProps, DiscoveryFeature } from "./DiscoveryView"

export { AnalysisView } from "./AnalysisView"
export type { AnalysisViewProps, AnalysisFeature } from "./AnalysisView"

export { ClassificationView } from "./ClassificationView"
export type { ClassificationViewProps, ClassificationFeature } from "./ClassificationView"

// Phase View Components (Session 2.3C)
export { DesignView } from "./design"
export type { DesignViewProps } from "./design"

// Re-export design submodule components for advanced usage
export * from "./design"

// Phase View Components (Session 2.3D)
export { SpecView } from "./spec/SpecView"
export type { SpecViewProps, SpecFeature } from "./spec/SpecView"

export { TestingView } from "./testing/TestingView"
export type { TestingViewProps, TestingFeature } from "./testing/TestingView"

export { ImplementationView } from "./implementation/ImplementationView"
export type { ImplementationViewProps, ImplementationFeature } from "./implementation/ImplementationView"

export { CompleteView } from "./complete/CompleteView"
export type { CompleteViewProps, CompleteFeature } from "./complete/CompleteView"
