// SPDX-License-Identifier: Apache-2.0
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

// Platform API (API keys, local config, feature flags)
export {
  PlatformApi,
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
} from './platform/index.js'

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
