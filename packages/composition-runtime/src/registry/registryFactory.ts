/**
 * Registry Factory - Domain-Driven Component Registry Creation
 * Task: task-sdr-v2-003
 *
 * Creates ComponentRegistry instances from component-builder domain entities.
 * Replaces hardcoded studioRegistry.ts with data-driven approach.
 *
 * Vision principle: "Make inputs data-driven, not replace resolution logic"
 * The factory bridges Wavesmith entities to runtime ComponentRegistry using
 * the existing hydration layer.
 *
 * Flow:
 * 1. Query componentBuilder.registryCollection.defaultRegistry
 * 2. Call registry.toEntrySpecs() to get ComponentEntrySpec[]
 * 3. Map each spec via specToEntry() using implementations map
 * 4. Return new ComponentRegistry with mapped entries
 */

import type { ComponentType } from "react"
import type {
  ComponentEntrySpec,
  ComponentEntry,
  PropertyMetadata,
  DisplayRendererProps,
} from "../types"
import { ComponentRegistry, createComponentRegistry } from "./ComponentRegistry"
import { componentImplementationMap, getComponent } from "../rendering/implementations"
import { StringDisplay } from "../displays"

/**
 * Type for the component-builder domain store.
 * Uses 'any' because the actual MST instance is dynamically generated.
 */
type ComponentBuilderStore = {
  registryCollection: {
    defaultRegistry: any | undefined
  }
}

/**
 * Default fallback component used when no implementation is found.
 * Uses StringDisplay as the safest fallback for unknown types.
 */
const FallbackDisplay = StringDisplay

/**
 * Converts a ComponentEntrySpec (isomorphic, no React) to a ComponentEntry (with React component).
 *
 * This bridges the gap between entity-based specs from the domain layer
 * and actual React components from the implementations map.
 *
 * @param spec - The ComponentEntrySpec from domain.toEntrySpec()
 * @returns ComponentEntry with resolved React component
 *
 * @example
 * ```typescript
 * const spec: ComponentEntrySpec = {
 *   id: "string-type",
 *   priority: 10,
 *   matcher: (meta) => meta.type === "string",
 *   componentRef: "StringDisplay"
 * }
 * const entry = specToEntry(spec)
 * // entry.component is now the actual StringDisplay React component
 * ```
 */
export function specToEntry(spec: ComponentEntrySpec): ComponentEntry {
  // Resolve componentRef to actual React component
  // Falls back to FallbackDisplay if ref not found in map
  const component = componentImplementationMap.get(spec.componentRef) ?? FallbackDisplay

  return {
    id: spec.id,
    priority: spec.priority,
    matches: spec.matcher,
    component,
    defaultConfig: spec.defaultConfig,
  }
}

/**
 * Default entries for fallback registry when no domain registry exists.
 * Provides basic type-based resolution as a safety net.
 */
function createDefaultFallbackEntries(): ComponentEntry[] {
  return [
    // xRenderer explicit binding - highest priority (matches x-renderer: "image-display")
    {
      id: "default-image-display-explicit",
      matches: (meta: PropertyMetadata) => meta.xRenderer === "image-display",
      component: getComponent("ImageDisplay"),
      priority: 200,
    },
    // xRenderer implicit - URI format + image-related name pattern
    {
      id: "default-image-display-implicit",
      matches: (meta: PropertyMetadata) => {
        if (meta.format !== "uri") return false
        const name = meta.name?.toLowerCase() ?? ""
        return /image|photo|avatar|thumbnail|cover|logo|icon|picture|banner/.test(name)
      },
      component: getComponent("ImageDisplay"),
      priority: 40,
    },
    // xComputed - highest priority for computed fields
    {
      id: "default-computed",
      matches: (meta: PropertyMetadata) => meta.xComputed === true,
      component: getComponent("ComputedDisplay"),
      priority: 100,
    },
    // xReferenceType single
    {
      id: "default-reference-single",
      matches: (meta: PropertyMetadata) => meta.xReferenceType === "single",
      component: getComponent("ReferenceDisplay"),
      priority: 100,
    },
    // xReferenceType array
    {
      id: "default-reference-array",
      matches: (meta: PropertyMetadata) => meta.xReferenceType === "array",
      component: getComponent("ArrayDisplay"),
      priority: 100,
    },
    // enum
    {
      id: "default-enum",
      matches: (meta: PropertyMetadata) => Array.isArray(meta.enum) && meta.enum.length > 0,
      component: getComponent("EnumBadge"),
      priority: 50,
    },
    // format: date-time
    {
      id: "default-datetime",
      matches: (meta: PropertyMetadata) => meta.format === "date-time",
      component: getComponent("DateTimeDisplay"),
      priority: 30,
    },
    // format: email
    {
      id: "default-email",
      matches: (meta: PropertyMetadata) => meta.format === "email",
      component: getComponent("EmailDisplay"),
      priority: 30,
    },
    // format: uri
    {
      id: "default-uri",
      matches: (meta: PropertyMetadata) => meta.format === "uri",
      component: getComponent("UriDisplay"),
      priority: 30,
    },
    // type: number
    {
      id: "default-number",
      matches: (meta: PropertyMetadata) => meta.type === "number",
      component: getComponent("NumberDisplay"),
      priority: 10,
    },
    // type: boolean
    {
      id: "default-boolean",
      matches: (meta: PropertyMetadata) => meta.type === "boolean",
      component: getComponent("BooleanDisplay"),
      priority: 10,
    },
    // type: array
    {
      id: "default-array",
      matches: (meta: PropertyMetadata) => meta.type === "array",
      component: getComponent("ArrayDisplay"),
      priority: 10,
    },
    // type: object
    {
      id: "default-object",
      matches: (meta: PropertyMetadata) => meta.type === "object",
      component: getComponent("ObjectDisplay"),
      priority: 10,
    },
    // type: string
    {
      id: "default-string",
      matches: (meta: PropertyMetadata) => meta.type === "string",
      component: getComponent("StringDisplay"),
      priority: 10,
    },
  ]
}

/**
 * Creates a ComponentRegistry from a component-builder domain store.
 *
 * This is the main factory function that bridges Wavesmith entities
 * to the runtime ComponentRegistry system.
 *
 * @param componentBuilder - The component-builder domain store instance
 * @returns ComponentRegistry populated with entries from domain bindings
 *
 * @example
 * ```typescript
 * // In React component with DomainProvider context
 * const { componentBuilder } = useDomains()
 * const registry = createRegistryFromDomain(componentBuilder)
 *
 * // Use registry for property resolution
 * const Component = registry.resolve(propertyMetadata)
 * ```
 */
export function createRegistryFromDomain(componentBuilder: ComponentBuilderStore): ComponentRegistry {
  // Query the default registry from domain
  const defaultRegistry = componentBuilder.registryCollection.defaultRegistry

  // If no default registry exists, return fallback registry
  if (!defaultRegistry) {
    return createComponentRegistry({
      defaultComponent: FallbackDisplay,
      entries: createDefaultFallbackEntries(),
    })
  }

  // Get entry specs from domain enhancements
  const specs: ComponentEntrySpec[] = defaultRegistry.toEntrySpecs()

  // Map specs to entries with resolved React components
  const entries = specs.map(specToEntry)

  // Create and return registry with domain-driven entries
  return createComponentRegistry({
    defaultComponent: FallbackDisplay,
    entries,
  })
}
