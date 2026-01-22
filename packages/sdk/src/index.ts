/**
 * @shogo/sdk
 *
 * Shogo Platform SDK - Zero-boilerplate auth with Prisma pass-through for database.
 *
 * @example
 * ```typescript
 * import { PrismaClient } from '@prisma/client'
 * import { createClient } from '@shogo/sdk'
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
 * const user = shogo.auth.currentUser()
 *
 * // Database - direct Prisma pass-through
 * const todos = await shogo.db.todo.findMany({ where: { completed: false } })
 * const todo = await shogo.db.todo.create({ data: { title: 'Buy milk' } })
 * await shogo.db.todo.update({ where: { id: todo.id }, data: { completed: true } })
 * await shogo.db.todo.delete({ where: { id: todo.id } })
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
