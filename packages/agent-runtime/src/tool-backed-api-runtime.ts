/**
 * Tool-Backed API Runtime
 *
 * Creates Hono CRUD routes that proxy to installed tool calls instead of SQLite.
 * This allows the canvas to bind to `/api/{model}` endpoints that are backed by
 * live tool integrations (e.g. Google Calendar, GitHub Issues).
 *
 * Sibling to ManagedApiRuntime — same REST interface, different backing store.
 */

import { Hono } from 'hono'
import type { MCPClientManager } from './mcp-client'
import type { FieldType, ModelField } from './managed-api-runtime'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCrudBinding {
  /** The full tool name (e.g. "GOOGLECALENDAR_LIST_EVENTS") */
  tool: string
  /** Static params to always include in the tool call */
  params?: Record<string, unknown>
  /** Dot-path to extract the results array from the tool response JSON */
  resultPath?: string
  /** Maps model field names to tool parameter names. Value ":id" is interpolated from the route param. */
  paramMap?: Record<string, string>
}

export interface ToolBindingConfig {
  model: string
  fields: ModelField[]
  bindings: {
    list?: ToolCrudBinding
    get?: ToolCrudBinding
    create?: ToolCrudBinding
    update?: ToolCrudBinding
    delete?: ToolCrudBinding
  }
  cache?: {
    enabled: boolean
    ttlSeconds?: number
  }
  /** When set, auto-query the list binding and push results to this data model path */
  dataPath?: string
}

