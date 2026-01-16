/**
 * Shared Components Barrel Export
 * Tasks: task-2-1-013, task-2-3b-001
 *
 * Exports all shared/common components for the Studio App.
 */

// Base shared components (Session 2.1)
export { UserMenu } from "./UserMenu"
export { ThemeToggle } from "./ThemeToggle"
export { AdvancedModeToggle } from "./AdvancedModeToggle"
export { SplashScreen } from "./SplashScreen"
export { CommandPalette, useCommandPalette } from "./CommandPalette"
export { SettingsModal, SettingsModalProvider, useSettingsModal } from "./SettingsModal"
export { EmptyState } from "./EmptyState"
export type { EmptyStateVariant } from "./EmptyState"

// Phase view shared cards (Session 2.3B)
export { RequirementCard, priorityBadgeVariants } from "./RequirementCard"
export type { RequirementCardProps, Requirement, RequirementPriority } from "./RequirementCard"

export { FindingCard, findingTypeBadgeVariants } from "./FindingCard"
export type { FindingCardProps, Finding, FindingType } from "./FindingCard"

export { ArchetypeBadge, archetypeBadgeVariants } from "./ArchetypeBadge"
export type { ArchetypeBadgeProps, FeatureArchetype } from "./ArchetypeBadge"

export { PatternChips } from "./PatternChips"
export type { PatternChipsProps } from "./PatternChips"

export { EvidenceChecklist } from "./EvidenceChecklist"
export type { EvidenceChecklistProps } from "./EvidenceChecklist"
