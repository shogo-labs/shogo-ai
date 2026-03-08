// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * APIPersistence - SDK Implementation
 *
 * Persistence service for MST stores that uses SDK's HttpClient.
 * Implements IPersistenceService interface.
 *
 * Features:
 * - Request deduplication via HttpClient
 * - MST-compatible data transformations
 * - Automatic route mapping from model names
 */

import type { HttpClient } from '../http/client.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Context for persistence operations
 */
export interface PersistenceContext {
  schemaName: string
  modelName: string
  location?: string
  filter?: Record<string, any>
}

/**
 * Context for entity operations
 */
export interface EntityContext extends PersistenceContext {
  entityId: string
}

/**
 * Persistence service interface
 */
export interface IPersistenceService {
  saveCollection(context: PersistenceContext, snapshot: any): Promise<void>
  loadCollection(context: PersistenceContext): Promise<any | null>
  saveEntity(context: EntityContext, snapshot: any): Promise<void>
  loadEntity(context: EntityContext): Promise<any | null>
  loadSchema?(name: string, location?: string): Promise<any | null>
  listSchemas?(location?: string): Promise<string[]>
}

// ============================================================================
// Configuration
// ============================================================================

export interface APIPersistenceConfig {
  /** HttpClient instance for API calls */
  http: HttpClient
  /** Base path for API routes (default: '/api') */
  basePath?: string
  /** Model name to route path mapping (auto-generated if not provided) */
  routeMap?: Record<string, string>
}

// ============================================================================
// Default Route Mapping
// ============================================================================

/**
 * Convert model name to route path (kebab-case, plural)
 */
function toRoutePath(name: string): string {
  const kebab = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
  if (kebab.endsWith('y')) return kebab.slice(0, -1) + 'ies'
  if (kebab.endsWith('s') || kebab.endsWith('x') || kebab.endsWith('ch') || kebab.endsWith('sh')) {
    return kebab + 'es'
  }
  return kebab + 's'
}

// ============================================================================
// APIPersistence Class
// ============================================================================

/**
 * API-based persistence service for MST stores.
 *
 * Uses SDK's HttpClient for all requests, benefiting from:
 * - Request deduplication
 * - Auth header injection
 * - Consistent error handling
 *
 * @example
 * ```typescript
 * import { HttpClient, APIPersistence } from '@shogo-ai/sdk'
 *
 * const http = new HttpClient({ baseUrl: 'http://localhost:3000' })
 * const persistence = new APIPersistence({ http })
 *
 * // Use with MST stores
 * const data = await persistence.loadCollection({
 *   schemaName: 'studio-core',
 *   modelName: 'Workspace',
 * })
 * ```
 */
export class APIPersistence implements IPersistenceService {
  private http: HttpClient
  private basePath: string
  private routeMap: Record<string, string>
  private userId: string | null = null

  constructor(config: APIPersistenceConfig) {
    this.http = config.http
    this.basePath = config.basePath ?? '/api'
    this.routeMap = config.routeMap ?? {}
  }

  /**
   * Set the current user ID for user-scoped queries.
   */
  setUserId(userId: string | null): void {
    if (this.userId !== userId) {
      this.http.clearCache()
    }
    this.userId = userId
  }

  // =========================================================================
  // Collection Operations
  // =========================================================================

  /**
   * Load a collection via REST API.
   */
  async loadCollection(ctx: PersistenceContext): Promise<{ items: Record<string, any> } | null> {
    try {
      const endpoint = this.getCollectionEndpoint(ctx)
      if (!endpoint) {
        console.warn(`[APIPersistence] No endpoint for model: ${ctx.modelName}`)
        return null
      }

      const response = await this.http.get<{ ok: boolean; items?: any[] }>(endpoint)

      if (!response.data?.ok || !response.data.items) {
        return null
      }

      // Transform array to items map (MST collection format)
      const items: Record<string, any> = {}
      for (const item of response.data.items) {
        if (item.id) {
          items[item.id] = this.transformForMST(item)
        }
      }

      return { items }
    } catch (error: any) {
      console.error('[APIPersistence] loadCollection error:', error.message)
      return null
    }
  }

  /**
   * Save a collection via REST API.
   */
  async saveCollection(ctx: PersistenceContext, snapshot: any): Promise<void> {
    const items = snapshot.items || {}

    for (const [id, entity] of Object.entries(items)) {
      try {
        await this.saveEntity({ ...ctx, entityId: id }, entity)
      } catch (error: any) {
        console.error(`[APIPersistence] saveCollection failed for ${id}:`, error.message)
      }
    }
  }

  // =========================================================================
  // Entity Operations
  // =========================================================================

  /**
   * Load a single entity via REST API.
   */
  async loadEntity(ctx: EntityContext): Promise<any | null> {
    try {
      const endpoint = this.getEntityEndpoint(ctx)
      if (!endpoint) {
        console.warn(`[APIPersistence] No endpoint for model: ${ctx.modelName}`)
        return null
      }

      const response = await this.http.get<{ ok: boolean; data?: any }>(endpoint)
      
      if (!response.data?.ok || !response.data.data) {
        return null
      }

      return this.transformForMST(response.data.data)
    } catch (error: any) {
      // 404 is expected for non-existent entities
      if (error.message?.includes('not found') || error.status === 404) {
        return null
      }
      console.error('[APIPersistence] loadEntity error:', error.message)
      return null
    }
  }

