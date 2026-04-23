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
import {
  DirectTelephonyClient,
  HostedTelephonyClient,
  type TelephonyClient,
} from './voice/telephony.js'
import type { ShogoClientConfig } from './types.js'

export interface ShogoVoiceModule {
  /**
   * Telephony client for Twilio + ElevenLabs.
   *
   * `null` when the client was constructed without either a Shogo API key
   * + projectId (Mode B) or direct elevenlabs + twilio credentials (Mode A).
   * Call {@link ShogoClient.setShogoApiKey} or recreate the client to enable.
   */
  telephony: TelephonyClient | null
}

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
   * Voice module — Twilio + ElevenLabs telephony.
   *
   * `voice.telephony` resolves to `HostedTelephonyClient` when `shogoApiKey`
   * + `projectId` are configured, `DirectTelephonyClient` when direct
   * `elevenlabs` + `twilio` credentials are passed, or `null` otherwise.
   */
  voice: ShogoVoiceModule

  /**
   * Configure (or replace) the Shogo API key used by {@link ShogoClient.llm}.
   * Pass `null` to clear the provider (e.g. on sign-out). Useful when the key
   * is fetched asynchronously from secure storage or `platform.getShogoKeyStatus()`.
   *
   * Also re-evaluates {@link ShogoClient.voice.telephony}: setting a key when
   * a `projectId` was originally supplied lights up Mode B; clearing the key
   * drops back to Mode A (if direct creds were supplied) or `null`.
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
  voice: ShogoVoiceModule
  _http: HttpClient

  private shogoCloudUrl: string | undefined
  private config: ShogoClientConfig<DB>

  constructor(config: ShogoClientConfig<DB>) {
    this.config = config
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

    this.voice = { telephony: this.buildTelephony(config.shogoApiKey) }
  }

  private buildTelephony(
    shogoApiKey: string | undefined | null,
  ): TelephonyClient | null {
    const { projectId, elevenlabs, twilio, apiUrl } = this.config
    const hasHosted = Boolean(shogoApiKey && projectId)
    const hasDirect = Boolean(elevenlabs && twilio)

    if (hasHosted && hasDirect) {
      console.warn(
        '[shogo] createClient received both shogoApiKey + direct elevenlabs/twilio creds; using hosted (Mode B). Drop shogoApiKey to use direct (Mode A).',
      )
    }
    if (hasHosted) {
      return new HostedTelephonyClient({
        shogoApiKey: shogoApiKey as string,
        projectId: projectId as string,
        apiUrl,
      })
    }
    if (hasDirect) {
      return new DirectTelephonyClient({
        projectId,
        elevenlabs: elevenlabs!,
        twilio: twilio!,
      })
    }
    return null
  }

  setShogoApiKey(key: string | null): void {
    this.llm = key
      ? createShogoLlmProvider({ apiKey: key, baseUrl: this.shogoCloudUrl })
      : null
    this.voice = { telephony: this.buildTelephony(key) }
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
