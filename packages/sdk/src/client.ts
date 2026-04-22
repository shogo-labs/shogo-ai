// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Client
 *
 * Main SDK entry point. Creates a client with auth and database.
 * Database is a direct pass-through to your Prisma client.
 */

import { HttpClient } from './http/client.js'
import { ShogoAuth } from './auth/index.js'
import { PlatformApi } from './platform/index.js'
import {
  getDefaultStorageAdapter,
  type StorageAdapter,
} from './storage/adapter.js'
import {
  createShogoLlmProvider,
  type ShogoLlmProvider,
} from './llm/index.js'
import type { ShogoClientConfig } from './types.js'

/**
 * Shogo Client interface
 *
 * @template DB - Your Prisma client type
 */
export interface ShogoClient<DB = unknown> {
  /** Authentication module */
  auth: ShogoAuth

  /** Platform API: API keys, local config, feature flags */
  platform: PlatformApi

  /** Database - direct pass-through to your Prisma client */
  db: DB

  /**
   * Vercel AI SDK provider routed through the Shogo Cloud LLM gateway.
   * `null` until a Shogo API key is configured via `shogoApiKey` in
   * `createClient()` or {@link ShogoClient.setShogoApiKey}.
   *
   * ```ts
   * import { streamText } from 'ai'
   * const result = streamText({
   *   model: shogo.llm!('claude-sonnet-4-5'),
   *   prompt: 'Hello',
   * })
   * ```
   */
  llm: ShogoLlmProvider | null

  /**
   * Configure (or replace) the Shogo API key used by {@link ShogoClient.llm}.
   * Pass `null` to clear the provider (e.g. on sign-out). Useful when the key
   * is fetched asynchronously from secure storage or `platform.getShogoKeyStatus()`.
   */
  setShogoApiKey: (key: string | null) => void

  /** Internal HTTP client (for advanced use cases) */
  _http: HttpClient
}

/**
 * Shogo Client implementation
 */
class ShogoClientImpl<DB> implements ShogoClient<DB> {
  auth: ShogoAuth
  platform: PlatformApi
  db: DB
  llm: ShogoLlmProvider | null
  _http: HttpClient

  private shogoCloudUrl: string | undefined

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

    // Create platform API
    this.platform = new PlatformApi(this._http)

    // Wire up token getter from auth to HTTP client
    this._http.setTokenGetter(() => this.auth.getToken())

    // Database is a direct pass-through to Prisma
    this.db = config.db

    // LLM gateway: only provisioned when a Shogo API key is present.
    this.shogoCloudUrl = config.shogoCloudUrl
    this.llm = config.shogoApiKey
      ? createShogoLlmProvider({
          apiKey: config.shogoApiKey,
          baseUrl: this.shogoCloudUrl,
        })
      : null
  }

  setShogoApiKey(key: string | null): void {
    this.llm = key
      ? createShogoLlmProvider({ apiKey: key, baseUrl: this.shogoCloudUrl })
      : null
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
