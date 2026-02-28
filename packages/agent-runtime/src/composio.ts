/**
 * Composio Integration Service
 *
 * Manages Composio sessions for per-user OAuth-based tool integrations.
 * Discovers available toolkits dynamically via the Composio API rather
 * than hardcoding them. Only COMPOSIO_API_KEY is required -- Composio
 * provides managed OAuth credentials for all toolkits by default.
 * Optional auth config env vars enable white-labeling.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Composio } from '@composio/core'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { MCPClientManager } from './mcp-client'
import { fetchComposioToolSchemas, type ComposioToolSchema } from './composio-auto-bind'

/**
 * Private MCP Client connected to Composio's endpoint.
 * Used internally by proxy tools and auth checks. Never exposed to the agent.
 */
let composioMcpClient: Client | null = null

/** Track registered proxy tool names for dedup across multiple toolkit installs */
const registeredProxyToolNames = new Set<string>()

interface ComposioAuthConfigs {
  [toolkit: string]: string
}

export interface ComposioToolkitInfo {
  slug: string
  name: string
  logo?: string
}

// ---------------------------------------------------------------------------
// Toolkit catalog cache (fetched from Composio API)
// ---------------------------------------------------------------------------

let toolkitCache: { items: ComposioToolkitInfo[]; fetchedAt: number } | null = null
const TOOLKIT_CACHE_TTL_MS = 10 * 60 * 1000 // 10 min

/**
 * Fetch all available toolkits from the Composio API catalog.
 * Results are cached for 10 minutes.
 */
export async function getComposioToolkitsCatalog(): Promise<ComposioToolkitInfo[]> {
  const client = getComposioClient()
  if (!client) return []

  if (toolkitCache && Date.now() - toolkitCache.fetchedAt < TOOLKIT_CACHE_TTL_MS) {
    return toolkitCache.items
  }

  try {
    const result = await client.toolkits.get()

    const rawItems: any[] = Array.isArray(result) ? result : (result as any).items || []
    const items: ComposioToolkitInfo[] = rawItems.map((t: any) => ({
      slug: t.slug || t.id || '',
      name: t.name || t.slug || '',
      logo: t.logo,
    }))

    toolkitCache = { items, fetchedAt: Date.now() }
    console.log(`[Composio] Fetched ${items.length} toolkits from catalog`)
    return items
  } catch (err: any) {
    console.error(`[Composio] Failed to fetch toolkits catalog: ${err.message}`)
    return toolkitCache?.items || []
  }
}

/**
 * Search the Composio toolkit catalog for toolkits matching a query.
 * Uses fuzzy matching on slug and name.
 */
export async function searchComposioToolkits(query: string): Promise<ComposioToolkitInfo[]> {
  const all = await getComposioToolkitsCatalog()
  if (all.length === 0) return []

  const q = query.toLowerCase()
  const words = q.split(/\s+/).filter(w => w.length > 1)

  const scored: Array<{ toolkit: ComposioToolkitInfo; score: number }> = []

  for (const t of all) {
    const haystack = `${t.slug} ${t.name}`.toLowerCase()
    let score = 0
    if (haystack.includes(q)) score += 10
    if (t.slug.toLowerCase() === q || t.name.toLowerCase() === q) score += 20
    for (const w of words) {
      if (haystack.includes(w)) score += 3
    }
    if (score > 0) scored.push({ toolkit: t, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 10).map(s => s.toolkit)
}

/**
 * Look up a specific Composio toolkit by name/slug.
 * Handles normalization (hyphens, underscores, spaces stripped).
 */
export async function findComposioToolkit(name: string): Promise<ComposioToolkitInfo | null> {
  const all = await getComposioToolkitsCatalog()
  if (all.length === 0) return null

  const normalized = name.toLowerCase().replace(/[-_\s]/g, '')

  // Exact slug match
  const exact = all.find(t => t.slug.toLowerCase() === name.toLowerCase())
  if (exact) return exact

  // Normalized match (strip hyphens/underscores/spaces)
  const norm = all.find(t => t.slug.toLowerCase().replace(/[-_\s]/g, '') === normalized)
  if (norm) return norm

  // Containment match
  const contained = all.find(t => {
    const tNorm = t.slug.toLowerCase().replace(/[-_\s]/g, '')
    return tNorm.includes(normalized) || normalized.includes(tNorm)
  })
  return contained || null
}

// ---------------------------------------------------------------------------
// Auth configs (optional white-labeling)
// ---------------------------------------------------------------------------

/**
 * Load optional white-label auth configs from env.
 * When set, OAuth consent screens show your app name instead of "Composio".
 * When empty, Composio's own managed OAuth credentials are used (works fine).
 */
function getAuthConfigs(): ComposioAuthConfigs {
  const configs: ComposioAuthConfigs = {}
  const prefix = 'COMPOSIO_AUTH_CONFIG_'

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix) && value) {
      const toolkit = key.slice(prefix.length).toLowerCase()
      configs[toolkit] = value
    }
  }

  // Legacy env var support
  const legacyMap: Record<string, string[]> = {
    COMPOSIO_GOOGLE_AUTH_CONFIG: ['googlecalendar', 'gmail', 'googledrive'],
    COMPOSIO_SLACK_AUTH_CONFIG: ['slack'],
    COMPOSIO_GITHUB_AUTH_CONFIG: ['github'],
    COMPOSIO_LINEAR_AUTH_CONFIG: ['linear'],
    COMPOSIO_NOTION_AUTH_CONFIG: ['notion'],
  }

  for (const [envKey, toolkits] of Object.entries(legacyMap)) {
    const value = process.env[envKey]
    if (value) {
      for (const tk of toolkits) configs[tk] = value
    }
  }

  return configs
}

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let composioClient: Composio | null = null

