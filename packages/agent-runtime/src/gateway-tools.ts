// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gateway Tools
 *
 * Tool definitions available to the live gateway agent during agent turns.
 * Uses Pi Agent Core's AgentTool format with TypeBox parameter schemas.
 *
 * Tools are created via createGatewayTools(ctx) which closes over the
 * ToolContext, since Pi's execute() signature doesn't accept external context.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, statSync } from 'fs'
import { join, resolve, extname } from 'path'
import { execSync } from 'child_process'
import { Type, type Static } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { sandboxExec } from './sandbox-exec'
import { MemorySearchEngine } from './memory-search'
import { FileIndexEngine } from './file-index-engine'
import { MCP_CATALOG, isPreinstalledMcpId, isMcpServerAllowed, getPreinstalledPackages } from './mcp-catalog'
import { initComposioSession, isComposioEnabled, isComposioInitialized, searchComposioToolkits, findComposioToolkit, registerToolkitProxyTools, checkComposioAuth } from './composio'
import { autoBindPrimaryEntity } from './composio-auto-bind'
import { getDynamicAppManager, getByPointer } from './dynamic-app-manager'
import {
  CANVAS_COMPONENT_SCHEMA,
  BASIC_CANVAS_COMPONENT_SCHEMA,
  VALID_COMPONENT_TYPES,
  BASIC_VALID_COMPONENT_TYPES,
  getComponentSchema,
  getBasicComponentSchema,
  lintComponents,
  normalizeComponents,
  type ComponentSchema,
  type LintMessage,
} from './canvas-component-schema'

export interface ToolContext {
  workspaceDir: string
  channels: Map<string, import('./types').ChannelAdapter>
  config: import('./gateway').GatewayConfig
  projectId: string
  cronManager?: import('./cron-manager').CronManager
  sessionId?: string
  sandbox?: Partial<import('./types').SandboxConfig>
  mainSessionIds?: string[]
  mcpClientManager?: import('./mcp-client').MCPClientManager
  /** Hot-connect a channel at runtime (called by channel_connect tool) */
  connectChannel?: (type: string, config: Record<string, string>) => Promise<void>
  disconnectChannel?: (type: string) => Promise<void>
  /** Lazily-initialized file index engine for RAG over workspace files */
  fileIndexEngine?: FileIndexEngine
}

const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf /*',
  'shutdown',
  'reboot',
  'mkfs',
  'dd if=',
  'chmod 777',
  'curl.*|.*bash',
  'wget.*|.*bash',
  'curl.*|.*sh',
  'wget.*|.*sh',
  'nc -l',
  'ncat -l',
  'python.*-m.*http.server',
  'python.*SimpleHTTPServer',
  'eval\\s*\\$',
  '\\$\\(curl',
  '\\$\\(wget',
]

function isBlockedCommand(command: string): boolean {
  const lower = command.toLowerCase()
  return BLOCKED_COMMANDS.some((pattern) => {
    if (pattern.includes('.*')) {
      try {
        return new RegExp(pattern, 'i').test(command)
      } catch {
        return false
      }
    }
    return lower.includes(pattern.toLowerCase())
  })
}

function assertWithinWorkspace(workspaceDir: string, filePath: string): string {
  const resolved = resolve(workspaceDir, filePath)
  if (!resolved.startsWith(workspaceDir)) {
    throw new Error(`Path outside workspace: ${filePath}`)
  }
  return resolved
}

export function textResult(data: any): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    details: data,
  }
}

// ---------------------------------------------------------------------------
// Tool Definitions (created via factory)
// ---------------------------------------------------------------------------

function createExecTool(ctx: ToolContext): AgentTool {
  return {
    name: 'exec',
    description:
      'Run a shell command in the agent workspace. Commands are executed synchronously with a 30s timeout. Destructive commands are blocked.',
    label: 'Execute Command',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute' }),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default: 30000)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { command, timeout = 30000 } = params as { command: string; timeout?: number }

      if (isBlockedCommand(command)) {
        return textResult({ error: `Blocked command: ${command}` })
      }

      const result = sandboxExec({
        command,
        workspaceDir: ctx.workspaceDir,
        timeout,
        sandboxConfig: ctx.sandbox,
        sessionId: ctx.sessionId,
        mainSessionIds: ctx.mainSessionIds,
      })

      return textResult({
        stdout: result.stdout,
        stderr: result.stderr || undefined,
        exitCode: result.exitCode,
        sandboxed: result.sandboxed || undefined,
      })
    },
  }
}

function createReadFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'read_file',
    description: 'Read a file from the agent workspace.',
    label: 'Read File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to workspace' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath } = params as { path: string }
      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath)
      if (!existsSync(resolved)) {
        return textResult({ error: `File not found: ${filePath}` })
      }
      const content = readFileSync(resolved, 'utf-8')
      return textResult({ content, bytes: content.length })
    },
  }
}

function createWriteFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'write_file',
    description: 'Write content to a file in the agent workspace. Creates parent directories as needed.',
    label: 'Write File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to workspace' }),
      content: Type.String({ description: 'Content to write' }),
      append: Type.Optional(Type.Boolean({ description: 'Append instead of overwrite (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, content, append } = params as {
        path: string
        content: string
        append?: boolean
      }
      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath)
      const dir = resolved.substring(0, resolved.lastIndexOf('/'))
      if (dir) mkdirSync(dir, { recursive: true })

      if (append) {
        const existing = existsSync(resolved) ? readFileSync(resolved, 'utf-8') : ''
        writeFileSync(resolved, existing + content, 'utf-8')
      } else {
        writeFileSync(resolved, content, 'utf-8')
      }
      return textResult({ ok: true, path: filePath, bytes: content.length })
    },
  }
}

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const WEB_FETCH_TIMEOUT_MS = 30_000

function stripHtmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text
}

// ---------------------------------------------------------------------------
// Serper.dev Web Search
// ---------------------------------------------------------------------------

const SERPER_ENDPOINTS: Record<string, string> = {
  search: 'https://google.serper.dev/search',
  news: 'https://google.serper.dev/news',
  images: 'https://google.serper.dev/images',
  places: 'https://google.serper.dev/places',
  maps: 'https://google.serper.dev/maps',
  shopping: 'https://google.serper.dev/shopping',
}

interface SerperOrganicResult {
  title?: string
  link?: string
  snippet?: string
  position?: number
  date?: string
  sitelinks?: Array<{ title: string; link: string }>
}

interface SerperResponse {
  searchParameters?: Record<string, unknown>
  knowledgeGraph?: { title?: string; description?: string; type?: string; website?: string; attributes?: Record<string, string> }
  answerBox?: { answer?: string; snippet?: string; snippetHighlighted?: string[] }
  organic?: SerperOrganicResult[]
  peopleAlsoAsk?: Array<{ question: string; snippet?: string; link?: string }>
  relatedSearches?: Array<{ query: string }>
  news?: Array<{ title?: string; link?: string; snippet?: string; date?: string; source?: string }>
  places?: Array<{ title?: string; address?: string; rating?: number; ratingCount?: number }>
  images?: Array<{ title?: string; imageUrl?: string; link?: string }>
  shopping?: Array<{ title?: string; price?: string; link?: string; source?: string }>
  credits?: number
}

function formatSerperResults(raw: SerperResponse, searchType: string): string {
  const parts: string[] = []

  if (raw.answerBox) {
    const ab = raw.answerBox
    const answer = [ab.answer, ab.snippet].filter(Boolean).join(' — ')
    if (answer) parts.push(`**Answer:** ${answer}`)
  }

  if (raw.knowledgeGraph) {
    const kg = raw.knowledgeGraph
    const kgParts = [`**${kg.title || 'Knowledge Graph'}**`]
    if (kg.type) kgParts.push(`Type: ${kg.type}`)
    if (kg.description) kgParts.push(kg.description)
    if (kg.website) kgParts.push(`Website: ${kg.website}`)
    if (kg.attributes) {
      for (const [k, v] of Object.entries(kg.attributes)) {
        kgParts.push(`${k}: ${v}`)
      }
    }
    parts.push(kgParts.join('\n'))
  }

  if ((searchType === 'search' || searchType === 'maps') && raw.organic?.length) {
    parts.push('**Search Results:**')
    for (const r of raw.organic.slice(0, 10)) {
      const entry = [`${r.position ?? ''}. **${r.title}**`, r.link, r.snippet].filter(Boolean).join('\n   ')
      parts.push(entry)
    }
  }

  if (searchType === 'news' && raw.news?.length) {
    parts.push('**News Results:**')
    for (const n of raw.news.slice(0, 10)) {
      parts.push([`- **${n.title}**`, n.source ? `(${n.source})` : '', n.date || '', n.link, n.snippet].filter(Boolean).join(' '))
    }
  }

  if ((searchType === 'places' || searchType === 'maps') && raw.places?.length) {
    parts.push('**Places:**')
    for (const p of raw.places.slice(0, 10)) {
      parts.push(`- **${p.title}** — ${p.address || 'N/A'} (${p.rating ?? '?'}/5, ${p.ratingCount ?? 0} reviews)`)
    }
  }

  if (searchType === 'shopping' && raw.shopping?.length) {
    parts.push('**Shopping Results:**')
    for (const s of raw.shopping.slice(0, 10)) {
      parts.push(`- **${s.title}** — ${s.price || 'N/A'} (${s.source || ''}) ${s.link || ''}`)
    }
  }

  if (raw.peopleAlsoAsk?.length) {
    parts.push('**People Also Ask:**')
    for (const q of raw.peopleAlsoAsk.slice(0, 5)) {
      parts.push(`- ${q.question}${q.snippet ? ` — ${q.snippet}` : ''}`)
    }
  }

  if (raw.relatedSearches?.length) {
    parts.push('**Related Searches:** ' + raw.relatedSearches.map(r => r.query).join(', '))
  }

  return parts.join('\n\n') || 'No results found.'
}

// ---------------------------------------------------------------------------
// Google URL → Serper routing
// ---------------------------------------------------------------------------

interface GoogleUrlRoute {
  query: string
  searchType: string
}

/**
 * Detects Google property URLs that won't return useful content via raw HTTP
 * fetch (Maps, Flights, Shopping) and converts them into Serper API queries.
 */
function detectGoogleUrl(url: string): GoogleUrlRoute | null {
  let u: URL
  try { u = new URL(url) } catch { return null }

  const host = u.hostname.replace('www.', '')
  if (host !== 'google.com' && !host.endsWith('.google.com')) return null

  const path = u.pathname

  // Maps directions: /maps/dir/ORIGIN/DESTINATION
  const dirMatch = path.match(/^\/maps\/dir\/([^/]+)\/([^/]+)/)
  if (dirMatch) {
    const origin = decodeURIComponent(dirMatch[1]).replace(/\+/g, ' ')
    const dest = decodeURIComponent(dirMatch[2]).replace(/\+/g, ' ')
    return { query: `directions from ${origin} to ${dest}`, searchType: 'search' }
  }

  // Maps place: /maps/place/PLACE
  const placeMatch = path.match(/^\/maps\/place\/([^/@]+)/)
  if (placeMatch) {
    return { query: decodeURIComponent(placeMatch[1]).replace(/\+/g, ' '), searchType: 'places' }
  }

  // Maps search: /maps/search/QUERY
  const mapSearchMatch = path.match(/^\/maps\/search\/([^/@]+)/)
  if (mapSearchMatch) {
    return { query: decodeURIComponent(mapSearchMatch[1]).replace(/\+/g, ' '), searchType: 'places' }
  }

  // Maps with ?q= parameter
  if (path.startsWith('/maps') && u.searchParams.get('q')) {
    return { query: u.searchParams.get('q')!, searchType: 'places' }
  }

  // Flights: /travel/flights
  if (path.startsWith('/travel/flights')) {
    const q = u.searchParams.get('q')
    if (q) return { query: q, searchType: 'search' }
    const tfs = u.searchParams.get('tfs')
    return { query: tfs ? `flights ${tfs}` : 'flights', searchType: 'search' }
  }

  // Shopping: /shopping
  if (path.startsWith('/shopping')) {
    const q = u.searchParams.get('q') || 'shopping'
    return { query: q, searchType: 'shopping' }
  }

  return null
}

const MIN_USEFUL_CONTENT_LENGTH = 200

// ---------------------------------------------------------------------------
// Unified Web Tool (fetch + search + smart Google routing)
// ---------------------------------------------------------------------------

async function serperSearch(
  query: string,
  searchType: string,
  opts: { num?: number; gl?: string; hl?: string } = {},
): Promise<AgentToolResult<any>> {
  const directKey = process.env.SERPER_API_KEY
  const proxyUrl = process.env.TOOLS_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  const apiKey = directKey || proxyToken
  if (!apiKey) {
    return textResult({
      error: 'SERPER_API_KEY not configured and no proxy available. Web search is unavailable.',
      suggestion: 'Set SERPER_API_KEY or configure TOOLS_PROXY_URL + AI_PROXY_TOKEN.',
    })
  }

  const { num = 10, gl = 'us', hl = 'en' } = opts
  const endpoint = directKey
    ? (SERPER_ENDPOINTS[searchType] || SERPER_ENDPOINTS.search)
    : `${proxyUrl}/serper/${searchType || 'search'}`

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num, gl, hl }),
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      return textResult({ error: `Serper API error: HTTP ${response.status}`, details: errorText, query })
    }

    const data = (await response.json()) as SerperResponse
    const formatted = formatSerperResults(data, searchType)

    return textResult({
      results: formatted,
      raw: data,
      query,
      searchType,
      creditsUsed: data.credits,
    })
  } catch (err: any) {
    return textResult({ error: `Web search failed: ${err.message}`, query })
  }
}