  /**
   * Save a single entity via REST API.
   */
  async saveEntity(ctx: EntityContext, snapshot: any): Promise<void> {
    try {
      const existing = await this.loadEntity(ctx)
      const baseEndpoint = this.getCollectionEndpoint(ctx)

      if (!baseEndpoint) {
        throw new Error(`No endpoint for model: ${ctx.modelName}`)
      }

      // Transform MST snapshot to API-compatible format
      const apiData = this.transformForAPI(snapshot)

      if (existing) {
        // Update existing entity
        await this.http.patch(`${baseEndpoint}/${ctx.entityId}`, apiData)
      } else {
        // Create new entity
        await this.http.post(baseEndpoint, { ...apiData, id: ctx.entityId })
      }
    } catch (error: any) {
      console.error('[APIPersistence] saveEntity error:', error.message)
      throw error
    }
  }

  // =========================================================================
  // Schema Operations (not supported with Prisma)
  // =========================================================================

  async loadSchema(_name: string, _location?: string): Promise<any | null> {
    console.debug('[APIPersistence] loadSchema not supported with Prisma backend')
    return null
  }

  async listSchemas(_location?: string): Promise<string[]> {
    console.debug('[APIPersistence] listSchemas not supported with Prisma backend')
    return []
  }

  // =========================================================================
  // Endpoint Mapping
  // =========================================================================

  /**
   * Get route path for a model name
   */
  private getRoutePath(modelName: string): string | null {
    // Check custom mapping first
    if (this.routeMap[modelName]) {
      return this.routeMap[modelName]
    }
    // Fall back to auto-generated path
    return toRoutePath(modelName)
  }

  /**
   * Get collection endpoint URL
   */
  private getCollectionEndpoint(ctx: PersistenceContext): string | null {
    const routePath = this.getRoutePath(ctx.modelName)
    if (!routePath) return null

    // Build query params
    const params = new URLSearchParams()

    if (ctx.filter) {
      for (const [key, value] of Object.entries(ctx.filter)) {
        if (value !== undefined && value !== null) {
          params.set(key, String(value))
        }
      }
    }

    // Add userId for user-scoped collections
    if (this.userId) {
      const userScopedModels = ['Workspace', 'StarredProject', 'Notification']
      if (userScopedModels.includes(ctx.modelName)) {
        params.set('userId', this.userId)
      }
    }

    const queryString = params.toString()
    return `${this.basePath}/${routePath}${queryString ? `?${queryString}` : ''}`
  }

  /**
   * Get entity endpoint URL
   */
  private getEntityEndpoint(ctx: EntityContext): string | null {
    const routePath = this.getRoutePath(ctx.modelName)
    if (!routePath) return null

    return `${this.basePath}/${routePath}/${encodeURIComponent(ctx.entityId)}`
  }

  // =========================================================================
  // Data Transformations
  // =========================================================================

  /**
   * Transform API response for MST compatibility
   */
  private transformForMST(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj

    const dateFields = ['createdAt', 'updatedAt', 'expiresAt', 'publishedAt', 'readAt', 'emailSentAt', 'lastActiveAt']
    const referenceFields = ['workspaceId', 'projectId', 'folderId', 'parentId', 'userId']
    const referenceObjectFields = ['workspace', 'project', 'folder', 'parent', 'user']
    const result: Record<string, any> = {}

    for (const [key, value] of Object.entries(obj)) {
      // Skip null values (MST uses undefined)
      if (value === null) continue

      // Convert *Id fields to reference fields
      if (referenceFields.includes(key) && typeof value === 'string') {
        const refName = key.replace(/Id$/, '')
        if (!(refName in obj)) {
          result[refName] = value
        }
        result[key] = value
      }
      // Handle embedded reference objects
      else if (referenceObjectFields.includes(key) && value && typeof value === 'object' && 'id' in value) {
        result[key] = value.id
      }
      // Convert date strings to timestamps
      else if (dateFields.includes(key) && typeof value === 'string') {
        result[key] = new Date(value).getTime()
      }
      // Recursively transform nested objects
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.transformForMST(value)
      }
      else {
        result[key] = value
      }
    }

    return result
  }

  /**
   * Transform MST snapshot for API compatibility
   */
  private transformForAPI(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj

    const dateFields = ['createdAt', 'updatedAt', 'expiresAt', 'publishedAt', 'readAt', 'emailSentAt', 'lastActiveAt']
    const referenceFields = ['workspace', 'project', 'folder', 'parent', 'user', 'session', 'chatSession']
    const result: Record<string, any> = {}

    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue

      // Convert timestamps to ISO date strings
      if (dateFields.includes(key) && typeof value === 'number') {
        result[key] = new Date(value).toISOString()
      }
      // Convert reference fields to *Id fields
      else if (referenceFields.includes(key) && typeof value === 'string') {
        result[`${key}Id`] = value
      }
      // Recursively transform nested objects
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.transformForAPI(value)
      }
      else {
        result[key] = value
      }
    }

    return result
  }
}
