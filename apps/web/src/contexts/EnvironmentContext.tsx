/**
 * EnvironmentContext - Centralized MST environment configuration provider
 *
 * Provides IEnvironment (persistence, auth, context) to descendant providers
 * (DomainProvider, MetaStoreProvider) via React context.
 *
 * Usage:
 * ```tsx
 * const env = createEnvironment({
 *   persistence: new MCPPersistence(mcpService),
 *   workspace: import.meta.env.VITE_WORKSPACE
 * })
 *
 * <EnvironmentProvider env={env}>
 *   <DomainProvider domains={{ teams: teamsDomain }}>
 *     <App />
 *   </DomainProvider>
 * </EnvironmentProvider>
 *
 * // In components that need direct env access:
 * const env = useEnv()
 * ```
 */

import { createContext, useContext, type ReactNode } from "react"
import type { IEnvironment } from "@shogo/state-api"

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for createEnvironment factory.
 *
 * Takes services as top-level fields for a cleaner API.
 * Adds workspace which maps to context.location.
 */
export interface EnvironmentConfig {
  /** Required: Persistence service for data storage */
  persistence: IEnvironment["services"]["persistence"]
  /** Optional: Backend registry for query execution */
  backendRegistry?: IEnvironment["services"]["backendRegistry"]
  /** Optional: Auth service */
  auth?: IEnvironment["services"]["auth"]
  /** Optional: Authorization service for query-level access control */
  authorization?: IEnvironment["services"]["authorization"]
  /** Optional: Query validator */
  queryValidator?: IEnvironment["services"]["queryValidator"]
  /** Optional: Workspace/location for data isolation (maps to context.location) */
  workspace?: string
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an IEnvironment from configuration options.
 *
 * @param config - Environment configuration (services as top-level fields + workspace)
 * @returns IEnvironment suitable for MST stores
 *
 * @example
 * ```typescript
 * const env = createEnvironment({
 *   persistence: new MCPPersistence(mcpService),
 *   backendRegistry: createBackendRegistry({ default: 'postgres', backends: { postgres: mcpBackend } }),
 *   workspace: '.schemas/my-project'
 * })
 * ```
 */
export function createEnvironment(config: EnvironmentConfig): IEnvironment {
  const { persistence, backendRegistry, auth, authorization, queryValidator, workspace } = config
  return {
    services: {
      persistence,
      backendRegistry,
      auth,
      authorization,
      queryValidator,
    },
    context: {
      schemaName: "default",
      location: workspace,
    },
  }
}

// ============================================================================
// Context
// ============================================================================

const EnvironmentContext = createContext<IEnvironment | null>(null)

// ============================================================================
// Provider
// ============================================================================

export interface EnvironmentProviderProps {
  /** The IEnvironment to provide to descendants */
  env: IEnvironment
  children: ReactNode
}

/**
 * Provider component that makes IEnvironment available to descendants.
 *
 * All MST store providers (DomainProvider, MetaStoreProvider) should be
 * descendants of EnvironmentProvider to access shared configuration.
 */
export function EnvironmentProvider({ env, children }: EnvironmentProviderProps) {
  return (
    <EnvironmentContext.Provider value={env}>
      {children}
    </EnvironmentContext.Provider>
  )
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to access the IEnvironment from context.
 *
 * @throws Error if used outside EnvironmentProvider
 * @returns The IEnvironment from the nearest EnvironmentProvider ancestor
 *
 * @example
 * ```typescript
 * function MyComponent() {
 *   const env = useEnv()
 *   console.log(env.services.persistence)
 * }
 * ```
 */
export function useEnv(): IEnvironment {
  const env = useContext(EnvironmentContext)
  if (!env) {
    throw new Error("useEnv must be used within EnvironmentProvider")
  }
  return env
}

/**
 * Hook to optionally access the IEnvironment from context.
 *
 * Returns null if used outside EnvironmentProvider (does not throw).
 * Useful for providers that can work with or without EnvironmentProvider.
 *
 * @returns The IEnvironment or null if not in provider tree
 *
 * @example
 * ```typescript
 * function MyProvider({ persistence, children }) {
 *   const ancestorEnv = useOptionalEnv()
 *   const effectivePersistence = persistence ?? ancestorEnv?.services.persistence
 *   // ...
 * }
 * ```
 */
export function useOptionalEnv(): IEnvironment | null {
  return useContext(EnvironmentContext)
}
