/**
 * Browser-side persistence implementation that delegates to MCP tools.
 *
 * This allows browser-based MST stores to persist data to the server
 * via the MCP protocol, achieving isomorphic persistence with the
 * server-side FileSystemPersistence.
 */
import type { MCPService } from '../services/mcpService'
import type {
  IPersistenceService,
  PersistenceContext,
  EntityContext
} from '@shogo/state-api'

export class MCPPersistence implements IPersistenceService {
  private initialized = false
  private initPromise: Promise<void> | null = null

  constructor(private mcp: MCPService) {}

  // === Lazy Initialization ===

  /**
   * Ensure MCP session is initialized before any operations.
   * Uses lazy initialization with retry logic for transient failures.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return

    if (!this.initPromise) {
      this.initPromise = this.initWithRetry()
    }
    await this.initPromise
  }

  /**
   * Initialize with retry and exponential backoff.
   * Clears the cached promise on final failure to allow future retries.
   */
  private async initWithRetry(maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.mcp.initializeSession()
        this.initialized = true
        return
      } catch (error) {
        if (attempt === maxRetries) {
          // Clear the promise so future calls can retry
          this.initPromise = null
          throw error
        }
        // Exponential backoff: 100ms, 200ms, 400ms...
        await this.delay(100 * Math.pow(2, attempt - 1))
      }
    }
  }

  /**
   * Helper for async delay.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // === Schema operations ===

  /**
   * Load a schema by name via MCP.
   * First triggers schema.load (server-side caching), then retrieves payload via schema.get.
   */
  async loadSchema(name: string, location?: string): Promise<{
    metadata: { name: string; id?: string; views?: Record<string, any> }
    enhanced: any
  } | null> {
    await this.ensureInitialized()
    try {
      // First load schema (triggers server-side caching and returns metadata)
      const loadResult = await this.mcp.callTool<{
        ok: boolean
        schemaId?: string
        error?: { message: string }
      }>('schema.load', { name, workspace: location })

      if (!loadResult?.ok) {
        console.warn('[MCPPersistence] schema.load failed:', loadResult?.error?.message)
        return null
      }

      // Then get the full schema payload
      const getResult = await this.mcp.callTool<{
        ok: boolean
        format?: string
        payload?: any
        views?: Record<string, any>
        error?: { message: string }
      }>('schema.get', { name })

      if (!getResult?.ok || !getResult.payload) {
        console.warn('[MCPPersistence] schema.get failed:', getResult?.error?.message)
        return null
      }

      return {
        metadata: {
          name,
          id: loadResult.schemaId,
          views: getResult.views
        },
        enhanced: getResult.payload
      }
    } catch (error: any) {
      console.error('[MCPPersistence] loadSchema error:', error.message)
      return null
    }
  }

  /**
   * List available schemas via MCP.
   */
  async listSchemas(location?: string): Promise<string[]> {
    await this.ensureInitialized()
    try {
      const result = await this.mcp.callTool<{
        ok: boolean
        schemas?: Array<{ name: string }>
      }>('schema.list', {})

      return result?.schemas?.map(s => s.name) || []
    } catch (error: any) {
      console.error('[MCPPersistence] listSchemas error:', error.message)
      return []
    }
  }

  // === Data operations ===

  /**
   * Load a collection via MCP store.list tool.
   * Transforms the array response into MST collection format { items: { [id]: entity } }.
   * Passes filter through for partition pushdown optimization.
   */
  async loadCollection(ctx: PersistenceContext): Promise<any | null> {
    await this.ensureInitialized()
    try {
      const result = await this.mcp.callTool<{
        ok: boolean
        items?: any[]
        error?: { message: string }
      }>('store.list', {
        schema: ctx.schemaName,
        model: ctx.modelName,
        workspace: ctx.location,
        filter: ctx.filter  // Enable partition pushdown from browser
      })

      if (!result?.ok || !result.items) {
        return null
      }

      // Transform array to items map (MST collection format)
      const items: Record<string, any> = {}
      for (const item of result.items) {
        if (item.id) {
          items[item.id] = item
        }
      }

      return { items }
    } catch (error: any) {
      console.error('[MCPPersistence] loadCollection error:', error.message)
      return null
    }
  }

  /**
   * Save a collection via MCP.
   * Since MCP doesn't have a bulk save, we update each entity individually.
   *
   * Note: This is less efficient than FileSystemPersistence but maintains consistency
   * with MCP's entity-level operations.
   */
  async saveCollection(ctx: PersistenceContext, snapshot: any): Promise<void> {
    await this.ensureInitialized()
    const items = snapshot.items || {}

    for (const [id, entity] of Object.entries(items)) {
      try {
        // Use store.update for each entity
        await this.mcp.callTool('store.update', {
          schema: ctx.schemaName,
          model: ctx.modelName,
          id,
          changes: entity,
          workspace: ctx.location
        })
      } catch (error: any) {
        console.error(`[MCPPersistence] saveCollection failed for ${id}:`, error.message)
        // Continue with other entities
      }
    }
  }

  /**
   * Load a single entity via MCP store.get tool.
   */
  async loadEntity(ctx: EntityContext): Promise<any | null> {
    await this.ensureInitialized()
    try {
      const result = await this.mcp.callTool<{
        ok: boolean
        data?: any
        error?: { message: string }
      }>('store.get', {
        schema: ctx.schemaName,
        model: ctx.modelName,
        id: ctx.entityId,
        workspace: ctx.location
      })

      return result?.data || null
    } catch (error: any) {
      console.error('[MCPPersistence] loadEntity error:', error.message)
      return null
    }
  }

  /**
   * Save a single entity via MCP.
   * Determines whether to create or update based on existence check.
   */
  async saveEntity(ctx: EntityContext, snapshot: any): Promise<void> {
    await this.ensureInitialized()
    try {
      // Check if entity exists to decide create vs update
      const existing = await this.loadEntity(ctx)

      if (existing) {
        // Update existing entity
        await this.mcp.callTool('store.update', {
          schema: ctx.schemaName,
          model: ctx.modelName,
          id: ctx.entityId,
          changes: snapshot,
          workspace: ctx.location
        })
      } else {
        // Create new entity
        await this.mcp.callTool('store.create', {
          schema: ctx.schemaName,
          model: ctx.modelName,
          data: { ...snapshot, id: ctx.entityId },
          workspace: ctx.location
        })
      }
    } catch (error: any) {
      console.error('[MCPPersistence] saveEntity error:', error.message)
      throw error
    }
  }
}
