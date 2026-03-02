/**
 * Composio Integration Service
 *
 * Manages Composio sessions for per-user OAuth-based tool integrations.
 * Uses the Composio SDK directly for tool execution and auth management
 * (no MCP intermediary). Only COMPOSIO_API_KEY is required -- Composio
 * provides managed OAuth credentials for all toolkits by default.
 * Optional auth config env vars enable white-labeling.
 */

import { Composio } from '@composio/core'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { MCPClientManager } from './mcp-client'
import { fetchComposioToolSchemas, type ComposioToolSchema } from './composio-auto-bind'

/** Stored composio user ID for SDK auth and tool execution scoping */
let storedComposioUserId: string | null = null

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
// Timing infrastructure
// ---------------------------------------------------------------------------

export interface ComposioTiming {
  operation: string
  durationMs: number
  timestamp: number
}

const timings: ComposioTiming[] = []

export function getComposioTimings(): ComposioTiming[] {
  return [...timings]
}

export function clearComposioTimings(): void {
  timings.length = 0
}

function recordTiming(operation: string, durationMs: number) {
  timings.push({ operation, durationMs, timestamp: Date.now() })
  console.log(`[Composio] [Timing] ${operation}: ${durationMs.toFixed(0)}ms`)
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

  const exact = all.find(t => t.slug.toLowerCase() === name.toLowerCase())
  if (exact) return exact

  const norm = all.find(t => t.slug.toLowerCase().replace(/[-_\s]/g, '') === normalized)
  if (norm) return norm

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
  const proxyUrl = process.env.TOOLS_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  if (apiKey) {
    composioClient = new Composio({ apiKey })
    console.log('[Composio] Client initialized (direct)')
    return composioClient
  }

  if (proxyUrl && proxyToken) {
    composioClient = new Composio({
      apiKey: proxyToken,
      baseURL: `${proxyUrl}/composio`,
    })
    console.log('[Composio] Client initialized (via proxy)')
    return composioClient
  }

  console.log('[Composio] No COMPOSIO_API_KEY or proxy config, Composio integration disabled')
  return null
}

// ---------------------------------------------------------------------------
// SDK-based session init (replaces MCP connection)
// ---------------------------------------------------------------------------

/**
 * Initialize a Composio session for a given user/project.
 * Creates the session via SDK (registers user with Composio) and stores the
 * user ID for tool execution scoping. No MCP transport is used.
 */
export async function initComposioSession(
  userId: string,
  projectId: string,
): Promise<boolean> {
  if (storedComposioUserId) return true

  const client = getComposioClient()
  if (!client) return false

  const composioUserId = `shogo_${userId}_${projectId}`
  const authConfigs = getAuthConfigs()
  const hasCustomAuth = Object.keys(authConfigs).length > 0

  try {
    const t0 = performance.now()
    console.log(`[Composio] Creating session for user "${composioUserId}"${hasCustomAuth ? ' (with custom auth configs)' : ' (using Composio managed auth)'}...`)
    const sessionOpts = hasCustomAuth ? { authConfigs } : undefined
    await client.create(composioUserId, sessionOpts)

    storedComposioUserId = composioUserId
    const elapsed = performance.now() - t0
    recordTiming('session init', elapsed)
    console.log(`[Composio] Session initialized for user "${composioUserId}"`)
    return true
  } catch (err: any) {
    console.error(`[Composio] Failed to init session: ${err.message}`)
    return false
  }
}

/**
 * Reset the Composio session state. Clears stored user ID and proxy tools.
 */
export function resetComposioSession(): void {
  storedComposioUserId = null
  registeredProxyToolNames.clear()
  console.log('[Composio] Session reset')
}

/**
 * Check if a Composio session has been initialized.
 */
export function isComposioInitialized(): boolean {
  return storedComposioUserId !== null
}

/**
 * Check if Composio integration is configured (direct key or proxy).
 */
