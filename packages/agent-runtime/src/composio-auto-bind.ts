/**
 * Composio Auto-Bind
 *
 * Generates ToolBindingConfig automatically from Composio tool schemas.
 * Uses the Composio REST API to fetch tool metadata including output schemas,
 * then applies CRUD classification (via tags + slug patterns), entity grouping,
 * field inference, and resultPath discovery.
 *
 * This eliminates the "prior knowledge" requirement — the agent can auto-bind
 * a toolkit purely from schema introspection + one optional sample call.
 */

import type { ToolBindingConfig, ToolCrudBinding } from './tool-backed-api-runtime'
import type { FieldType, ModelField } from './managed-api-runtime'
import type { MCPClientManager } from './mcp-client'

// ---------------------------------------------------------------------------
// Composio REST API types (from GET /api/v3/tools)
// ---------------------------------------------------------------------------

export interface ComposioToolSchema {
  slug: string
  name: string
  description?: string
  input_parameters?: JsonSchemaObject
  output_parameters?: JsonSchemaObject
  tags?: string[]
  toolkit?: { slug: string; name: string; logo?: string }
  no_auth?: boolean
  version?: string
  is_deprecated?: boolean
  scopes?: string[]
}

interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

interface JsonSchemaProperty {
  type?: string
  description?: string
  properties?: Record<string, JsonSchemaProperty>
  items?: JsonSchemaProperty
  required?: string[]
  additionalProperties?: boolean
  nullable?: boolean
  title?: string
  default?: unknown
  anyOf?: JsonSchemaProperty[]
  oneOf?: JsonSchemaProperty[]
  enum?: string[]
}

// ---------------------------------------------------------------------------
// CRUD classification
// ---------------------------------------------------------------------------

type CrudRole = 'list' | 'get' | 'create' | 'update' | 'delete'

interface ClassifiedTool {
  slug: string
  mcpName: string
  role: CrudRole
  entity: string
  tags: string[]
  outputSchema?: JsonSchemaObject
  inputSchema?: JsonSchemaObject
}

const TAG_ROLE_MAP: Record<string, CrudRole | null> = {
  readOnlyHint: null, // ambiguous between list/get — use slug pattern
  updateHint: 'update',
  destructiveHint: 'delete',
}

const SLUG_PATTERNS: Array<{ pattern: RegExp; role: CrudRole }> = [
  { pattern: /^LIST_|_LIST_|_LIST$/, role: 'list' },
  { pattern: /^FIND_|_FIND_|_FIND$/, role: 'list' },
  { pattern: /^SEARCH_|_SEARCH_|_SEARCH$/, role: 'list' },
  { pattern: /^GET_|_GET_|_GET$/, role: 'get' },
  { pattern: /^CREATE_|_CREATE_|_CREATE$/, role: 'create' },
  { pattern: /^ADD_|_ADD_|_ADD$/, role: 'create' },
  { pattern: /^INSERT_|_INSERT_|_INSERT$/, role: 'create' },
  { pattern: /^UPDATE_|_UPDATE_|_UPDATE$/, role: 'update' },
  { pattern: /^PATCH_|_PATCH_|_PATCH$/, role: 'update' },
  { pattern: /^MODIFY_|_MODIFY_|_MODIFY$/, role: 'update' },
  { pattern: /^DELETE_|_DELETE_|_DELETE$/, role: 'delete' },
  { pattern: /^REMOVE_|_REMOVE_|_REMOVE$/, role: 'delete' },
]

function classifyCrudRole(slug: string, tags: string[]): CrudRole | null {
  // Tags are reliable for update/delete classification
  for (const tag of tags) {
    const mapped = TAG_ROLE_MAP[tag]
    if (mapped) return mapped
  }

  // For slug-based classification, use the LAST matching action word.
  // This handles cases like "CALENDAR_LIST_INSERT" where INSERT is the action
  // and LIST is part of the resource name (CalendarList).
  const upperSlug = slug.toUpperCase()
  const parts = upperSlug.split('_')
  let lastMatchedRole: CrudRole | null = null
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    for (const { pattern, role } of SLUG_PATTERNS) {
      if (pattern.test(`_${part}_`)) {
        if (!lastMatchedRole) lastMatchedRole = role
      }
    }
    if (lastMatchedRole) break
  }
  if (lastMatchedRole) return lastMatchedRole

  if (tags.includes('readOnlyHint')) {
    if (/GET/.test(upperSlug)) return 'get'
    if (/LIST|FIND|SEARCH/.test(upperSlug)) return 'list'
    return 'get'
  }

  return null
}

