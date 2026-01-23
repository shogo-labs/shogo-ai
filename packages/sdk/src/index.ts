/**
 * @shogo-ai/sdk
 *
 * Shogo Platform SDK - Zero-boilerplate auth, database, and state management.
 *
 * Features:
 * - Authentication (email/password, OAuth)
 * - Database (Prisma pass-through)
 * - Code generation (server functions, domain stores)
 * - React bindings (hooks, providers)
 *
 * @example
 * ```typescript
 * import { PrismaClient } from '@prisma/client'
 * import { createClient } from '@shogo-ai/sdk'
 *
 * const prisma = new PrismaClient()
 *
 * const shogo = createClient({
 *   apiUrl: 'http://localhost:3000',
 *   db: prisma,
 * })
 *
 * // Auth
 * await shogo.auth.signUp({ email: 'user@example.com', password: 'secret' })
 * await shogo.auth.signIn({ email: 'user@example.com', password: 'secret' })
 *
 * // Database - direct Prisma pass-through
 * const todos = await shogo.db.todo.findMany({ where: { completed: false } })
 * ```
 *
 * @example Code Generation
 * ```bash
 * # Generate server functions and domain stores from Prisma schema
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
