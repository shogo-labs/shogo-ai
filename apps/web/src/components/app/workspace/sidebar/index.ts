/**
 * Sidebar Components
 * Task: task-2-2-005
 *
 * Exports all sidebar components for the workspace feature navigation.
 *
 * Components:
 * - FeatureSidebar: Main container with search, groups, and new button
 * - FeatureGroup: Phase group with header and feature items
 * - FeatureItem: Clickable feature row with status badge
 * - SidebarSearch: Search input with clear button
 * - NewFeatureButton: Button to create new features
 *
 * Per design-2-2-clean-break:
 * - All components built fresh in /components/app/workspace/sidebar/
 * - Zero imports from /components/Studio/
 */

export { FeatureSidebar, type FeatureSidebarProps } from "./FeatureSidebar"
export { FeatureGroup, FEATURE_PHASES, type FeatureGroupProps, type FeaturePhase } from "./FeatureGroup"
export { FeatureItem, type FeatureItemProps, type Feature } from "./FeatureItem"
export { SidebarSearch, type SidebarSearchProps } from "./SidebarSearch"
export { NewFeatureButton, type NewFeatureButtonProps } from "./NewFeatureButton"
