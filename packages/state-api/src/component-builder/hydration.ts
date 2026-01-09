/**
 * Hydration Module
 *
 * Transforms Registry/RendererBinding entities into ComponentEntrySpec[].
 * Implements registry inheritance chain traversal and priority-based binding resolution.
 *
 * This module is isomorphic - no React dependencies. It produces ComponentEntrySpec
 * objects that can be used by apps/web to build ComponentEntry with React.ComponentType.
 *
 * @module component-builder/hydration
 * @task task-dcb-004
 *
 * @example
 * ```typescript
 * import { hydrateRegistry } from './hydration'
 *
 * // Get registry from store
 * const registry = store.Registries.get("default")
 *
 * // Hydrate to get ComponentEntrySpec[]
 * const { specs, fallbackRef } = hydrateRegistry(registry, store)
 *
 * // specs is sorted by priority (highest first), with child-first ordering for equal priorities
 * // fallbackRef is the implementationRef for the fallback component (if any)
 * ```
 */

import { createMatcherFromExpression } from "./match-expression"
import type { ComponentEntrySpec, RegistryEntity, BindingEntity } from "./types"

// ============================================================================
// Types
// ============================================================================

/**
 * Result of hydrating a registry.
 */
export interface HydrationResult {
  /**
   * ComponentEntrySpec array sorted by priority (highest first).
   * For equal priorities, child bindings appear before parent bindings.
   */
  specs: ComponentEntrySpec[]

  /**
   * The implementationRef for the fallback component, if defined.
   * Resolved from registry.fallbackComponent.implementationRef,
   * with inheritance from parent registries.
   */
  fallbackRef?: string
}

/**
 * Minimal store interface for hydration.
 * The store provides collection accessors for querying entities.
 */
export interface HydrationStore {
  Registries: {
    get: (id: string) => RegistryEntity | undefined
    all: () => RegistryEntity[]
  }
  ComponentDefinitions: {
    get: (id: string) => any | undefined
    all: () => any[]
  }
  RendererBindings: {
    get: (id: string) => BindingEntity | undefined
    all: () => BindingEntity[]
  }
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Recursively collects bindings from a registry and its parent registries.
 *
 * Traverses the `extends` chain to collect all bindings, with child bindings
 * appearing before parent bindings in the result array.
 *
 * Includes circular reference detection to prevent infinite loops when
 * registries have cycles in their extends chain.
 *
 * @param registry - The registry entity to start from
 * @param store - The store for entity lookups
 * @param visited - Set of visited registry IDs for cycle detection (internal)
 * @returns Array of bindings, child-first order
 *
 * @example
 * ```typescript
 * const bindings = collectBindingsWithInheritance(registry, store)
 * // bindings[0..n] are from registry
 * // bindings[n+1..m] are from registry.extends
 * // bindings[m+1..p] are from registry.extends.extends
 * // etc.
 * ```
 */
export function collectBindingsWithInheritance(
  registry: RegistryEntity,
  store: HydrationStore,
  visited: Set<string> = new Set()
): BindingEntity[] {
  // Circular reference detection
  if (visited.has(registry.id)) {
    return []
  }
  visited.add(registry.id)

  // Collect bindings from this registry (child-first)
  const bindings: BindingEntity[] = [...(registry.bindings || [])]

  // Recursively collect from parent registry
  if (registry.extends) {
    const parentBindings = collectBindingsWithInheritance(
      registry.extends,
      store,
      visited
    )
    bindings.push(...parentBindings)
  }

  return bindings
}

/**
 * Resolves the fallback component implementationRef from a registry.
 *
 * Traverses the `extends` chain to find the first defined fallbackComponent,
 * with child taking precedence over parent.
 *
 * @param registry - The registry entity to start from
 * @param store - The store for entity lookups
 * @param visited - Set of visited registry IDs for cycle detection (internal)
 * @returns The fallback implementationRef, or undefined if none defined
 */
function resolveFallbackRef(
  registry: RegistryEntity,
  store: HydrationStore,
  visited: Set<string> = new Set()
): string | undefined {
  // Circular reference detection
  if (visited.has(registry.id)) {
    return undefined
  }
  visited.add(registry.id)

  // Check this registry first (child takes precedence)
  if (registry.fallbackComponent) {
    return registry.fallbackComponent.implementationRef
  }

  // Check parent registry
  if (registry.extends) {
    return resolveFallbackRef(registry.extends, store, visited)
  }

  return undefined
}

/**
 * Converts a single RendererBinding entity to a ComponentEntrySpec.
 *
 * Creates the matcher function from the binding's matchExpression using
 * createMatcherFromExpression, and extracts the componentRef from the
 * component's implementationRef.
 *
 * @param binding - The binding entity to convert
 * @returns ComponentEntrySpec with id, priority, matcher, and componentRef
 */
function bindingToSpec(binding: BindingEntity): ComponentEntrySpec {
  return {
    id: binding.id,
    priority: binding.priority,
    matcher: createMatcherFromExpression(binding.matchExpression),
    componentRef: binding.component.implementationRef
  }
}

/**
 * Hydrates a registry into ComponentEntrySpec[] with optional fallback.
 *
 * This is the main entry point for the hydration module. It:
 * 1. Collects all bindings from the registry and its extends chain (child-first)
 * 2. Sorts bindings by priority (highest first), preserving child-first order for equal priorities
 * 3. Converts each binding to a ComponentEntrySpec
 * 4. Resolves the fallback component from the registry chain
 *
 * The resulting specs can be used by apps/web to build a ComponentRegistry:
 * ```typescript
 * // In apps/web
 * const { specs, fallbackRef } = hydrateRegistry(registry, store)
 * const entries = specs.map(spec => specToEntry(spec, implementationMap))
 * const registry = new ComponentRegistry(entries, fallbackRef)
 * ```
 *
 * @param registry - The registry entity to hydrate
 * @param store - The store for entity lookups
 * @returns HydrationResult with specs array and optional fallbackRef
 *
 * @example
 * ```typescript
 * const registry = store.Registries.get("default")
 * const { specs, fallbackRef } = hydrateRegistry(registry, store)
 *
 * // specs is sorted by priority (highest first)
 * // For equal priorities, child bindings come before parent bindings
 * console.log(specs[0].id) // Highest priority binding
 * console.log(fallbackRef) // "FallbackDisplay" or undefined
 * ```
 */
export function hydrateRegistry(
  registry: RegistryEntity,
  store: HydrationStore
): HydrationResult {
  // Collect all bindings with inheritance (child-first)
  const bindings = collectBindingsWithInheritance(registry, store)

  // Sort by priority (highest first), using stable sort to preserve child-first order
  // for equal priorities
  const sortedBindings = [...bindings].sort((a, b) => b.priority - a.priority)

  // Convert to ComponentEntrySpec
  const specs = sortedBindings.map(bindingToSpec)

  // Resolve fallback
  const fallbackRef = resolveFallbackRef(registry, store)

  return {
    specs,
    fallbackRef
  }
}
