/**
 * Workspace Hooks
 * Task: task-2-2-002
 *
 * Barrel export for workspace navigation and data hooks.
 */

export { useWorkspaceNavigation } from "./useWorkspaceNavigation"
export type { WorkspaceNavigationState } from "./useWorkspaceNavigation"

export { useWorkspaceData, PHASES } from "./useWorkspaceData"
export type { WorkspaceDataState, Phase } from "./useWorkspaceData"
