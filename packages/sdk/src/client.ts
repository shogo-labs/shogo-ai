/**
 * Shogo Client
 *
 * Main SDK entry point. Creates a client with auth and database.
 * Database is a direct pass-through to your Prisma client.
 */

import { HttpClient } from './http/client.js'
import { ShogoAuth } from './auth/index.js'
import {
  getDefaultStorageAdapter,
  type StorageAdapter,
} from './storage/adapter.js'
import type { ShogoClientConfig } from './types.js'

/**
 * Shogo Client interface
 *
 * @template DB - Your Prisma client type
 */
export interface ShogoClient<DB = unknown> {
  /** Authentication module */
  auth: ShogoAuth

  /** Database - direct pass-through to your Prisma client */
  db: DB

  /** Internal HTTP client (for advanced use cases) */
  _http: HttpClient
}

/**
 * Shogo Client implementation
 */
class ShogoClientImpl<DB> implements ShogoClient<DB> {
  auth: ShogoAuth
  db: DB
  _http: HttpClient

  constructor(config: ShogoClientConfig<DB>) {
    // Get or create storage adapter
    const storage: StorageAdapter = config.storage ?? getDefaultStorageAdapter()

    // Create HTTP client
    this._http = new HttpClient({
      baseUrl: config.apiUrl,
      mcpPath: '/mcp',
      authPath: config.auth?.authPath ?? '/api/auth',
    })

    // Create auth module
    this.auth = new ShogoAuth(this._http, storage, config.auth)

    // Wire up token getter from auth to HTTP client
    this._http.setTokenGetter(() => this.auth.getToken())

    // Database is a direct pass-through to Prisma
    this.db = config.db
  }
}

// Global default client (for convenience patterns)
let defaultClient: ShogoClient<unknown> | null = null

/**
 * Create a new Shogo client instance.
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
 *
 * // Database - direct Prisma pass-through
 * const todos = await shogo.db.todo.findMany({ where: { completed: false } })
 * const todo = await shogo.db.todo.create({ data: { title: 'Buy milk' } })
 * ```
 */
export function createClient<DB = unknown>(config: ShogoClientConfig<DB>): ShogoClient<DB> {
  const client = new ShogoClientImpl(config)

  // Set as default client
  defaultClient = client as ShogoClient<unknown>

  return client
}

/**
 * Get the default client instance.
 *
 * @throws Error if createClient() hasn't been called yet
 */
export function getDefaultClient<DB = unknown>(): ShogoClient<DB> {
  if (!defaultClient) {
    throw new Error(
      'No default client. Call createClient() first.'
    )
  }
  return defaultClient as ShogoClient<DB>
}