export function isComposioEnabled(): boolean {
  return !!process.env.COMPOSIO_API_KEY ||
    !!(process.env.TOOLS_PROXY_URL && process.env.AI_PROXY_TOKEN)
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
 * Each proxy tool executes via the Composio SDK directly.
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
  mcpClientManager.addProxyTools(toolkitSlug.toLowerCase(), proxyTools)

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
      const client = getComposioClient()
      if (!client || !storedComposioUserId) {
        return textResult({ error: 'Composio not initialized. Call tool_install first.' })
      }
      const args = (params && typeof params === 'object') ? params as Record<string, any> : {}
      try {
        const t0 = performance.now()
        const result = await client.tools.execute(schema.slug, {
          userId: storedComposioUserId,
          arguments: args,
          dangerouslySkipVersionCheck: true,
        })
        const elapsed = performance.now() - t0
        recordTiming(schema.slug, elapsed)

        if (!result.successful) {
          return textResult({ error: result.error || `Tool ${schema.slug} returned an error` })
        }

        let raw = JSON.stringify(result.data)
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
 * Check auth status for a Composio toolkit via the SDK.
 * Lists connected accounts to determine if the user has an active connection,
 * then falls back to initiating a new auth flow if needed.
 */
export async function checkComposioAuth(
  toolkitSlug: string,
): Promise<{ status: 'active' | 'needs_auth'; authUrl?: string }> {
  const client = getComposioClient()
  if (!client || !storedComposioUserId) {
    return { status: 'needs_auth' }
  }

  try {
    const t0 = performance.now()
    const accounts = await client.connectedAccounts.list({
      userIds: [storedComposioUserId],
      toolkitSlugs: [toolkitSlug],
    })
    const elapsed = performance.now() - t0
    recordTiming(`auth check (${toolkitSlug})`, elapsed)

    const items: any[] = (accounts as any)?.items || (accounts as any)?.data || []
    const active = items.find((acc: any) => {
      const status = acc.status?.toLowerCase()
      return status === 'active'
    })

    if (active) {
      return { status: 'active' }
    }

    return await initiateComposioAuth(toolkitSlug)
  } catch (err: any) {
    console.error(`[Composio] Auth check failed for "${toolkitSlug}": ${err.message}`)
    return await initiateComposioAuth(toolkitSlug)
  }
}

/**
 * Use the Composio SDK to initiate auth and get a redirect URL.
 */
async function initiateComposioAuth(
  toolkitSlug: string,
): Promise<{ status: 'active' | 'needs_auth'; authUrl?: string }> {
  const client = getComposioClient()
  if (!client || !storedComposioUserId) {
    return { status: 'needs_auth' }
  }

  try {
    const authConfigs = getAuthConfigs()
    const hasCustomAuth = Object.keys(authConfigs).length > 0
    const sessionOpts = hasCustomAuth ? { authConfigs } : undefined
    const session = await client.create(storedComposioUserId, sessionOpts)

    const callbackBase = process.env.BETTER_AUTH_URL || process.env.API_URL || 'http://localhost:8002'
    const connection = await session.authorize(toolkitSlug, {
      callbackUrl: `${callbackBase}/api/integrations/callback?toolkit=${encodeURIComponent(toolkitSlug)}`,
    })

    const redirectUrl = (connection as any)?.redirectUrl || (connection as any)?.redirect_url
    if (redirectUrl) {
      console.log(`[Composio] Got auth URL via SDK for "${toolkitSlug}"`)
      return { status: 'needs_auth', authUrl: redirectUrl }
    }

    const status = (connection as any)?.status
    if (status === 'active' || status === 'ACTIVE') {
      return { status: 'active' }
    }

    return { status: 'needs_auth' }
  } catch (err: any) {
    console.error(`[Composio] SDK auth initiation failed for "${toolkitSlug}": ${err.message}`)
    return { status: 'needs_auth' }
  }
}
