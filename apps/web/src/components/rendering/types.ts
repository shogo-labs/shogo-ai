/**
 * Component Registry Type Definitions
 *
 * Defines interfaces for the schema-aware dynamic component system.
 * PropertyMetadata mirrors the x-* extensions from EnhancedJsonSchema.
 *
 * Task: task-registry-types
 * Updated: task-dcb-006 (added HydratedComponentEntry, entity type aliases)
 */

import type { ComponentType } from "react"

// Re-export isomorphic types from state-api for convenience
export type {
  ComponentEntrySpec,
  ComponentDefinitionEntity,
  RegistryEntity,
  BindingEntity,
  XRendererConfig,
  RenderableComponentProps,
} from "@shogo/state-api"

// Import XRendererConfig for local use
import type { XRendererConfig } from "@shogo/state-api"

/**
 * Metadata about a property, derived from EnhancedJsonSchema.
 * Used by ComponentRegistry to resolve the appropriate display renderer.
 *
 * Property names use camelCase (matching meta-store Property entity),
 * while the source schema uses kebab-case (x-renderer, x-computed, etc.)
 */
export interface PropertyMetadata {
  /** Property name */
  name: string
  /** JSON Schema type */
  type?: "string" | "number" | "boolean" | "array" | "object"
  /** JSON Schema format (email, uri, date-time, etc.) */
  format?: string
  /** Enum values if this is an enum type */
  enum?: string[]
  /** Reference type: single or array */
  xReferenceType?: "single" | "array"
  /** Target model name for references */
  xReferenceTarget?: string
  /** Whether this is a computed/derived property */
  xComputed?: boolean
  /** Explicit renderer binding (overrides cascade) */
  xRenderer?: string
  /** Whether this property is required */
  required?: boolean
  /** Renderer configuration for this property (overrides binding defaults) */
  xRendererConfig?: XRendererConfig
}

/**
 * Props passed to display renderer components.
 *
 * Components receive:
 * - property: Metadata about the property being rendered
 * - value: The actual value to display
 * - entity: Optional resolved entity (for references)
 * - depth: Current nesting depth (for arrays/objects)
 */
export interface DisplayRendererProps {
  /** Property metadata for the value being rendered */
  property: PropertyMetadata
  /** The value to render (any type) */
  value: any
  /** Optional resolved entity for reference displays */
  entity?: any
  /** Current nesting depth for recursive rendering (max 2) */
  depth?: number
  /** Merged config from cascade (binding defaults + schema overrides) */
  config?: XRendererConfig
}

/**
 * A registry entry that maps property metadata to a component.
 *
 * The registry uses priority-based cascade resolution:
 * 1. xRenderer explicit (200) - check registry by id
 * 2. xComputed (100) - ComputedDisplay
 * 3. xReferenceType (100) - ReferenceDisplay / ReferenceArrayDisplay
 * 4. enum (50) - EnumBadge
 * 5. format (30) - DateTimeDisplay, EmailDisplay, UriDisplay
 * 6. type (10) - StringDisplay, NumberDisplay, BooleanDisplay, etc.
 * 7. fallback (0) - StringDisplay
 */
export interface ComponentEntry {
  /** Unique identifier for this entry (used by xRenderer explicit binding) */
  id: string
  /** Predicate function that returns true if this entry matches the property */
  matches: (meta: PropertyMetadata) => boolean
  /** The React component to render for matching properties */
  component: ComponentType<DisplayRendererProps>
  /** Priority for cascade resolution (higher wins). Defaults to 10. */
  priority?: number
  /** Default XRendererConfig applied when this entry matches */
  defaultConfig?: XRendererConfig
}

/**
 * A ComponentEntry that was hydrated from a RendererBinding entity.
 *
 * Extends ComponentEntry with tracking information for the source entity,
 * enabling the registry to maintain reactivity with Wavesmith entities.
 *
 * Used by:
 * - registryFactory.ts: Creates HydratedComponentEntry from RendererBinding entities
 * - ComponentBuilderContext: Tracks entity source for MobX reactivity
 *
 * Task: task-dcb-006
 *
 * @example
 * ```typescript
 * const entry: HydratedComponentEntry = {
 *   id: "string-display",
 *   matches: (meta) => meta.type === "string",
 *   component: StringDisplay,
 *   priority: 10,
 *   entityId: "binding-string-display-001"  // RendererBinding entity ID
 * }
 * ```
 */
export interface HydratedComponentEntry extends ComponentEntry {
  /**
   * ID of the RendererBinding entity this entry was hydrated from.
   *
   * Enables:
   * - Tracing entries back to their source entity
   * - MobX reactivity when the source entity changes
   * - Debugging which entity produced which registry entry
   */
  entityId: string
}

/**
 * Component Registry interface.
 *
 * Resolves property metadata to display components using cascade priority.
 */
export interface IComponentRegistry {
  /** Register a new component entry */
  register(entry: ComponentEntry): void
  /** Remove a component entry by id */
  unregister(id: string): boolean
  /** Resolve property metadata to the best matching component */
  resolve(property: PropertyMetadata): ComponentType<DisplayRendererProps>
  /** Get all registered entries */
  entries(): ComponentEntry[]
}
