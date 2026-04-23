// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo SDK Type Definitions
 */

// ============================================================================
// Client Configuration
// ============================================================================

export interface ShogoClientConfig<DB = unknown> {
  /** Base URL of the app's backend (e.g., 'http://localhost:3000') */
  apiUrl: string

  /** Prisma client instance - passed through directly as shogo.db */
  db: DB

  /** Auth configuration */
  auth?: ShogoAuthConfig

  /** Storage adapter for cross-platform token persistence */
  storage?: StorageAdapter

  /**
   * Shogo API key (starts with `shogo_sk_`) used to authenticate LLM gateway
   * requests via `client.llm`. When set, the client exposes an AI SDK provider
   * that routes through the Shogo Cloud LLM proxy. When unset, `client.llm`
   * is `null` and attempts to call LLMs should configure a key via
   * `client.setShogoApiKey()` or recreate the client.
   *
   * Also unlocks Mode B (hosted) voice telephony when paired with `projectId`.
   */
  shogoApiKey?: string

  /**
   * Override the Shogo Cloud base URL used by `client.llm` (no trailing slash,
   * no `/api/ai/v1` suffix). Defaults to `https://studio.shogo.ai`. Useful for
   * staging / self-hosted Shogo deployments.
   */
  shogoCloudUrl?: string

  /**
   * Shogo project id. Required for Mode B voice telephony; also forwarded
   * to the direct (Mode A) telephony client as a bookkeeping handle.
   */
  projectId?: string

  /**
   * Bring-your-own ElevenLabs credentials. Supplying this (and `twilio`)
   * opts the `client.voice.telephony` module into Mode A — the SDK talks
   * directly to ElevenLabs + Twilio and never contacts Shogo's API for
   * voice. Ignored when `shogoApiKey` is also supplied (hosted wins).
   */
  elevenlabs?: {
    apiKey: string
    agentId: string
    phoneNumberId?: string
    baseUrl?: string
  }

  /** Bring-your-own Twilio credentials — see `elevenlabs`. */
  twilio?: {
    accountSid: string
    authToken: string
    fromNumber?: string
    phoneSid?: string
    baseUrl?: string
  }
}

export interface ShogoAuthConfig {
  /** Auth mode: 'managed' (redirect) or 'headless' (custom UI) */
  mode?: 'managed' | 'headless'

  /** Custom auth endpoint path (default: '/api/auth') */
  authPath?: string

  /** Redirect URL after auth (for OAuth flows) */
  redirectUrl?: string
}

// ============================================================================
// Storage Adapter
// ============================================================================

export interface StorageAdapter {
  getItem(key: string): Promise<string | null> | string | null
  setItem(key: string, value: string): Promise<void> | void
  removeItem(key: string): Promise<void> | void
  clear?(): Promise<void> | void
}

// ============================================================================
// Auth Types
// ============================================================================

export interface ShogoUser {
  id: string
  email: string
  name?: string
  image?: string
  emailVerified?: boolean
  createdAt?: string
  updatedAt?: string
}

export interface ShogoSession {
  user: ShogoUser
  token: string
  expiresAt?: string
}

export interface AuthState {
  user: ShogoUser | null
  session: ShogoSession | null
  isAuthenticated: boolean
  isLoading: boolean
}

export type AuthStateChangeCallback = (state: AuthState) => void

export interface SignUpData {
  email: string
  password: string
  name?: string
  metadata?: Record<string, unknown>
}

export interface SignInData {
  email: string
  password: string
}

export interface SignInWithProviderData {
  provider: AuthProvider
  redirectUrl?: string
}

export type AuthProvider = 'google' | 'github' | 'apple' | 'microsoft'

export interface AuthTokens {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  expiresAt?: number
}

// ============================================================================
// MCP Types (Internal)
// ============================================================================

export interface MCPRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export interface MCPResponse<T = unknown> {
  jsonrpc: '2.0'
  id: string | number
  result?: T
  error?: MCPError
}

export interface MCPError {
  code: number
  message: string
  data?: unknown
}

export interface MCPToolCallParams {
  name: string
  arguments: Record<string, unknown>
}

// ============================================================================
// HTTP Types
// ============================================================================

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  searchParams?: Record<string, string>
  signal?: AbortSignal
}

export interface ShogoResponse<T = unknown> {
  data: T
  status: number
  headers: Headers
}

// ============================================================================
// Route Hook Types (for generated routes)
// ============================================================================

/**
 * Context passed to route hooks
 */
export interface RouteHookContext<TBody = any> {
  /** Request body (for create/update) */
  body: TBody
  /** URL parameters */
  params: Record<string, string>
  /** Query parameters */
  query: Record<string, string>
  /** Authenticated user ID (if available) */
  userId?: string
  /** Prisma client instance */
  prisma: any
}

/**
 * Result from a hook that can modify or reject the operation
 */
export interface HookResult<T = any> {
  /** If false, operation is rejected with error */
  ok: boolean
  /** Error to return if ok is false */
  error?: { code: string; message: string }
  /** Modified data to use instead of original */
  data?: T
}

// ============================================================================
// SDK Environment Types (for MST stores)
// ============================================================================

import type { HttpClient } from './http/client.js'

/**
 * Environment interface for SDK MST stores.
 * Inject this when creating the store.
 */
export interface ISDKEnvironment {
  /** HTTP client for API calls */
  http: HttpClient
  /** Optional context for authorization */
  context?: {
    userId?: string
    workspaceId?: string
  }
}