async function rawFetch(url: string, maxChars: number): Promise<AgentToolResult<any>> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  }

  const MAX_ATTEMPTS = 2

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
        redirect: 'follow',
      })

      if (response.status === 403 || response.status === 429) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
        return textResult({
          error: `HTTP ${response.status}: Access denied or rate limited. The site may block automated requests.`,
          url,
          suggestion: 'Try again with a query instead of a URL, or try a different source.',
        })
      }

      if (!response.ok) {
        return textResult({ error: `HTTP ${response.status}: ${response.statusText}`, url })
      }

      const contentType = response.headers.get('content-type') || ''
      let text = await response.text()

      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        text = stripHtmlToText(text)
      }

      if (text.length > maxChars) {
        text = text.substring(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`
      }

      return textResult({ content: text, status: response.status, bytes: text.length, url })
    } catch (err: any) {
      if (attempt < MAX_ATTEMPTS && (err.name === 'TimeoutError' || err.code === 'ECONNRESET')) {
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      return textResult({ error: err.message, url })
    }
  }

  return textResult({ error: 'All fetch attempts failed', url })
}

function createWebTool(): AgentTool {
  return {
    name: 'web',
    description:
      'Unified web tool: fetch a URL or search the web via Google (Serper API). ' +
      'Provide `url` to fetch a page, or `query` to search. Google property URLs (Maps, Flights, Shopping) ' +
      'are automatically routed through the search API for rich results. ' +
      'Search types: "search" (default), "news", "images", "places", "maps", "shopping".',
    label: 'Web',
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: 'URL to fetch. Google URLs (Maps, Flights, Shopping) are auto-routed to search API.' })),
      query: Type.Optional(Type.String({ description: 'Search query (e.g., "best restaurants in Bali", "directions from LAX to SFO")' })),
      searchType: Type.Optional(Type.String({ description: 'Type of search: "search" (default), "news", "images", "places", "maps", "shopping"' })),
      num: Type.Optional(Type.Number({ description: 'Number of search results (default: 10, max: 100)' })),
      gl: Type.Optional(Type.String({ description: 'Country code for localized results (e.g., "us", "uk", "id")' })),
      hl: Type.Optional(Type.String({ description: 'Language code (e.g., "en", "id", "fr")' })),
      maxChars: Type.Optional(Type.Number({ description: 'Maximum characters for URL fetch (default: 50000)' })),
    }),
    execute: async (_toolCallId, params) => {
      const {
        url,
        query,
        searchType = 'search',
        num = 10,
        gl = 'us',
        hl = 'en',
        maxChars = 50000,
      } = params as {
        url?: string; query?: string; searchType?: string
        num?: number; gl?: string; hl?: string; maxChars?: number
      }

      if (!url && !query) {
        return textResult({ error: 'Provide either `url` (to fetch a page) or `query` (to search the web).' })
      }

      // If a URL is provided, check for Google property routing first
      if (url) {
        const googleRoute = detectGoogleUrl(url)
        if (googleRoute) {
          return serperSearch(googleRoute.query, googleRoute.searchType, { num, gl, hl })
        }

        // Raw fetch for non-Google URLs
        const result = await rawFetch(url, maxChars)
        const details = result.details

        // If the page returned very little useful content, fallback to Serper
        if (
          !details?.error &&
          typeof details?.content === 'string' &&
          details.content.trim().length < MIN_USEFUL_CONTENT_LENGTH &&
          (process.env.SERPER_API_KEY || (process.env.TOOLS_PROXY_URL && process.env.AI_PROXY_TOKEN))
        ) {
          const fallbackQuery = query || url
          const fallback = await serperSearch(fallbackQuery, searchType, { num, gl, hl })
          fallback.details._note = `Raw fetch returned minimal content (${details.content.trim().length} chars); fell back to search.`
          fallback.details._originalUrl = url
          return fallback
        }

        return result
      }

      // Pure search path
      return serperSearch(query!, searchType, { num, gl, hl })
    },
  }
}

function createMemoryReadTool(ctx: ToolContext): AgentTool {
  return {
    name: 'memory_read',
    description: 'Read agent memory. Use "MEMORY.md" for long-lived facts or a date like "2026-02-18" for daily logs.',
    label: 'Read Memory',
    parameters: Type.Object({
      file: Type.String({ description: '"MEMORY.md" or a date string (YYYY-MM-DD)' }),
    }),
    execute: async (_toolCallId, params) => {
      const { file } = params as { file: string }
      const filePath =
        file === 'MEMORY.md'
          ? join(ctx.workspaceDir, 'MEMORY.md')
          : join(ctx.workspaceDir, 'memory', `${file}.md`)

      if (!existsSync(filePath)) {
        return textResult({ content: '', exists: false })
      }
      return textResult({ content: readFileSync(filePath, 'utf-8'), exists: true })
    },
  }
}

function createMemoryWriteTool(ctx: ToolContext): AgentTool {
  return {
    name: 'memory_write',
    description: 'Write to agent memory. Appends a timestamped entry to MEMORY.md or a daily log.',
    label: 'Write Memory',
    parameters: Type.Object({
      file: Type.String({ description: '"MEMORY.md" or a date string (YYYY-MM-DD)' }),
      content: Type.String({ description: 'Content to write' }),
      append: Type.Optional(Type.Boolean({ description: 'Append instead of overwrite (default: true)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { file, content, append } = params as { file: string; content: string; append?: boolean }
      let filePath: string

      if (file === 'MEMORY.md') {
        filePath = join(ctx.workspaceDir, 'MEMORY.md')
      } else {
        const memDir = join(ctx.workspaceDir, 'memory')
        mkdirSync(memDir, { recursive: true })
        filePath = join(memDir, `${file}.md`)
      }

      const shouldAppend = append !== false
      if (shouldAppend && existsSync(filePath)) {
        const existing = readFileSync(filePath, 'utf-8')
        writeFileSync(filePath, existing + '\n' + content, 'utf-8')
      } else {
        writeFileSync(filePath, content, 'utf-8')
      }

      return textResult({ ok: true, file, bytes: content.length })
    },
  }
}

function createMemorySearchTool(ctx: ToolContext): AgentTool {
  let engine: MemorySearchEngine | null = null

  function getEngine(): MemorySearchEngine {
    if (!engine) {
      engine = new MemorySearchEngine(ctx.workspaceDir)
    }
    return engine
  }

  return {
    name: 'memory_search',
    description:
      'Search across all agent memory (MEMORY.md and daily logs) using hybrid keyword + semantic matching. Returns the most relevant memory chunks ranked by relevance.',
    label: 'Search Memory',
    parameters: Type.Object({
      query: Type.String({ description: 'Natural language search query' }),
      limit: Type.Optional(Type.Number({ description: 'Max results to return (default: 8)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { query, limit = 8 } = params as { query: string; limit?: number }

      try {
        const results = getEngine().search(query, limit)
        return textResult({
          query,
          results: results.map((r) => ({
            file: r.file,
            lines: `${r.lineStart}-${r.lineEnd}`,
            score: Math.round(r.score * 100) / 100,
            matchType: r.matchType,
            content: r.chunk,
          })),
          totalMatches: results.length,
        })
      } catch (err: any) {
        return textResult({ error: `Memory search failed: ${err.message}`, query })
      }
    },
  }
}

function createBrowserTool(ctx: ToolContext): AgentTool {
  let browser: any = null
  let page: any = null

  async function ensureBrowser() {
    if (browser && page) return page
    try {
      const pw = await import('playwright-core')
      browser = await pw.chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      })
      page = await browser.newPage()
      return page
    } catch {
      throw new Error('Playwright is not installed. Run: bunx playwright install chromium')
    }
  }

  async function cleanup() {
    try { if (page) await page.close() } catch {}
    try { if (browser) await browser.close() } catch {}
    page = null
    browser = null
  }

  return {
    name: 'browser',
    description:
      'Control a headless browser. Actions: navigate (go to URL), click (CSS selector), fill (type into input), extract (get elements by selector), text (full page text), screenshot (capture page), evaluate (run JS), select (dropdown option), scroll (scroll page), wait_for (wait for element), close.',
    label: 'Browser',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('navigate'),
        Type.Literal('click'),
        Type.Literal('fill'),
        Type.Literal('extract'),
        Type.Literal('text'),
        Type.Literal('screenshot'),
        Type.Literal('evaluate'),
        Type.Literal('select'),
        Type.Literal('scroll'),
        Type.Literal('wait_for'),
        Type.Literal('close'),
      ], { description: 'Browser action to perform' }),
      url: Type.Optional(Type.String({ description: 'URL to navigate to (for navigate action)' })),
      selector: Type.Optional(Type.String({ description: 'CSS selector (for click/fill/extract/select/scroll/wait_for actions)' })),
      value: Type.Optional(Type.String({ description: 'Text to type (fill), JS to run (evaluate), option value (select), or scroll distance in px (scroll)' })),
      waitMs: Type.Optional(Type.Number({ description: 'Wait time in ms after action (default: 1000)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { action, url, selector, value, waitMs = 1000 } = params as {
        action: string
        url?: string
        selector?: string
        value?: string
        waitMs?: number
      }

      try {
        if (action === 'close') {
          await cleanup()
          return textResult({ ok: true, action: 'close' })
        }

        const p = await ensureBrowser()

        switch (action) {
          case 'navigate': {
            if (!url) return textResult({ error: 'url is required for navigate' })
            await p.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' })
            if (waitMs > 0) await p.waitForTimeout(Math.min(waitMs, 5000))
            const title = await p.title()
            const pageUrl = p.url()
            return textResult({ ok: true, title, url: pageUrl })
          }
          case 'click': {
            if (!selector) return textResult({ error: 'selector is required for click' })
            await p.click(selector, { timeout: 5000 })
            if (waitMs > 0) await p.waitForTimeout(Math.min(waitMs, 3000))
            return textResult({ ok: true, action: 'click', selector })
          }
          case 'fill': {
            if (!selector || value === undefined) return textResult({ error: 'selector and value required for fill' })
            await p.fill(selector, value, { timeout: 5000 })
            return textResult({ ok: true, action: 'fill', selector })
          }
          case 'extract': {
            if (!selector) return textResult({ error: 'selector is required for extract' })
            const elements = await p.$$eval(selector, (els: Element[]) =>
              els.map(el => ({ text: el.textContent?.trim(), html: el.outerHTML.substring(0, 500) }))
            )
            return textResult({ elements: elements.slice(0, 50), count: elements.length, url: p.url() })
          }
          case 'text': {
            const text = await p.evaluate(() => document.body.innerText)
            const truncated = typeof text === 'string' && text.length > 50000
              ? text.substring(0, 50000) + '\n[Truncated]'
              : text
            return textResult({ content: truncated, url: p.url(), title: await p.title() })
          }
          case 'screenshot': {
            const screenshotPath = join(ctx.workspaceDir, 'screenshot.png')
            await p.screenshot({ path: screenshotPath, fullPage: false })
            return textResult({ ok: true, path: 'screenshot.png', url: p.url() })
          }
          case 'evaluate': {
            if (!value) return textResult({ error: 'value (JS code) is required for evaluate' })
            const result = await p.evaluate(value)
            return textResult({ result, url: p.url() })
          }
          case 'select': {
            if (!selector || value === undefined) return textResult({ error: 'selector and value required for select' })
            await p.selectOption(selector, value, { timeout: 5000 })
            return textResult({ ok: true, action: 'select', selector, value })
          }
          case 'scroll': {
            if (selector) {
              await p.locator(selector).scrollIntoViewIfNeeded({ timeout: 5000 })
            } else {
              const distance = parseInt(value || '500', 10)
              await p.evaluate((d: number) => window.scrollBy(0, d), distance)
            }
            return textResult({ ok: true, action: 'scroll' })
          }
          case 'wait_for': {
            if (!selector) return textResult({ error: 'selector is required for wait_for' })
            await p.waitForSelector(selector, { timeout: waitMs || 10000 })
            return textResult({ ok: true, action: 'wait_for', selector })
          }
          default:
            return textResult({ error: `Unknown browser action: ${action}` })
        }
      } catch (err: any) {
        return textResult({ error: `Browser error: ${err.message}`, action })
      }
    },
  }
}

function createSendMessageTool(ctx: ToolContext): AgentTool {
  return {
    name: 'send_message',
    description:
      'Send a message through a connected messaging channel (telegram, discord, slack, whatsapp, email).',
    label: 'Send Message',
    parameters: Type.Object({
      channel: Type.String({ description: 'Channel type (e.g. "telegram", "discord")' }),
      channelId: Type.String({ description: 'Target chat/channel ID' }),
      message: Type.String({ description: 'Message text to send' }),
    }),
    execute: async (_toolCallId, params) => {
      const { channel: channelType, channelId, message } = params as {
        channel: string
        channelId: string
        message: string
      }

      const adapter = ctx.channels.get(channelType)
      if (!adapter) {
        return textResult({ error: `Channel not connected: ${channelType}` })
      }

      const status = adapter.getStatus()
      if (!status.connected) {
        return textResult({ error: `Channel ${channelType} is not connected` })
      }

      try {
        await adapter.sendMessage(channelId, message)
        return textResult({ ok: true, channel: channelType, channelId })
      } catch (err: any) {
        return textResult({ error: `Failed to send: ${err.message}` })
      }
    },
  }
}

function createChannelDisconnectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'channel_disconnect',
    description: 'Disconnect a messaging channel and remove it from config.',
    label: 'Disconnect Channel',
    parameters: Type.Object({
      type: Type.String({ description: 'Channel type to disconnect (e.g. "discord")' }),
    }),
    execute: async (_toolCallId, params) => {
      const { type } = params as { type: string }

      if (!ctx.disconnectChannel) {
        return textResult({ error: 'Channel disconnect not available in this context' })
      }

      try {
        await ctx.disconnectChannel(type)

        const configPath = join(ctx.workspaceDir, 'config.json')
        if (existsSync(configPath)) {
          try {
            const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
            fileConfig.channels = (fileConfig.channels || []).filter((ch: any) => ch.type !== type)
            writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')
          } catch { /* config corrupted, skip */ }
        }

        return textResult({ ok: true, type, message: `${type} channel disconnected` })
      } catch (err: any) {
        return textResult({ error: `Failed to disconnect ${type}: ${err.message}` })
      }
    },
  }
}

function createChannelListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'channel_list',
    description: 'List all configured messaging channels and their connection status.',
    label: 'List Channels',
    parameters: Type.Object({}),
    execute: async () => {
      const statuses = []
      for (const [type, adapter] of ctx.channels) {
        statuses.push(adapter.getStatus())
      }

      const configPath = join(ctx.workspaceDir, 'config.json')
      let configured: string[] = []
      if (existsSync(configPath)) {
        try {
          const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
          configured = (fileConfig.channels || []).map((ch: any) => ch.type)
        } catch { /* ignore */ }
      }

      return textResult({
        connected: statuses,
        configured,
      })
    },
  }
}

function createCronTool(ctx: ToolContext): AgentTool {
  return {
    name: 'cron',
    description:
      'Manage scheduled jobs. Actions: "add" (create/update), "remove", "list", "enable", "disable", "trigger".',
    label: 'Manage Cron Jobs',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('add'),
        Type.Literal('remove'),
        Type.Literal('list'),
        Type.Literal('enable'),
        Type.Literal('disable'),
        Type.Literal('trigger'),
      ], { description: 'Action to perform' }),
      name: Type.Optional(Type.String({ description: 'Job name (required for add/remove/enable/disable/trigger)' })),
      intervalSeconds: Type.Optional(Type.Number({ description: 'Run interval in seconds (required for add)' })),
      prompt: Type.Optional(Type.String({ description: 'Prompt to execute when job fires (required for add)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { action, name, intervalSeconds, prompt } = params as {
        action: string
        name?: string
        intervalSeconds?: number
        prompt?: string
      }

      const cm = ctx.cronManager
      if (!cm) {
        return textResult({ error: 'Cron manager not available' })
      }

      try {
        switch (action) {
          case 'list':
            return textResult({ jobs: cm.listJobs() })

          case 'add': {
            if (!name || !intervalSeconds || !prompt) {
              return textResult({ error: 'add requires name, intervalSeconds, and prompt' })
            }
            const job = cm.addJob({ name, intervalSeconds, prompt })
            return textResult({ ok: true, job })
          }

          case 'remove':
            if (!name) return textResult({ error: 'remove requires name' })
            return textResult({ ok: cm.removeJob(name), name })

          case 'enable':
            if (!name) return textResult({ error: 'enable requires name' })
            return textResult({ ok: cm.enableJob(name), name })

          case 'disable':
            if (!name) return textResult({ error: 'disable requires name' })
            return textResult({ ok: cm.disableJob(name), name })

          case 'trigger': {
            if (!name) return textResult({ error: 'trigger requires name' })
            const result = await cm.triggerJob(name)
            return textResult({ ok: result.success, result })
          }

          default:
            return textResult({ error: `Unknown action: ${action}` })
        }
      } catch (err: any) {
        return textResult({ error: err.message })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Canvas Tools (Dynamic App)
// ---------------------------------------------------------------------------

function createCanvasCreateTool(): AgentTool {
  return {
    name: 'canvas_create',
    description:
      'Create a new UI surface on the dynamic app canvas. A surface is a container for interactive UI components visible to the user. You must create a surface before adding components to it.',
    label: 'Create Canvas Surface',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Unique ID for the surface (e.g. "flight_results", "email_dashboard")' }),
      title: Type.Optional(Type.String({ description: 'Display title for the surface' })),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, title } = params as { surfaceId: string; title?: string }
      const manager = getDynamicAppManager()
      return textResult(manager.createSurface(surfaceId, title))
    },
  }
}

function createCanvasUpdateTool(): AgentTool {
  return {
    name: 'canvas_update',
    description: `Add or update UI components on a surface. Components form a tree via ID references.
One component must have id "root" as the tree root. Available component types:

Layout: Row, Column, Grid, Card, ScrollArea, Tabs, TabPanel, Accordion, AccordionItem
Display: Text, Badge, Image, Icon, Separator, Progress, Skeleton, Alert
Data: Table (read-only display), Metric, Chart, DataList (repeating template with actions)
Interactive: Button, TextField, Select, Checkbox, ChoicePicker

Each component has: id, component (type), and type-specific props.
Use "children" (array of IDs) or "child" (single ID) for nesting.
Use { "path": "/some/pointer" } (with leading /) for data binding to the root data model.

BUTTON — All button behavior uses the "action" prop with a mutation:
  External link (opens in new tab):
    { id: "link", component: "Button", label: "View on Airbnb", variant: "outline",
      action: { name: "open_listing", mutation: { endpoint: "https://airbnb.com/rooms/123", method: "OPEN" } } }
  DataList template with per-item URL (data-bound):
    { id: "link", component: "Button", label: "View Listing", variant: "outline",
      action: { name: "open_listing", mutation: { endpoint: { path: "url" }, method: "OPEN" } } }
  CRUD mutation:
    { id: "add", component: "Button", label: "Add",
      action: { name: "add_item", mutation: { endpoint: "/api/items", method: "POST", body: { title: "New" } } } }
  Supported methods: POST, PATCH, DELETE (CRUD), OPEN (external URL in new tab).

IMPORTANT — For lists with per-row buttons (edit/delete), use DataList NOT Table:
- Table is for read-only data display only (no buttons in rows).
- DataList renders a template for each item and supports per-item mutation buttons.
- Set DataList children to: { "path": "/items", "templateId": "item_template" }
- Inside the template, { "path": "fieldName" } (NO leading /) binds to the current item.

See canvas_api_schema tool description for a complete working DataList + mutation example.

TABS — Use TabPanel children with a "title" prop (tab labels auto-derive from title):
  { id: "tabs", component: "Tabs", children: ["tab1", "tab2"] }
  { id: "tab1", component: "TabPanel", title: "First Tab", children: ["content1"] }
  { id: "tab2", component: "TabPanel", title: "Second Tab", children: ["content2"] }
NEVER use Column/Card as direct Tabs children without an explicit "tabs" prop — tabs will render empty.`,
    label: 'Update Canvas Components',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID to update' }),
      components: Type.Array(
        Type.Object({
          id: Type.String(),
          component: Type.String(),
        }, { additionalProperties: true }),
        { description: 'Array of component definitions' },
      ),
      merge: Type.Optional(Type.Boolean({ description: 'If true, merge with existing components instead of validating as a complete tree. Use for updating individual components without resending the full tree.' })),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, components: rawComponents, merge } = params as { surfaceId: string; components: any[]; merge?: boolean }

      // Auto-correct known variant/enum mismatches before validation
      const { components: normalizedComponents, corrections } = normalizeComponents(rawComponents)
      const components = normalizedComponents as typeof rawComponents

      // Auto-inject mutations for buttons that have action.name but no mutation
      const autoMutationWarnings: string[] = []
      const manager = getDynamicAppManager()
      for (const comp of components) {
        if (comp.component !== 'Button' || !comp.action) continue
        const action = comp.action as Record<string, unknown>
        if (!action.name || action.mutation) continue

        const inferred = manager.inferMutationForButton(surfaceId, String(action.name))
        if (inferred) {
          const needsParams = inferred.endpoint.includes(':id')
          action.mutation = {
            endpoint: inferred.endpoint,
            method: inferred.method,
            ...(needsParams ? { params: { id: { path: 'id' } } } : {}),
          }
          autoMutationWarnings.push(
            `[${comp.id}] Auto-injected mutation { endpoint: "${inferred.endpoint}", method: "${inferred.method}" } from action name "${action.name}". Verify this is correct and add explicit mutation props (body, params) if needed.`
          )
        }
      }

      // When merging, lint against the full merged component set
      let lintTarget = components
      if (merge) {
        const surface = manager.getSurface(surfaceId)
        if (surface) {
          const existing = [...surface.components.values()] as typeof components
          const incomingIds = new Set(components.map(c => String(c.id)))
          const merged = [
            ...existing.filter(c => !incomingIds.has(String(c.id))),
            ...components,
          ]
          lintTarget = merged
        }
      }
      const lint = lintComponents(lintTarget)
      const errors = lint.filter((m) => m.severity === 'error')
      const warnings = lint.filter((m) => m.severity === 'warning')

      // Fatal structural errors — don't render at all
      const fatalErrors = errors.filter((e) =>
        e.message.includes('missing required "id"') ||
        e.message.includes('missing required "component"') ||
        e.message.includes('Unknown component type') ||
        e.message.includes('No component with id "root"') ||
        e.message.includes('does not exist in the component set')
      )

      if (fatalErrors.length > 0) {
        return textResult({
          ok: false,
          error: 'Component validation failed. Fix the errors below and retry.',
          errors: errors.map((e) => `[${e.componentId}] ${e.message}`),
          warnings: warnings.map((w) => `[${w.componentId}] ${w.message}`),
          hint: 'Use canvas_components with action "detail" to look up valid props for any component type.',
        })
      }

      // Render with auto-corrected components
      const result = manager.updateComponents(surfaceId, components)

      // Build test checklist for buttons with mutations (helps agent know exactly what to test)
      const allComponents = merge
        ? [...(manager.getSurface(surfaceId)?.components.values() ?? [])]
        : components
      const buttonChecklist = allComponents
        .filter((c: any) => c.component === 'Button' && c.action?.mutation)
        .map((c: any) => {
          const mut = c.action.mutation as Record<string, unknown>
          return {
            actionName: c.action.name,
            buttonId: c.id,
            endpoint: mut.endpoint,
            method: mut.method,
            hasParams: !!mut.params,
          }
        })
      const testChecklistFields = buttonChecklist.length > 0
        ? {
            testChecklist: buttonChecklist,
            testHint: `Test each button with canvas_trigger_action({ surfaceId: "${surfaceId}", actionName: "..." }). For PATCH/DELETE buttons inside DataList templates, also pass itemData with a real item's data (e.g. { id: "..." }).`,
          }
        : {}

      // Non-fatal errors still present after auto-correction
      if (errors.length > 0) {
        return textResult({
          ...result,
          ok: false,
          error: `Components rendered with ${errors.length} error(s) that MUST be fixed. The UI is broken or incomplete until these are resolved. Call canvas_update again with corrected components.`,
          errors: errors.map((e) => `[${e.componentId}] ${e.message}`),
          warnings: warnings.length > 0 ? warnings.map((w) => `[${w.componentId}] ${w.message}`) : undefined,
          corrections: corrections.length > 0 ? corrections : undefined,
          ...testChecklistFields,
          hint: 'Use canvas_components with action "detail" to look up valid props and enum values for any component type.',
        })
      }

      if (warnings.length > 0) {
        return textResult({
          ...result,
          ok: false,
          error: `Components rendered with ${warnings.length} warning(s) that should be fixed. Call canvas_update again with corrected components.`,
          warnings: warnings.map((w) => `[${w.componentId}] ${w.message}`),
          corrections: corrections.length > 0 ? corrections : undefined,
          ...testChecklistFields,
          hint: 'Use canvas_components with action "detail" to look up valid props for any component type.',
        })
      }

      if (corrections.length > 0 || autoMutationWarnings.length > 0) {
        return textResult({
          ...result,
          corrections: corrections.length > 0 ? corrections : undefined,
          autoMutations: autoMutationWarnings.length > 0 ? autoMutationWarnings : undefined,
          ...testChecklistFields,
          note: autoMutationWarnings.length > 0
            ? 'Some buttons had missing mutations that were auto-inferred from action names. Always define explicit mutations in future updates — auto-inference may be incorrect.'
            : 'Some prop values were auto-corrected. Use these corrected values in future updates.',
        })
      }
      return textResult({ ...result, ...testChecklistFields })
    },
  }
}

