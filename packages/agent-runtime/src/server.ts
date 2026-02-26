/**
 * Agent Runtime Server
 *
 * Runs inside each agent's Knative pod, providing:
 * - Claude Code agent with agent-building MCP tools
 * - Agent Gateway process (heartbeat, channels, skills)
 * - Health check endpoint for Kubernetes probes
 * - S3 file synchronization for persistent storage
 *
 * This mirrors project-runtime but replaces the Vite dev server
 * with an Agent Gateway that makes the configured agent "alive."
 */

// =============================================================================
// OpenTelemetry - Initialize before anything else
// =============================================================================
import { initInstrumentation, traceOperation, createLogger } from '@shogo/shared-runtime'
initInstrumentation({ serviceName: 'shogo-agent-runtime' })

const log = createLogger('agent-runtime', {
  projectId: process.env.PROJECT_ID,
  poolMode: process.env.WARM_POOL_MODE === 'true' || process.env.PROJECT_ID === '__POOL__',
})

const SERVER_START_TIME = Date.now()
const ENTRYPOINT_START_TIME = process.env.STARTUP_TIME
  ? parseInt(process.env.STARTUP_TIME, 10)
  : SERVER_START_TIME

function logTiming(message: string): void {
  const now = Date.now()
  const fromEntrypoint = ENTRYPOINT_START_TIME ? now - ENTRYPOINT_START_TIME : 0
  const fromServer = now - SERVER_START_TIME
  console.log(
    `[agent-runtime] [+${fromEntrypoint}ms total, +${fromServer}ms server] ${message}`
  )
}

logTiming('Server module loading...')

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { resolve, dirname, join } from 'path'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'fs'
import {
  initializeS3Sync,
  initializePostgresBackup,
  configureAIProxy,
} from '@shogo/shared-runtime'
import { buildAgentSystemPrompt } from './system-prompt'
import { seedWorkspaceDefaults } from './workspace-defaults'
import { AgentGateway } from './gateway'
import { userMessage } from './pi-adapter'
import { getDynamicAppManager, initDynamicAppManager } from './dynamic-app-manager'
import type { ActionEvent } from './dynamic-app-types'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MONOREPO_ROOT = resolve(__dirname, '../../..')

// =============================================================================
// Configuration
// =============================================================================

logTiming('Loading configuration...')

const POOL_PROJECT_ID = '__POOL__'
let currentProjectId = process.env.PROJECT_ID
const AGENT_DIR = process.env.AGENT_DIR || process.env.PROJECT_DIR || '/app/agent'
const SCHEMAS_PATH = process.env.SCHEMAS_PATH || '/app/.schemas'
const MCP_SERVER_PATH =
  process.env.MCP_SERVER_PATH ||
  resolve(MONOREPO_ROOT, 'packages/agent-runtime/src/tools/mcp-server.ts')
const PORT = parseInt(process.env.PORT || '8080', 10)

const IS_POOL_MODE = currentProjectId === POOL_PROJECT_ID || process.env.WARM_POOL_MODE === 'true'
let poolAssigned = false

if (!currentProjectId) {
  console.error(
    '[agent-runtime] ERROR: PROJECT_ID environment variable is required'
  )
  process.exit(1)
}

if (IS_POOL_MODE) {
  logTiming('Starting in WARM POOL mode (awaiting project assignment)')
} else {
  logTiming(`Configuration loaded for agent: ${currentProjectId}`)
}
console.log(`[agent-runtime] Agent directory: ${AGENT_DIR}`)

// =============================================================================
// Agent Workspace Bootstrap
// =============================================================================

function ensureWorkspaceFiles(): void {
  seedWorkspaceDefaults(AGENT_DIR)
  logTiming('Workspace defaults seeded')
}

// =============================================================================
// AI Proxy Configuration
// =============================================================================

