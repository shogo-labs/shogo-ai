/**
 * Component Rendering System
 *
 * Schema-aware dynamic component system for React.
 * Renders UI from Enhanced JSON Schema metadata.
 *
 * Task: task-component-registry, task-display-renderers, task-demo-page
 */

// Types
export type {
  PropertyMetadata,
  ComponentEntry,
  DisplayRendererProps,
  IComponentRegistry,
  SectionRendererProps
} from "./types"

// Registry
export { ComponentRegistry, createComponentRegistry } from "./ComponentRegistry"
export type { ComponentRegistryConfig } from "./ComponentRegistry"

// Context and hooks
export {
  ComponentRegistryProvider,
  useComponentRegistry,
  // Hydration (task-dcb-007)
  useHydratedRegistry,
  RegistryHydrationProvider
} from "./ComponentRegistryContext"

// Hydration types (task-dcb-007)
export type {
  HydratedRegistryResult,
  ComponentImplementationMap,
  RegistryHydrationProviderProps
} from "./ComponentRegistryContext"

// PropertyRenderer
export { PropertyRenderer } from "./PropertyRenderer"

// Display components
export * from "./displays"

// Default registry factory
export { createDefaultRegistry } from "./defaultRegistry"

// Studio registry factory (includes domain renderers)
export { createStudioRegistry } from "./studioRegistry"

// Domain-specific renderers and variants
export * from "./displays/domain"

// Component implementations map (task-dcb-003)
export { componentImplementationMap, getComponent } from "./implementations"

// Seed data (task-dcb-005)
export {
  seedComponentBuilderData,
  COMPONENT_DEFINITIONS,
  REGISTRY_DEFINITIONS,
  DEFAULT_BINDINGS,
  STUDIO_BINDINGS
} from "./seedData"

// Section implementations map (task-cpv-005)
export { sectionImplementationMap, getSectionComponent } from "./sectionImplementations"
// SectionRendererProps is exported from ./types above

// Composition components (task-cpv-011, task-cpv-012)
export { SlotLayout } from "./composition/SlotLayout"
export type { SlotLayoutProps, SlotDefinition, LayoutTemplateData } from "./composition/SlotLayout"
export { ComposablePhaseView } from "./composition/ComposablePhaseView"
export type { ComposablePhaseViewProps } from "./composition/ComposablePhaseView"
