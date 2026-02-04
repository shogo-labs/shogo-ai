/**
 * HTTP Client
 *
 * Central HTTP client for all SDK requests.
 * Handles auth headers, error handling, and MCP protocol.
 */

import { ShogoError } from '../errors.js'
import type {
  RequestOptions,
  ShogoResponse,
  MCPRequest,
  MCPResponse,
} from '../types.js'

export interface HttpClientConfig {
  /** Base URL of the app's backend */
  baseUrl: string

  /** Function to get current auth token */
  getToken?: () => string | null

  /** MCP endpoint path (default: '/mcp') */
  mcpPath?: string

  /** Auth endpoint path (default: '/api/auth') */
  authPath?: string

  /** Request deduplication window in ms (default: 100) */
  dedupWindowMs?: number
}

/**
 * Cache entry for request deduplication
 */
interface CacheEntry<T> {
  promise: Promise<T>
  timestamp: number
}

export class HttpClient {
  private baseUrl: string
  private getToken: () => string | null
  private mcpPath: string
  private authPath: string
  private mcpSessionId: string | null = null
  private mcpInitPromise: Promise<void> | null = null

  /** Request deduplication window in milliseconds */
  private dedupWindowMs: number

  /** Cache for in-flight and recently completed GET requests */
  private requestCache = new Map<string, CacheEntry<any>>()

  constructor(config: HttpClientConfig) {
    // Remove trailing slash from baseUrl
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.getToken = config.getToken ?? (() => null)
    this.mcpPath = config.mcpPath ?? '/mcp'
    this.authPath = config.authPath ?? '/api/auth'
    this.dedupWindowMs = config.dedupWindowMs ?? 100
  }

  /**
   * Update the token getter (called when auth state changes)
   */
  setTokenGetter(getToken: () => string | null): void {
    this.getToken = getToken
  }

  /**
   * Build full URL with optional search params
   */
  private buildUrl(path: string, searchParams?: Record<string, string>): string {
    const url = new URL(path, this.baseUrl)
    if (searchParams) {
      Object.entries(searchParams).forEach(([key, value]) => {
        url.searchParams.set(key, value)
      })
    }
    return url.toString()
  }