// ---------------------------------------------------------------------------
// Entity extraction from slug
// ---------------------------------------------------------------------------

/**
 * Extract the entity name from a Composio tool slug.
 * e.g., "GOOGLECALENDAR_CREATE_EVENT" → "Event"
 *       "LINEAR_LIST_LINEAR_ISSUES" → "Issue"
 *       "GITHUB_LIST_PULL_REQUESTS" → "PullRequest"
 */
function extractEntity(slug: string, toolkitSlug: string): string {
  const prefix = toolkitSlug.toUpperCase().replace(/-/g, '_')
  let rest = slug.startsWith(prefix + '_') ? slug.slice(prefix.length + 1) : slug

  const actionWords = new Set([
    'LIST', 'GET', 'CREATE', 'UPDATE', 'DELETE', 'FIND', 'SEARCH',
    'ADD', 'REMOVE', 'INSERT', 'PATCH', 'MODIFY', 'ALL',
  ])

  // Also strip the toolkit name if it appears within the action part (e.g., LINEAR_LIST_LINEAR_ISSUES)
  const parts = rest.split('_').filter(p => {
    const up = p.toUpperCase()
    return !actionWords.has(up) && up !== prefix.replace(/_/g, '')
  })

  if (parts.length === 0) return 'Item'

  return parts.map(p => singularize(capitalize(p.toLowerCase()))).join('')
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function singularize(word: string): string {
  if (word.endsWith('ies') && word.length > 4) {
    return word.slice(0, -3) + 'y'
  }
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('ches') || word.endsWith('shes')) {
    return word.slice(0, -2)
  }
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && word.length > 2) {
    return word.slice(0, -1)
  }
  return word
}

// ---------------------------------------------------------------------------
// ResultPath discovery from output schema
// ---------------------------------------------------------------------------

// Arrays that are metadata, not primary data lists
const METADATA_ARRAY_NAMES = new Set([
  'default_reminders', 'defaultreminders', 'reminders', 'attachments',
  'scopes', 'tags', 'errors', 'warnings',
])

/**
 * Walk the output_parameters schema to find the path to the data array.
 * Composio wraps all responses in { data: { ... }, error, successful }.
 * The actual items array is nested inside `data`.
 */
function discoverResultPath(outputSchema?: JsonSchemaObject): string | undefined {
  if (!outputSchema?.properties) return undefined

  const dataField = outputSchema.properties['data']
  if (!dataField?.properties) return undefined

  // Prefer arrays named "items", then other data-like arrays, skip metadata arrays
  const arrays: Array<{ key: string; priority: number }> = []
  for (const [key, prop] of Object.entries(dataField.properties)) {
    if (prop.type !== 'array') continue
    const lowerKey = key.toLowerCase().replace(/_/g, '')
    if (METADATA_ARRAY_NAMES.has(lowerKey)) continue

    let priority = 1
    if (key === 'items') priority = 10
    if (key === 'results' || key === 'entries' || key === 'records') priority = 8
    // Entity-named arrays (e.g., "issues", "events", "teams") are strong signals
    if (key.length > 3 && !['etag', 'kind', 'type'].includes(key)) priority = Math.max(priority, 5)
    arrays.push({ key, priority })
  }

  if (arrays.length === 0) return undefined
  arrays.sort((a, b) => b.priority - a.priority)
  return `data.${arrays[0].key}`
}

/**
 * Walk the output schema to find field names from the data object.
 * For create tools, fields are often directly on data.
 * For get tools, there's usually a single nested object.
 */
