/**
 * Browser-side persistence implementation that delegates to MCP tools.
 *
 * This allows browser-based MST stores to persist data to the server
 * via the MCP protocol, achieving isomorphic persistence with the
 * server-side FileSystemPersistence.
 */
import type { MCPService, BatchToolCall } from '../services/MCPService'
import type {
  IPersistenceService,
  PersistenceContext,
  EntityContext
} from '@shogo/state-api'

export class MCPPersistence implements IPersistenceService {
  private initialized = false
  private initPromise: Promise<void> | null = null

  constructor(private mcp: MCPService) { }

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
   * Uses schema.load which creates the runtime store server-side and returns
   * the full enhanced JSON schema (preserving x-renderer, format, and all extensions).
   */
  async loadSchema(name: string, location?: string): Promise<{
    metadata: { name: string; id?: string; views?: Record<string, any> }
    enhanced: any
  } | null> {
    await this.ensureInitialized()
    try {
      // Load schema (triggers server-side caching and returns full enhanced schema)
      // Default workspace to "workspace" if not provided
      const workspace = location || 'workspace'

      const loadResult = await this.mcp.callTool<{
        ok: boolean
        schemaId?: string
        enhanced?: any  // Full enhanced JSON schema with all x-* extensions
        models?: Array<{
          name: string
          collectionName: string
          fields: Array<{ name: string; type: string; required?: boolean }>
          refs?: Array<{ name: string; target: string; type: 'single' | 'array' }>
        }>
        error?: { code?: string; message: string }
      }>('schema.load', { name, workspace })

      if (!loadResult?.ok) {
        const errorCode = loadResult?.error?.code || 'UNKNOWN_ERROR'
        const errorMessage = loadResult?.error?.message || 'Unknown schema load error'

        // Log with appropriate severity - SCHEMA_NOT_FOUND is often expected during app creation
        if (errorCode === 'SCHEMA_NOT_FOUND') {
          console.debug(`[MCPPersistence] Schema '${name}' not found - may need to be created first`)
        } else {
          console.warn('[MCPPersistence] schema.load failed:', errorMessage)
        }
        return null
      }

      // Use the full enhanced schema directly (preserves x-renderer, format, etc.)
      // Fall back to reconstructing from model descriptors for backward compatibility
      let enhanced = loadResult.enhanced
      if (!enhanced) {
        console.warn('[MCPPersistence] No enhanced schema in response, falling back to model descriptors')
        const $defs: Record<string, any> = {}

        for (const model of loadResult.models || []) {
          const properties: Record<string, any> = {}
          const required: string[] = []

          for (const field of model.fields || []) {
            properties[field.name] = { type: field.type }
            if (field.required) {
              required.push(field.name)
            }
          }

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

        enhanced = {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $defs
        }
      }

      return {
        metadata: {
          name,
          id: loadResult.schemaId
        },
        enhanced
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

  // === Batch Operations (Optimization) ===

  /**
   * Load multiple schemas in a single batched HTTP request.
   * OPTIMIZATION: Reduces N HTTP requests to 1 for schema loading.
   */
  async loadSchemasBatch(
    schemas: Array<{ name: string; location?: string }>
  ): Promise<Map<string, { metadata: { name: string; id?: string }; enhanced: any } | null>> {
    await this.ensureInitialized()

    const calls: BatchToolCall[] = schemas.map(({ name, location }) => ({
      name: 'schema.load',
      arguments: { name, workspace: location || 'workspace' }
    }))

    const results = await this.mcp.callToolsBatch(calls)
    const resultMap = new Map<string, { metadata: { name: string; id?: string }; enhanced: any } | null>()

    schemas.forEach((schema, index) => {
      const result = results[index]
      if (!result.ok) {
        console.warn(`[MCPPersistence] batch schema.load failed for "${schema.name}":`, result.error)
        resultMap.set(schema.name, null)
        return
      }

      const loadResult = result.result as {
        ok: boolean
        schemaId?: string
        enhanced?: any  // Full enhanced JSON schema with all x-* extensions
        models?: Array<{
          name: string
          collectionName: string
          fields: Array<{ name: string; type: string; required?: boolean }>
          refs?: Array<{ name: string; target: string; type: 'single' | 'array' }>
        }>
        error?: { message: string }
      }

      if (!loadResult?.ok) {
        console.warn(`[MCPPersistence] batch schema.load failed for "${schema.name}":`, loadResult?.error?.message)
        resultMap.set(schema.name, null)
        return
      }

      // Use the full enhanced schema directly (preserves x-authorization, x-renderer, etc.)
      // Fall back to reconstructing from model descriptors for backward compatibility
      let enhanced = loadResult.enhanced
      if (!enhanced) {
        console.warn(`[MCPPersistence] No enhanced schema in batch response for "${schema.name}", falling back to model descriptors`)
        const $defs: Record<string, any> = {}
        for (const model of loadResult.models || []) {
          const properties: Record<string, any> = {}
          const required: string[] = []

          for (const field of model.fields || []) {
            properties[field.name] = { type: field.type }
            if (field.required) {
              required.push(field.name)
            }
          }

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
        enhanced = {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $defs
        }
      }

      resultMap.set(schema.name, {
        metadata: { name: schema.name, id: loadResult.schemaId },
        enhanced
      })
    })

    return resultMap
  }

  /**
   * Load multiple collections in a single batched HTTP request.
   * OPTIMIZATION: Reduces N HTTP requests to 1 for collection loading.
   */
  async loadCollectionsBatch(
    collections: Array<PersistenceContext>
  ): Promise<Map<string, { items: Record<string, any> } | null>> {
    await this.ensureInitialized()

    const calls: BatchToolCall[] = collections.map((ctx) => ({
      name: 'store.query',
      arguments: {
        schema: ctx.schemaName,
        model: ctx.modelName,
        workspace: ctx.location,
        filter: ctx.filter
      }
    }))

    const results = await this.mcp.callToolsBatch(calls)
    const resultMap = new Map<string, { items: Record<string, any> } | null>()

    collections.forEach((ctx, index) => {
      const key = `${ctx.schemaName}:${ctx.modelName}`
      const result = results[index]

      if (!result.ok) {
        console.warn(`[MCPPersistence] batch store.query failed for "${key}":`, result.error)
        resultMap.set(key, null)
        return
      }

      const queryResult = result.result as {
        ok: boolean
        items?: any[]
        error?: { message: string }
      }

      if (!queryResult?.ok || !queryResult.items) {
        resultMap.set(key, null)
        return
      }

      // Transform array to items map (MST collection format)
      const items: Record<string, any> = {}
      for (const item of queryResult.items) {
        if (item.id) {
          items[item.id] = item
        }
      }

      resultMap.set(key, { items })
    })

    return resultMap
  }
}