function createCanvasDataTool(): AgentTool {
  return {
    name: 'canvas_data',
    description:
      'Update the data model of a surface without resending the component layout. Components with data bindings (e.g. { "path": "/users/0/name" }) will automatically reflect the new data. Use JSON Pointer paths (RFC 6901) to target specific locations in the data model.',
    label: 'Update Canvas Data',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID to update' }),
      path: Type.Optional(Type.String({ description: 'JSON Pointer path (e.g. "/flights/0/price"). Defaults to "/" which replaces the entire data model.' })),
      value: Type.Unknown({ description: 'New value to set at the given path' }),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, path, value } = params as { surfaceId: string; path?: string; value: unknown }
      const manager = getDynamicAppManager()
      const resolved = autoParseJsonString(value)
      return textResult(manager.updateData(surfaceId, path, resolved))
    },
  }
}

/**
 * LLMs frequently send JSON values as stringified JSON (e.g. `"[{\"id\":1}]"`)
 * instead of native JSON arrays/objects. Auto-parse when the string looks like
 * a JSON array or object so data bindings work correctly.
 */
function autoParseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return value
}

function createCanvasDataPatchTool(): AgentTool {
  return {
    name: 'canvas_data_patch',
    description:
      'Apply atomic operations to the data model without replacing entire values. ' +
      'Supports: increment/decrement (numbers), toggle (booleans), append (arrays), set (any). ' +
      'Use this for counters, toggles, and adding items to lists without reading the current value first.',
    label: 'Patch Canvas Data',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID to patch' }),
      operations: Type.Array(
        Type.Object({
          op: Type.String({ description: 'Operation: "increment", "decrement", "toggle", "append", or "set"' }),
          path: Type.String({ description: 'JSON Pointer path (e.g. "/count", "/items")' }),
          value: Type.Optional(Type.Unknown({ description: 'Value for the operation. For increment/decrement: amount (default 1). For append: item to add. For set: new value.' })),
        }),
        { description: 'Array of patch operations to apply atomically' },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, operations } = params as { surfaceId: string; operations: Array<{ op: string; path: string; value?: unknown }> }
      const manager = getDynamicAppManager()
      return textResult(manager.patchData(surfaceId, operations))
    },
  }
}

function createCanvasDeleteTool(): AgentTool {
  return {
    name: 'canvas_delete',
    description: 'Remove a surface and all its components from the canvas.',
    label: 'Delete Canvas Surface',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID to delete' }),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId } = params as { surfaceId: string }
      const manager = getDynamicAppManager()
      return textResult(manager.deleteSurface(surfaceId))
    },
  }
}