function discoverFieldsFromOutputSchema(outputSchema?: JsonSchemaObject, role?: CrudRole): ModelField[] {
  if (!outputSchema?.properties) return []

  const dataField = outputSchema.properties['data']
  if (!dataField?.properties) return []

  if (role === 'create') {
    // Create responses often have flat fields on data
    return Object.entries(dataField.properties)
      .filter(([_, prop]) => prop.type && prop.type !== 'object' && prop.type !== 'array')
      .map(([name, prop]) => ({
        name,
        type: jsonTypeToFieldType(prop.type, prop.description),
      }))
  }

  // For list/get, look inside nested objects/arrays for items
  for (const [_, prop] of Object.entries(dataField.properties)) {
    if (prop.type === 'array' && prop.items?.properties) {
      return Object.entries(prop.items.properties)
        .map(([name, itemProp]) => ({
          name,
          type: jsonTypeToFieldType(itemProp.type, itemProp.description),
        }))
    }
  }

  return []
}

function jsonTypeToFieldType(jsonType?: string, description?: string): FieldType {
  if (!jsonType) return 'String'

  const desc = (description || '').toLowerCase()
  if (desc.includes('timestamp') || desc.includes('datetime') || desc.includes('rfc3339') || desc.includes('date')) {
    return 'DateTime'
  }

  switch (jsonType) {
    case 'string': return 'String'
    case 'integer':
    case 'int': return 'Int'
    case 'number':
    case 'float': return 'Float'
    case 'boolean': return 'Boolean'
    case 'object':
    case 'array': return 'Json'
    default: return 'String'
  }
}

// ---------------------------------------------------------------------------
// Field inference from sample response data
// ---------------------------------------------------------------------------

function inferFieldsFromSample(item: Record<string, unknown>): ModelField[] {
  const fields: ModelField[] = []
  for (const [key, value] of Object.entries(item)) {
    if (value === null || value === undefined) {
      fields.push({ name: key, type: 'String', optional: true })
      continue
    }
    fields.push({ name: key, type: inferJsType(value, key) })
  }
  return fields
}

function inferJsType(value: unknown, key?: string): FieldType {
  if (typeof value === 'boolean') return 'Boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int' : 'Float'
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'DateTime'
    const k = (key || '').toLowerCase()
    if (k.endsWith('_at') || k.endsWith('date') || k.endsWith('time') || k === 'created' || k === 'updated') {
      return 'DateTime'
    }
    return 'String'
  }
  if (Array.isArray(value) || typeof value === 'object') return 'Json'
  return 'String'
}

// ---------------------------------------------------------------------------
// Composio REST API client
// ---------------------------------------------------------------------------

interface ComposioToolsResponse {
  total_items: number
  current_page: number
  total_pages: number
  next_cursor?: string | null
  items: ComposioToolSchema[]
}

/**
 * Fetch tools from the Composio REST API with full schema information.
 * Uses the REST API directly to get output_parameters for auto-bind.
 */
