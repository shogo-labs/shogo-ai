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
   * Uses schema.load which creates the runtime store server-side.
   * Converts the model descriptors response into enhanced JSON schema format
   * that can be ingested by the meta-store.
   */
  async loadSchema(name: string, location?: string): Promise<{
    metadata: { name: string; id?: string; views?: Record<string, any> }
    enhanced: any
  } | null> {
    await this.ensureInitialized()
    try {
      // Load schema (triggers server-side caching and returns metadata)
      const loadResult = await this.mcp.callTool<{
        ok: boolean
        schemaId?: string
        models?: Array<{
          name: string
          collectionName: string
          fields: Array<{ name: string; type: string; required?: boolean }>
          refs?: Array<{ name: string; target: string; type: 'single' | 'array' }>
        }>
        error?: { message: string }
      }>('schema.load', { name, workspace: location })

      if (!loadResult?.ok) {
        console.warn('[MCPPersistence] schema.load failed:', loadResult?.error?.message)
        return null
      }

      // Convert model descriptors back to enhanced JSON schema format
      // This allows the meta-store to ingest them properly
      const $defs: Record<string, any> = {}

      for (const model of loadResult.models || []) {
        const properties: Record<string, any> = {}
        const required: string[] = []

        // Convert fields to properties
        for (const field of model.fields || []) {
          properties[field.name] = { type: field.type }
          if (field.required) {
            required.push(field.name)
          }
        }

        // Convert refs to properties with x-reference-type
        for (const ref of model.refs || []) {
          properties[ref.name] = {
            $ref: `#/$defs/${ref.target}`,
            'x-reference-type': ref.type
          }
        }

        $defs[model.name] = {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {})
        }
      }

      return {
        metadata: {
          name,
          id: loadResult.schemaId
        },
        enhanced: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $defs
        }
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
   * Load a collection via MCP store.query tool.
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
      }>('store.query', {
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
