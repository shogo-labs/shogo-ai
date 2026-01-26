/**
 * Browser-side persistence implementation that calls REST API directly.
 *
 * This replaces MCPPersistence to remove MCP dependency while keeping
 * the same IPersistenceService interface for the MST domain stores.
 *
 * OPTIMIZATION: Implements request deduplication to prevent API spam when
 * multiple components call loadCollection() for the same resource simultaneously.
 * In-flight requests are tracked and reused, with a short cache window (100ms)
 * to handle rapid successive calls from React effects.
 */
import type {
  IPersistenceService,
  PersistenceContext,
  EntityContext
} from '@shogo/state-api'

// Base API URL - use relative path (proxied by nginx in k8s, Vite in dev)
const API_BASE = import.meta.env.VITE_API_URL || ''

// Deduplication cache duration in milliseconds
// Short enough to always get fresh data, long enough to dedupe rapid calls
const DEDUP_CACHE_MS = 100

// Model name to route path mapping (kebab-case, plural)
const MODEL_ROUTE_MAP: Record<string, string> = {
  // Studio-Core
  Workspace: 'workspaces',
  Project: 'projects',
  Folder: 'folders',
  Member: 'members',
  Invitation: 'invitations',
  StarredProject: 'starred-projects',
  Notification: 'notifications',
  BillingAccount: 'billing-accounts',
  // Billing
  Subscription: 'subscriptions',
  CreditLedger: 'credit-ledgers',
  UsageEvent: 'usage-events',
  // Studio-Chat
  ChatSession: 'chat-sessions',
  ChatMessage: 'chat-messages',
  ToolCallLog: 'tool-call-logs',
}

/**
 * Cache entry for request deduplication
 */
interface CacheEntry {
  promise: Promise<any>
  timestamp: number
}

export class APIPersistence implements IPersistenceService {
  private userId: string | null = null

  /**
   * In-flight request cache for deduplication.
   * Key is the full endpoint URL, value is the pending promise and timestamp.
   * This ensures multiple simultaneous calls to the same endpoint share one request.
   */
  private requestCache = new Map<string, CacheEntry>()

  /**
   * Set the current user ID for user-scoped queries.
   * Also clears the request cache when user changes to ensure fresh data.
   */
  setUserId(userId: string | null): void {
    if (this.userId !== userId) {
      this.requestCache.clear()
    }
    this.userId = userId
  }

  // === Helper methods ===

  /**
   * Get a cached request if still valid, or undefined if expired/not found.
   */
  private getCachedRequest(cacheKey: string): Promise<any> | undefined {
    const entry = this.requestCache.get(cacheKey)
    if (!entry) return undefined

    const age = Date.now() - entry.timestamp
    if (age > DEDUP_CACHE_MS) {
      // Cache expired, remove it
      this.requestCache.delete(cacheKey)
      return undefined
    }

    return entry.promise
  }

  /**
   * Store a request promise in the cache for deduplication.
   */
  private cacheRequest(cacheKey: string, promise: Promise<any>): void {
    this.requestCache.set(cacheKey, {
      promise,
      timestamp: Date.now(),
    })

    // Clean up after the dedup window expires
    setTimeout(() => {
      const entry = this.requestCache.get(cacheKey)
      if (entry && Date.now() - entry.timestamp >= DEDUP_CACHE_MS) {
        this.requestCache.delete(cacheKey)
      }
    }, DEDUP_CACHE_MS + 10)
  }

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
   *
   * OPTIMIZATION: Uses request deduplication to prevent API spam when multiple
   * components call loadCollection() for the same resource simultaneously.
   */
  async loadCollection(ctx: PersistenceContext): Promise<any | null> {
    try {
      const endpoint = this.getCollectionEndpoint(ctx)
      if (!endpoint) {
        console.warn(`[APIPersistence] No endpoint for model: ${ctx.modelName}`)
        return null
      }

      // Check for in-flight or recently cached request
      const cachedPromise = this.getCachedRequest(endpoint)
      if (cachedPromise) {
        return cachedPromise
      }

      // Create the actual fetch promise
      const fetchPromise = (async () => {
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
      })()

      // Cache the promise for deduplication
      this.cacheRequest(endpoint, fetchPromise)

      return fetchPromise
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
   * - Convert embedded objects (from Prisma includes) to just their IDs for MST references
   */
  private transformForMST(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj
    
    const dateFields = ['createdAt', 'updatedAt', 'expiresAt', 'publishedAt', 'readAt', 'emailSentAt', 'lastActiveAt']
    // Fields that are FK references (e.g., workspaceId -> workspace as MST reference)
    const referenceFields = ['workspaceId', 'projectId', 'folderId', 'parentId', 'userId']
    // Fields that should be treated as references (MST expects just an ID, not an object)
    // These correspond to Prisma relations that get included as full objects
    const referenceObjectFields = ['workspace', 'project', 'folder', 'parent', 'user']
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
      // Handle embedded reference objects (from Prisma includes) - extract just the ID
      // MST expects references to be string IDs, not full objects
      else if (referenceObjectFields.includes(key) && value && typeof value === 'object' && 'id' in value) {
        // Extract just the ID for MST reference resolution
        result[key] = value.id
      }
      // Convert date strings to timestamps
      else if (dateFields.includes(key) && typeof value === 'string') {
        result[key] = new Date(value).getTime()
      }
      // Recursively transform nested objects (but not reference objects which we handle above)
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
   * Transform MST snapshot for API compatibility:
   * - Convert timestamps (numbers) to ISO date strings for DateTime fields
   * - Convert reference fields back to ID fields (e.g., workspace -> workspaceId)
   */
  private transformForAPI(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj
    
    const dateFields = ['createdAt', 'updatedAt', 'expiresAt', 'publishedAt', 'readAt', 'emailSentAt', 'lastActiveAt']
    // MST reference fields that need to be converted to *Id fields for API
    const referenceFields = ['workspace', 'project', 'folder', 'parent', 'user', 'session', 'chatSession']
    const result: Record<string, any> = {}
    
    for (const [key, value] of Object.entries(obj)) {
      // Skip undefined values
      if (value === undefined) {
        continue
      }
      
      // Convert timestamps to ISO date strings for DateTime fields
      if (dateFields.includes(key) && typeof value === 'number') {
        result[key] = new Date(value).toISOString()
      }
      // Convert MST reference fields to *Id fields for API
      // (e.g., session: "uuid" -> sessionId: "uuid")
      else if (referenceFields.includes(key) && typeof value === 'string') {
        // Keep the original reference field for convenience
        result[key] = value
        // Also add the *Id version for Prisma compatibility
        result[`${key}Id`] = value
      }
      // Recursively transform nested objects
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.transformForAPI(value)
      }
      // Keep arrays and other values as-is
      else {
        result[key] = value
      }
    }
    
    return result
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

      // Transform MST snapshot to API-compatible format
      const apiData = this.transformForAPI(snapshot)

      if (existing) {
        // Update existing entity
        await this.fetchJson(`${baseEndpoint}/${ctx.entityId}`, {
          method: 'PATCH',
          body: JSON.stringify(apiData),
        })
      } else {
        // Create new entity
        await this.fetchJson(baseEndpoint, {
          method: 'POST',
          body: JSON.stringify({ ...apiData, id: ctx.entityId }),
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

    const routePath = MODEL_ROUTE_MAP[modelName]
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

    const routePath = MODEL_ROUTE_MAP[modelName]
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
