/**
 * Provider Implementation Map
 *
 * Maps providerWrapper strings to their corresponding React provider components.
 * This bridges composition data (from Wavesmith) to code-side provider implementations.
 *
 * Provider components wrap the SlotLayout to provide shared context to all
 * section components within a phase view.
 *
 * Note: This package provides only the infrastructure. Feature-specific providers
 * (AnalysisPanelProvider, TestingPanelProvider, etc.) should be registered by
 * the consuming application.
 *
 * @example
 * ```typescript
 * // Register a provider in your application
 * import { providerImplementationMap } from '@shogo/composition-runtime'
 * import { AnalysisPanelProvider } from './sections/analysis/AnalysisPanelContext'
 *
 * providerImplementationMap.set("AnalysisPanelProvider", AnalysisPanelProvider)
 *
 * // Later, ComposablePhaseView looks it up
 * const ProviderComponent = getProviderComponent("AnalysisPanelProvider")
 * ```
 */

import type { ComponentType, ReactNode } from "react"

/**
 * Props passed to provider wrapper components.
 *
 * Provider components receive:
 * - children: The SlotLayout content to wrap
 * - feature: The current FeatureSession data
 * - config: Optional configuration from composition.providerConfig
 */
export interface ProviderWrapperProps {
  /**
   * The SlotLayout content that should be wrapped
   */
  children: ReactNode

  /**
   * The current feature session data.
   * Typed as 'any' to match codebase patterns for MST instance types.
   */
  feature: any

  /**
   * Optional configuration from the composition's providerConfig field.
   * Allows customization of provider behavior without creating new implementations.
   */
  config?: Record<string, unknown>
}

/**
 * Map of providerWrapper strings to React provider components.
 *
 * This map starts empty. Feature-specific providers should be registered
 * by the consuming application:
 * ```typescript
 * providerImplementationMap.set("AnalysisPanelProvider", AnalysisPanelProvider)
 * providerImplementationMap.set("TestingPanelProvider", TestingPanelProvider)
 * ```
 */
export const providerImplementationMap = new Map<
  string,
  ComponentType<ProviderWrapperProps>
>()

/**
 * Safely retrieves a provider component by its name string.
 *
 * @param name - The string key to look up in the map
 * @returns The corresponding React provider component, or null if not found
 *
 * @example
 * ```typescript
 * const Provider = getProviderComponent("AnalysisPanelProvider")
 * if (Provider) {
 *   return <Provider feature={feature}>{children}</Provider>
 * }
 * ```
 */
export function getProviderComponent(
  name: string
): ComponentType<ProviderWrapperProps> | null {
  if (!name) {
    return null
  }
  return providerImplementationMap.get(name) ?? null
}

/**
 * Helper: Register a provider for use in ComposablePhaseView
 *
 * @param name - The provider name to register (matches composition.providerWrapper)
 * @param provider - The React provider component
 *
 * @example
 * ```typescript
 * registerProvider("AnalysisPanelProvider", AnalysisPanelProvider)
 * ```
 */
export function registerProvider(
  name: string,
  provider: ComponentType<ProviderWrapperProps>
) {
  providerImplementationMap.set(name, provider)
}

export default providerImplementationMap