export async function fetchComposioToolSchemas(
  toolkitSlug: string,
  options?: { apiKey?: string; important?: boolean; limit?: number },
): Promise<ComposioToolSchema[]> {
  const directKey = options?.apiKey || process.env.COMPOSIO_API_KEY
  const proxyUrl = process.env.TOOLS_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  const authKey = directKey || proxyToken
  if (!authKey) throw new Error('COMPOSIO_API_KEY or TOOLS_PROXY_URL + AI_PROXY_TOKEN required')

  const baseUrl = directKey
    ? 'https://backend.composio.dev'
    : `${proxyUrl}/composio`

  const params = new URLSearchParams({
    toolkit_slug: toolkitSlug,
    limit: String(options?.limit || 100),
  })
  if (options?.important) params.set('important', 'true')

  const t0 = performance.now()
  const res = await fetch(`${baseUrl}/api/v3/tools?${params}`, {
    headers: { 'x-api-key': authKey },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    throw new Error(`Composio API error: ${res.status} ${res.statusText}`)
  }

  const data = await res.json() as ComposioToolsResponse
  const items = data.items || []
  const elapsed = performance.now() - t0
  console.log(`[Composio] [Timing] fetchSchemas(${toolkitSlug}): ${elapsed.toFixed(0)}ms (${items.length} tools)`)
  return items
}

// ---------------------------------------------------------------------------
// Entity grouping
// ---------------------------------------------------------------------------

export interface EntityGroup {
  entity: string
  tools: Map<CrudRole, ClassifiedTool>
}

/**
 * Group Composio tools by entity and CRUD role.
 * Returns a map of entity name → EntityGroup.
 */
export function groupToolsByEntity(
  tools: ComposioToolSchema[],
  toolkitSlug: string,
): Map<string, EntityGroup> {
  const groups = new Map<string, EntityGroup>()

  for (const tool of tools) {
    if (tool.is_deprecated) continue

    const role = classifyCrudRole(tool.slug, tool.tags || [])
    if (!role) continue

    const entity = extractEntity(tool.slug, toolkitSlug)

    const classified: ClassifiedTool = {
      slug: tool.slug,
      mcpName: tool.slug,
      role,
      entity,
      tags: tool.tags || [],
      outputSchema: tool.output_parameters as JsonSchemaObject | undefined,
      inputSchema: tool.input_parameters as JsonSchemaObject | undefined,
    }

    if (!groups.has(entity)) {
      groups.set(entity, { entity, tools: new Map() })
    }
    const group = groups.get(entity)!

    // Prefer direct _LIST slugs for list role (EVENTS_LIST > FIND_EVENT),
    // then fall back to "important" tag as a tiebreaker for other roles.
    const existing = group.tools.get(role)
    if (!existing) {
      group.tools.set(role, classified)
    } else if (role === 'list') {
      const existingIsList = /(_LIST$|_LIST_)/.test(existing.slug)
      const newIsList = /(_LIST$|_LIST_)/.test(tool.slug)
      if (newIsList && !existingIsList) {
        group.tools.set(role, classified)
      }
    } else {
      const isImportant = tool.tags?.includes('important') && !existing.tags.includes('important')
      if (isImportant) {
        group.tools.set(role, classified)
      }
    }
  }

  return groups
}

// ---------------------------------------------------------------------------
// Auto-bind config generation
// ---------------------------------------------------------------------------

export interface AutoBindResult {
  config: ToolBindingConfig
  entity: string
  discoveredFrom: 'schema' | 'sample' | 'schema+sample'
  tools: Record<string, string>
}

export interface AutoBindOptions {
  /** Override the model name (default: entity name from slug) */
  modelName?: string
  /** JSON Pointer path to auto-load list data (e.g. "/events") */
  dataPath?: string
  /** Enable caching (default: true for list bindings) */
  cache?: { enabled: boolean; ttlSeconds?: number }
  /** MCPClientManager for optional sample call when output schema is opaque */
  mcpClient?: MCPClientManager
  /** Max fields to include (default: 20) */
  maxFields?: number
  /** Only include entities with a list binding */
  requireList?: boolean
}

/**
 * Generate ToolBindingConfig(s) for a Composio toolkit.
 *
 * 1. Fetches tool schemas from the Composio REST API
 * 2. Groups tools by entity with CRUD classification
 * 3. Discovers resultPath from output schemas
 * 4. Infers fields from output schemas or a sample call
 * 5. Returns ready-to-use ToolBindingConfig for each entity
 */
export async function autoBindComposioToolkit(
  toolkitSlug: string,
  options: AutoBindOptions = {},
): Promise<AutoBindResult[]> {
  const tools = await fetchComposioToolSchemas(toolkitSlug)
  if (tools.length === 0) {
    throw new Error(`No tools found for toolkit "${toolkitSlug}"`)
  }

  const groups = groupToolsByEntity(tools, toolkitSlug)
  const results: AutoBindResult[] = []

  for (const [entity, group] of groups) {
    if (options.requireList !== false && !group.tools.has('list')) continue

    const listTool = group.tools.get('list')
    const getTool = group.tools.get('get')
    const createTool = group.tools.get('create')
    const updateTool = group.tools.get('update')
    const deleteTool = group.tools.get('delete')

    // Discover resultPath from the list tool's output schema
    const resultPath = listTool ? discoverResultPath(listTool.outputSchema) : undefined

    // Discover fields — first try output schema, then sample call
    let fields: ModelField[] = []
    let discoveredFrom: 'schema' | 'sample' | 'schema+sample' = 'schema'

    // Try output schema fields from create tool (usually has the most explicit fields)
    if (createTool?.outputSchema) {
      fields = discoverFieldsFromOutputSchema(createTool.outputSchema, 'create')
    }

    // Try list tool schema if create didn't yield fields
    if (fields.length === 0 && listTool?.outputSchema) {
      fields = discoverFieldsFromOutputSchema(listTool.outputSchema, 'list')
    }

    // Fall back to sample call if fields are still empty
    if (fields.length === 0 && listTool && options.mcpClient) {
      try {
        const sampleFields = await discoverFieldsViaSampleCall(
          listTool.mcpName,
          listTool.inputSchema,
          resultPath,
          options.mcpClient,
        )
        if (sampleFields.length > 0) {
          fields = sampleFields
          discoveredFrom = discoveredFrom === 'schema' ? 'sample' : 'schema+sample'
        }
      } catch (err) {
        console.warn(`[AutoBind] Sample call failed for ${entity}: ${(err as Error).message}`)
      }
    }

    // Limit fields
    const maxFields = options.maxFields || 20
    if (fields.length > maxFields) {
      fields = fields.slice(0, maxFields)
    }

    const modelName = options.modelName || entity

    const bindings: ToolBindingConfig['bindings'] = {}
    const toolMap: Record<string, string> = {}

    if (listTool) {
      const binding: ToolCrudBinding = { tool: listTool.mcpName }
      if (resultPath) binding.resultPath = resultPath
      bindings.list = binding
      toolMap.list = listTool.slug
    }
    if (getTool) {
      bindings.get = { tool: getTool.mcpName }
      toolMap.get = getTool.slug
    }
    if (createTool) {
      bindings.create = { tool: createTool.mcpName }
      toolMap.create = createTool.slug
    }
    if (updateTool) {
      bindings.update = { tool: updateTool.mcpName }
      toolMap.update = updateTool.slug
    }
    if (deleteTool) {
      bindings.delete = { tool: deleteTool.mcpName }
      toolMap.delete = deleteTool.slug
    }

    const config: ToolBindingConfig = {
      model: modelName,
      fields,
      bindings,
      cache: options.cache ?? { enabled: true, ttlSeconds: 120 },
    }

    if (options.dataPath) {
      config.dataPath = options.dataPath
    }

    results.push({
      config,
      entity,
      discoveredFrom,
      tools: toolMap,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Sample call for field discovery
// ---------------------------------------------------------------------------

async function discoverFieldsViaSampleCall(
  toolMcpName: string,
  inputSchema?: JsonSchemaObject,
  resultPath?: string,
  mcpClient?: MCPClientManager,
): Promise<ModelField[]> {
  if (!mcpClient) return []

  // Build minimal params — only include required fields with sensible defaults
  const params: Record<string, unknown> = {}
  if (inputSchema?.required && inputSchema.properties) {
    for (const reqField of inputSchema.required) {
      const prop = inputSchema.properties[reqField]
      if (prop?.default !== undefined) {
        params[reqField] = prop.default
      } else if (prop?.type === 'string') {
        // Use a reasonable default for common required fields
        const name = reqField.toLowerCase()
        if (name.includes('calendar') && name.includes('id')) {
          params[reqField] = 'primary'
        }
      }
    }
  }

  const result = await mcpClient.callTool(toolMcpName, params)
  if (!result.ok || !result.data) return []

  let parsed: unknown
  try { parsed = JSON.parse(result.data) } catch { return [] }

  // Navigate to the items using resultPath
  let items: unknown = parsed
  if (resultPath) {
    for (const part of resultPath.split('.')) {
      if (items && typeof items === 'object' && !Array.isArray(items)) {
        items = (items as Record<string, unknown>)[part]
      }
    }
  }

  if (!Array.isArray(items) || items.length === 0) {
    // Try to find an array somewhere in the response
    items = findFirstArray(parsed)
    if (!Array.isArray(items) || items.length === 0) return []
  }

  const firstItem = items[0]
  if (!firstItem || typeof firstItem !== 'object') return []

  return inferFieldsFromSample(firstItem as Record<string, unknown>)
}

function findFirstArray(obj: unknown, depth = 0): unknown[] | null {
  if (depth > 3) return null
  if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') return obj
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      const found = findFirstArray(value, depth + 1)
      if (found) return found
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Quick helpers for agent integration
// ---------------------------------------------------------------------------

/**
 * Generate a single auto-bind config for the "primary" entity of a toolkit.
 * The primary entity is the one tagged "important" with the most CRUD coverage.
 */
export async function autoBindPrimaryEntity(
  toolkitSlug: string,
  options: AutoBindOptions = {},
): Promise<AutoBindResult | null> {
  // First try with "important" filter to focus on primary tools
  let tools = await fetchComposioToolSchemas(toolkitSlug, { important: true })
  let groups = groupToolsByEntity(tools, toolkitSlug)

  // Fall back to full toolkit if no important tools or no list-capable entities
  const hasListEntity = [...groups.values()].some(g => g.tools.has('list'))
  if (tools.length === 0 || !hasListEntity) {
    tools = await fetchComposioToolSchemas(toolkitSlug)
    groups = groupToolsByEntity(tools, toolkitSlug)
  }

  if (tools.length === 0) return null
  const results: AutoBindResult[] = []

  for (const [entity, group] of groups) {
    if (!group.tools.has('list')) continue

    const listTool = group.tools.get('list')
    const getTool = group.tools.get('get')
    const createTool = group.tools.get('create')
    const updateTool = group.tools.get('update')
    const deleteTool = group.tools.get('delete')

    const resultPath = listTool ? discoverResultPath(listTool.outputSchema) : undefined

    let fields: ModelField[] = []
    let discoveredFrom: 'schema' | 'sample' | 'schema+sample' = 'schema'

    if (createTool?.outputSchema) {
      fields = discoverFieldsFromOutputSchema(createTool.outputSchema, 'create')
    }
    if (fields.length === 0 && listTool?.outputSchema) {
      fields = discoverFieldsFromOutputSchema(listTool.outputSchema, 'list')
    }
    if (fields.length === 0 && listTool && options.mcpClient) {
      try {
        const sampleFields = await discoverFieldsViaSampleCall(
          listTool.mcpName, listTool.inputSchema, resultPath, options.mcpClient,
        )
        if (sampleFields.length > 0) {
          fields = sampleFields
          discoveredFrom = 'sample'
        }
      } catch { /* ignore */ }
    }

    const maxFields = options.maxFields || 20
    if (fields.length > maxFields) fields = fields.slice(0, maxFields)

    const modelName = options.modelName || entity
    const bindings: ToolBindingConfig['bindings'] = {}
    const toolMap: Record<string, string> = {}

    if (listTool) {
      const binding: ToolCrudBinding = { tool: listTool.mcpName }
      if (resultPath) binding.resultPath = resultPath
      bindings.list = binding
      toolMap.list = listTool.slug
    }
    if (getTool) { bindings.get = { tool: getTool.mcpName }; toolMap.get = getTool.slug }
    if (createTool) { bindings.create = { tool: createTool.mcpName }; toolMap.create = createTool.slug }
    if (updateTool) { bindings.update = { tool: updateTool.mcpName }; toolMap.update = updateTool.slug }
    if (deleteTool) { bindings.delete = { tool: deleteTool.mcpName }; toolMap.delete = deleteTool.slug }

    const config: ToolBindingConfig = {
      model: modelName,
      fields,
      bindings,
      cache: options.cache ?? { enabled: true, ttlSeconds: 120 },
    }
    if (options.dataPath) config.dataPath = options.dataPath

    results.push({ config, entity, discoveredFrom, tools: toolMap })
  }

  if (results.length === 0) return null

  // Score entities by CRUD coverage and field discovery quality
  const scored = results.map(r => {
    let score = Object.keys(r.tools).length * 2
    if (r.config.fields.length > 0) score += 3
    if (r.config.bindings.list?.resultPath) score += 2
    return { result: r, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored[0].result
}