// configureAIProxy() throws when AI_PROXY_URL is set but no token is available,
// preventing silent fallback to a raw platform ANTHROPIC_API_KEY.
// In pool mode, the token isn't available yet — it's injected via /pool/assign.
let aiProxy: ReturnType<typeof configureAIProxy>
if (IS_POOL_MODE) {
  aiProxy = { useProxy: false, env: {} }
  logTiming('Pool mode: deferring AI proxy configuration until assignment')
} else {
  try {
    aiProxy = configureAIProxy({ logPrefix: 'agent-runtime' })
  } catch (err: any) {
    console.error(`[agent-runtime] FATAL: ${err.message}`)
    process.exit(1)
  }
}
if (aiProxy.useProxy) {
  Object.assign(process.env, aiProxy.env)
}

// =============================================================================
// Write CLAUDE.md for Claude Code to load
// =============================================================================

function verifyMcpServerPath(): boolean {
  if (!existsSync(MCP_SERVER_PATH)) {
    console.error(`[agent-runtime] WARNING: MCP server not found at ${MCP_SERVER_PATH}`)
    return false
  }
  return true
}

function writeAgentConfigFiles(): void {
  const claudeMdPath = resolve(AGENT_DIR, 'CLAUDE.md')
  const systemPromptContent = buildAgentSystemPrompt(AGENT_DIR)
  writeFileSync(claudeMdPath, systemPromptContent, 'utf-8')
  logTiming('Wrote CLAUDE.md')

  const mcpServerValid = verifyMcpServerPath()
  if (!mcpServerValid) {
    logTiming('WARNING: MCP server path invalid — builder will use Write/Edit fallback')
  }

  const mcpConfig = {
    mcpServers: {
      shogo: {
        command: 'bun',
        args: ['run', MCP_SERVER_PATH],
        env: {
          PROJECT_ID: currentProjectId!,
          AGENT_DIR,
          MCP_CONTEXT: 'agent',
        },
      },
    },
  }
  const mcpJsonPath = resolve(AGENT_DIR, '.mcp.json')
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf-8')
  logTiming('Wrote .mcp.json')
}

// =============================================================================
// Agent Gateway Instance
// =============================================================================

let agentGateway: AgentGateway | null = null
let s3SyncInstance: import('@shogo/shared-runtime').S3Sync | null = null

// =============================================================================
// Stream Keep-Alive Utility
// =============================================================================

function wrapStreamWithKeepalive(
  stream: ReadableStream<Uint8Array>,
  intervalMs: number = 15_000
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const keepAliveMsg = encoder.encode(': keep-alive\n\n')
  let timer: ReturnType<typeof setInterval> | null = null
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  const reader = stream.getReader()

  function cleanup() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return new ReadableStream({
    start(c) {
      ctrl = c
      timer = setInterval(() => {
        if (closed || !ctrl) { cleanup(); return }
        try { ctrl.enqueue(keepAliveMsg) } catch { closed = true; cleanup() }
      }, intervalMs)
    },
    async pull(c) {
      try {
        const { done, value } = await reader.read()
        if (done) { closed = true; cleanup(); c.close(); return }
        c.enqueue(value)
      } catch (err) {
        closed = true; cleanup(); c.error(err)
      }
    },
    cancel() { closed = true; cleanup(); reader.cancel() },
  })
}

// =============================================================================
// Hono Server
// =============================================================================

const app = new Hono()

app.use('*', cors({ origin: '*' }))

// Register WhatsApp webhook routes (must be before any auth middleware)
import('./channels/whatsapp').then(({ WhatsAppAdapter }) => {
  WhatsAppAdapter.registerWebhookRoutes(app)
}).catch(() => { /* WhatsApp adapter not available */ })

// Register Webhook/HTTP channel routes
import('./channels/webhook').then(({ WebhookAdapter }) => {
  WebhookAdapter.registerRoutes(app, () => {
    if (!agentGateway) return null
    const adapter = agentGateway.getChannel('webhook')
    return adapter && adapter.getStatus().connected ? adapter as any : null
  })
}).catch(() => { /* Webhook adapter not available */ })

