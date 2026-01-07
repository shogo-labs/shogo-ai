/**
 * ComponentRegistryContext - React context for ComponentRegistry injection
 *
 * Follows WavesmithMetaStoreContext pattern from apps/web/src/contexts/
 *
 * Usage:
 * ```tsx
 * const registry = createComponentRegistry({ defaultComponent, entries })
 *
 * <ComponentRegistryProvider registry={registry}>
 *   <MyApp />
 * </ComponentRegistryProvider>
 *
 * function MyComponent() {
 *   const registry = useComponentRegistry()
 *   const Component = registry.resolve(propertyMetadata)
 *   return <Component property={metadata} value={value} />
 * }
 * ```
 *
 * Task: task-component-registry
 */

import { createContext, useContext, type ReactNode } from "react"
import type { ComponentRegistry } from "./ComponentRegistry"

/**
 * Context for ComponentRegistry
 */
const ComponentRegistryContext = createContext<ComponentRegistry | null>(null)

export interface ComponentRegistryProviderProps {
  /** The registry instance to provide */
  registry: ComponentRegistry
  children: ReactNode
}

/**
 * Provider that makes ComponentRegistry available to descendants.
 *
 * The registry instance is passed directly (not created internally)
 * to allow configuration at the application level.
 */
export function ComponentRegistryProvider({
  registry,
  children
}: ComponentRegistryProviderProps) {
  return (
    <ComponentRegistryContext.Provider value={registry}>
      {children}
    </ComponentRegistryContext.Provider>
  )
}

/**
 * Hook to access the ComponentRegistry.
 *
 * @throws Error if used outside of ComponentRegistryProvider
 * @returns The ComponentRegistry instance
 */
export function useComponentRegistry(): ComponentRegistry {
  const context = useContext(ComponentRegistryContext)
  if (!context) {
    throw new Error(
      "useComponentRegistry must be used within ComponentRegistryProvider"
    )
  }
  return context
}