function createCanvasActionWaitTool(): AgentTool {
  return {
    name: 'canvas_action_wait',
    description:
      'Pause and wait for a REAL USER to click a button or interact with a canvas component. Returns the action event when the user acts, or times out after 2 minutes. DO NOT use this when self-testing your canvas — use canvas_trigger_action + canvas_inspect instead. Only use canvas_action_wait when you need to hand control to the human and wait for their input.',
    label: 'Wait for Canvas Action',
    parameters: Type.Object({
      surfaceId: Type.Optional(Type.String({ description: 'Only wait for actions from this surface (optional)' })),
      actionName: Type.Optional(Type.String({ description: 'Only wait for this specific action name (optional)' })),
      timeoutSeconds: Type.Optional(Type.Number({ description: 'Timeout in seconds (default: 120)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, actionName, timeoutSeconds = 120 } = params as {
        surfaceId?: string
        actionName?: string
        timeoutSeconds?: number
      }
      const manager = getDynamicAppManager()
      const event = await manager.waitForAction(surfaceId, actionName, timeoutSeconds * 1000)
      if (!event) {
        return textResult({ timeout: true, message: 'No user action received within the timeout period' })
      }
      return textResult({ action: event })
    },
  }
}

function createCanvasComponentsTool(options?: { basic?: boolean }): AgentTool {
  const isBasic = options?.basic ?? false
  const catalog = isBasic ? BASIC_CANVAS_COMPONENT_SCHEMA : CANVAS_COMPONENT_SCHEMA
  const validTypes = isBasic ? BASIC_VALID_COMPONENT_TYPES : VALID_COMPONENT_TYPES
  const lookupSchema = isBasic ? getBasicComponentSchema : getComponentSchema

  return {
    name: 'canvas_components',
    description:
      'Discover available canvas component types, their props, and valid values. Use "list" to see all components grouped by category, "detail" to get full prop info for a specific component type, or "search" to find components by keyword.',
    label: 'Canvas Component Catalog',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('detail'),
        Type.Literal('search'),
      ], { description: 'list = overview of all components, detail = props for one type, search = find by keyword' }),
      type: Type.Optional(Type.String({ description: 'Component type name (for "detail" action, e.g. "Card", "Table")' })),
      query: Type.Optional(Type.String({ description: 'Search keyword (for "search" action, e.g. "chart", "input", "layout")' })),
      category: Type.Optional(Type.String({ description: 'Filter by category (layout, display, data, interactive, extended)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { action, type, query, category } = params as {
        action: string
        type?: string
        query?: string
        category?: string
      }

      if (action === 'detail') {
        if (!type) {
          return textResult({ error: 'The "type" parameter is required for the "detail" action. Example: { action: "detail", type: "Card" }' })
        }
        const schema = lookupSchema(type)
        if (!schema) {
          const typeList = [...validTypes].join(', ')
          return textResult({ error: `Unknown component type "${type}". Valid types: ${typeList}` })
        }
        return textResult({
          component: schema.type,
          category: schema.category,
          description: schema.description,
          hasChildren: schema.hasChildren,
          props: schema.props,
        })
      }

      if (action === 'search') {
        const q = (query || '').toLowerCase()
        if (!q) {
          return textResult({ error: 'The "query" parameter is required for the "search" action. Example: { action: "search", query: "table" }' })
        }
        const matches = catalog.filter((s) =>
          s.type.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q) ||
          Object.keys(s.props).some((p) => p.toLowerCase().includes(q))
        )
        if (matches.length === 0) {
          return textResult({ results: [], hint: `No components matched "${query}". Try broader terms or use action "list" to see everything.` })
        }
        return textResult({
          results: matches.map((s) => ({
            type: s.type,
            category: s.category,
            description: s.description,
            hasChildren: s.hasChildren,
            props: Object.keys(s.props),
          })),
        })
      }

      // Default: list
      let schemas = catalog as ComponentSchema[]
      if (category) {
        schemas = schemas.filter((s) => s.category === category)
      }

      const grouped: Record<string, Array<{ type: string; description: string; hasChildren: boolean; props: string[] }>> = {}
      for (const s of schemas) {
        if (!grouped[s.category]) grouped[s.category] = []
        grouped[s.category].push({
          type: s.type,
          description: s.description,
          hasChildren: s.hasChildren,
          props: Object.keys(s.props),
        })
      }

      return textResult({
        categories: grouped,
        totalComponents: schemas.length,
        hint: 'Use { action: "detail", type: "ComponentName" } to see full prop definitions for any component.',
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Canvas API Tools (Managed Data Layer)
// ---------------------------------------------------------------------------

function createCanvasApiSchemaTool(): AgentTool {
  return {
    name: 'canvas_api_schema',
    description: `Define data models for a surface and auto-generate a CRUD API backed by SQLite.
Each model automatically gets id, createdAt, updatedAt fields. After calling this tool,
the surface will have REST endpoints available for each model (e.g. GET/POST /api/todos).

Field types: String, Int, Float, Boolean, DateTime, Json

COMPLETE WORKFLOW — follow these 4 steps to build a working CRUD UI:

STEP 1: canvas_api_schema — define your model
  canvas_api_schema({ surfaceId: "my_app", models: [{
    name: "Task", fields: [
      { name: "title", type: "String" },
      { name: "status", type: "String", default: "todo" }
    ]
  }]})
  → Creates endpoints: GET/POST /api/tasks, GET/PATCH/DELETE /api/tasks/:id

STEP 2: Populate data — PREFER real data from MCP/Composio tools or uploaded files.
  Use mcp_search to find integrations, then canvas_api_seed with the real results.
  Only use fabricated sample data if the user explicitly requests it or no real source is available.
  Fallback example (sample data only):
  canvas_api_seed({ surfaceId: "my_app", model: "Task", records: [
    { title: "Buy groceries" }, { title: "Walk the dog", status: "done" }
  ]})

STEP 3: canvas_api_query — load data into the data model
  canvas_api_query({ surfaceId: "my_app", model: "Task", dataPath: "/tasks" })
  → Now { path: "/tasks" } is available for data binding in components

STEP 4: canvas_update — build the UI with DataList for per-item actions
  Use a DataList with template children for per-row buttons (add, edit, delete).
  Inside a DataList template, { path: "fieldName" } (NO leading slash) binds to the current item.

  FULL COMPONENT EXAMPLE (copy and adapt):
  [
    { id: "root", component: "Column", children: ["header", "add_form", "task_list"], gap: "md", padding: "md" },
    { id: "header", component: "Text", text: "My Tasks", variant: "h3" },
    { id: "add_form", component: "Row", children: ["add_input", "add_btn"], gap: "sm", align: "end" },
    { id: "add_input", component: "TextField", placeholder: "Task title...", dataPath: "/newTaskTitle" },
    { id: "add_btn", component: "Button", label: "Add Task",
      action: { name: "add", mutation: { endpoint: "/api/tasks", method: "POST",
        body: { title: { path: "/newTaskTitle" } } } } },
    { id: "task_list", component: "DataList",
      children: { path: "/tasks", templateId: "task_card" }, emptyText: "No tasks yet" },
    { id: "task_card", component: "Card", child: "task_row" },
    { id: "task_row", component: "Row", children: ["task_info", "task_actions"], align: "center", justify: "between" },
    { id: "task_info", component: "Column", children: ["task_title", "task_status"], gap: "xs" },
    { id: "task_title", component: "Text", text: { path: "title" }, weight: "medium" },
    { id: "task_status", component: "Badge", text: { path: "status" } },
    { id: "task_actions", component: "Row", children: ["done_btn", "del_btn"], gap: "sm" },
    { id: "done_btn", component: "Button", label: "Done", variant: "outline", size: "sm",
      action: { name: "done", mutation: { endpoint: "/api/tasks/:id", method: "PATCH",
        params: { id: { path: "id" } }, body: { status: "done" } } } },
    { id: "del_btn", component: "Button", label: "Delete", variant: "destructive", size: "sm",
      action: { name: "delete", mutation: { endpoint: "/api/tasks/:id", method: "DELETE",
        params: { id: { path: "id" } } } } }
  ]

KEY RULES:
- DataList children: { path: "/items", templateId: "template_component_id" }
- Inside templates: { path: "field" } (no leading /) binds to the CURRENT ITEM
- Outside templates: { path: "/field" } (with leading /) binds to the ROOT data model
- Mutation params: { id: { path: "id" } } resolves the current item's id for :id in the endpoint
- POST mutations use the collection endpoint (/api/tasks)
- PATCH/DELETE mutations use the item endpoint (/api/tasks/:id)
- FORM INPUTS: Set dataPath on TextField/Select to write user input to the data model.
  Then use { path: "/dataPath" } in the mutation body to read those values.
  Example: TextField has dataPath="/newTitle", Button mutation body has { title: { path: "/newTitle" } }`,
    label: 'Define API Schema',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID (must exist via canvas_create)' }),
      models: Type.Array(
        Type.Object({
          name: Type.String({ description: 'Model name in PascalCase (e.g. "Todo", "Stock")' }),
          fields: Type.Array(
            Type.Object({
              name: Type.String({ description: 'Field name in camelCase' }),
              type: Type.Union([
                Type.Literal('String'),
                Type.Literal('Int'),
                Type.Literal('Float'),
                Type.Literal('Boolean'),
                Type.Literal('DateTime'),
                Type.Literal('Json'),
              ], { description: 'Field data type' }),
              optional: Type.Optional(Type.Boolean({ description: 'Allow null values (default: false)' })),
              default: Type.Optional(Type.Unknown({ description: 'Default value for new records' })),
              unique: Type.Optional(Type.Boolean({ description: 'Enforce uniqueness' })),
            }),
            { description: 'Field definitions' },
          ),
        }),
        { description: 'Model definitions' },
      ),
      reset: Type.Optional(Type.Boolean({ description: 'Drop and recreate all tables (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, models, reset = false } = params as {
        surfaceId: string
        models: Array<{ name: string; fields: Array<{ name: string; type: string; optional?: boolean; default?: unknown; unique?: boolean }> }>
        reset?: boolean
      }
      const manager = getDynamicAppManager()
      return textResult(manager.applyApiSchema(surfaceId, models as any, reset))
    },
  }
}

function createCanvasApiSeedTool(): AgentTool {
  return {
    name: 'canvas_api_seed',
    description:
      'Bulk insert records into a model\'s table. Use after canvas_api_schema to populate data. PREFER inserting real data fetched from MCP/Composio tools or uploaded files. Only use fabricated sample data if the user explicitly asks for demo/fake data or no real data source exists. Records can omit the id field (auto-generated). Use upsert=true to update existing records by id.',
    label: 'Seed API Data',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID' }),
      model: Type.String({ description: 'Model name (e.g. "Todo", "Stock")' }),
      records: Type.Array(Type.Object({}, { additionalProperties: true }), {
        description: 'Array of record objects to insert',
      }),
      upsert: Type.Optional(Type.Boolean({ description: 'Update existing records by id (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, model, records, upsert = false } = params as {
        surfaceId: string
        model: string
        records: Record<string, unknown>[]
        upsert?: boolean
      }
      const manager = getDynamicAppManager()
      return textResult(manager.seedApiData(surfaceId, model, records, upsert))
    },
  }
}

function createCanvasApiQueryTool(): AgentTool {
  return {
    name: 'canvas_api_query',
    description:
      `Query a model and push results into the surface data model at a given path.
This is the recommended way to pipe API data into components:
1. Call canvas_api_query with dataPath (e.g. "/todos") to push query results into the surface data model.
2. Bind component props to the data via { path: "/todos" } in canvas_update.

Example: canvas_api_query({ surfaceId: "app", model: "Todo", dataPath: "/todos" })
Then in canvas_update: { id: "table", component: "Table", rows: { path: "/todos" } }`,
    label: 'Query API Data',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID' }),
      model: Type.String({ description: 'Model name (e.g. "Todo")' }),
      where: Type.Optional(Type.Object({}, { additionalProperties: true, description: 'Filter conditions (field: value)' })),
      orderBy: Type.Optional(Type.String({ description: 'Field to sort by. Prefix with - for descending (e.g. "-createdAt")' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of results' })),
      dataPath: Type.Optional(Type.String({ description: 'JSON Pointer path to write results into the surface data model (e.g. "/todos")' })),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, model, where, orderBy, limit, dataPath } = params as {
        surfaceId: string
        model: string
        where?: Record<string, unknown>
        orderBy?: string
        limit?: number
        dataPath?: string
      }
      const manager = getDynamicAppManager()
      return textResult(manager.queryApiData(surfaceId, model, { where, orderBy, limit }, dataPath))
    },
  }
}

// ---------------------------------------------------------------------------
// Canvas API Hooks Tool
// ---------------------------------------------------------------------------

const HookActionSchema = Type.Object({
  action: Type.Union([
    Type.Literal('recompute'),
    Type.Literal('validate'),
    Type.Literal('cascade-delete'),
    Type.Literal('transform'),
    Type.Literal('log'),
  ], { description: 'Hook action type' }),
  target: Type.Optional(Type.String({ description: 'Target data path (recompute), model name (cascade-delete, log)' })),
  source: Type.Optional(Type.String({ description: 'Source collection path for recompute (e.g. "/expenses")' })),
  field: Type.Optional(Type.String({ description: 'Field name for recompute aggregate or validate rule' })),
  aggregate: Type.Optional(Type.Union([
    Type.Literal('sum'), Type.Literal('count'), Type.Literal('avg'), Type.Literal('min'), Type.Literal('max'),
  ], { description: 'Aggregate function for recompute' })),
  rule: Type.Optional(Type.Union([
    Type.Literal('required'), Type.Literal('positive'), Type.Literal('min'), Type.Literal('max'), Type.Literal('pattern'), Type.Literal('enum'),
  ], { description: 'Validation rule type' })),
  value: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: 'Threshold for min/max, regex for pattern, comma-separated values for enum' })),
  message: Type.Optional(Type.String({ description: 'Custom validation error message' })),
  foreignKey: Type.Optional(Type.String({ description: 'Foreign key field for cascade-delete (e.g. "projectId")' })),
  transform: Type.Optional(Type.Union([
    Type.Literal('lowercase'), Type.Literal('uppercase'), Type.Literal('trim'),
    Type.Literal('round'), Type.Literal('floor'), Type.Literal('ceil'), Type.Literal('abs'),
  ], { description: 'Transform function' })),
  fields: Type.Optional(Type.Object({}, { additionalProperties: true, description: 'Field mappings for log action ($id, $operation, $model, $timestamp)' })),
})

function createCanvasApiHooksTool(): AgentTool {
  return {
    name: 'canvas_api_hooks',
    description: `Register declarative hooks on a model's CRUD operations. Hooks fire automatically when data is mutated.

HOOK ACTIONS:

1. recompute — Auto-update a metric after mutations (sum, count, avg, min, max)
   { action: "recompute", target: "/summary/totalSpent", source: "/expenses", field: "amount", aggregate: "sum" }

2. validate — Reject mutations that fail validation (beforeCreate/beforeUpdate only)
   { action: "validate", field: "amount", rule: "positive" }
   { action: "validate", field: "status", rule: "enum", value: "pending,shipped,delivered" }
   { action: "validate", field: "email", rule: "required" }

3. cascade-delete — Delete related records when parent is deleted (afterDelete only)
   { action: "cascade-delete", target: "Task", foreignKey: "projectId" }

4. transform — Normalize field values before saving (beforeCreate/beforeUpdate only)
   { action: "transform", field: "email", transform: "lowercase" }
   { action: "transform", field: "name", transform: "trim" }

5. log — Append an audit entry to a log model after mutations
   { action: "log", target: "ActivityLog" }
   { action: "log", target: "ActivityLog", fields: { "entityId": "$id", "action": "$operation", "model": "$model" } }

EXAMPLE — Expense tracker with auto-updating metrics and validation:
  canvas_api_hooks({
    surfaceId: "app",
    model: "Expense",
    beforeCreate: [
      { action: "validate", field: "amount", rule: "positive" },
      { action: "validate", field: "description", rule: "required" },
      { action: "transform", field: "description", transform: "trim" }
    ],
    afterCreate: [
      { action: "recompute", target: "/summary/totalSpent", source: "/expenses", field: "amount", aggregate: "sum" },
      { action: "recompute", target: "/summary/count", source: "/expenses", aggregate: "count" }
    ],
    afterDelete: [
      { action: "recompute", target: "/summary/totalSpent", source: "/expenses", field: "amount", aggregate: "sum" },
      { action: "recompute", target: "/summary/count", source: "/expenses", aggregate: "count" }
    ]
  })

RULES:
- ALWAYS register recompute hooks when Metric components display aggregates of a collection
- Use validate hooks for data integrity (required fields, positive numbers, enum constraints)
- Use cascade-delete when models have parent-child relationships
- validate and transform actions only work in beforeCreate/beforeUpdate
- cascade-delete, recompute, and log actions work in afterCreate/afterUpdate/afterDelete`,
    label: 'Register API Hooks',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID' }),
      model: Type.String({ description: 'Model name to register hooks on (e.g. "Expense")' }),
      beforeCreate: Type.Optional(Type.Array(HookActionSchema, { description: 'Hooks to run before creating a record (validate, transform)' })),
      beforeUpdate: Type.Optional(Type.Array(HookActionSchema, { description: 'Hooks to run before updating a record (validate, transform)' })),
      afterCreate: Type.Optional(Type.Array(HookActionSchema, { description: 'Hooks to run after creating a record (recompute, cascade-delete, log)' })),
      afterUpdate: Type.Optional(Type.Array(HookActionSchema, { description: 'Hooks to run after updating a record (recompute, log)' })),
      afterDelete: Type.Optional(Type.Array(HookActionSchema, { description: 'Hooks to run after deleting a record (recompute, cascade-delete, log)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, model, beforeCreate, beforeUpdate, afterCreate, afterUpdate, afterDelete } = params as {
        surfaceId: string
        model: string
        beforeCreate?: any[]
        beforeUpdate?: any[]
        afterCreate?: any[]
        afterUpdate?: any[]
        afterDelete?: any[]
      }
      const manager = getDynamicAppManager()
      const defs = { beforeCreate, beforeUpdate, afterCreate, afterUpdate, afterDelete }
      // Strip undefined phases
      for (const key of Object.keys(defs) as (keyof typeof defs)[]) {
        if (!defs[key]) delete defs[key]
      }
      const result = manager.registerHooks(surfaceId, model, defs)
      return textResult(result)
    },
  }
}

function createCanvasApiBindTool(ctx: ToolContext): AgentTool {
  return {
    name: 'canvas_api_bind',
    description: `Bind CRUD API routes to installed tools so the canvas can display live data from integrations.

Instead of seeding local data, this creates REST endpoints that proxy directly to tool calls.
The canvas binds to these endpoints identically to SQLite-backed models.

EXAMPLE — Bind Google Calendar events to the canvas:

1. Install the integration:
   tool_install({ name: "googlecalendar" })

2. Bind tool operations to CRUD routes:
   canvas_api_bind({
     surfaceId: "app",
     model: "CalendarEvent",
     fields: [
       { name: "summary", type: "String" },
       { name: "start", type: "DateTime" },
       { name: "end", type: "DateTime" }
     ],
     bindings: {
       list: {
         tool: "GOOGLECALENDAR_LIST_EVENTS",
         params: { calendar_id: "primary" },
         resultPath: "items"
       },
       create: {
         tool: "GOOGLECALENDAR_CREATE_EVENT",
         paramMap: { summary: "summary", start: "start", end: "end" }
       }
     },
     cache: { enabled: true, ttlSeconds: 60 },
     dataPath: "/events"
   })
   → Creates: GET /api/calendar-events (calls list tool), POST /api/calendar-events (calls create tool)
   → Data auto-loaded at "/events" for { path: "/events" } bindings

3. Build UI with data binding:
   { component: "DataList", children: { path: "/events", templateId: "event_card" } }

Use dataPath to auto-load list data into the surface data model (replaces separate canvas_api_query call):
   canvas_api_bind({ surfaceId: "app", model: "CalendarEvent", ..., dataPath: "/events" })
   → Data auto-loaded at "/events", ready for { path: "/events" } bindings

BINDING OPERATIONS:
- list: Fetches all items. Use resultPath to extract the array from the tool response.
- get: Fetches a single item by ID.
- create: Creates an item. paramMap maps model field names to tool parameter names.
- update: Updates an item. Use ":id" in paramMap values to interpolate the route ID.
- delete: Deletes an item.

Only bind operations the tool actually supports. Read-only tools can use just "list".`,
    label: 'Bind Tools to API',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID (must exist via canvas_create)' }),
      model: Type.String({ description: 'Model name in PascalCase (e.g. "CalendarEvent", "GitHubIssue")' }),
      fields: Type.Array(
        Type.Object({
          name: Type.String({ description: 'Field name' }),
          type: Type.Union([
            Type.Literal('String'), Type.Literal('Int'), Type.Literal('Float'),
            Type.Literal('Boolean'), Type.Literal('DateTime'), Type.Literal('Json'),
          ], { description: 'Field type' }),
        }),
        { description: 'Field definitions describing the shape of items from the tool' },
      ),
      bindings: Type.Object({
        list: Type.Optional(Type.Object({
          tool: Type.String({ description: 'Full tool name for listing items' }),
          params: Type.Optional(Type.Any({ description: 'Static params to pass to the tool' })),
          resultPath: Type.Optional(Type.String({ description: 'Dot-path to extract items array from result (e.g. "items", "data.events")' })),
        })),
        get: Type.Optional(Type.Object({
          tool: Type.String({ description: 'Full tool name for getting a single item' }),
          params: Type.Optional(Type.Any()),
          paramMap: Type.Optional(Type.Any({ description: 'Maps tool params to model fields. Use ":id" for the route ID.' })),
        })),
        create: Type.Optional(Type.Object({
          tool: Type.String({ description: 'Full tool name for creating an item' }),
          params: Type.Optional(Type.Any()),
          paramMap: Type.Optional(Type.Any({ description: 'Maps tool params to model field names' })),
        })),
        update: Type.Optional(Type.Object({
          tool: Type.String({ description: 'Full tool name for updating an item' }),
          params: Type.Optional(Type.Any()),
          paramMap: Type.Optional(Type.Any({ description: 'Maps tool params to model fields. Use ":id" for the route ID.' })),
        })),
        delete: Type.Optional(Type.Object({
          tool: Type.String({ description: 'Full tool name for deleting an item' }),
          params: Type.Optional(Type.Any()),
          paramMap: Type.Optional(Type.Any({ description: 'Maps tool params. Use ":id" for the route ID.' })),
        })),
      }, { description: 'Map CRUD operations to tool calls' }),
      cache: Type.Optional(Type.Object({
        enabled: Type.Boolean({ description: 'Enable caching for list results (default: false)' }),
        ttlSeconds: Type.Optional(Type.Number({ description: 'Cache TTL in seconds (default: 60)' })),
      })),
      dataPath: Type.Optional(Type.String({ description: 'JSON Pointer path to auto-load list data into the surface data model (e.g. "/events"). Eliminates the need for a separate canvas_api_query call.' })),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, model, fields, bindings, cache, dataPath } = params as any

      if (!ctx.mcpClientManager) {
        return textResult({ error: 'Tool manager not available' })
      }

      const availableTools = ctx.mcpClientManager.getTools().map(t => t.name)
      const boundTools = [
        bindings.list?.tool, bindings.get?.tool, bindings.create?.tool,
        bindings.update?.tool, bindings.delete?.tool,
      ].filter(Boolean)

      const missing = boundTools.filter((t: string) => !availableTools.includes(t))
      if (missing.length > 0) {
        return textResult({ error: `Tool(s) not found: ${missing.join(', ')}. Use tool_search to find available tools.` })
      }

      const manager = getDynamicAppManager()
      const result = manager.bindToolApi(surfaceId, {
        model,
        fields,
        bindings,
        cache,
        dataPath,
      }, ctx.mcpClientManager)

      return textResult(result)
    },
  }
}

// ---------------------------------------------------------------------------
// Canvas Self-Testing Tools
// ---------------------------------------------------------------------------

/**
 * Resolve a dynamic path binding against scope data (DataList item) or root data model.
 * Mirrors the resolution logic in shared-app/resolve-props.ts resolveValue().
 */
function resolveBinding(
  value: unknown,
  dataModel: Record<string, unknown>,
  scopeData?: Record<string, unknown>,
): unknown {
  if (typeof value === 'object' && value !== null && 'path' in value && typeof (value as any).path === 'string') {
    const path = (value as any).path as string
    if (!path.startsWith('/') && scopeData) {
      return (scopeData as any)[path]
    }
    return getByPointer(dataModel, path)
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const resolved: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveBinding(v, dataModel, scopeData)
    }
    return resolved
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveBinding(item, dataModel, scopeData))
  }
  return value
}

/**
 * Resolve a button's mutation definition against the data model, matching
 * the frontend's resolveValue() path. Returns the fully-resolved mutation
 * (endpoint with :param placeholders replaced, body bindings resolved).
 */
function resolveButtonMutation(
  mutation: Record<string, unknown>,
  dataModel: Record<string, unknown>,
  scopeData?: Record<string, unknown>,
): { endpoint: string; method: string; body?: unknown } {
  const resolvedBody = mutation.body && typeof mutation.body === 'object'
    ? resolveBinding(mutation.body, dataModel, scopeData)
    : mutation.body

  const rawEndpoint = typeof mutation.endpoint === 'object' && mutation.endpoint !== null && 'path' in mutation.endpoint
    ? resolveBinding(mutation.endpoint, dataModel, scopeData)
    : mutation.endpoint
  let resolvedEndpoint = typeof rawEndpoint === 'string' ? rawEndpoint : ''

  if (resolvedEndpoint && resolvedEndpoint.includes(':')) {
    const params = (mutation.params || {}) as Record<string, unknown>
    for (const [pk, pv] of Object.entries(params)) {
      const resolved = resolveBinding(pv, dataModel, scopeData)
      resolvedEndpoint = resolvedEndpoint.replace(`:${pk}`, String(resolved ?? ''))
    }
  }

  return {
    endpoint: resolvedEndpoint,
    method: String(mutation.method || 'POST'),
    ...(resolvedBody !== undefined ? { body: resolvedBody } : {}),
  }
}

/**
 * Collect all Button action names on a surface (for error messages).
 */
function listButtonActionNames(surface: { components: Map<string, any> }): string[] {
  const names: string[] = []
  for (const [, comp] of surface.components) {
    if (comp.component !== 'Button') continue
    const action = comp.action as Record<string, unknown> | undefined
    if (action?.name) names.push(String(action.name))
  }
  return names
}

/**
 * Find the Button component on a surface whose action.name matches.
 * Tries exact match first, then case-insensitive, then substring containment.
 */
function findButtonByActionName(
  surface: { components: Map<string, any> },
  actionName: string,
): { id: string; action: Record<string, unknown> } | null {
  const normalized = actionName.toLowerCase().replace(/[-_\s]/g, '')
  let fuzzyMatch: { id: string; action: Record<string, unknown> } | null = null

  for (const [, comp] of surface.components) {
    if (comp.component !== 'Button') continue
    const action = comp.action as Record<string, unknown> | undefined
    if (!action?.name) continue
    const btnName = String(action.name)
    if (btnName === actionName) return { id: comp.id, action }
    if (!fuzzyMatch) {
      const btnNormalized = btnName.toLowerCase().replace(/[-_\s]/g, '')
      if (btnNormalized === normalized || btnNormalized.includes(normalized) || normalized.includes(btnNormalized)) {
        fuzzyMatch = { id: comp.id, action }
      }
    }
  }
  return fuzzyMatch
}

function createCanvasTriggerActionTool(): AgentTool {
  return {
    name: 'canvas_trigger_action',
    description:
      `Programmatically simulate a real user click on a canvas button. This resolves the button's actual mutation definition from the component tree (same as the frontend), so the test faithfully matches what the user would experience.

Provide the actionName and optional itemData (for buttons inside DataList templates):
  canvas_trigger_action({ surfaceId: "app", actionName: "add_todo" })
  canvas_trigger_action({ surfaceId: "app", actionName: "delete", itemData: { id: "abc123" } })

For DataList template buttons, itemData provides the current item's data (like { id, title, status }) so the mutation's :id params and scoped bindings resolve correctly.

This tool performs real verification: it finds the button, resolves its mutation, captures data before/after, and returns ok: false if the button has no mutation, the mutation failed, or no data changed. Always follow up with canvas_inspect to double-check.`,
    label: 'Trigger Canvas Action',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID to trigger the action on' }),
      actionName: Type.String({ description: 'Name of the action to trigger (matches the action.name on a Button)' }),
      itemData: Type.Optional(Type.Object({}, { additionalProperties: true, description: 'For buttons inside DataList templates: the current item data (e.g. { id: "abc123", title: "...", status: "..." }). Used to resolve scoped bindings like { path: "id" } and :id endpoint params.' })),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, actionName, itemData } = params as {
        surfaceId: string
        actionName: string
        itemData?: Record<string, unknown>
      }
      const manager = getDynamicAppManager()

      const surface = manager.getSurface(surfaceId)
      if (!surface) {
        return textResult({ ok: false, error: `Surface "${surfaceId}" does not exist.` })
      }

      const button = findButtonByActionName(surface, actionName)

      if (!button) {
        // No button found — deliver as a non-mutation action (e.g. for canvas_action_wait waiters)
        const deliveryResult = await manager.deliverActionAsync({
          surfaceId,
          name: actionName,
          context: {},
          timestamp: new Date().toISOString(),
        })
        const updatedSurface = manager.getSurface(surfaceId)
        const dataKeys = updatedSurface ? Object.keys(updatedSurface.dataModel) : []
        const availableActions = listButtonActionNames(surface)
        return textResult({
          ok: false,
          surfaceId,
          actionName,
          resolvedFromButton: false,
          dataKeys,
          availableActions,
          error: `No Button with action.name "${actionName}" found in the component tree. Cannot verify this action.`,
          message: availableActions.length > 0
            ? `No button named "${actionName}" exists on surface "${surfaceId}". Available button actions: [${availableActions.join(', ')}]. Retry with one of these exact names.`
            : `No button named "${actionName}" exists on surface "${surfaceId}". No buttons with action.name were found on this surface.`,
        })
      }

      const mutation = button.action.mutation as Record<string, unknown> | undefined
      if (!mutation) {
        return textResult({
          ok: false,
          surfaceId,
          actionName,
          resolvedFromButton: true,
          buttonId: button.id,
          error: `Button "${button.id}" has action.name "${actionName}" but NO mutation defined. This button does NOTHING when a real user clicks it. Fix the button with canvas_update({ merge: true }) to add: mutation: { endpoint: "/api/...", method: "POST|PATCH|DELETE", body?: {...} }`,
          message: `BROKEN BUTTON: "${button.id}" is missing its mutation. The button looks correct in the UI but does absolutely nothing when clicked. This is the #1 canvas bug.`,
        })
      }

      const resolvedMutation = resolveButtonMutation(mutation, surface.dataModel, itemData)
      const warnings: string[] = []

      if (resolvedMutation.endpoint.includes(':')) {
        warnings.push(`Resolved endpoint "${resolvedMutation.endpoint}" still has unresolved parameter placeholders. The button's mutation.params may be missing or itemData was not provided. In the real UI, this will cause a 404 error.`)
      }

      const beforeSnapshot = JSON.parse(JSON.stringify(surface.dataModel))

      const deliveryResult = await manager.deliverActionAsync({
        surfaceId,
        name: actionName,
        context: { _mutation: resolvedMutation },
        timestamp: new Date().toISOString(),
      })

      const updatedSurface = manager.getSurface(surfaceId)
      const afterSnapshot = updatedSurface ? JSON.parse(JSON.stringify(updatedSurface.dataModel)) : {}
      const dataKeys = updatedSurface ? Object.keys(updatedSurface.dataModel) : []

      if (deliveryResult.result && !deliveryResult.result.ok) {
        return textResult({
          ok: false,
          surfaceId,
          actionName,
          wasMutation: true,
          resolvedFromButton: true,
          buttonId: button.id,
          resolvedMutation,
          error: `Mutation FAILED: ${deliveryResult.result.error ?? 'unknown error'}`,
          status: deliveryResult.result.status,
          warnings: warnings.length > 0 ? warnings : undefined,
          message: `The "${actionName}" mutation failed on "${surfaceId}". Resolved from button "${button.id}". The API returned an error. This button is BROKEN and needs to be fixed.`,
        })
      }

      const changes = diffDataSnapshots(beforeSnapshot, afterSnapshot)
      if (changes.length === 0) {
        return textResult({
          ok: false,
          surfaceId,
          actionName,
          wasMutation: true,
          resolvedFromButton: true,
          buttonId: button.id,
          resolvedMutation,
          dataKeys,
          error: 'Mutation executed but NO data changed in the data model.',
          warnings: warnings.length > 0 ? warnings : undefined,
          message: `WARNING: The "${actionName}" mutation on "${surfaceId}" (button "${button.id}") did not change any data. The mutation may have wrong endpoint or body. This action may be BROKEN for users.`,
        })
      }

      return textResult({
        ok: true,
        surfaceId,
        actionName,
        wasMutation: true,
        resolvedFromButton: true,
        buttonId: button.id,
        resolvedMutation,
        dataKeys,
        changes,
        itemCount: deliveryResult.result?.itemCount,
        warnings: warnings.length > 0 ? warnings : undefined,
        message: `Mutation "${actionName}" VERIFIED on "${surfaceId}". Resolved from button "${button.id}" definition (${resolvedMutation.method} ${resolvedMutation.endpoint}). Data changed: ${changes.map(c => c.summary).join('; ')}. Use canvas_inspect to double-check.`,
      })
    },
  }
}

/**
 * Compare two data model snapshots and describe what changed.
 */
function diffDataSnapshots(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Array<{ path: string; type: 'added' | 'removed' | 'changed' | 'count_changed'; summary: string }> {
  const changes: Array<{ path: string; type: 'added' | 'removed' | 'changed' | 'count_changed'; summary: string }> = []

  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of allKeys) {
    const bVal = before[key]
    const aVal = after[key]

    if (bVal === undefined && aVal !== undefined) {
      changes.push({ path: `/${key}`, type: 'added', summary: `/${key} was added` })
      continue
    }
    if (bVal !== undefined && aVal === undefined) {
      changes.push({ path: `/${key}`, type: 'removed', summary: `/${key} was removed` })
      continue
    }

    if (Array.isArray(bVal) && Array.isArray(aVal)) {
      if (bVal.length !== aVal.length) {
        changes.push({
          path: `/${key}`,
          type: 'count_changed',
          summary: `/${key} count: ${bVal.length} → ${aVal.length}`,
        })
      } else if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
        const changedItems = aVal.reduce((count, item, i) =>
          JSON.stringify(item) !== JSON.stringify(bVal[i]) ? count + 1 : count, 0)
        changes.push({
          path: `/${key}`,
          type: 'changed',
          summary: `/${key} ${changedItems} item(s) modified (count unchanged at ${aVal.length})`,
        })
      }
    } else if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      changes.push({ path: `/${key}`, type: 'changed', summary: `/${key} value changed` })
    }
  }

  return changes
}

