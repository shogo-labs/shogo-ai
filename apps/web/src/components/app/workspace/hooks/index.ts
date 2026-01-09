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

export { useDeleteFeature } from "./useDeleteFeature"
export type { UseDeleteFeatureProps, UseDeleteFeatureReturn } from "./useDeleteFeature"

// Task: task-dcb-008 - Component Builder Store Hook
export { useComponentBuilderStore } from "./useComponentBuilderStore"
export type {
  ComponentBuilderStoreResult,
  ComponentBuilderStore,
  ComponentDefinitionEntity,
  RegistryEntity,
  BindingEntity,
  CollectionAccessor,
  BindingCollectionAccessor,
} from "./useComponentBuilderStore"