function getComposioClient(): Composio | null {
  if (composioClient) return composioClient

  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) {
    console.log('[Composio] COMPOSIO_API_KEY not set, Composio integration disabled')
    return null
  }

  composioClient = new Composio({ apiKey })
  console.log('[Composio] Client initialized')
  return composioClient
}

// ---------------------------------------------------------------------------
// MCP connection
// ---------------------------------------------------------------------------

const MCP_CONNECT_TIMEOUT_MS = 90_000

/**
 * Connect to Composio's MCP endpoint for a given user/project.
 * Establishes a private internal MCP connection — no tools are exposed to the agent.
 * Proxy tools are registered separately via registerToolkitProxyTools().
 */
export async function connectComposioMCP(
  userId: string,
  projectId: string,
): Promise<boolean> {
  if (composioMcpClient) return true

  const client = getComposioClient()
  if (!client) return false

  const composioUserId = `shogo_${userId}_${projectId}`
  const authConfigs = getAuthConfigs()
  const hasCustomAuth = Object.keys(authConfigs).length > 0

  try {
    console.log(`[Composio] Creating session for user "${composioUserId}"${hasCustomAuth ? ' (with custom auth configs)' : ' (using Composio managed auth)'}...`)
    const sessionOpts = hasCustomAuth ? { authConfigs } : undefined
    const session = await client.create(composioUserId, sessionOpts)

    if (!session.mcp?.url) {
      console.error('[Composio] Session created but no MCP URL returned')
      return false
    }

    const transport = new StreamableHTTPClientTransport(
      new URL(session.mcp.url),
      { requestInit: session.mcp.headers ? { headers: session.mcp.headers } : undefined },
    )

    const mcpClient = new Client(
      { name: 'shogo-composio-internal', version: '1.0.0' },
      { capabilities: {} },
    )

    await Promise.race([
      mcpClient.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Composio MCP connection timed out')), MCP_CONNECT_TIMEOUT_MS),
      ),
    ])

    composioMcpClient = mcpClient
    console.log(`[Composio] Connected to MCP endpoint for user "${composioUserId}"`)
    return true
  } catch (err: any) {
    console.error(`[Composio] Failed to connect MCP: ${err.message}`)
    return false
  }
}

/**
 * Disconnect from Composio's MCP endpoint.
 */
export async function disconnectComposioMCP(): Promise<void> {
  if (!composioMcpClient) return
  try {
    await composioMcpClient.close()
    composioMcpClient = null
    registeredProxyToolNames.clear()
    console.log('[Composio] Disconnected from MCP endpoint')
  } catch (err: any) {
    console.error(`[Composio] Error disconnecting: ${err.message}`)
  }
}

/**
 * Check if the private Composio MCP connection is active.
 */
export function isComposioConnected(): boolean {
  return composioMcpClient !== null
}

/**
 * Check if Composio integration is configured (API key present).
 */
export function isComposioEnabled(): boolean {
  return !!process.env.COMPOSIO_API_KEY
}

/**
 * Get the Composio client for direct API calls.
 * Returns null if COMPOSIO_API_KEY is not configured.
 */
export function getComposio(): Composio | null {
  return getComposioClient()
}

/**
 * Build the composio user ID from Shogo user/project IDs.
 */
export function buildComposioUserId(userId: string, projectId: string): string {
  return `shogo_${userId}_${projectId}`
}

// ---------------------------------------------------------------------------
// Proxy tool registration
// ---------------------------------------------------------------------------

function textResult(data: any): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    details: data,
  }
}

/**
 * Dynamically register proxy AgentTools for each action in a Composio toolkit.
 * Each proxy tool calls COMPOSIO_MULTI_EXECUTE_TOOL internally via the private connection.
 * Tool names are the raw Composio slugs (e.g. GOOGLECALENDAR_CREATE_EVENT).
 */
