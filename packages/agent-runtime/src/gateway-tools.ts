/**
 * Gateway Tools
 *
 * Tool definitions available to the live gateway agent during agent turns.
 * Uses Pi Agent Core's AgentTool format with TypeBox parameter schemas.
 *
 * Tools are created via createGatewayTools(ctx) which closes over the
 * ToolContext, since Pi's execute() signature doesn't accept external context.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { execSync } from 'child_process'
import { Type, type Static } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { sandboxExec } from './sandbox-exec'
import { MemorySearchEngine } from './memory-search'
import { getDynamicAppManager } from './dynamic-app-manager'
import {
  CANVAS_COMPONENT_SCHEMA,
  VALID_COMPONENT_TYPES,
  getComponentSchema,
  lintComponents,
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
}

const BLOCKED_COMMANDS = [
  'rm -rf /',
  'shutdown',
  'reboot',
  'mkfs',
  'dd if=',
  'chmod 777',
  'curl.*|.*bash',
  'wget.*|.*bash',
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
  if (!resolved.startsWith(workspaceDir) && !resolved.startsWith('/tmp')) {
    throw new Error(`Path outside workspace: ${filePath}`)
  }
  return resolved
}

function textResult(data: any): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
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

function createWebFetchTool(): AgentTool {
  return {
    name: 'web_fetch',
    description: 'Fetch content from a URL and return it as text. Useful for checking APIs, web pages, or downloading data.',
    label: 'Web Fetch',
    parameters: Type.Object({
      url: Type.String({ description: 'URL to fetch' }),
      maxChars: Type.Optional(Type.Number({ description: 'Maximum characters to return (default: 50000)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { url, maxChars = 50000 } = params as { url: string; maxChars?: number }

      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Shogo-Agent/1.0' },
          signal: AbortSignal.timeout(15000),
        })

        if (!response.ok) {
          return textResult({ error: `HTTP ${response.status}: ${response.statusText}`, url })
        }

        let text = await response.text()
        if (text.length > maxChars) {
          text = text.substring(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`
        }

        return textResult({ content: text, status: response.status, bytes: text.length, url })
      } catch (err: any) {
        return textResult({ error: err.message, url })
      }
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
      browser = await pw.chromium.launch({ headless: true })
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
      'Control a headless browser. Actions: navigate (go to URL), click (CSS selector), fill (type into input), text (extract page text), screenshot (capture page), evaluate (run JS), close.',
    label: 'Browser',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('navigate'),
        Type.Literal('click'),
        Type.Literal('fill'),
        Type.Literal('text'),
        Type.Literal('screenshot'),
        Type.Literal('evaluate'),
        Type.Literal('close'),
      ], { description: 'Browser action to perform' }),
      url: Type.Optional(Type.String({ description: 'URL to navigate to (for navigate action)' })),
      selector: Type.Optional(Type.String({ description: 'CSS selector (for click/fill actions)' })),
      value: Type.Optional(Type.String({ description: 'Text to type (for fill action) or JS to evaluate' })),
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
Data: Table, Metric, Chart, DataList
Interactive: Button, TextField, Select, Checkbox, ChoicePicker

Each component has: id, component (type), and type-specific props.
Use "children" (array of IDs) or "child" (single ID) for nesting.
Use { "path": "/some/pointer" } for dynamic data binding to the surface data model.

Example components:
- { "id": "root", "component": "Column", "children": ["header", "content"], "gap": "md" }
- { "id": "header", "component": "Text", "text": "Flight Results", "variant": "h2" }
- { "id": "content", "component": "Card", "child": "card_body", "title": "Option 1" }
- { "id": "price", "component": "Text", "text": { "path": "/flights/0/price" } }
- { "id": "book_btn", "component": "Button", "label": "Book Now", "action": { "name": "book", "context": { "flightId": "FL123" } } }`,
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
    }),
    execute: async (_toolCallId, params) => {
      const { surfaceId, components } = params as { surfaceId: string; components: any[] }

      const lint = lintComponents(components)
      const errors = lint.filter((m) => m.severity === 'error')
      const warnings = lint.filter((m) => m.severity === 'warning')

      if (errors.length > 0) {
        return textResult({
          ok: false,
          error: 'Component validation failed. Fix the errors below and retry.',
          errors: errors.map((e) => `[${e.componentId}] ${e.message}`),
          warnings: warnings.map((w) => `[${w.componentId}] ${w.message}`),
          hint: 'Use canvas_components with action "detail" to look up valid props for any component type.',
        })
      }

      const manager = getDynamicAppManager()
      const result = manager.updateComponents(surfaceId, components)

      if (warnings.length > 0) {
        return textResult({
          ...result,
          warnings: warnings.map((w) => `[${w.componentId}] ${w.message}`),
        })
      }
      return textResult(result)
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
      return textResult(manager.updateData(surfaceId, path, value))
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
      'Wait for the user to interact with a canvas component (e.g. clicking a Button). Returns the action event including any context data. Times out after 2 minutes if no action occurs.',
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

function createCanvasComponentsTool(): AgentTool {
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
        const schema = getComponentSchema(type)
        if (!schema) {
          const validTypes = [...VALID_COMPONENT_TYPES].join(', ')
          return textResult({ error: `Unknown component type "${type}". Valid types: ${validTypes}` })
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
        const matches = CANVAS_COMPONENT_SCHEMA.filter((s) =>
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
      let schemas = CANVAS_COMPONENT_SCHEMA
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
// Tool Group Mapping
// ---------------------------------------------------------------------------

/**
 * Maps group names (used in skill frontmatter) to individual gateway tool names.
 * Skills can reference either group names or individual tool names.
 */
