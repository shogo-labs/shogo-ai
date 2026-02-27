/**
 * Composio Integration Service
 *
 * Manages Composio sessions for per-user OAuth-based tool integrations.
 * Discovers available toolkits dynamically via the Composio API rather
 * than hardcoding them. Only COMPOSIO_API_KEY is required -- Composio
 * provides managed OAuth credentials for all toolkits by default.
 * Optional auth config env vars enable white-labeling.
 */

import { Composio } from '@composio/core'
import type { MCPClientManager } from './mcp-client'

const COMPOSIO_MCP_SERVER_NAME = 'composio'

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

/**
 * Connect to Composio's MCP endpoint for a given user/project.
 * Creates a Composio session and registers it as a remote MCP server.
 */
export async function connectComposioMCP(
  mcpClientManager: MCPClientManager,
  userId: string,
  projectId: string,
): Promise<boolean> {
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

    await mcpClientManager.startRemoteServer(COMPOSIO_MCP_SERVER_NAME, {
      url: session.mcp.url,
      headers: session.mcp.headers,
      excludeTools: [
        'COMPOSIO_REMOTE_WORKBENCH',
        'COMPOSIO_REMOTE_BASH_TOOL',
        'COMPOSIO_GET_TOOL_SCHEMAS',
      ],
      maxResultChars: 12000,
    })

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
export async function disconnectComposioMCP(
  mcpClientManager: MCPClientManager,
): Promise<void> {
  try {
    await mcpClientManager.stopRemoteServer(COMPOSIO_MCP_SERVER_NAME)
    console.log('[Composio] Disconnected from MCP endpoint')
  } catch (err: any) {
    console.error(`[Composio] Error disconnecting: ${err.message}`)
  }
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