// Hot-connect a channel at runtime (called by MCP tool after writing config.json)
app.post('/agent/channels/connect', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const body = await c.req.json()
  const { type, config: channelConfig } = body as { type: string; config: Record<string, string> }

  if (!type) {
    return c.json({ error: 'Missing required field: type' }, 400)
  }

  try {
    await agentGateway.connectChannel(type, channelConfig || {})
    return c.json({ ok: true, message: `${type} channel connected` })
  } catch (err: any) {
    console.error(`[agent-runtime] Hot-connect ${type} failed:`, err.message)
    return c.json({ error: `Failed to connect ${type}: ${err.message}` }, 500)
  }
})

// Health check
app.get('/health', (c) =>
  c.json({
    status: 'ok',
    projectId: currentProjectId,
    runtimeType: 'agent',
    poolMode: IS_POOL_MODE && !poolAssigned,
    uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
    gateway: agentGateway?.getStatus() ?? null,
  })
)

// Readiness probe
app.get('/ready', (c) => {
  return c.json({ ready: true })
})

// =============================================================================
// Warm Pool Assignment Endpoint
// =============================================================================

app.post('/pool/assign', async (c) => {
  if (!IS_POOL_MODE) {
    return c.json({ error: 'Not in pool mode' }, 400)
  }
  if (poolAssigned) {
    return c.json({ error: 'Already assigned', projectId: currentProjectId }, 400)
  }

  const startTime = Date.now()
  const body = await c.req.json()
  const { projectId, env: envVars } = body

  if (!projectId || typeof projectId !== 'string') {
    return c.json({ error: 'projectId (string) is required' }, 400)
  }

  logTiming(`Pool assignment starting for project ${projectId}`)

  // 1. Update project identity
  currentProjectId = projectId
  process.env.PROJECT_ID = projectId

  // 2. Inject environment variables from the controller
  if (envVars && typeof envVars === 'object') {
    for (const [key, value] of Object.entries(envVars)) {
      if (typeof value === 'string') {
        process.env[key] = value
      }
    }
  }

  // 3. Reconfigure AI proxy with new env (picks up AI_PROXY_TOKEN)
  try {
    aiProxy = configureAIProxy({ logPrefix: 'agent-runtime' })
  } catch (err: any) {
    console.error(`[agent-runtime] FATAL during reconfigure: ${err.message}`)
    process.exit(1)
  }
  if (aiProxy.useProxy) {
    Object.assign(process.env, aiProxy.env)
  }

  // 4. Run essential initialization (workspace files, S3 sync, config)
  try {
    await initializeEssentials()
    poolAssigned = true
    const duration = Date.now() - startTime
    logTiming(`Pool assignment essentials complete for ${projectId} (${duration}ms)`)

    // 5. Start gateway in background — don't block the assign response.
    // The pod can serve health, file, and catalog endpoints immediately.
    // Chat/heartbeat endpoints return 503 until gateway is ready.
    startGateway().catch((error) => {
      console.error(`[agent-runtime] Background gateway start failed for ${projectId}:`, error.message)
    })

    return c.json({ ok: true, projectId, durationMs: duration })
  } catch (error: any) {
    console.error(`[agent-runtime] Pool assignment failed for ${projectId}:`, error.message)
    return c.json({ error: `Assignment failed: ${error.message}` }, 500)
  }
})

// Agent status (detailed)
app.get('/agent/status', (c) => {
  const status = agentGateway?.getStatus() ?? {
    running: false,
    heartbeat: { enabled: false, lastTick: null, nextTick: null },
    channels: [],
    skills: [],
  }
  return c.json(status)
})

