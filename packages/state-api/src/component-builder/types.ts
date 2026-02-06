/**
 * Component Builder Type Definitions
 *
 * Isomorphic types for the component-builder domain that can be used
 * in both state-api (MCP, tests) and apps/web (React).
 *
 * Key principle: These types have NO React dependency, enabling them
 * to be used in the MCP layer for entity hydration.
 *
 * Task: task-dcb-006
 */

/**
 * Universal configuration interface for display components.
 *
 * XRendererConfig enables Claude to dynamically adjust rendering appearance
 * and behavior via MCP without code changes. Components declare which config
 * keys they support via `supportedConfig` static property.
 *
 * Config cascade (highest to lowest priority):
 * 1. Schema-level `x-renderer-config` on property definition
 * 2. Binding-level `defaultConfig` on RendererBinding entity
 * 3. Component-level defaults (baked into component)
 */
export interface XRendererConfig {
  /** Visual variant for emphasis or semantic meaning */
  variant?: "default" | "muted" | "emphasized" | "warning" | "success" | "error"
  /** Text/element size */
  size?: "xs" | "sm" | "md" | "lg" | "xl"
  /** Layout mode */
  layout?: "inline" | "block" | "compact"
  /** Truncate text at character count (number) or default 200 (true) */
  truncate?: boolean | number
  /** Allow expanding truncated content */
  expandable?: boolean
  /** Make element interactive/clickable */
  clickable?: boolean
  /** Pass-through for component-specific props */
  customProps?: Record<string, unknown>
}

/**
 * Universal props interface for renderable display components.
 *
 * All display components should accept these props to enable:
 * - PropertyRenderer integration
 * - Config cascade from bindings
 * - Recursive rendering via depth tracking
 */
export interface RenderableComponentProps<T = any> {
  /** Property metadata for resolution context */
  property: PropertyMetadata
  /** The value to render */
  value: T
  /** Optional entity instance for reference displays */
  entity?: any
  /** Current nesting depth for recursive rendering (default 0) */
  depth?: number
  /** Merged config from cascade (binding defaults + schema overrides) */
  config?: XRendererConfig
}

/**
 * Metadata about a property, derived from EnhancedJsonSchema.
 * Used by ComponentRegistry to resolve the appropriate display renderer.
 *
 * This is the isomorphic version without React dependencies.
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
 * Intermediate format for registry entries that can be hydrated from Wavesmith entities.
 * Has NO React dependency - componentRef is a string lookup key, not a React component.
 *
 * This is produced by hydration layer in state-api and consumed by apps/web
 * to build the actual ComponentEntry with React.ComponentType.
 *
 * Hydration flow:
 * 1. RendererBinding entity (MST) -> toEntrySpec() view -> ComponentEntrySpec
 * 2. ComponentEntrySpec -> specToEntry() in apps/web -> ComponentEntry (with React.ComponentType)
 *
 * @example
 * ```typescript
 * const spec: ComponentEntrySpec = {
 *   id: "string-display",
 *   priority: 10,
 *   matcher: (meta) => meta.type === "string",
 *   componentRef: "StringDisplay"  // Looked up in implementation map
 * }
 * ```
 */
export interface ComponentEntrySpec {
  /**
   * Unique identifier for this entry.
   * Used for xRenderer explicit binding and debugging.
   */
  id: string

  /**
   * Resolution priority (higher wins).
   *
   * Convention:
   * - 200: Explicit x-renderer binding
   * - 100: Computed properties, references
   * - 50: Enum types
   * - 30: Format-specific (email, uri, date-time)
   * - 10: Type-specific (string, number, boolean, etc.)
   * - 0: Fallback
   */
  priority: number

  /**
   * Predicate function that returns true if this entry matches the property.
   * Generated from MongoDB-style matchExpression via createMatcherFromExpression().
   */
  matcher: (meta: PropertyMetadata) => boolean

  /**
   * Component implementation reference (string key, NOT React component).
   *
   * This is looked up in an implementation map to get the actual React.ComponentType.
   * The string format matches ComponentDefinition.implementationRef in the schema.
   *
   * Examples: "StringDisplay", "EnumBadge", "ReferenceDisplay", "@shogo/web/displays/Custom"
   */
  componentRef: string

  /**
   * Default XRendererConfig applied when this binding matches.
   * Can be overridden by schema-level xRendererConfig on the property.
   */
  defaultConfig?: XRendererConfig
}