  /**
   * Get default headers including auth token
   */
  private getHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...additionalHeaders,
    }

    const token = this.getToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    return headers
  }

  /**
   * Make an HTTP request with optional deduplication for GET requests
   */
  async request<T = unknown>(
    path: string,
    options: RequestOptions = {}
  ): Promise<ShogoResponse<T>> {
    const { method = 'GET', headers, body, searchParams, signal } = options

    // Only dedupe GET requests
    if (method === 'GET') {
      const cacheKey = this.buildCacheKey(path, searchParams)
      const cached = this.getCachedRequest<ShogoResponse<T>>(cacheKey)
      if (cached) {
        return cached
      }

      // Execute and cache
      const promise = this.executeRequest<T>(path, options)
      this.cacheRequest(cacheKey, promise)
      return promise
    }

    // Non-GET requests are not deduplicated
    return this.executeRequest<T>(path, options)
  }

  /**
   * Build cache key for request deduplication
   */
  private buildCacheKey(path: string, searchParams?: Record<string, string>): string {
    const params = searchParams ? JSON.stringify(searchParams) : ''
    return `GET:${path}:${params}`
  }

  /**
   * Get a cached request if still valid
   */
  private getCachedRequest<T>(cacheKey: string): Promise<T> | undefined {
    const entry = this.requestCache.get(cacheKey)
    if (!entry) return undefined

    const age = Date.now() - entry.timestamp
    if (age > this.dedupWindowMs) {
      // Cache expired
      this.requestCache.delete(cacheKey)
      return undefined
    }

    return entry.promise
  }

  /**
   * Cache a request promise
   */
  private cacheRequest<T>(cacheKey: string, promise: Promise<T>): void {
    this.requestCache.set(cacheKey, {
      promise,
      timestamp: Date.now(),
    })

    // Clean up after dedup window expires
    setTimeout(() => {
      const entry = this.requestCache.get(cacheKey)
      if (entry && Date.now() - entry.timestamp >= this.dedupWindowMs) {
        this.requestCache.delete(cacheKey)
      }
    }, this.dedupWindowMs + 10)
  }

  /**
   * Clear the request cache (e.g., after auth change)
   */
  clearCache(): void {
    this.requestCache.clear()
  }

  /**
   * Execute an HTTP request (internal, no deduplication)
   */
  private async executeRequest<T = unknown>(
    path: string,
    options: RequestOptions = {}
  ): Promise<ShogoResponse<T>> {
    const { method = 'GET', headers, body, searchParams, signal } = options

    const url = this.buildUrl(path, searchParams)
    const requestHeaders = this.getHeaders(headers)

    try {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      })

      const data = await this.parseResponse<T>(response)

      if (!response.ok) {
        throw ShogoError.fromStatus(
          response.status,
          typeof data === 'object' && data !== null && 'message' in data
            ? String((data as { message: string }).message)
            : undefined,
          data
        )
      }

      return {
        data,
        status: response.status,
        headers: response.headers,
      }
    } catch (error) {
      if (error instanceof ShogoError) {
        throw error
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }
      throw ShogoError.networkError(
        error instanceof Error ? error.message : 'Network request failed',
        error
      )
    }
  }

  /**
   * Parse response body
   */
  private async parseResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type')
    if (contentType?.includes('application/json')) {
      return response.json() as Promise<T>
    }
    return response.text() as unknown as T
  }

  /**
   * GET request
   */
  async get<T = unknown>(
    path: string,
    searchParams?: Record<string, string>
  ): Promise<ShogoResponse<T>> {
    return this.request<T>(path, { method: 'GET', searchParams })
  }

  /**
   * POST request
   */
  async post<T = unknown>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<ShogoResponse<T>> {
    return this.request<T>(path, { method: 'POST', body, headers })
  }

  /**
   * PATCH request
   */
  async patch<T = unknown>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<ShogoResponse<T>> {
    return this.request<T>(path, { method: 'PATCH', body, headers })
  }

  /**
   * DELETE request
   */
  async delete<T = unknown>(
    path: string,
    searchParams?: Record<string, string>
  ): Promise<ShogoResponse<T>> {
    return this.request<T>(path, { method: 'DELETE', searchParams })
  }

  // ==========================================================================
  // Auth-specific methods
  // ==========================================================================

  /**
   * Get auth endpoint URL
   */
  getAuthUrl(endpoint: string): string {
    return `${this.authPath}${endpoint}`
  }

  /**
   * Make auth request
   */
  async authRequest<T = unknown>(
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<ShogoResponse<T>> {
    return this.request<T>(this.getAuthUrl(endpoint), options)
  }

  // ==========================================================================
  // MCP-specific methods
  // ==========================================================================

  /**
   * Initialize MCP session if not already initialized
   */
  private async ensureMcpInitialized(): Promise<void> {
    if (this.mcpSessionId) {
      return
    }

    if (this.mcpInitPromise) {
      return this.mcpInitPromise
    }

    this.mcpInitPromise = this.initializeMcpSession()
    try {
      await this.mcpInitPromise
    } finally {
      this.mcpInitPromise = null
    }
  }

  /**
   * Initialize MCP session
   */
  private async initializeMcpSession(): Promise<void> {
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: '@shogo-ai/sdk',
          version: '0.1.0',
        },
      },
    }

    const response = await fetch(this.buildUrl(this.mcpPath), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
    })

    // Extract session ID from response header
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId) {
      this.mcpSessionId = sessionId
    }

    const result = await response.json() as MCPResponse
    if (result.error) {
      throw new ShogoError(
        result.error.message,
        'SERVER_ERROR',
        undefined,
        result.error
      )
    }
  }

  /**
   * Call an MCP tool
   */
  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>
  ): Promise<T> {
    await this.ensureMcpInitialized()

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    }

    const headers: Record<string, string> = this.getHeaders()
    if (this.mcpSessionId) {
      headers['mcp-session-id'] = this.mcpSessionId
    }

    const response = await fetch(this.buildUrl(this.mcpPath), {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    })

    const result = await response.json() as MCPResponse<{ content: Array<{ type: string; text: string }> }>

    if (result.error) {
      throw new ShogoError(
        result.error.message,
        'DB_QUERY_ERROR',
        undefined,
        result.error
      )
    }

    // Parse tool result from content
    if (result.result?.content?.[0]?.text) {
      try {
        return JSON.parse(result.result.content[0].text) as T
      } catch {
        return result.result.content[0].text as unknown as T
      }
    }

    return result.result as T
  }

  /**
   * Reset MCP session (e.g., after auth change)
   */
  resetMcpSession(): void {
    this.mcpSessionId = null
    this.mcpInitPromise = null
  }
}
