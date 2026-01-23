/**
 * @shogo/app-core - App bootstrapping providers
 *
 * Provides generic React context providers for app initialization:
 * - Auth: Authentication store with IAuthService integration
 * - Environment: MST environment configuration (persistence, auth, context)
 * - Domain: Multi-domain store provider with lazy loading support
 * - Meta-store: Dynamic schema loading via persistence
 * - Wavesmith Store: Simple schema-to-store provider
 *
 * These providers are designed to work independently of feature-specific code
 * and can be used in both the main Shogo Studio app and project iframes.
 */

// Auth
export { AuthProvider, useAuth } from './auth/AuthContext'
export type { AuthProviderProps } from './auth/AuthContext'

// Environment
export {
  EnvironmentProvider,
  createEnvironment,
  useEnv,
  useOptionalEnv,
} from './environment/EnvironmentContext'
export type {
  EnvironmentConfig,
  EnvironmentProviderProps,
} from './environment/EnvironmentContext'

// Domain
export {
  DomainProvider,
  useDomains,
  useDomainStore,
  useOptionalDomainStore,
  useSchemaLoadingState,
} from './domain/DomainProvider'
export type {
  DomainsMap,
  EagerCollectionsConfig,
  DomainProviderProps,
} from './domain/DomainProvider'

// Runtime Store (unified access with metastore fallback)
export {
  useRuntimeStore,
  useRuntimeCollection,
} from './hooks/useRuntimeStore'

// Meta-store
export {
  WavesmithMetaStoreProvider,
  useWavesmithMetaStore,
  useOptionalWavesmithMetaStore,
  useWavesmithPersistence,
} from './meta/WavesmithMetaStoreContext'
export type { WavesmithMetaStoreProviderProps } from './meta/WavesmithMetaStoreContext'

// Wavesmith Store
export {
  WavesmithStoreProvider,
  useWavesmithStore,
} from './wavesmith/WavesmithStoreContext'
export type { WavesmithStoreProviderProps } from './wavesmith/WavesmithStoreContext'
