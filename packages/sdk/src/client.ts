// SPDX-License-Identifier: MIT
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
import { MachinesApi } from './machines/index.js'
import { ProjectsApi } from './projects/index.js'
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
  HostedRuntimeTokenClient,
  HostedTelephonyClient,
  MockTelephonyClient,
  isVoiceMockEnv,
  type TelephonyClient,
} from '@shogo-ai/voice'
import type { ShogoClientConfig } from './types.js'

export interface ShogoVoiceModule {
  /**
   * Telephony client for Twilio + ElevenLabs.
   *
   * `null` when the client was constructed without any of:
   *   - `process.env.RUNTIME_AUTH_SECRET` + `projectId` (pod-native)
   *   - `shogoApiKey` + `projectId` (Mode B hosted bearer)
   *   - direct `elevenlabs` + `twilio` credentials (Mode A)
   *
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

  /**
   * Machines API: list paired desktops + `shogo worker` VPS sign-ins,
   * and manage per-project "Run on" routing for external triggers.
   *
   * ```ts
   * const machines = await client.machines.list({ workspaceId })
   * await client.machines.pinProject(projectId, { instanceId: vps.id })
   * ```
   */
  machines: MachinesApi

  /**
   * Projects API: clone/sync a project's workspace between cloud and
   * local. Used by `shogo project pull/push` and the worker's auto-pull.
   *
   * ```ts
   * await client.projects.pull(projectId, { into: './myproj' })
   * await client.projects.push(projectId, { from: './myproj' })
   * ```
   */
  projects: ProjectsApi

  /** Database - direct pass-through to your Prisma client */
  db: DB

  /**
   * Vercel AI SDK provider routed through the Shogo Cloud LLM gateway.
   *
   * Resolves to a working provider when **either**:
   *   - `process.env.RUNTIME_AUTH_SECRET` is present (pod-native; default
   *     inside generated apps — no API key required), or
   *   - `shogoApiKey` was supplied to `createClient()` /
   *     {@link ShogoClient.setShogoApiKey} (local dev / external sites).
   *
   * Runtime token wins when both are present; a warning is logged.
   * `null` only when neither credential is available.
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
   * `voice.telephony` resolves to:
   *   - `HostedRuntimeTokenClient` when `process.env.RUNTIME_AUTH_SECRET` +
   *     `projectId` are present (pod-native; default inside generated apps),
   *   - `HostedTelephonyClient` when `shogoApiKey` + `projectId` are
   *     configured (external-site Mode B),
   *   - `DirectTelephonyClient` when direct `elevenlabs` + `twilio`
   *     credentials are passed (Mode A), or
   *   - `null` otherwise.
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
  machines: MachinesApi
  projects: ProjectsApi
  db: DB
  llm: ShogoLlmProvider | null
  voice: ShogoVoiceModule
  _http: HttpClient

  private shogoCloudUrl: string | undefined
  private shogoApiKey: string | null
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

    // Create machines API (powers the "Run on" / external-trigger story).
    this.machines = new MachinesApi(this._http)

    // Projects API: workspace clone/sync (`shogo project pull/push`).
    // Both apiKey and apiUrl are resolved lazily so `setShogoApiKey` keeps
    // working without re-instantiating.
    this.shogoApiKey = config.shogoApiKey ?? null
    this.projects = new ProjectsApi(
      this._http,
      () => this.shogoApiKey,
      () => config.apiUrl,
    )

    // Wire up token getter from auth to HTTP client
    this._http.setTokenGetter(() => this.auth.getToken())

    // Database is a direct pass-through to Prisma
    this.db = config.db

    // LLM gateway: prefer pod-native `RUNTIME_AUTH_SECRET` when present;
    // fall back to `shogoApiKey`; otherwise leave `null`. See
    // `buildLlm` for precedence + warning rules (mirrors voice).
    this.shogoCloudUrl = config.shogoCloudUrl
    this.llm = this.buildLlm(config.shogoApiKey ?? null)

    this.voice = { telephony: this.buildTelephony(config.shogoApiKey) }
  }

  private buildLlm(
    shogoApiKey: string | undefined | null,
  ): ShogoLlmProvider | null {
    // Server-only: guard `typeof process` so this code never runs in a
    // browser bundle (where `process.env.RUNTIME_AUTH_SECRET` would be
    // undefined or, worse, inlined by a bundler).
    const runtimeToken =
      typeof process !== 'undefined'
        ? process.env?.RUNTIME_AUTH_SECRET
        : undefined
    const hasRuntime = Boolean(runtimeToken)
    const hasApiKey = Boolean(shogoApiKey)

    if (hasRuntime && hasApiKey) {
      console.warn(
        '[shogo] createClient received both RUNTIME_AUTH_SECRET env + shogoApiKey for client.llm; using runtime-token (pod-native). Drop shogoApiKey to silence this warning.',
      )
    }

    if (hasRuntime) {
      return createShogoLlmProvider({
        runtimeToken: runtimeToken as string,
        baseUrl: this.shogoCloudUrl,
      })
    }
    if (hasApiKey) {
      return createShogoLlmProvider({
        apiKey: shogoApiKey as string,
        baseUrl: this.shogoCloudUrl,
      })
    }
    return null
  }

  private buildTelephony(
    shogoApiKey: string | undefined | null,
  ): TelephonyClient | null {
    const { projectId, elevenlabs, twilio, apiUrl } = this.config

    // Mock mode short-circuits everything else. When SHOGO_VOICE_MODE=mock
    // is set (typically in demo recordings), every method on the returned
    // client returns deterministic fixture data and zero network requests
    // are made — Twilio + EL accounts are never touched and the workspace
    // usage wallet is not debited. Used by the Playwright demo suite to
    // record Scene 7 (cold-call agent) without dialing real numbers.
    if (isVoiceMockEnv()) {
      return new MockTelephonyClient({ projectId: projectId ?? undefined })
    }

    // Runtime-token mode (pod-native). Checked first because every
    // Shogo-managed pod already has `RUNTIME_AUTH_SECRET` + `PROJECT_ID`
    // in env — the developer should not have to also mint an API key.
    // Server-only: we guard `typeof process` so this code never runs in
    // a browser bundle (where `process.env.RUNTIME_AUTH_SECRET` would
    // either be undefined or, worse, inlined by a bundler).
    const runtimeToken =
      typeof process !== 'undefined'
        ? process.env?.RUNTIME_AUTH_SECRET
        : undefined
    const hasRuntime = Boolean(runtimeToken && projectId)
    const hasHosted = Boolean(shogoApiKey && projectId)
    const hasDirect = Boolean(elevenlabs && twilio)

    if (hasRuntime && hasHosted) {
      console.warn(
        '[shogo] createClient received both RUNTIME_AUTH_SECRET env + shogoApiKey; using runtime-token (pod-native). Drop shogoApiKey to silence this warning.',
      )
    } else if (hasHosted && hasDirect) {
      console.warn(
        '[shogo] createClient received both shogoApiKey + direct elevenlabs/twilio creds; using hosted (Mode B). Drop shogoApiKey to use direct (Mode A).',
      )
    }

    if (hasRuntime) {
      return new HostedRuntimeTokenClient({
        runtimeToken: runtimeToken as string,
        projectId: projectId as string,
        apiUrl,
      })
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
    this.shogoApiKey = key
    this.llm = this.buildLlm(key)
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