// Agent chat endpoint — send a message to the running agent.
// Accepts AI SDK v3 format: { messages: [{ role, parts: [{ type: 'text', text }] }] }
// Returns an AI SDK UI message stream so the frontend can use useChat().
app.post('/agent/chat', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const body = await c.req.json()

  const allMessages = (body.messages || []) as Array<{ role: string; parts: Array<{ type: string; text: string }> }>

  let userText: string | undefined
  if (allMessages.length > 0) {
    const last = [...allMessages].reverse().find((m: any) => m.role === 'user')
    if (last?.parts && Array.isArray(last.parts)) {
      userText = last.parts
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join('\n')
    }
  }

  if (!userText) {
    return c.json({ error: 'message is required — send { messages: [{ role: "user", parts: [{ type: "text", text: "..." }] }] }' }, 400)
  }

  // Seed the chat session with prior conversation history from the request.
  // AI SDK clients and eval runners send the full message array each turn;
  // the session is the authoritative store so we only seed when it's empty
  // to avoid duplicating messages on subsequent turns.
  if (allMessages.length > 1) {
    const sessionMgr = agentGateway!.getSessionManager()
    const session = sessionMgr.getOrCreate('chat')
    if (session.messages.length === 0) {
      const priorMessages = allMessages.slice(0, -1)
      for (const msg of priorMessages) {
        const text = (msg.parts || [])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('\n')
        if (!text) continue

        if (msg.role === 'user') {
          sessionMgr.addMessages('chat', userMessage(text))
        } else if (msg.role === 'assistant') {
          sessionMgr.addMessages('chat', {
            role: 'assistant',
            content: [{ type: 'text', text }],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'history',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          } as any)
        }
      }
    }
  }

  const agentMode = body.agentMode as 'basic' | 'advanced' | undefined
  const modelOverride = agentMode === 'basic' ? 'claude-haiku-4-5'
    : agentMode === 'advanced' ? 'claude-sonnet-4-5'
    : undefined

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        writer.write({ type: 'start-step' })
        await agentGateway!.processChatMessageStream(userText!, writer, { modelOverride })

        const usage = agentGateway!.consumeLastTurnUsage()
        if (usage) {
          writer.write({
            type: 'data-usage',
            data: usage,
          } as any)
        }

        writer.write({ type: 'finish-step' })
        writer.write({ type: 'finish', finishReason: 'stop' })
      } catch (error: any) {
        writer.write({ type: 'error', errorText: error.message || 'Agent chat error' } as any)
      }
    },
  })

  const response = createUIMessageStreamResponse({ stream })
  if (response.body) {
    const wrappedStream = wrapStreamWithKeepalive(response.body, 15_000)
    return new Response(wrappedStream, {
      status: response.status,
      headers: response.headers,
    })
  }
  return response
})

// Retrieve chat history so the UI can restore past messages on reconnect
app.get('/agent/chat/history', async (c) => {
  if (!agentGateway) {
    return c.json({ messages: [] })
  }

  const session = await agentGateway.getSessionManager().getOrCreateAsync('chat')
  if (session.messages.length === 0) {
    return c.json({ messages: [] })
  }

  const simplified: Array<{ id: string; role: string; content: string }> = []
  for (const msg of session.messages) {
    if (msg.role === 'user') {
      const raw = typeof msg.content === 'string' ? msg.content : ''
      const userMatch = raw.match(/\[User Message\]\n([\s\S]+)$/)
      const chatMatch = raw.match(/\[Chat — User Message\]\n[\s\S]*?\n\n([\s\S]+)$/)
      const displayText = userMatch?.[1]?.trim() || chatMatch?.[1]?.trim() || raw
      simplified.push({ id: `h-${simplified.length}`, role: 'user', content: displayText })
    } else if (msg.role === 'assistant') {
      const parts = (msg as any).content as any[] | undefined
      const text = parts
        ?.filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join('\n') || ''
      if (text) {
        simplified.push({ id: `h-${simplified.length}`, role: 'assistant', content: text })
      }
    }
  }

  return c.json({ messages: simplified })
})

// ---------------------------------------------------------------------------
// Webhook Ingress Endpoints
// ---------------------------------------------------------------------------

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN

function verifyWebhookAuth(c: any): boolean {
  if (!WEBHOOK_TOKEN) return true
  const auth = c.req.header('authorization') || ''
  const token = c.req.header('x-webhook-token') || ''
  return auth === `Bearer ${WEBHOOK_TOKEN}` || token === WEBHOOK_TOKEN
}