export async function registerToolkitProxyTools(
  mcpClientManager: MCPClientManager,
  toolkitSlug: string,
): Promise<{ toolNames: string[]; toolCount: number }> {
  const prefix = `${toolkitSlug.toUpperCase()}_`
  const alreadyRegistered = [...registeredProxyToolNames].filter(n => n.startsWith(prefix))
  if (alreadyRegistered.length > 0) {
    console.log(`[Composio] Toolkit "${toolkitSlug}" already has ${alreadyRegistered.length} proxy tools registered`)
    return { toolNames: alreadyRegistered, toolCount: alreadyRegistered.length }
  }

  const schemas = await fetchComposioToolSchemas(toolkitSlug)
  const nonDeprecated = schemas.filter(s => !s.is_deprecated)

  if (nonDeprecated.length === 0) {
    console.warn(`[Composio] No tools found for toolkit "${toolkitSlug}"`)
    return { toolNames: [], toolCount: 0 }
  }

  const proxyTools: AgentTool[] = nonDeprecated.map(schema => createProxyTool(schema))
  mcpClientManager.addProxyTools(proxyTools)

  const toolNames = proxyTools.map(t => t.name)
  for (const n of toolNames) registeredProxyToolNames.add(n)
  console.log(`[Composio] Registered ${toolNames.length} proxy tools for "${toolkitSlug}"`)
  return { toolNames, toolCount: toolNames.length }
}

function createProxyTool(schema: ComposioToolSchema): AgentTool {
  const { Type } = require('@sinclair/typebox')

  let parameters: any = Type.Object({})
  if (schema.input_parameters?.properties) {
    const props: Record<string, any> = {}
    const required = new Set(schema.input_parameters.required || [])
    for (const [key, prop] of Object.entries(schema.input_parameters.properties)) {
      const tb = jsonSchemaPropertyToTypebox(prop)
      props[key] = required.has(key) ? tb : Type.Optional(tb)
    }
    parameters = Type.Object(props)
  }

  return {
    name: schema.slug,
    description: schema.description || `Composio tool: ${schema.slug}`,
    label: `composio: ${schema.slug}`,
    parameters,
    execute: async (_toolCallId: string, params: unknown) => {
      if (!composioMcpClient) {
        return textResult({ error: 'Composio MCP not connected. Call tool_install first.' })
      }
      const args = (params && typeof params === 'object') ? params as Record<string, any> : {}
      try {
        const result = await composioMcpClient.callTool({
          name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
          arguments: { tools: [{ tool_slug: schema.slug, arguments: args }] },
        })

        const texts = (result.content as any[])
          ?.filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n') || ''

        if (result.isError) {
          return textResult({ error: texts || `Tool ${schema.slug} returned an error` })
        }

        let raw = texts || JSON.stringify(result.content)
        const MAX_CHARS = 12000
        if (raw.length > MAX_CHARS) {
          const headSize = Math.floor(MAX_CHARS * 0.75)
          const tailSize = Math.max(0, MAX_CHARS - headSize - 100)
          const omitted = raw.length - headSize - tailSize
          raw = raw.substring(0, headSize)
            + `\n\n[... ${omitted} chars truncated ...]\n\n`
            + (tailSize > 0 ? raw.substring(raw.length - tailSize) : '')
        }

        return textResult(raw)
      } catch (err: any) {
        return textResult({ error: `Tool "${schema.slug}" failed: ${err.message}` })
      }
    },
  } as AgentTool
}

function jsonSchemaPropertyToTypebox(p: Record<string, any>): any {
  const { Type } = require('@sinclair/typebox')
  switch (p.type) {
    case 'string':
      return Type.String({ description: p.description })
    case 'number':
    case 'integer':
      return Type.Number({ description: p.description })
    case 'boolean':
      return Type.Boolean({ description: p.description })
    case 'array': {
      const itemSchema = p.items
        ? jsonSchemaPropertyToTypebox(p.items as Record<string, any>)
        : Type.Any()
      return Type.Array(itemSchema, { description: p.description })
    }
    case 'object': {
      if (p.properties) {
        const props: Record<string, any> = {}
        const required = new Set(p.required || [])
        for (const [key, prop] of Object.entries(p.properties as Record<string, any>)) {
          const tb = jsonSchemaPropertyToTypebox(prop)
          props[key] = required.has(key) ? tb : Type.Optional(tb)
        }
        return Type.Object(props, { description: p.description })
      }
      return Type.Any({ description: p.description })
    }
    default:
      return Type.Any({ description: p.description })
  }
}

/**
 * Check auth status for a Composio toolkit by calling MANAGE_CONNECTIONS internally.
 */
export async function checkComposioAuth(
  toolkitSlug: string,
): Promise<{ status: 'active' | 'needs_auth'; authUrl?: string }> {
  if (!composioMcpClient) {
    return { status: 'needs_auth' }
  }
  try {
    const result = await composioMcpClient.callTool({
      name: 'COMPOSIO_MANAGE_CONNECTIONS',
      arguments: { toolkits: [toolkitSlug] },
    })

    const texts = (result.content as any[])
      ?.filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n') || ''

    let parsed: any
    try { parsed = JSON.parse(texts) } catch { parsed = {} }

    if (parsed?.status === 'active' || texts.includes('"active"')) {
      return { status: 'active' }
    }

    const urlMatch = texts.match(/https:\/\/[^\s"]+connect[^\s"]*/i)
    return {
      status: 'needs_auth',
      authUrl: urlMatch?.[0] || parsed?.authUrl || parsed?.redirect_url,
    }
  } catch (err: any) {
    console.error(`[Composio] Auth check failed for "${toolkitSlug}": ${err.message}`)
    return { status: 'needs_auth' }
  }
}
