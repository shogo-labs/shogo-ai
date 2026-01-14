/**
 * Provider Implementation Map
 * Task: task-prephase-003
 *
 * Maps providerWrapper strings to their corresponding React provider components.
 * This bridges composition data (from Wavesmith) to code-side provider implementations.
 *
 * Provider components wrap the SlotLayout to provide shared context to all
 * section components within a phase view.
 *
 * @example
 * ```typescript
 * // Register a provider
 * providerImplementationMap.set("AnalysisPanelProvider", AnalysisPanelProvider)
 *
 * // Later, ComposablePhaseView looks it up
 * const ProviderComponent = getProviderComponent("AnalysisPanelProvider")
 * ```
 */

import type { ComponentType, ReactNode } from "react"
import { AnalysisPanelProvider } from "../sections/analysis/AnalysisPanelContext"
import { TestingPanelProvider } from "../sections/testing/TestingPanelContext"
import { ImplementationPanelProvider } from "../sections/implementation/ImplementationPanelContext"
import { WorkspaceProvider } from "../sections/workspace/WorkspaceContext"
import { ComponentBuilderProvider } from "../sections/component-builder/ComponentBuilderContext"

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
 * Fallback provider that renders children without wrapping.
 * Used when the requested provider is not found in the map.
 */
function FallbackProvider({ children }: ProviderWrapperProps) {
  return <>{children}</>
}

/**
 * Map of providerWrapper strings to React provider components.
 *
 * @example
 * ```typescript
 * // Register providers as they are created
 * providerImplementationMap.set("AnalysisPanelProvider", AnalysisPanelProvider)
 * providerImplementationMap.set("TestingPanelProvider", TestingPanelProvider)
 * providerImplementationMap.set("ImplementationPanelProvider", ImplementationPanelProvider)
 * ```
 */
export const providerImplementationMap = new Map<
  string,
  ComponentType<ProviderWrapperProps>
>([
  // Provider components registered for composable phase views
  // Analysis phase provider - coordinates viewMode and activeFilter state
  ["AnalysisPanelProvider", AnalysisPanelProvider],
  // Testing phase provider - coordinates selectedSpec state
  ["TestingPanelProvider", TestingPanelProvider],
  // Implementation phase provider - coordinates selectedExecutionId, latestRun, sortedExecutions, currentTDDStage
  ["ImplementationPanelProvider", ImplementationPanelProvider],
  // Workspace provider - coordinates dynamic workspace state for advanced-chat
  ["WorkspaceProvider", WorkspaceProvider],
  // Component Builder provider - coordinates UI state for component builder (layout, tabs, property selection)
  ["ComponentBuilderProvider", ComponentBuilderProvider],
])

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
 * Test helper: Register a mock provider for testing
 * This is a temporary provider that wraps children with a data attribute
 * for test verification.
 */
export function registerTestProvider(name: string) {
  const TestProvider = ({ children, feature, config }: ProviderWrapperProps) => (
    <div data-provider-wrapper={name} data-testid={`provider-${name}`}>
      {children}
    </div>
  )
  providerImplementationMap.set(name, TestProvider)
}

// Register a default test provider for tests
registerTestProvider("TestProvider")

export default providerImplementationMap
