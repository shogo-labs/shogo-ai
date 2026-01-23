/**
 * Browser-side persistence implementation that calls REST API directly.
 *
 * This replaces MCPPersistence to remove MCP dependency while keeping
 * the same IPersistenceService interface for the MST domain stores.
 */
import type {
  IPersistenceService,
  PersistenceContext,
  EntityContext
} from '@shogo/state-api'

// Base API URL - use relative path (proxied by nginx in k8s, Vite in dev)
const API_BASE = import.meta.env.VITE_API_URL || ''

export class APIPersistence implements IPersistenceService {
  private userId: string | null = null

  /**
   * Set the current user ID for user-scoped queries.
   */
  setUserId(userId: string | null): void {
    this.userId = userId
  }

  // === Helper methods ===

  private async fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }))
      throw new Error(error.error?.message || error.message || 'API request failed')
    }

    return response.json()
  }

  // === Schema operations (not supported - schemas are now in Prisma) ===

  /**
   * Load a schema by name.
   * NOTE: With Prisma, schemas are defined in the Prisma schema file,
   * not stored as JSON. This method returns null as schemas are not
   * dynamically loadable anymore.
   */
  async loadSchema(_name: string, _location?: string): Promise<{
    metadata: { name: string; id?: string; views?: Record<string, any> }
    enhanced: any
  } | null> {
    // Prisma schemas are not dynamically loadable
    console.debug('[APIPersistence] loadSchema not supported with Prisma backend')
    return null
  }

  /**
   * List available schemas.
   * NOTE: Returns empty array as Prisma schemas are defined statically.
   */
  async listSchemas(_location?: string): Promise<string[]> {
    console.debug('[APIPersistence] listSchemas not supported with Prisma backend')
    return []
  }

  // === Data operations ===

  /**
   * Load a collection via REST API.
   * Maps model names to API endpoints.
   */
  async loadCollection(ctx: PersistenceContext): Promise<any | null> {
    try {
      const endpoint = this.getCollectionEndpoint(ctx)
      if (!endpoint) {
        console.warn(`[APIPersistence] No endpoint for model: ${ctx.modelName}`)
        return null
      }

      const result = await this.fetchJson<{ ok: boolean; items?: any[] }>(endpoint)

      if (!result?.ok || !result.items) {
        return null
      }

      // Transform array to items map (MST collection format)
      // Also convert dates and nulls for MST compatibility
      const items: Record<string, any> = {}
      for (const item of result.items) {
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
   * Transform API response for MST compatibility:
   * - Convert ISO date strings to timestamps
   * - Convert null values to undefined (MST optional fields)
   * - Convert *Id fields to reference fields (e.g., workspaceId -> workspace)
   */
  private transformForMST(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj
    
    const dateFields = ['createdAt', 'updatedAt', 'expiresAt', 'publishedAt', 'readAt', 'emailSentAt']
    // Fields that are FK references (e.g., workspaceId -> workspace as MST reference)
    const referenceFields = ['workspaceId', 'projectId', 'folderId', 'parentId', 'userId']
    const result: Record<string, any> = {}
    
    for (const [key, value] of Object.entries(obj)) {
      // Skip null values (MST uses undefined for optional fields)
      if (value === null) {
        continue
      }
      
      // Convert *Id fields to reference fields for MST
      if (referenceFields.includes(key) && typeof value === 'string') {
        // Convert workspaceId -> workspace, projectId -> project, etc.
        const refName = key.replace(/Id$/, '')
        // Only add if not already present (don't overwrite embedded objects)
        if (!(refName in obj)) {
          result[refName] = value  // MST will resolve as reference
        }
        // Also keep the original Id field for convenience
        result[key] = value
      }
      // Convert date strings to timestamps
      else if (dateFields.includes(key) && typeof value === 'string') {
        result[key] = new Date(value).getTime()
      }
      // Recursively transform nested objects (like workspace, project references)
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.transformForMST(value)
      }
      // Keep arrays and other values as-is
      else {
        result[key] = value
      }
    }
    
    return result
  }

  /**
   * Save a collection via REST API.
   * Updates each entity individually.
   */
  async saveCollection(ctx: PersistenceContext, snapshot: any): Promise<void> {
    const items = snapshot.items || {}

    for (const [id, entity] of Object.entries(items)) {
      try {
        await this.saveEntity({ ...ctx, entityId: id }, entity)
      } catch (error: any) {
        console.error(`[APIPersistence] saveCollection failed for ${id}:`, error.message)
        // Continue with other entities
      }
    }
  }

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

      const result = await this.fetchJson<{ ok: boolean; data?: any }>(endpoint)
      return result?.data || null
    } catch (error: any) {
      // 404 is expected for non-existent entities
      if (error.message.includes('not found') || error.message.includes('404')) {
        return null
      }
      console.error('[APIPersistence] loadEntity error:', error.message)
      return null
    }
  }

  /**
   * Save a single entity via REST API.
   * Determines whether to create or update based on existence.
   */
  async saveEntity(ctx: EntityContext, snapshot: any): Promise<void> {
    try {
      const existing = await this.loadEntity(ctx)
      const baseEndpoint = this.getCollectionEndpoint(ctx)

      if (!baseEndpoint) {
        throw new Error(`No endpoint for model: ${ctx.modelName}`)
      }

      if (existing) {
        // Update existing entity
        await this.fetchJson(`${baseEndpoint}/${ctx.entityId}`, {
          method: 'PATCH',
          body: JSON.stringify(snapshot),
        })
      } else {
        // Create new entity
        await this.fetchJson(baseEndpoint, {
          method: 'POST',
          body: JSON.stringify({ ...snapshot, id: ctx.entityId }),
        })
      }
    } catch (error: any) {
      console.error('[APIPersistence] saveEntity error:', error.message)
      throw error
    }
  }

  // === Endpoint mapping ===

  /**
   * Map model name to collection API endpoint.
   * Uses generated v2 API routes from Prisma schema.
   */
  private getCollectionEndpoint(ctx: PersistenceContext): string | null {
    const { modelName, filter } = ctx

    // Model name to route path mapping (kebab-case, plural)
    const routeMap: Record<string, string> = {
      Workspace: 'workspaces',
      Project: 'projects',
      Folder: 'folders',
      Member: 'members',
      Invitation: 'invitations',
      StarredProject: 'starred-projects',
      Notification: 'notifications',
      BillingAccount: 'billing-accounts',
    }

    const routePath = routeMap[modelName]
    if (!routePath) {
      return null
    }

    // Build query params from filter and userId
    const params = new URLSearchParams()
    
    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined && value !== null) {
          params.set(key, String(value))
        }
      }
    }

    // Add userId for user-scoped collections
    if (this.userId) {
      if (modelName === 'Workspace' || modelName === 'StarredProject' || modelName === 'Notification') {
        params.set('userId', this.userId)
      }
    }

    const queryString = params.toString()
    return `/api/v2/${routePath}${queryString ? `?${queryString}` : ''}`
  }

  /**
   * Map model name to entity API endpoint.
   * Uses generated v2 API routes from Prisma schema.
   */
  private getEntityEndpoint(ctx: EntityContext): string | null {
    const { modelName, entityId } = ctx

    // Model name to route path mapping (kebab-case, plural)
    const routeMap: Record<string, string> = {
      Workspace: 'workspaces',
      Project: 'projects',
      Folder: 'folders',
      Member: 'members',
      Invitation: 'invitations',
      StarredProject: 'starred-projects',
      Notification: 'notifications',
      BillingAccount: 'billing-accounts',
    }

    const routePath = routeMap[modelName]
    if (!routePath) {
      return null
    }

    return `/api/v2/${routePath}/${encodeURIComponent(entityId)}`
  }

  // === Batch Operations (Optimization) ===

  /**
   * Load multiple schemas in batch.
   * NOTE: Not supported with Prisma backend.
   */
  async loadSchemasBatch(
    _schemas: Array<{ name: string; location?: string }>
  ): Promise<Map<string, { metadata: { name: string; id?: string }; enhanced: any } | null>> {
    console.debug('[APIPersistence] loadSchemasBatch not supported with Prisma backend')
    return new Map()
  }

  /**
   * Load multiple collections in batch.
   * Makes parallel API calls for each collection.
   */
  async loadCollectionsBatch(
    collections: Array<PersistenceContext>
  ): Promise<Map<string, { items: Record<string, any> } | null>> {
    const results = await Promise.all(
      collections.map(ctx => this.loadCollection(ctx))
    )

    const resultMap = new Map<string, { items: Record<string, any> } | null>()
    collections.forEach((ctx, index) => {
      const key = `${ctx.schemaName}:${ctx.modelName}`
      resultMap.set(key, results[index])
    })

    return resultMap
  }
}
