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
