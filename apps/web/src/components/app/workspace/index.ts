/**
 * Workspace Module
 * Tasks: task-2-2-002, task-2-2-003, task-2-2-004, task-2-2-005, task-2-2-006, task-2-2-007, task-2-2-008
 *
 * Barrel export for all workspace components, hooks, and sub-modules.
 *
 * Per design-2-2-clean-break:
 * - Only exports from /components/app/workspace/ subdirectories
 * - Zero re-exports from /components/Studio/
 *
 * Usage:
 *   import { OrgSwitcher, WorkspaceLayout } from "@/components/app/workspace"
 *   import { FeatureSidebar, NewFeatureModal } from "@/components/app/workspace"
 */

// ============================================================
// Core Workspace Components
// ============================================================
export { WorkspaceLayout } from "./WorkspaceLayout"
export { OrgSwitcher } from "./OrgSwitcher"
export type { OrgSwitcherProps, Organization } from "./OrgSwitcher"
export { ProjectSelector } from "./ProjectSelector"
export type { ProjectSelectorProps, Project } from "./ProjectSelector"

// ============================================================
// Sidebar Components
// ============================================================
export {
  FeatureSidebar,
  FeatureGroup,
  FeatureItem,
  SidebarSearch,
  NewFeatureButton,
  FEATURE_PHASES,
  statusBadgeVariants,
} from "./sidebar"
export type {
  FeatureSidebarProps,
  FeatureGroupProps,
  FeatureItemProps,
  FeaturePhase,
  Feature,
  SidebarSearchProps,
  NewFeatureButtonProps,
} from "./sidebar"

// ============================================================
// Dashboard Components
// ============================================================
export {
  ProjectDashboard,
  StatsCards,
  STAT_PHASES,
} from "./dashboard"
export type {
  ProjectDashboardProps,
  StatsCardsProps,
  StatPhase,
} from "./dashboard"

// ============================================================
// Modal Components
// ============================================================
export { NewFeatureModal } from "./modals"
export type { NewFeatureModalProps } from "./modals"

// ============================================================
// Hooks
// ============================================================
export {
  useWorkspaceNavigation,
  useWorkspaceData,
  PHASES,
} from "./hooks"
export type {
  WorkspaceNavigationState,
  WorkspaceDataState,
  Phase,
} from "./hooks"