app.post('/agent/hooks/wake', async (c) => {
  if (!verifyWebhookAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const body = await c.req.json()
  const text = body.text as string
  const mode = (body.mode as string) || 'now'

  if (!text || typeof text !== 'string') {
    return c.json({ error: 'text (string) is required' }, 400)
  }

  if (mode === 'next-heartbeat') {
    agentGateway.queuePendingEvent(text)
    return c.json({ ok: true, mode: 'next-heartbeat', queued: true })
  }

  try {
    const result = await agentGateway.triggerHeartbeat()
    return c.json({ ok: true, mode: 'now', result: result.substring(0, 500) })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.post('/agent/hooks/agent', async (c) => {
  if (!verifyWebhookAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const body = await c.req.json()
  const message = body.message as string
  const deliver = body.deliver !== false
  const channel = body.channel as string | undefined
  const to = body.to as string | undefined

  if (!message || typeof message !== 'string') {
    return c.json({ error: 'message (string) is required' }, 400)
  }

  // Run asynchronously — return 202 immediately
  const runAsync = async () => {
    try {
      const response = await agentGateway!.processWebhookMessage(message)
      if (deliver && channel && to) {
        const status = agentGateway!.getStatus()
        const connected = status.channels.find((ch) => ch.type === channel && ch.connected)
        if (connected) {
          // Deliver through the gateway's test message path for now
          console.log(`[agent-runtime] Webhook: delivering to ${channel}:${to}`)
        }
      }
      console.log('[agent-runtime] Webhook agent turn complete:', response.substring(0, 200))
    } catch (error: any) {
      console.error('[agent-runtime] Webhook agent error:', error.message)
    }
  }

  runAsync()
  return c.json({ status: 'accepted' }, 202)
})

// Prompt override — used by DSPy optimization to inject candidate prompts at runtime
app.post('/agent/prompt-override', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  const overrides = await c.req.json() as Record<string, string>
  agentGateway.setPromptOverrides(overrides)
  return c.json({ ok: true, keys: Object.keys(overrides) })
})

app.delete('/agent/prompt-override', (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  agentGateway.setPromptOverrides({})
  return c.json({ ok: true, cleared: true })
})

// Session reset — used by eval runner to clear conversation history between tests
app.post('/agent/session/reset', (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  const sm = agentGateway.getSessionManager()
  sm.clearHistory('chat')
  return c.json({ ok: true })
})

// Tool mocks — used by eval runner to install deterministic tool responses
app.post('/agent/tool-mocks', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  const body = await c.req.json() as {
    mocks: Record<string, {
      type: 'static'
      response: any
      description?: string
      paramKeys?: string[]
    } | {
      type: 'pattern'
      patterns: Array<{ match: Record<string, string>; response: any }>
      default?: any
      description?: string
      paramKeys?: string[]
    }>
  }

  const fns: Record<string, (params: Record<string, any>) => any> = {}
  const syntheticDefs: Record<string, { description: string; paramKeys: string[] }> = {}

  for (const [toolName, spec] of Object.entries(body.mocks)) {
    if (spec.type === 'static') {
      const resp = spec.response
      fns[toolName] = () => resp
    } else if (spec.type === 'pattern') {
      const patterns = spec.patterns
      const defaultResp = spec.default ?? { ok: true }
      fns[toolName] = (params: Record<string, any>) => {
        const paramsStr = JSON.stringify(params).toLowerCase()
        for (const p of patterns) {
          const allMatch = Object.values(p.match).every(
            substr => paramsStr.includes(substr.toLowerCase())
          )
          if (allMatch) return p.response
        }
        return defaultResp
      }
    }

    if (spec.description || spec.paramKeys) {
      syntheticDefs[toolName] = {
        description: spec.description || `External integration tool: ${toolName}`,
        paramKeys: spec.paramKeys || [],
      }
    }
  }
  agentGateway.setToolMocks(fns, syntheticDefs)
  return c.json({ ok: true, mockedTools: Object.keys(fns) })
})

app.delete('/agent/tool-mocks', (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  agentGateway.clearToolMocks()
  return c.json({ ok: true })
})

// Heartbeat manual trigger
app.post('/agent/heartbeat/trigger', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  try {
    const result = await agentGateway.triggerHeartbeat()
    return c.json({ result })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Workspace file read/write endpoints
app.get('/agent/files/:filename', async (c) => {
  const filename = c.req.param('filename')
  const allowedFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md', 'config.json']

  if (!allowedFiles.includes(filename)) {
    return c.json({ error: `File not allowed: ${filename}` }, 400)
  }

  try {
    const filepath = join(AGENT_DIR, filename)
    const content = existsSync(filepath) ? readFileSync(filepath, 'utf-8') : ''
    return c.json({ filename, content })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.put('/agent/files/:filename', async (c) => {
  const filename = c.req.param('filename')
  const allowedFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md', 'config.json']

  if (!allowedFiles.includes(filename)) {
    return c.json({ error: `File not allowed: ${filename}` }, 400)
  }

  try {
    const { content } = await c.req.json()
    const filepath = join(AGENT_DIR, filename)
    writeFileSync(filepath, content, 'utf-8')
    return c.json({ ok: true, filename })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// MCP Catalog endpoints — powers the "MCP Servers" tab in the web UI
import { MCP_CATALOG, MCP_CATEGORIES } from './mcp-catalog'
// Agent Templates API — powers the templates gallery
import { getTemplateSummaries, TEMPLATE_CATEGORIES } from './agent-templates'
// Agent Recipes API — powers the recipes wizard
import { AGENT_RECIPES, RECIPE_CATEGORIES } from './agent-recipes'

app.get('/agent/mcp-catalog', (c) => {
  return c.json({ catalog: MCP_CATALOG, categories: MCP_CATEGORIES })
})

app.get('/agent/bundled-skills', (c) => {
  const { loadBundledSkills } = require('./skills')
  const bundled = loadBundledSkills(new Set())
  return c.json({
    skills: bundled.map((s: any) => ({
      name: s.name,
      version: s.version,
      description: s.description,
      trigger: s.trigger,
      tools: s.tools,
      content: s.content,
    })),
  })
})

app.post('/agent/bundled-skills/install', async (c) => {
  const { name } = await c.req.json() as { name: string }
  const { loadBundledSkills } = require('./skills')
  const bundled = loadBundledSkills(new Set())
  const skill = bundled.find((s: any) => s.name === name)

  if (!skill) {
    return c.json({ error: `Bundled skill "${name}" not found` }, 404)
  }

  const skillsDir = join(AGENT_DIR, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  const destPath = join(skillsDir, `${name}.md`)

  const { readFileSync: rfs } = require('fs')
  const content = rfs(skill.filePath, 'utf-8')
  writeFileSync(destPath, content, 'utf-8')

  return c.json({ ok: true, installed: name })
})

app.delete('/agent/skills/:name', (c) => {
  const name = c.req.param('name')
  if (!name || name.includes('/') || name.includes('..')) {
    return c.json({ error: 'Invalid skill name' }, 400)
  }

  const filePath = join(AGENT_DIR, 'skills', `${name}.md`)
  if (!existsSync(filePath)) {
    return c.json({ error: `Skill "${name}" not found` }, 404)
  }

  unlinkSync(filePath)
  return c.json({ ok: true, removed: name })
})

app.get('/agent/templates', (c) => {
  return c.json({ templates: getTemplateSummaries(), categories: TEMPLATE_CATEGORIES })
})

app.get('/agent/recipes', (c) => {
  return c.json({ recipes: AGENT_RECIPES, categories: RECIPE_CATEGORIES })
})

app.post('/agent/mcp-servers/toggle', async (c) => {
  const { serverId, enabled, env } = await c.req.json() as {
    serverId: string
    enabled: boolean
    env?: Record<string, string>
  }

  const entry = MCP_CATALOG.find((e) => e.id === serverId)
  if (!entry) {
    return c.json({ error: `Unknown MCP server: ${serverId}` }, 400)
  }

  const configPath = join(AGENT_DIR, 'config.json')
  let config: Record<string, any> = {}
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf-8'))
  }

  config.mcpServers = config.mcpServers || {}

  if (enabled) {
    config.mcpServers[entry.id] = {
      command: 'npx',
      args: [entry.package, ...entry.defaultArgs],
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    }
  } else {
    delete config.mcpServers[entry.id]
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  return c.json({ ok: true, serverId, enabled, servers: config.mcpServers })
})

// Agent export/import — bundle workspace into a shareable .shogo config
app.get('/agent/export', async (c) => {
  const exportFiles: Record<string, string> = {}
  const exportableFiles = [
    'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md',
    'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md', 'config.json',
  ]

  for (const filename of exportableFiles) {
    const filepath = join(AGENT_DIR, filename)
    if (existsSync(filepath)) {
      exportFiles[filename] = readFileSync(filepath, 'utf-8')
    }
  }

  const skillsDir = join(AGENT_DIR, 'skills')
  if (existsSync(skillsDir)) {
    const { readdirSync } = require('fs')
    const skillFiles = readdirSync(skillsDir) as string[]
    for (const file of skillFiles) {
      if (file.endsWith('.md')) {
        exportFiles[`skills/${file}`] = readFileSync(join(skillsDir, file), 'utf-8')
      }
    }
  }

  const bundle = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    projectId: process.env.PROJECT_ID || 'unknown',
    files: exportFiles,
  }

  return c.json(bundle)
})

app.post('/agent/import', async (c) => {
  const bundle = await c.req.json() as {
    version: string
    files: Record<string, string>
  }

  if (!bundle.files || typeof bundle.files !== 'object') {
    return c.json({ error: 'Invalid bundle: missing files' }, 400)
  }

  const written: string[] = []
  for (const [filename, content] of Object.entries(bundle.files)) {
    if (filename.includes('..') || filename.startsWith('/')) {
      continue
    }
    const filepath = join(AGENT_DIR, filename)
    const dir = require('path').dirname(filepath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(filepath, content, 'utf-8')
    written.push(filename)
  }

  return c.json({ ok: true, imported: written.length, files: written })
})

// =============================================================================
// Dynamic App Endpoints
// =============================================================================

app.get('/agent/dynamic-app/stream', (c) => {
  const manager = getDynamicAppManager()

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch {
          // Client disconnected
        }
      }

      // Send current state as initial replay
      const state = manager.getState()
      for (const surface of Object.values(state.surfaces) as any[]) {
        send(JSON.stringify({ type: 'createSurface', surfaceId: surface.surfaceId, title: surface.title, theme: surface.theme }))
        const components = Object.values(surface.components)
        if (components.length > 0) {
          send(JSON.stringify({ type: 'updateComponents', surfaceId: surface.surfaceId, components }))
        }
        if (Object.keys(surface.dataModel).length > 0) {
          send(JSON.stringify({ type: 'updateData', surfaceId: surface.surfaceId, path: '/', value: surface.dataModel }))
        }
      }

      // Subscribe to live updates
      const unsubscribe = manager.addClient((message) => {
        send(JSON.stringify(message))
      })

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
          unsubscribe()
        }
      }, 15_000)

      // Cleanup on abort
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(heartbeat)
        unsubscribe()
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  })
})

app.get('/agent/dynamic-app/state', (c) => {
  const manager = getDynamicAppManager()
  return c.json(manager.getState())
})

app.post('/agent/dynamic-app/action', async (c) => {
  const body = await c.req.json() as ActionEvent
  if (!body.surfaceId || !body.name) {
    return c.json({ error: 'Missing surfaceId or action name' }, 400)
  }

  const manager = getDynamicAppManager()
  const event: ActionEvent = {
    surfaceId: body.surfaceId,
    name: body.name,
    context: body.context || {},
    timestamp: new Date().toISOString(),
  }

  manager.deliverAction(event)
  return c.json({ ok: true, event })
})

// Proxy requests to managed API runtimes (per-surface data layer)
app.all('/agent/dynamic-app/api/:surfaceId/*', async (c) => {
  const surfaceId = c.req.param('surfaceId')
  const manager = getDynamicAppManager()
  const runtime = manager.getRuntime(surfaceId)

  if (!runtime || !runtime.isReady()) {
    return c.json({ error: `No API runtime for surface "${surfaceId}"` }, 404)
  }

  const prefix = `/agent/dynamic-app/api/${surfaceId}`
  const subPath = c.req.path.replace(prefix, '') || '/'
  const originalUrl = new URL(c.req.url)
  const subUrl = new URL(subPath, 'http://localhost')
  subUrl.search = originalUrl.search

  const subRequest = new Request(subUrl.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
  })

  return runtime.getApp().fetch(subRequest)
})

// Console log for forwarding (matches project-runtime pattern)
const consoleLogs: string[] = []
app.post('/console-log/append', async (c) => {
  const { line } = await c.req.json()
  if (line) {
    consoleLogs.push(line)
    if (consoleLogs.length > 1000) consoleLogs.splice(0, 500)
  }
  return c.json({ ok: true })
})

app.get('/console-log', (c) => {
  return c.json({ logs: consoleLogs })
})

// =============================================================================
// Initialization
// =============================================================================

/**
 * Essential initialization: workspace files, S3 sync, config.
 * Returns quickly so /pool/assign can respond fast.
 */
async function initializeEssentials(): Promise<void> {
  logTiming('Initializing essentials...')

  // Bootstrap workspace files
  ensureWorkspaceFiles()
  logTiming('Workspace files ready')

  // Initialize S3 sync BEFORE loading canvas state so that downloaded files
  // (including .canvas-state.json and api-runtimes/*.db) are available on disk.
  if (process.env.S3_WORKSPACES_BUCKET || process.env.S3_BUCKET) {
    try {
      const result = await initializeS3Sync(AGENT_DIR)
      if (result) {
        s3SyncInstance = result.sync
        logTiming('S3 sync initialized')
      }
    } catch (error: any) {
      console.error('[agent-runtime] S3 sync init failed:', error.message)
    }
  }

  // Initialize canvas state manager with disk persistence.
  // Loads surfaces + restores API runtimes from persisted model definitions.
  const canvasStatePath = join(AGENT_DIR, '.canvas-state.json')
  initDynamicAppManager(canvasStatePath)
  logTiming('Canvas state manager initialized')

  // Write CLAUDE.md and .mcp.json
  writeAgentConfigFiles()
  logTiming('Essentials complete')
}

/**
 * Start the agent gateway (heavy: loads skills, MCP servers, sessions, BOOT.md).
 * Called after essentials are done — can run in background for warm pool assigns.
 */
async function startGateway(): Promise<void> {
  logTiming('Starting agent gateway...')

  agentGateway = new AgentGateway(AGENT_DIR, currentProjectId!)
  agentGateway.setLogCallback((line) => {
    consoleLogs.push(line)
    if (consoleLogs.length > 1000) consoleLogs.splice(0, 500)
  })

  if (s3SyncInstance) {
    agentGateway.getMCPClientManager().setOnConfigPersisted(() => {
      s3SyncInstance?.triggerSync(true)
    })
  }

  await agentGateway.start()
  logTiming('Agent gateway started')
}

/**
 * Full initialization: essentials + gateway.
 * Used for non-pool-mode startup (cold start path).
 */
async function initialize(): Promise<void> {
  await initializeEssentials()
  await startGateway()
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

let isShuttingDown = false

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[agent-runtime] ${signal} received — starting graceful shutdown`)

  try {
    if (s3SyncInstance) {
      await s3SyncInstance.flushAndShutdown(10_000)
    }
  } catch (err: any) {
    console.error(`[agent-runtime] S3 flush error during shutdown:`, err.message)
  }

  try {
    if (agentGateway) {
      await agentGateway.stop()
    }
  } catch (err: any) {
    console.error(`[agent-runtime] Gateway stop error during shutdown:`, err.message)
  }

  console.log(`[agent-runtime] Graceful shutdown complete`)
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// =============================================================================
// Start Server
// =============================================================================

if (IS_POOL_MODE) {
  logTiming('Pool mode: skipping project init, server ready for assignment')
} else {
  initialize()
    .then(() => {
      logTiming(`Starting server on port ${PORT}`)
    })
    .catch((error) => {
      console.error('[agent-runtime] Initialization failed:', error)
    })
}

export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 120,
}