interface CacheEntry {
  data: unknown[]
  fetchedAt: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPlural(name: string): string {
  const lower = name.charAt(0).toLowerCase() + name.slice(1)
  const kebab = lower.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
  if (kebab.endsWith('y') && !kebab.endsWith('ay') && !kebab.endsWith('ey') && !kebab.endsWith('oy') && !kebab.endsWith('uy')) {
    return kebab.slice(0, -1) + 'ies'
  }
  if (kebab.endsWith('s') || kebab.endsWith('x') || kebab.endsWith('ch') || kebab.endsWith('sh')) {
    return kebab + 'es'
  }
  return kebab + 's'
}

function extractAtPath(data: unknown, path?: string): unknown {
  if (!path) return data
  const parts = path.split('.')
  let current: any = data
  for (const part of parts) {
    if (current == null) return undefined
    current = current[part]
  }
  return current
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}

function mapParams(
  body: Record<string, unknown>,
  paramMap: Record<string, string>,
  routeId?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [toolParam, source] of Object.entries(paramMap)) {
    if (source === ':id') {
      result[toolParam] = routeId
    } else {
      result[toolParam] = body[source] ?? body[toolParam]
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class ToolBackedApiRuntime {
  private app: Hono
  private mcpClient: MCPClientManager
  private bindings: ToolBindingConfig[]
  private cache = new Map<string, CacheEntry>()

  constructor(mcpClient: MCPClientManager) {
    this.mcpClient = mcpClient
    this.bindings = []
    this.app = new Hono()
  }

  addBinding(config: ToolBindingConfig): { model: string; endpoint: string; methods: string[] } {
    this.bindings.push(config)
    const plural = toPlural(config.model)
    const basePath = `/api/${plural}`
    const methods: string[] = []

    if (config.bindings.list) {
      methods.push('GET')
      this.app.get(basePath, async (c) => {
        try {
          const binding = config.bindings.list!
          const cacheKey = `${config.model}:list`
          const ttl = (config.cache?.enabled && config.cache?.ttlSeconds)
            ? config.cache.ttlSeconds * 1000
            : 0

          if (ttl > 0) {
            const cached = this.cache.get(cacheKey)
            if (cached && Date.now() - cached.fetchedAt < ttl) {
              return c.json({ ok: true, items: cached.data, cached: true })
            }
          }

          const result = await this.mcpClient.callTool(binding.tool, binding.params || {})
          if (!result.ok) {
            return c.json({ ok: false, error: result.error }, 500)
          }

          const parsed = tryParseJson(result.data || '{}')
          let items = extractAtPath(parsed, binding.resultPath)
          if (!Array.isArray(items)) {
            items = parsed ? [parsed] : []
          }

          if (ttl > 0) {
            this.cache.set(cacheKey, { data: items as unknown[], fetchedAt: Date.now() })
          }

          return c.json({ ok: true, items })
        } catch (err: any) {
          return c.json({ ok: false, error: err.message }, 500)
        }
      })
    }

    if (config.bindings.get) {
      methods.push('GET /:id')
      this.app.get(`${basePath}/:id`, async (c) => {
        try {
          const id = c.req.param('id')
          const binding = config.bindings.get!
          const params = {
            ...(binding.params || {}),
            ...(binding.paramMap ? mapParams({}, binding.paramMap, id) : { id }),
          }
          const result = await this.mcpClient.callTool(binding.tool, params)
          if (!result.ok) {
            return c.json({ ok: false, error: result.error }, 500)
          }
          const parsed = tryParseJson(result.data || '{}')
          const item = extractAtPath(parsed, binding.resultPath) ?? parsed
          return c.json({ ok: true, item })
        } catch (err: any) {
          return c.json({ ok: false, error: err.message }, 500)
        }
      })
    }

    if (config.bindings.create) {
      methods.push('POST')
      this.app.post(basePath, async (c) => {
        try {
          const body = await c.req.json()
          const binding = config.bindings.create!
          const params = {
            ...(binding.params || {}),
            ...(binding.paramMap ? mapParams(body, binding.paramMap) : body),
          }
          const result = await this.mcpClient.callTool(binding.tool, params)
          if (!result.ok) {
            return c.json({ ok: false, error: result.error }, 500)
          }
          this.invalidateCache(config.model)
          const parsed = tryParseJson(result.data || '{}')
          return c.json({ ok: true, item: parsed }, 201)
        } catch (err: any) {
          return c.json({ ok: false, error: err.message }, 400)
        }
      })
    }

    if (config.bindings.update) {
      methods.push('PATCH /:id')
      this.app.patch(`${basePath}/:id`, async (c) => {
        try {
          const id = c.req.param('id')
          const body = await c.req.json()
          const binding = config.bindings.update!
          const params = {
            ...(binding.params || {}),
            ...(binding.paramMap ? mapParams(body, binding.paramMap, id) : { ...body, id }),
          }
          const result = await this.mcpClient.callTool(binding.tool, params)
          if (!result.ok) {
            return c.json({ ok: false, error: result.error }, 500)
          }
          this.invalidateCache(config.model)
          const parsed = tryParseJson(result.data || '{}')
          return c.json({ ok: true, item: parsed })
        } catch (err: any) {
          return c.json({ ok: false, error: err.message }, 400)
        }
      })
    }

    if (config.bindings.delete) {
      methods.push('DELETE /:id')
      this.app.delete(`${basePath}/:id`, async (c) => {
        try {
          const id = c.req.param('id')
          const binding = config.bindings.delete!
          const params = {
            ...(binding.params || {}),
            ...(binding.paramMap ? mapParams({}, binding.paramMap, id) : { id }),
          }
          const result = await this.mcpClient.callTool(binding.tool, params)
          if (!result.ok) {
            return c.json({ ok: false, error: result.error }, 500)
          }
          this.invalidateCache(config.model)
          return c.json({ ok: true })
        } catch (err: any) {
          return c.json({ ok: false, error: err.message }, 500)
        }
      })
    }

    return { model: config.model, endpoint: basePath, methods }
  }

  invalidateCache(model: string): void {
    this.cache.delete(`${model}:list`)
  }

  getApp(): Hono { return this.app }
  getBindings(): ToolBindingConfig[] { return this.bindings }

  getEndpointInfo(): Array<{ name: string; endpoint: string; fields: string[] }> {
    return this.bindings.map(b => ({
      name: b.model,
      endpoint: `/api/${toPlural(b.model)}`,
      fields: b.fields.map(f => f.name),
    }))
  }

  /**
   * Fetch list data directly (without going through HTTP) for a given model.
   * Used for auto-query when `dataPath` is provided and for reactive invalidation.
   */
  async fetchListData(model: string): Promise<{ ok: boolean; items?: unknown[]; error?: string }> {
    const config = this.bindings.find(b => b.model === model)
    if (!config?.bindings.list) {
      return { ok: false, error: `No list binding for model "${model}"` }
    }
    const binding = config.bindings.list
    try {
      const result = await this.mcpClient.callTool(binding.tool, binding.params || {})
      if (!result.ok) {
        return { ok: false, error: result.error }
      }
      const parsed = tryParseJson(result.data || '{}')
      let items = extractAtPath(parsed, binding.resultPath)
      if (!Array.isArray(items)) {
        items = parsed ? [parsed] : []
      }

      const ttl = (config.cache?.enabled && config.cache?.ttlSeconds)
        ? config.cache.ttlSeconds * 1000
        : 0
      if (ttl > 0) {
        this.cache.set(`${model}:list`, { data: items as unknown[], fetchedAt: Date.now() })
      }

      return { ok: true, items: items as unknown[] }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }

  /**
   * Returns a map of MCP tool names to the models they're bound to.
   * Used by the reactive invalidation hook to detect when a tool call
   * affects a bound model.
   */
  getBoundToolNames(): Map<string, string> {
    const map = new Map<string, string>()
    for (const config of this.bindings) {
      const { list, get, create, update, delete: del } = config.bindings
      if (list) map.set(list.tool, config.model)
      if (get) map.set(get.tool, config.model)
      if (create) map.set(create.tool, config.model)
      if (update) map.set(update.tool, config.model)
      if (del) map.set(del.tool, config.model)
    }
    return map
  }
}
