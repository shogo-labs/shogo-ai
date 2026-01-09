/**
 * Sidebar Components
 * Task: task-2-2-005
 * Updated: task-dcb-013 (added Component* exports)
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
 * Component Builder Components (task-dcb-009, task-dcb-010, task-dcb-011):
 * - ComponentCatalogSidebar: Main sidebar for component catalog
 * - ComponentGroup: Collapsible category section
 * - ComponentItem: Individual component row
 *
 * Per design-2-2-clean-break:
 * - All components built fresh in /components/app/workspace/sidebar/
 * - Zero imports from /components/Studio/
 */

// Feature sidebar components
export { FeatureSidebar, type FeatureSidebarProps } from "./FeatureSidebar"
export { FeatureGroup, FEATURE_PHASES, type FeatureGroupProps, type FeaturePhase } from "./FeatureGroup"
export { FeatureItem, type FeatureItemProps, type Feature } from "./FeatureItem"
export { SidebarSearch, type SidebarSearchProps } from "./SidebarSearch"
export { NewFeatureButton, type NewFeatureButtonProps } from "./NewFeatureButton"

// Component catalog components (task-dcb-009, task-dcb-010, task-dcb-011)
export { ComponentCatalogSidebar, type ComponentCatalogSidebarProps } from "./ComponentCatalogSidebar"
export { ComponentGroup, COMPONENT_CATEGORIES, type ComponentGroupProps, type ComponentCategory, type ComponentDefinitionEntity } from "./ComponentGroup"
export { ComponentItem, type ComponentItemProps, type ComponentDefinition } from "./ComponentItem"