export const TOOL_GROUP_MAP: Record<string, string[]> = {
  shell: ['exec'],
  filesystem: ['read_file', 'write_file'],
  web_fetch: ['web_fetch'],
  web_search: ['web_fetch'],
  browser: [
    'browser',
    'mcp_playwright_browser_navigate', 'mcp_playwright_browser_snapshot',
    'mcp_playwright_browser_click', 'mcp_playwright_browser_type',
    'mcp_playwright_browser_screenshot', 'mcp_playwright_browser_close',
  ],
  memory: ['memory_read', 'memory_write', 'memory_search'],
  messaging: ['send_message'],
  cron: ['cron'],
  canvas: ['canvas_create', 'canvas_update', 'canvas_data', 'canvas_delete', 'canvas_action_wait', 'canvas_components'],
}

export const ALL_TOOL_NAMES = [
  'exec', 'read_file', 'write_file', 'web_fetch', 'browser',
  'memory_read', 'memory_write', 'memory_search', 'send_message', 'cron',
  'canvas_create', 'canvas_update', 'canvas_data', 'canvas_delete', 'canvas_action_wait', 'canvas_components',
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
// Factory Functions
// ---------------------------------------------------------------------------

/** All gateway tools (full set for channel messages) */
export function createAllTools(ctx: ToolContext): AgentTool[] {
  return [
    createExecTool(ctx),
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createWebFetchTool(),
    createBrowserTool(ctx),
    createMemoryReadTool(ctx),
    createMemoryWriteTool(ctx),
    createMemorySearchTool(ctx),
    createSendMessageTool(ctx),
    createCronTool(ctx),
    createCanvasCreateTool(),
    createCanvasUpdateTool(),
    createCanvasDataTool(),
    createCanvasDeleteTool(),
    createCanvasActionWaitTool(),
    createCanvasComponentsTool(),
  ]
}

/** Reduced tool set for heartbeat ticks (no exec, no send_message) */
export function createHeartbeatTools(ctx: ToolContext): AgentTool[] {
  return [
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createWebFetchTool(),
    createBrowserTool(ctx),
    createMemoryReadTool(ctx),
    createMemoryWriteTool(ctx),
    createMemorySearchTool(ctx),
    createCronTool(ctx),
  ]
}
