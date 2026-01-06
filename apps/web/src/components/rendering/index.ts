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
  IComponentRegistry
} from "./types"

// Registry
export { ComponentRegistry, createComponentRegistry } from "./ComponentRegistry"
export type { ComponentRegistryConfig } from "./ComponentRegistry"

// Context and hooks
export {
  ComponentRegistryProvider,
  useComponentRegistry
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
