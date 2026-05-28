// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * @shogo-ai/sdk
 *
 * Shogo Platform SDK - Zero-boilerplate auth, database, and state management.
 *
 * Features:
 * - Authentication (email/password, OAuth)
 * - OptimisticStore for CRUD with optimistic updates
 * - Code generation (routes, types, stores)
 * - HTTP client with request deduplication
 *
 * @example
 * ```typescript
 * import { createClient, OptimisticStore } from '@shogo-ai/sdk'
 *
 * const client = createClient({
 *   apiUrl: 'http://localhost:3000',
 * })
 *
 * // Auth
 * await client.auth.signUp({ email: 'user@example.com', password: 'secret' })
 * await client.auth.signIn({ email: 'user@example.com', password: 'secret' })
 * ```
 *
 * @example Code Generation
 * ```bash
 * # Generate routes, types, and stores from Prisma schema
 * npx shogo generate
 * ```
 */

// Main client exports
export {
  createClient,
  getDefaultClient,
  type ShogoClient,
} from './client.js'

// Auth module
export { ShogoAuth } from './auth/index.js'

// HTTP client
export { HttpClient, type HttpClientConfig } from './http/client.js'

// Attachments (data URLs for multimodal chat, etc.)
export { buildDataUrlFromBase64 } from './attachments/data-url.js'

// Stores
export {
  OptimisticStore,
  type OptimisticStoreConfig,
  type StoreState,
} from './stores/index.js'

// Storage adapters
export {
  type StorageAdapter,
  WebStorageAdapter,
  AsyncStorageAdapter,
  NoOpStorageAdapter,
  MemoryStorageAdapter,
  getDefaultStorageAdapter,
  isBrowser,
} from './storage/adapter.js'

// LLM gateway (Vercel AI SDK provider backed by Shogo Cloud)
export {
  createShogoLlmProvider,
  DEFAULT_SHOGO_CLOUD_URL,
  type CreateShogoLlmProviderOptions,
  type ShogoLlmProvider,
} from './llm/index.js'

// Platform API (API keys, local config, feature flags)
export {
  PlatformApi,
  BYOK_PROVIDERS,
  type BYOKProviderId,
  type PlatformConfig,
  type ApiKeyInfo,
  type ApiKeyKind,
  type ApiKeyCreateResult,
  type ApiKeyValidation,
  type ShogoKeyStatus,
  type ShogoKeyConnectResult,
  type LlmConfig,
  type InstanceInfo,
  type DeviceInfo,
  type CloudLoginStart,
  type CloudLoginStatus,
  type WorkspaceSummary,
  type FeatureFlagOverrides,
  type FeatureFlagPatch,
  type VisibleModelsConfig,
  type VisibleOpenRouterModel,
  type ResolvedVisibleModels,
} from './platform/index.js'

// Machines API (paired desktops / VPS workers + per-project "Run on" routing)
export {
  MachinesApi,
  type Machine,
  type MachineKind,
  type MachineStatus,
  type OnlineMachine,
  type PinProjectOptions,
  type PinProjectResult,
  type PreferredInstancePolicy,
  type ProjectPin,
} from './machines/index.js'

// Projects API (workspace clone/sync via `shogo project pull/push`)
export {
  ProjectsApi,
  type PullOptions,
  type PushOptions,
  type ProjectFilesEntry,
  type ManifestEntry,
  type SyncStats,
  type FsAdapter,
  type ProgressEvent,
} from './projects/index.js'
export { CloudFileTransport, type CloudFileTransportOptions } from './projects/cloud-file-transport.js'

// Errors
export {
  ShogoError,
  AuthError,
  DatabaseError,
  type ShogoErrorCode,
} from './errors.js'

// Types
export type {
  // Client config
  ShogoClientConfig,
  ShogoAuthConfig,

  // Auth types
  ShogoUser,
  ShogoSession,
  AuthState,
  AuthStateChangeCallback,
  SignUpData,
  SignInData,
  SignInWithProviderData,
  AuthProvider,
  AuthTokens,

  // HTTP types
  RequestOptions,
  ShogoResponse,
} from './types.js'

// Route hook types (for generated routes)
export type {
  RouteHookContext,
  HookResult,
} from './types.js'

// MST Environment type (for generated MST stores)
export type { ISDKEnvironment } from './types.js'

// Persistence (for MST stores)
export {
  APIPersistence,
  type APIPersistenceConfig,
  type PersistenceContext,
  type EntityContext,
  type IPersistenceService,
} from './persistence/index.js'

// React components and hooks
export {
  DomainProvider,
  useDomain,
  useCollection,
  useDomainReady,
  withDomain,
  type DomainProviderProps,
  type DomainProviderConfig,
} from './react/index.js'

// NOTE: Database adapters are NOT exported from the main entry point because they
// contain Node.js-specific code (fs, child_process) that cannot run in the browser.
// Import from '@shogo-ai/sdk/db' for server-side use only:
//
// import { createPrismaClient, detectProvider } from '@shogo-ai/sdk/db'