function createCanvasInspectTool(): AgentTool {
  return {
    name: 'canvas_inspect',
    description:
      `Read the current state of a canvas surface. Use this after canvas_trigger_action to verify that actions and mutations worked correctly. This is the verification step in the trigger → inspect → report pattern.

Modes:
- "summary" (default): Component count, data keys, API models — quick health check
- "data": Full data model or a specific path — use to verify a mutation changed the data
- "components": Full component tree — verify UI structure
- "full": Everything — components, data, and API info

Tip: After a trigger_action mutation, use mode "data" with a dataPath to check the specific collection that should have changed.`,
    label: 'Inspect Canvas Surface',
    parameters: Type.Object({
      surfaceId: Type.String({ description: 'Surface ID to inspect' }),
      mode: Type.Optional(Type.Union([
        Type.Literal('summary'),
        Type.Literal('data'),
        Type.Literal('components'),
        Type.Literal('full'),
      ], { description: 'What to return (default: summary)' })),
      dataPath: Type.Optional(Type.String({ description: 'JSON Pointer path to query specific data (for "data" mode). E.g. "/todos" to inspect just the todos array.' })),
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, mode = 'summary', dataPath } = params as {
        surfaceId: string
        mode?: 'summary' | 'data' | 'components' | 'full'
        dataPath?: string
      }
      const manager = getDynamicAppManager()
      const surface = manager.getSurface(surfaceId)

      if (!surface) {
        return textResult({ ok: false, error: `Surface "${surfaceId}" does not exist.` })
      }

      const componentList = [...surface.components.values()].map((c) => ({
        id: c.id,
        component: c.component,
        hasChildren: !!(c.children || c.child),
      }))

      if (mode === 'summary') {
        return textResult({
          ok: true,
          surfaceId,
          title: surface.title,
          componentCount: surface.components.size,
          hasRoot: surface.components.has('root'),
          dataKeys: Object.keys(surface.dataModel),
          apiModels: surface.apiModels?.map((m: any) => m.name) || [],
          updatedAt: surface.updatedAt,
        })
      }

      if (mode === 'data') {
        if (dataPath) {
          const { getByPointer } = await import('./dynamic-app-manager')
          const value = getByPointer(surface.dataModel, dataPath)
          return textResult({
            ok: true,
            surfaceId,
            path: dataPath,
            value,
            type: Array.isArray(value) ? `array(${value.length})` : typeof value,
          })
        }
        return textResult({
          ok: true,
          surfaceId,
          dataModel: surface.dataModel,
        })
      }

      if (mode === 'components') {
        return textResult({
          ok: true,
          surfaceId,
          componentCount: surface.components.size,
          components: componentList,
        })
      }

      // mode === 'full'
      return textResult({
        ok: true,
        surfaceId,
        title: surface.title,
        componentCount: surface.components.size,
        components: componentList,
        dataModel: surface.dataModel,
        apiModels: surface.apiModels || [],
        createdAt: surface.createdAt,
        updatedAt: surface.updatedAt,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Personality Self-Update Tool
// ---------------------------------------------------------------------------

const _personalitySessionCounts = new Map<string, number>()

/** @internal Test-only: reset the personality update session counters */
export function _resetPersonalitySessionCounts(): void {
  _personalitySessionCounts.clear()
}

function createPersonalityUpdateTool(ctx: ToolContext): AgentTool {
  const ALLOWED_FILES = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'] as const
  const MAX_UPDATES_PER_SESSION = 1
  const MAX_UPDATES_PER_DAY = 3

  return {
    name: 'personality_update',
    description:
      `Update your own personality/behavior markdown files to improve future interactions.
Use this when the user explicitly corrects your tone, style, or boundaries, or when
you discover a lasting preference. Do NOT use for one-off requests.

Allowed files: SOUL.md (personality, tone, boundaries), AGENTS.md (high-level instructions), IDENTITY.md (name, role).
Updates are section-level: specify the heading to update and its new content.
Rate-limited: max ${MAX_UPDATES_PER_SESSION}/session, ${MAX_UPDATES_PER_DAY}/day.`,
    label: 'Update Personality',
    parameters: Type.Object({
      file: Type.Union(ALLOWED_FILES.map(f => Type.Literal(f)), {
        description: 'Which personality file to update',
      }),
      section: Type.String({ description: 'Section heading to update (e.g. "Communication Style")' }),
      content: Type.String({ description: 'New markdown content for that section' }),
      reasoning: Type.String({ description: 'Why this update improves your behavior' }),
    }),
    execute: async (_toolCallId, params) => {
      const { file, section, content, reasoning } = params as {
        file: string
        section: string
        content: string
        reasoning: string
      }

      if (!ALLOWED_FILES.includes(file as typeof ALLOWED_FILES[number])) {
        return textResult({ ok: false, error: `File must be one of: ${ALLOWED_FILES.join(', ')}` })
      }

      if (!section || !content || !content.trim()) {
        return textResult({ ok: false, error: 'Both section and content are required' })
      }

      // Rate limiting
      const sessionKey = ctx.sessionId || 'default'
      const sessionCount = _personalitySessionCounts.get(sessionKey) || 0
      if (sessionCount >= MAX_UPDATES_PER_SESSION) {
        return textResult({
          ok: false,
          error: `Rate limit: max ${MAX_UPDATES_PER_SESSION} personality update(s) per session`,
        })
      }

      // Daily rate limit via changelog
      const today = new Date().toISOString().slice(0, 10)
      const memoryDir = join(ctx.workspaceDir, 'memory')
      const dailyLogPath = join(memoryDir, `${today}.md`)
      let dailyCount = 0
      if (existsSync(dailyLogPath)) {
        const dailyContent = readFileSync(dailyLogPath, 'utf-8')
        dailyCount = (dailyContent.match(/\[personality-update\]/g) || []).length
      }
      if (dailyCount >= MAX_UPDATES_PER_DAY) {
        return textResult({
          ok: false,
          error: `Rate limit: max ${MAX_UPDATES_PER_DAY} personality updates per day`,
        })
      }

      const filePath = join(ctx.workspaceDir, file)
      if (!existsSync(filePath)) {
        return textResult({ ok: false, error: `File not found: ${file}` })
      }

      const currentContent = readFileSync(filePath, 'utf-8')

      // Preserve Boundaries section — never allow removal
      if (file === 'SOUL.md') {
        const hasBoundaries = currentContent.toLowerCase().includes('## boundaries')
        const newHasBoundaries = content.toLowerCase().includes('boundaries') || section.toLowerCase() !== 'boundaries'
        if (hasBoundaries && section.toLowerCase() === 'boundaries' && !content.trim()) {
          return textResult({ ok: false, error: 'Cannot remove the Boundaries section from SOUL.md' })
        }
      }

      // Apply section-level update
      const sectionPattern = new RegExp(
        `(## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\n[\\s\\S]*?(?=\\n## |$)`,
        'i'
      )
      let updatedContent: string
      if (sectionPattern.test(currentContent)) {
        updatedContent = currentContent.replace(sectionPattern, `## ${section}\n${content}\n`)
      } else {
        updatedContent = currentContent.trimEnd() + `\n\n## ${section}\n${content}\n`
      }

      writeFileSync(filePath, updatedContent, 'utf-8')

      // Log to changelog in daily memory
      if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true })
      const timestamp = new Date().toISOString()
      const logEntry = `\n[personality-update] ${timestamp} | ${file} > ${section} | ${reasoning}\n`
      if (existsSync(dailyLogPath)) {
        const existing = readFileSync(dailyLogPath, 'utf-8')
        writeFileSync(dailyLogPath, existing + logEntry, 'utf-8')
      } else {
        writeFileSync(dailyLogPath, `# ${today}\n${logEntry}`, 'utf-8')
      }

      // Increment session counter
      _personalitySessionCounts.set(sessionKey, sessionCount + 1)

      return textResult({
        ok: true,
        file,
        section,
        reasoning,
        message: `Updated ${file} section "${section}". Logged to daily memory.`,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// MCP Discovery Tools
// ---------------------------------------------------------------------------

function createToolSearchTool(): AgentTool {
  return {
    name: 'tool_search',
    description: process.env.SHOGO_LOCAL_MODE === 'true'
      ? 'Search for available tools and integrations by capability or keyword. Searches the full MCP server catalog and managed OAuth integrations. Managed integrations are preferred when available.'
      : 'Search for available tools and integrations by capability or keyword. Searches the built-in catalog of preinstalled MCP servers and managed OAuth integrations (hundreds of services — no credentials needed). Managed integrations are preferred when available.',
    label: 'Search Tools',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query describing the capability you need (e.g. "google calendar", "slack messaging", "postgres database")' }),
      limit: Type.Optional(Type.Number({ description: 'Max results to return (default: 5)' })),
    }),
    execute: async (_id: string, params: any) => {
      const query = params.query as string
      const limit = Math.min(params.limit || 5, 10)

      const results: Array<Record<string, any>> = []
      const seenSlugs = new Set<string>()

      // 1. Search Composio toolkit catalog (dynamic, via API)
      if (isComposioEnabled()) {
        try {
          const composioToolkits = await searchComposioToolkits(query)
          for (const tk of composioToolkits.slice(0, limit)) {
            seenSlugs.add(tk.slug.toLowerCase().replace(/[-_\s]/g, ''))
            results.push({
              name: tk.name,
              id: tk.slug,
              description: `${tk.name} — managed OAuth integration via Composio. No API keys or credentials needed.`,
              installCommand: `tool_install({ name: "${tk.slug}" })`,
              source: 'managed',
              logo: tk.logo,
            })
          }
        } catch { /* Composio API unavailable, continue with other sources */ }
      }

      // 2. Search MCP catalog (all entries in local mode, preinstalled only in cloud)
      const searchableCatalog = process.env.SHOGO_LOCAL_MODE === 'true' ? MCP_CATALOG : getPreinstalledPackages()
      const queryLower = query.toLowerCase()
      const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)
      const scored: Array<{ entry: typeof MCP_CATALOG[0]; score: number }> = []
      for (const entry of searchableCatalog) {
        const haystack = `${entry.id} ${entry.name} ${entry.description} ${entry.category} ${entry.providedTools.join(' ')}`.toLowerCase()
        const idName = `${entry.id} ${entry.name}`.toLowerCase()
        let score = 0
        if (haystack.includes(queryLower)) score += 10
        if (idName.includes(queryLower)) score += 20
        for (const w of queryWords) {
          if (idName.includes(w)) score += 5
          else if (haystack.includes(w)) score += 1
        }
        if (score > 0) scored.push({ entry, score })
      }
      scored.sort((a, b) => b.score - a.score)
      for (const { entry } of scored.slice(0, limit)) {
        const entryNorm = entry.id.toLowerCase().replace(/[-_\s]/g, '')
        if (seenSlugs.has(entryNorm)) continue
        seenSlugs.add(entryNorm)
        results.push({
          name: entry.name,
          id: entry.id,
          description: entry.description,
          installCommand: `tool_install({ name: "${entry.id}" })`,
          source: 'catalog',
        })
      }

      if (results.length === 0) {
        return textResult({ query, results: [], message: 'No tools found. Try a different search term.' })
      }

      const managedCount = results.filter(r => r.source === 'managed').length
      let message = `Found ${results.length} result(s). Use tool_install to add one.`
      if (managedCount > 0) {
        message = `Found ${results.length} result(s). ${managedCount} are managed integrations (no credentials needed) — prefer these. Just call tool_install with the name.`
      }

      return textResult({ query, results, message })
    },
  }
}

function formatToolInstallMessage(
  toolkitName: string,
  toolCount: number,
  auth: { status: string; authUrl?: string },
): string {
  const base = `"${toolkitName}" installed with ${toolCount} tool(s).`
  if (auth.status !== 'needs_auth') {
    return `${base} Auth is active. No manual credentials needed.`
  }
  if (auth.authUrl) {
    return `${base} User needs to authorize — a Connect button is displayed in the chat for them to click. Do NOT include the auth URL in your response; the UI button handles the OAuth popup flow automatically. Tell the user to click the Connect button below.`
  }
  return `${base} Auth status: needs_auth. The user may need to authorize via the Tools panel.`
}

function createToolInstallTool(ctx: ToolContext): AgentTool {
  return {
    name: 'tool_install',
    description: process.env.SHOGO_LOCAL_MODE === 'true'
      ? `Install and start a tool integration, making its tools available immediately. Any MCP server from the catalog can be used: ${MCP_CATALOG.map(e => e.id).join(', ')}. For managed integrations (Google Calendar, Slack, GitHub, and hundreds more), just provide the name — no command or args needed.

Managed integrations auto-bind by default: the toolkit's CRUD operations are automatically discovered and deferred to bind to the next canvas you create. No extra parameters needed — just call tool_install({ name: "googlecalendar" }) and then canvas_create.

Pass "autoBind" with surfaceId/dataPath to target a specific canvas. Pass "bind" with explicit config if you already know the tool's response shape (e.g. from a saved skill).`
      : `Install and start a tool integration, making its tools available immediately. For managed integrations (Google Calendar, Slack, GitHub, and hundreds more), just provide the name — no command or args needed. For preinstalled MCP servers (fetch, github, postgres, slack, notion, brave-search, airbnb, filesystem), provide the server name.

Managed integrations auto-bind by default: the toolkit's CRUD operations are automatically discovered and deferred to bind to the next canvas you create. No extra parameters needed — just call tool_install({ name: "googlecalendar" }) and then canvas_create.

Pass "autoBind" with surfaceId/dataPath to target a specific canvas. Pass "bind" with explicit config if you already know the tool's response shape (e.g. from a saved skill).`,
    label: 'Install Tool',
    parameters: Type.Object({
      name: Type.String({ description: process.env.SHOGO_LOCAL_MODE === 'true' ? 'Tool or integration name (e.g. "googlecalendar", "slack", "postgres"). Any catalog MCP server or managed integration is supported.' : 'Tool or integration name (e.g. "googlecalendar", "slack", "postgres"). Only preinstalled MCP servers and managed integrations are supported.' }),
      env: Type.Optional(Type.Any({ description: 'Environment variables for the server process' })),
      autoBind: Type.Optional(Type.Object({
        surfaceId: Type.String({ description: 'Surface ID to bind to (deferred if surface does not exist yet)' }),
        dataPath: Type.Optional(Type.String({ description: 'JSON Pointer path to auto-load list data (e.g. "/events")' })),
      }, { description: 'Auto-discover the toolkit\'s CRUD operations and bind to canvas API routes. No prior knowledge needed — schemas are introspected from the Composio API.' })),
      bind: Type.Optional(Type.Object({
        surfaceId: Type.String({ description: 'Surface ID to bind to (deferred if surface does not exist yet)' }),
        model: Type.String({ description: 'Model name in PascalCase (e.g. "CalendarEvent")' }),
        fields: Type.Array(Type.Object({
          name: Type.String(),
          type: Type.Union([
            Type.Literal('String'), Type.Literal('Int'), Type.Literal('Float'),
            Type.Literal('Boolean'), Type.Literal('DateTime'), Type.Literal('Json'),
          ]),
        })),
        bindings: Type.Object({
          list: Type.Optional(Type.Object({
            tool: Type.String(),
            params: Type.Optional(Type.Any()),
            resultPath: Type.Optional(Type.String()),
          })),
          get: Type.Optional(Type.Object({ tool: Type.String(), params: Type.Optional(Type.Any()), paramMap: Type.Optional(Type.Any()) })),
          create: Type.Optional(Type.Object({ tool: Type.String(), params: Type.Optional(Type.Any()), paramMap: Type.Optional(Type.Any()) })),
          update: Type.Optional(Type.Object({ tool: Type.String(), params: Type.Optional(Type.Any()), paramMap: Type.Optional(Type.Any()) })),
          delete: Type.Optional(Type.Object({ tool: Type.String(), params: Type.Optional(Type.Any()), paramMap: Type.Optional(Type.Any()) })),
        }),
        cache: Type.Optional(Type.Object({
          enabled: Type.Boolean(),
          ttlSeconds: Type.Optional(Type.Number()),
        })),
        dataPath: Type.Optional(Type.String({ description: 'JSON Pointer path to auto-load list data (e.g. "/events")' })),
      }, { description: 'Optional: bind installed tools to canvas CRUD API routes. Combines tool_install + canvas_api_bind in one call.' })),
    }),
    execute: async (_id: string, params: any) => {
      const { name, env, bind, autoBind } = params as {
        name: string; env?: Record<string, string>
        bind?: any; autoBind?: { surfaceId: string; dataPath?: string }
      }

      if (!ctx.mcpClientManager) {
        return textResult({ error: 'MCP client manager not available' })
      }

      const applyBind = (installResult: Record<string, unknown>) => {
        if (!bind || !ctx.mcpClientManager) return installResult
        const manager = getDynamicAppManager()
        const bindConfig = {
          model: bind.model,
          fields: bind.fields,
          bindings: bind.bindings,
          cache: bind.cache,
          dataPath: bind.dataPath,
        }
        if (manager.getSurface(bind.surfaceId)) {
          const bindResult = manager.bindToolApi(bind.surfaceId, bindConfig, ctx.mcpClientManager)
          return { ...installResult, bind: bindResult }
        }
        manager.deferToolBinding(bind.surfaceId, bindConfig, ctx.mcpClientManager)
        return { ...installResult, bind: { ok: true, deferred: true, surfaceId: bind.surfaceId, message: `Binding deferred — will apply when surface "${bind.surfaceId}" is created.` } }
      }

      const applyAutoBind = async (installResult: Record<string, unknown>, toolkitSlug: string, isComposio: boolean) => {
        if (!ctx.mcpClientManager) return installResult
        if (!autoBind && !isComposio) return installResult
        try {
          const result = await autoBindPrimaryEntity(toolkitSlug, {
            dataPath: autoBind?.dataPath,
            mcpClient: ctx.mcpClientManager,
          })
          if (!result) {
            return { ...installResult, autoBind: { ok: false, message: `Auto-bind: no bindable entities found for "${toolkitSlug}". Use canvas_api_bind manually after exploring the tools.` } }
          }
          const manager = getDynamicAppManager()
          const surfaceId = autoBind?.surfaceId
          if (surfaceId && manager.getSurface(surfaceId)) {
            const bindResult = manager.bindToolApi(surfaceId, result.config, ctx.mcpClientManager)
            return { ...installResult, autoBind: { ok: true, entity: result.entity, config: result.config, discoveredFrom: result.discoveredFrom, tools: result.tools, ...bindResult } }
          }
          manager.deferToolBinding(surfaceId || '*', result.config, ctx.mcpClientManager)
          return {
            ...installResult,
            autoBind: {
              ok: true, deferred: true,
              surfaceId: surfaceId || '(next canvas)',
              entity: result.entity, config: result.config, discoveredFrom: result.discoveredFrom, tools: result.tools,
              message: surfaceId
                ? `Auto-bind deferred — "${result.entity}" will bind when surface "${surfaceId}" is created.`
                : `Auto-bind ready — "${result.entity}" CRUD binding will apply automatically to the next canvas you create.`,
            },
          }
        } catch (err: any) {
          return { ...installResult, autoBind: { ok: false, error: err.message, message: `Auto-bind failed: ${err.message}. Use canvas_api_bind manually.` } }
        }
      }

      // Check if Composio session is already initialized
      if (isComposioInitialized() && isComposioEnabled()) {
        const composioToolkit = await findComposioToolkit(name)
        if (composioToolkit) {
          const proxy = await registerToolkitProxyTools(ctx.mcpClientManager, composioToolkit.slug)
          const auth = await checkComposioAuth(composioToolkit.slug)
          let result = applyBind({
            ok: true,
            server: 'composio',
            integration: composioToolkit.slug,
            toolCount: proxy.toolCount,
            tools: proxy.toolNames,
            authStatus: auth.status,
            ...(auth.authUrl ? { authUrl: auth.authUrl } : {}),
            message: formatToolInstallMessage(composioToolkit.name, proxy.toolCount, auth),
          })
          result = await applyAutoBind(result, composioToolkit.slug, true)
          return textResult(result)
        }
      }

      if (ctx.mcpClientManager.isRunning(name)) {
        const info = ctx.mcpClientManager.getServerInfo().find(s => s.name === name)
        return textResult({ error: `Server "${name}" is already running with ${info?.toolCount || 0} tools`, tools: info?.toolNames })
      }

      // Dynamically check if this matches a Composio toolkit
      if (isComposioEnabled()) {
        const composioToolkit = await findComposioToolkit(name)
        if (composioToolkit) {
          try {
            const userId = process.env.USER_ID || 'default'
            const initialized = await initComposioSession(userId, ctx.projectId)
            if (initialized) {
              const proxy = await registerToolkitProxyTools(ctx.mcpClientManager, composioToolkit.slug)
              const auth = await checkComposioAuth(composioToolkit.slug)
              let result = applyBind({
                ok: true,
                server: 'composio',
                integration: composioToolkit.slug,
                toolCount: proxy.toolCount,
                tools: proxy.toolNames,
                authStatus: auth.status,
                ...(auth.authUrl ? { authUrl: auth.authUrl } : {}),
                message: formatToolInstallMessage(composioToolkit.name, proxy.toolCount, auth),
              })
              result = await applyAutoBind(result, composioToolkit.slug, true)
              return textResult(result)
            }
            return textResult({ error: `Failed to connect "${composioToolkit.name}" via Composio. The integration may not be available.` })
          } catch (err: any) {
            return textResult({ error: `Composio connection failed for "${name}": ${err.message}` })
          }
        }
      }

      const catalogEntry = MCP_CATALOG.find(e => e.id === name)
      if (!isMcpServerAllowed(name) || !catalogEntry) {
        const allowed = getPreinstalledPackages().map(e => e.id).join(', ')
        return textResult({ error: `"${name}" is not available. Only preinstalled MCP servers are supported: ${allowed}` })
      }

      try {
        const tools = await ctx.mcpClientManager.hotAddServer(name, {
          command: 'npx',
          args: [catalogEntry.package, ...catalogEntry.defaultArgs],
          env,
        })
        return textResult(applyBind({
          ok: true,
          server: name,
          toolCount: tools.length,
          tools: tools.map(t => ({ name: t.name, description: t.description })),
          message: `Installed "${name}" with ${tools.length} tool(s). They are now available for use.`,
        }))
      } catch (err: any) {
        return textResult({ error: `Failed to install "${name}": ${err.message}` })
      }
    },
  }
}

function createToolUninstallTool(ctx: ToolContext): AgentTool {
  return {
    name: 'tool_uninstall',
    description: 'Stop and remove an installed tool. Its tools will no longer be available.',
    label: 'Uninstall Tool',
    parameters: Type.Object({
      name: Type.String({ description: 'Tool name to remove (use tool_search to find names)' }),
    }),
    execute: async (_id: string, params: any) => {
      const name = params.name as string

      if (!ctx.mcpClientManager) {
        return textResult({ error: 'MCP client manager not available' })
      }

      if (!ctx.mcpClientManager.isRunning(name)) {
        return textResult({ error: `Server "${name}" is not running`, installed: ctx.mcpClientManager.getServerNames() })
      }

      try {
        await ctx.mcpClientManager.hotRemoveServer(name)
        return textResult({ ok: true, removed: name, message: `Removed "${name}" and all its tools.` })
      } catch (err: any) {
        return textResult({ error: `Failed to remove "${name}": ${err.message}` })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Tool Group Mapping
// ---------------------------------------------------------------------------

/**
 * Maps group names (used in skill frontmatter) to individual gateway tool names.
 * Skills can reference either group names or individual tool names.
 */
export const TOOL_GROUP_MAP: Record<string, string[]> = {
  shell: ['exec'],
  filesystem: ['read_file', 'write_file'],
  files: ['list_files', 'delete_file', 'search_files', 'read_file', 'write_file'],
  web: ['web'],
  web_fetch: ['web'],
  web_search: ['web'],
  browser: [
    'browser', 'web',
    'mcp_playwright_browser_navigate', 'mcp_playwright_browser_snapshot',
    'mcp_playwright_browser_click', 'mcp_playwright_browser_type',
    'mcp_playwright_browser_screenshot', 'mcp_playwright_browser_close',
  ],
  memory: ['memory_read', 'memory_write', 'memory_search'],
  messaging: ['send_message', 'channel_connect', 'channel_disconnect', 'channel_list'],
  cron: ['cron'],
  canvas: ['canvas_create', 'canvas_update', 'canvas_data', 'canvas_data_patch', 'canvas_delete', 'canvas_action_wait', 'canvas_components', 'canvas_trigger_action', 'canvas_inspect'],
  api: ['canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_api_hooks', 'canvas_api_bind'],
  personality: ['personality_update'],
  tool_discovery: ['tool_search', 'tool_install', 'tool_uninstall'],
  mcp_discovery: ['tool_search', 'tool_install', 'tool_uninstall'],
}

export const ALL_TOOL_NAMES = [
  'exec', 'read_file', 'write_file', 'web', 'browser',
  'list_files', 'delete_file', 'search_files',
  'memory_read', 'memory_write', 'memory_search', 'send_message', 'channel_connect', 'channel_disconnect', 'channel_list', 'cron',
  'canvas_create', 'canvas_update', 'canvas_data', 'canvas_data_patch', 'canvas_delete', 'canvas_action_wait', 'canvas_components',
  'canvas_trigger_action', 'canvas_inspect',
  'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_api_hooks', 'canvas_api_bind',
  'personality_update',
  'tool_search', 'tool_install', 'tool_uninstall',
] as const

/**
 * Resolve a list of tool references (group names or individual names)
 * to a deduplicated list of individual gateway tool names.
 */
export function resolveToolNames(refs: string[]): string[] {
  const resolved = new Set<string>()
  for (const ref of refs) {
    const group = TOOL_GROUP_MAP[ref]
    if (group) {
      for (const name of group) resolved.add(name)
    } else if ((ALL_TOOL_NAMES as readonly string[]).includes(ref)) {
      resolved.add(ref)
    } else if (ref.startsWith('mcp_')) {
      resolved.add(ref)
    }
  }
  return [...resolved]
}

// ---------------------------------------------------------------------------
// File Management Tools (files/ directory with RAG search)
// ---------------------------------------------------------------------------

function getOrCreateFileIndex(ctx: ToolContext): FileIndexEngine {
  if (!ctx.fileIndexEngine) {
    ctx.fileIndexEngine = new FileIndexEngine(ctx.workspaceDir)
  }
  return ctx.fileIndexEngine
}

function createListFilesTool(ctx: ToolContext): AgentTool {
  return {
    name: 'list_files',
    description:
      'List files and directories in the workspace files/ directory. ' +
      'Supports recursive listing and returns file metadata.',
    label: 'List Files',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Subdirectory path within files/ (default: root)' })),
      recursive: Type.Optional(Type.Boolean({ description: 'List recursively (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: subPath = '', recursive = false } = params as { path?: string; recursive?: boolean }
      const filesDir = join(ctx.workspaceDir, 'files')
      mkdirSync(filesDir, { recursive: true })

      const targetDir = subPath ? join(filesDir, subPath) : filesDir
      const resolved = resolve(targetDir)
      if (!resolved.startsWith(resolve(filesDir))) {
        return textResult({ error: 'Path outside files directory' })
      }
      if (!existsSync(resolved)) {
        return textResult({ error: `Directory not found: ${subPath || '/'}` })
      }

      const entries = listDirEntries(resolved, resolve(filesDir), recursive)
      return textResult({ path: subPath || '/', entries, count: entries.length })
    },
  }
}

function listDirEntries(dir: string, rootDir: string, recursive: boolean): any[] {
  const results: any[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const absPath = join(dir, entry.name)
    const relPath = absPath.slice(rootDir.length + 1)
    const stat = statSync(absPath)

    if (entry.isDirectory()) {
      results.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        modified: stat.mtimeMs,
      })
      if (recursive) {
        results.push(...listDirEntries(absPath, rootDir, true))
      }
    } else {
      results.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        size: stat.size,
        modified: stat.mtimeMs,
      })
    }
  }
  return results
}

function createDeleteFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'delete_file',
    description: 'Delete a file from the workspace files/ directory.',
    label: 'Delete File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to files/' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath } = params as { path: string }
      const filesDir = join(ctx.workspaceDir, 'files')
      const resolved = resolve(filesDir, filePath)

      if (!resolved.startsWith(resolve(filesDir))) {
        return textResult({ error: 'Path outside files directory' })
      }
      if (!existsSync(resolved)) {
        return textResult({ error: `File not found: ${filePath}` })
      }

      unlinkSync(resolved)
      return textResult({ ok: true, deleted: filePath })
    },
  }
}

function createSearchFilesTool(ctx: ToolContext): AgentTool {
  return {
    name: 'search_files',
    description:
      'Search across all indexed files in files/ using hybrid keyword + semantic search. ' +
      'Supports .txt, .csv, and .md files. Returns relevant text chunks ranked by relevance.',
    label: 'Search Files',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query (natural language or keywords)' }),
      limit: Type.Optional(Type.Number({ description: 'Max results (default: 10)' })),
      path_filter: Type.Optional(Type.String({ description: 'Filter to files matching this substring' })),
    }),
    execute: async (_toolCallId, params) => {
      const { query, limit = 10, path_filter } = params as {
        query: string; limit?: number; path_filter?: string
      }
      const engine = getOrCreateFileIndex(ctx)
      const results = await engine.search(query, limit, path_filter)
      return textResult({
        query,
        results: results.map(r => ({
          path: r.path,
          chunk: r.chunk,
          score: Math.round(r.score * 1000) / 1000,
          lines: `${r.lineStart}-${r.lineEnd}`,
          matchType: r.matchType,
        })),
        count: results.length,
        stats: engine.getStats(),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Channel Connect Tool
// ---------------------------------------------------------------------------

function createChannelConnectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'channel_connect',
    description:
      'Connect a messaging channel (telegram, discord, email, slack, whatsapp, webhook, teams, or webchat). ' +
      'Saves the config and hot-connects the channel immediately. ' +
      'For webchat: creates an embeddable chat widget for any website — no external accounts needed.',
    label: 'Connect Channel',
    parameters: Type.Object({
      type: Type.String({
        description: 'Channel type: telegram, discord, email, slack, whatsapp, webhook, teams, or webchat',
      }),
      config: Type.Record(Type.String(), Type.String(), {
        description:
          'Channel configuration. For webhook: { secret?: "shared-secret" }. ' +
          'For telegram: { botToken: "..." }. For discord: { botToken: "...", guildId: "..." }. ' +
          'For email: { imapHost, smtpHost, username, password }. ' +
          'For slack: { botToken: "xoxb-...", appToken: "xapp-..." }. ' +
          'For whatsapp: { accessToken, phoneNumberId, verifyToken }. ' +
          'For teams: { appId, appPassword, botName? }. ' +
          'For webchat: { title?, subtitle?, primaryColor?, position?, welcomeMessage?, avatarUrl?, allowedOrigins? } — all fields optional.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { type, config: channelConfig } = params as {
        type: string
        config: Record<string, string>
      }

      const validTypes = ['telegram', 'discord', 'email', 'slack', 'whatsapp', 'webhook', 'teams', 'webchat']
      if (!validTypes.includes(type)) {
        return textResult({ error: `Invalid channel type: ${type}. Must be one of: ${validTypes.join(', ')}` })
      }

      try {
        const { existsSync, readFileSync, writeFileSync } = await import('fs')
        const { join } = await import('path')
        const configPath = join(ctx.workspaceDir, 'config.json')
        let savedConfig: Record<string, any> = {}
        if (existsSync(configPath)) {
          savedConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
        }
        savedConfig.channels = savedConfig.channels || []
        const existing = savedConfig.channels.findIndex((c: any) => c.type === type)
        if (existing >= 0) {
          savedConfig.channels[existing] = { type, config: channelConfig }
        } else {
          savedConfig.channels.push({ type, config: channelConfig })
        }
        writeFileSync(configPath, JSON.stringify(savedConfig, null, 2), 'utf-8')
      } catch (err: any) {
        return textResult({ error: `Failed to save config: ${err.message}` })
      }

      if (ctx.connectChannel) {
        try {
          await ctx.connectChannel(type, channelConfig)

          if (type === 'webchat') {
            const port = process.env.PORT || '8080'
            const widgetUrl = `http://localhost:${port}/agent/channels/webchat/widget.js`
            return textResult({
              ok: true,
              message: [
                'WebChat channel connected and live!',
                '',
                'Tell the user to add this single script tag before the closing </body> tag on their website:',
                '',
                `<script src="${widgetUrl}"></script>`,
                '',
                'A chat bubble will appear on their page. Visitors can click it to chat with the agent. No other setup needed.',
                'The user can also find the embed snippet in the Channels panel.',
              ].join('\n'),
              embedSnippet: `<script src="${widgetUrl}"></script>`,
            })
          }

          return textResult({
            ok: true,
            message: `${type} channel connected and live. ` +
              (type === 'webhook'
                ? 'External services can now POST to /agent/channels/webhook/incoming'
                : `The ${type} adapter is now receiving messages.`),
          })
        } catch (err: any) {
          return textResult({
            ok: true,
            message: `${type} channel saved to config but failed to hot-connect: ${err.message}. Restart the agent to connect.`,
          })
        }
      }

      return textResult({
        ok: true,
        message: `${type} channel configured. Restart the agent to connect.`,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/** All gateway tools (full set for channel messages) */
export function createAllTools(ctx: ToolContext): AgentTool[] {
  return [
    createExecTool(ctx),
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createListFilesTool(ctx),
    createDeleteFileTool(ctx),
    createSearchFilesTool(ctx),
    createWebTool(),
    createBrowserTool(ctx),
    createMemoryReadTool(ctx),
    createMemoryWriteTool(ctx),
    createMemorySearchTool(ctx),
    createSendMessageTool(ctx),
    createChannelConnectTool(ctx),
    createChannelDisconnectTool(ctx),
    createChannelListTool(ctx),
    createCronTool(ctx),
    createCanvasCreateTool(),
    createCanvasUpdateTool(),
    createCanvasDataTool(),
    createCanvasDataPatchTool(),
    createCanvasDeleteTool(),
    createCanvasActionWaitTool(),
    createCanvasComponentsTool(),
    createCanvasApiSchemaTool(),
    createCanvasApiSeedTool(),
    createCanvasApiQueryTool(),
    createCanvasApiHooksTool(),
    createCanvasApiBindTool(ctx),
    createCanvasTriggerActionTool(),
    createCanvasInspectTool(),
    createPersonalityUpdateTool(ctx),
    createToolSearchTool(),
    createToolInstallTool(ctx),
    createToolUninstallTool(ctx),
  ]
}

/** Basic agent tools — full non-canvas set + display-only canvas (no mutation tools) */
export function createBasicTools(ctx: ToolContext): AgentTool[] {
  return [
    createExecTool(ctx),
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createListFilesTool(ctx),
    createDeleteFileTool(ctx),
    createSearchFilesTool(ctx),
    createWebTool(),
    createBrowserTool(ctx),
    createMemoryReadTool(ctx),
    createMemoryWriteTool(ctx),
    createMemorySearchTool(ctx),
    createSendMessageTool(ctx),
    createChannelConnectTool(ctx),
    createCronTool(ctx),
    createCanvasCreateTool(),
    createCanvasUpdateTool(),
    createCanvasDataTool(),
    createCanvasDeleteTool(),
    createCanvasComponentsTool({ basic: true }),
    createCanvasApiSchemaTool(),
    createCanvasApiSeedTool(),
    createCanvasApiQueryTool(),
    createCanvasApiBindTool(ctx),
    createCanvasInspectTool(),
    createPersonalityUpdateTool(ctx),
    createToolSearchTool(),
    createToolInstallTool(ctx),
    createToolUninstallTool(ctx),
  ]
}

/** Reduced tool set for heartbeat ticks (no exec, no send_message) */
export function createHeartbeatTools(ctx: ToolContext): AgentTool[] {
  return [
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createWebTool(),
    createBrowserTool(ctx),
    createMemoryReadTool(ctx),
    createMemoryWriteTool(ctx),
    createMemorySearchTool(ctx),
    createCronTool(ctx),
  ]
}