/**
 * Type alias for ComponentDefinition MST entity instance.
 *
 * At runtime, this will be an MST Instance with properties like:
 * - id: string (identifier)
 * - name: string
 * - category: "display" | "input" | "layout" | "visualization"
 * - description?: string
 * - propsSchema?: object
 * - implementationRef: string
 * - previewRef?: string
 * - tags?: string[]
 * - createdAt: number
 * - updatedAt?: number
 *
 * Typed as 'any' because MST models are generated dynamically.
 * Use type assertions when you need specific property access.
 *
 * @example
 * ```typescript
 * const def: ComponentDefinitionEntity = store.ComponentDefinitions.get("string-display")
 * console.log(def.name) // TypeScript allows (no IntelliSense)
 * ```
 */
export type ComponentDefinitionEntity = any

/**
 * Type alias for Registry MST entity instance.
 *
 * At runtime, this will be an MST Instance with properties like:
 * - id: string (identifier)
 * - name: string
 * - description?: string
 * - extends?: Registry (maybe-reference)
 * - fallbackComponent?: ComponentDefinition (maybe-reference)
 * - bindings: RendererBinding[] (computed inverse)
 * - createdAt: number
 * - updatedAt?: number
 *
 * Enhanced views (from domain enhancements):
 * - allBindings: RendererBinding[] (flattened inheritance chain)
 * - toEntrySpecs(): ComponentEntrySpec[]
 *
 * Typed as 'any' because MST models are generated dynamically.
 *
 * @example
 * ```typescript
 * const registry: RegistryEntity = store.Registries.get("default")
 * const specs = registry.toEntrySpecs() // From domain enhancements
 * ```
 */
export type RegistryEntity = any

/**
 * Type alias for RendererBinding MST entity instance.
 *
 * At runtime, this will be an MST Instance with properties like:
 * - id: string (identifier)
 * - name: string
 * - registry: Registry (reference)
 * - component: ComponentDefinition (reference)
 * - matchExpression: object (MongoDB-style query)
 * - priority: number
 * - createdAt: number
 * - updatedAt?: number
 *
 * Enhanced views (from domain enhancements):
 * - matcher: (meta: PropertyMetadata) => boolean
 * - toEntrySpec(): ComponentEntrySpec
 *
 * Typed as 'any' because MST models are generated dynamically.
 *
 * @example
 * ```typescript
 * const binding: BindingEntity = store.RendererBindings.get("string-type-binding")
 * const spec = binding.toEntrySpec() // From domain enhancements
 * ```
 */
export type BindingEntity = any

/**
 * Interface for component registry implementations.
 *
 * This is the isomorphic version that both state-api and apps/web can use.
 * The apps/web version adds React-specific typing for the component field.
 *
 * Used by:
 * - IEnvironment.services.componentRegistry (optional service)
 * - apps/web ComponentRegistry class implements this
 */
/**
 * Slot specification for Composition hydration.
 *
 * Returned by Composition.toSlotSpecs() for use by renderers
 * that need to compose section components into layouts.
 *
 * @example
 * ```typescript
 * const composition = store.compositionCollection.findByName("Discovery View")
 * const specs = composition.toSlotSpecs()
 * // [
 * //   { slotName: "header", sectionRef: "HeaderSection" },
 * //   { slotName: "main", sectionRef: "ContentSection", config: { variant: "compact" } }
 * // ]
 * ```
 */
export interface SlotSpec {
  /** The slot name this content fills (matches LayoutTemplate slot name) */
  slotName: string
  /** ComponentDefinition.implementationRef for the section component */
  sectionRef: string
  /** Optional configuration passed to the component */
  config?: Record<string, unknown>
}

export interface IComponentRegistry {
  /**
   * Register a new component entry.
   * The entry can be either ComponentEntrySpec (isomorphic) or the full
   * ComponentEntry with React component (apps/web).
   */
  register(entry: ComponentEntrySpec | any): void

  /**
   * Remove a component entry by id.
   * @returns true if entry was found and removed, false otherwise
   */
  unregister(id: string): boolean

  /**
   * Resolve property metadata to the best matching component reference.
   * Returns componentRef string in isomorphic context, or React component in apps/web.
   */
  resolve(property: PropertyMetadata): string | any

  /**
   * Get all registered entries.
   */
  entries(): (ComponentEntrySpec | any)[]
}
