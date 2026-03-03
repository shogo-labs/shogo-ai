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
  readdirSync,
  statSync,
  rmSync,
} from 'fs'
import {
  initializeS3Sync,
  initializePostgresBackup,
  configureAIProxy,
} from '@shogo/shared-runtime'
import { buildAgentSystemPrompt } from './system-prompt'
import { seedWorkspaceDefaults, seedWorkspaceFromTemplate } from './workspace-defaults'
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
let poolAssignedAt: number | null = null
let lastRequestAt: number = Date.now()
const INTERNAL_PATHS = new Set(['/health', '/ready', '/pool/activity', '/pool/assign'])

if (!currentProjectId) {
  console.error(
    '[agent-runtime] ERROR: PROJECT_ID environment variable is required'
  )
  process.exit(1)
}

if (IS_POOL_MODE) {
  logTiming('Starting in WARM POOL mode (awaiting project assignment)')

  // Self-assign: if this pod was previously promoted (has ASSIGNED_PROJECT),
  // fetch config from the API and apply it so the pod resumes serving.
  const { checkSelfAssign } = await import('@shogo/shared-runtime')
  const selfAssignConfig = await checkSelfAssign()
  if (selfAssignConfig) {
    logTiming(`[self-assign] Applying config for project ${selfAssignConfig.projectId}`)
    currentProjectId = selfAssignConfig.projectId
    process.env.PROJECT_ID = selfAssignConfig.projectId
    for (const [key, value] of Object.entries(selfAssignConfig.env)) {
      if (typeof value === 'string') process.env[key] = value
    }
    poolAssigned = true
    poolAssignedAt = Date.now()
    logTiming(`[self-assign] Self-assigned to ${selfAssignConfig.projectId}`)
  }
} else {
  logTiming(`Configuration loaded for agent: ${currentProjectId}`)
}
console.log(`[agent-runtime] Agent directory: ${AGENT_DIR}`)

// =============================================================================
// Agent Workspace Bootstrap
// =============================================================================

function ensureWorkspaceFiles(): void {
  const templateMarker = join(AGENT_DIR, '.template')
  const templateIdFromEnv = process.env.TEMPLATE_ID
  const templateIdFromFile = existsSync(templateMarker) ? readFileSync(templateMarker, 'utf-8').trim() : undefined
  const templateId = templateIdFromEnv || templateIdFromFile

  if (templateId) {
    const seeded = seedWorkspaceFromTemplate(AGENT_DIR, templateId, process.env.AGENT_NAME)
    if (seeded) {
      logTiming(`Workspace seeded from template: ${templateId}`)
      return
    }
    logTiming(`Template "${templateId}" not found, falling back to defaults`)
  }

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

// Track last external HTTP request for idle detection (excludes internal probes)
app.use('*', async (c, next) => {
  if (!INTERNAL_PATHS.has(c.req.path)) {
    lastRequestAt = Date.now()
  }
  await next()
})

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

// Register Microsoft Teams messaging endpoint
import('./channels/teams').then(({ TeamsAdapter }) => {
  TeamsAdapter.registerRoutes(app, () => {
    if (!agentGateway) return undefined
    return agentGateway.getChannel('teams') as any
  })
}).catch(() => { /* Teams adapter not available */ })

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

// Activity probe for promoted pod GC — uses HTTP request activity, not just chat sessions
app.get('/pool/activity', (c) => {
  const sm = agentGateway?.getSessionManager()
  const stats = sm?.getAllStats() ?? []
  const now = Date.now()
  const lastSessionActivity = stats.reduce(
    (max: number, s) => Math.max(max, now - (s.idleSeconds ?? 0) * 1000),
    poolAssignedAt ?? SERVER_START_TIME
  )
  const lastActivity = Math.max(lastRequestAt, lastSessionActivity)
  return c.json({
    projectId: currentProjectId,
    lastActivityAt: lastActivity,
    idleSeconds: Math.floor((now - lastActivity) / 1000),
    activeSessions: stats.length,
    lastRequestAt,
    lastSessionActivityAt: lastSessionActivity,
    poolAssigned: poolAssigned,
  })
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

  // 1. Clean workspace to prevent cross-project file leakage.
  // emptyDir should be fresh, but wipe user-data directories defensively.
  for (const subdir of ['files', 'memory', 'skills']) {
    const dirPath = join(AGENT_DIR, subdir)
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true })
      mkdirSync(dirPath, { recursive: true })
    }
  }

  // 2. Update project identity
  currentProjectId = projectId
  process.env.PROJECT_ID = projectId

  // 3. Inject environment variables from the controller
  if (envVars && typeof envVars === 'object') {
    for (const [key, value] of Object.entries(envVars)) {
      if (typeof value === 'string') {
        process.env[key] = value
      }
    }
  }

  // 4. Reconfigure AI proxy with new env (picks up AI_PROXY_TOKEN)
  try {
    aiProxy = configureAIProxy({ logPrefix: 'agent-runtime' })
  } catch (err: any) {
    console.error(`[agent-runtime] FATAL during reconfigure: ${err.message}`)
    process.exit(1)
  }
  if (aiProxy.useProxy) {
    Object.assign(process.env, aiProxy.env)
  }

  // 5. Run essential initialization (workspace files, S3 sync, config)
  try {
    await initializeEssentials()
    poolAssigned = true
    poolAssignedAt = Date.now()
    const duration = Date.now() - startTime
    logTiming(`Pool assignment essentials complete for ${projectId} (${duration}ms)`)

    // 6. Start gateway in background — don't block the assign response.
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

// Channel connect — persist to config.json and hot-connect via the gateway
app.post('/agent/channels/connect', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const { type, config: channelConfig } = await c.req.json() as {
    type: string
    config: Record<string, string>
  }

  if (!type || !channelConfig) {
    return c.json({ error: 'type and config are required' }, 400)
  }

  const validTypes = ['telegram', 'discord', 'slack', 'whatsapp', 'email']
  if (!validTypes.includes(type)) {
    return c.json({ error: `Invalid channel type: ${type}. Must be one of: ${validTypes.join(', ')}` }, 400)
  }

  try {
    const configPath = join(AGENT_DIR, 'config.json')
    let fileConfig: Record<string, any> = {}
    if (existsSync(configPath)) {
      try {
        fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch {
        // config.json is corrupted — start fresh but preserve the file
        console.error('[agent-runtime] config.json is invalid JSON, starting with empty config')
        fileConfig = {}
      }
    }

    fileConfig.channels = fileConfig.channels || []
    const existing = fileConfig.channels.findIndex((ch: any) => ch.type === type)
    if (existing >= 0) {
      fileConfig.channels[existing] = { type, config: channelConfig }
    } else {
      fileConfig.channels.push({ type, config: channelConfig })
    }

    await agentGateway.connectChannel(type, channelConfig)

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')

    return c.json({ ok: true, type, message: `${type} channel connected` })
  } catch (error: any) {
    return c.json({ error: error.message || `Failed to connect ${type}` }, 500)
  }
})

// Channel disconnect — remove from config.json and disconnect live adapter
app.post('/agent/channels/disconnect', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const { type } = await c.req.json() as { type: string }

  if (!type) {
    return c.json({ error: 'type is required' }, 400)
  }

  try {
    await agentGateway.disconnectChannel(type)

    const configPath = join(AGENT_DIR, 'config.json')
    if (existsSync(configPath)) {
      try {
        const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
        fileConfig.channels = (fileConfig.channels || []).filter((ch: any) => ch.type !== type)
        writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')
      } catch {
        console.error('[agent-runtime] config.json is invalid JSON, skipping config update')
      }
    }

    return c.json({ ok: true, type, message: `${type} channel disconnected` })
  } catch (error: any) {
    return c.json({ error: error.message || `Failed to disconnect ${type}` }, 500)
  }
})

// Agent chat endpoint — send a message to the running agent.
// Accepts AI SDK v3 format: { messages: [{ role, parts: [{ type: 'text', text }] }] }
// Returns an AI SDK UI message stream so the frontend can use useChat().
app.post('/agent/chat', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const body = await c.req.json()

  const allMessages = (body.messages || []) as Array<{ role: string; parts: Array<{ type: string; text?: string; mediaType?: string; url?: string; name?: string }> }>

  let userText: string | undefined
  let userFileParts: Array<{ type: string; mediaType?: string; url?: string; name?: string }> = []
  if (allMessages.length > 0) {
    const last = [...allMessages].reverse().find((m: any) => m.role === 'user')
    if (last?.parts && Array.isArray(last.parts)) {
      userText = last.parts
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join('\n')

      userFileParts = last.parts.filter(
        (p: any) => p.type === 'file' && p.url,
      )
    }
  }

  if (!userText && userFileParts.length === 0) {
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

        if (msg.role === 'user') {
          const historyFileParts = (msg.parts || []).filter(
            (p: any) => p.type === 'file' && p.url,
          )
          if (historyFileParts.length > 0) {
            const imageCount = historyFileParts.filter((p: any) => p.mediaType?.startsWith('image/')).length
            const fileCount = historyFileParts.length - imageCount
            const notes: string[] = []
            if (imageCount > 0) notes.push(`[${imageCount} image(s) were attached]`)
            if (fileCount > 0) notes.push(`[${fileCount} file(s) were attached]`)
            const effectiveText = [text, ...notes].filter(Boolean).join('\n')
            if (!effectiveText) continue
            sessionMgr.addMessages('chat', userMessage(effectiveText))
          } else {
            if (!text) continue
            sessionMgr.addMessages('chat', userMessage(text))
          }
        } else if (msg.role === 'assistant') {
          if (!text) continue
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

  if (body.timezone && typeof body.timezone === 'string') {
    agentGateway!.setUserTimezone(body.timezone)
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        writer.write({ type: 'start-step' })
        await agentGateway!.processChatMessageStream(userText || '', writer, {
          modelOverride,
          fileParts: userFileParts.length > 0 ? userFileParts : undefined,
        })

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
app.post('/agent/session/reset', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  const sm = agentGateway.getSessionManager()
  sm.clearHistory('chat')
  agentGateway.reloadConfig()
  await agentGateway.getMCPClientManager().stopAll()
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
      hidden?: boolean
    } | {
      type: 'pattern'
      patterns: Array<{ match: Record<string, string>; response: any }>
      default?: any
      description?: string
      paramKeys?: string[]
      hidden?: boolean
    }>
  }

  const fns: Record<string, (params: Record<string, any>) => any> = {}
  const syntheticDefs: Record<string, { description: string; paramKeys: string[] }> = {}
  const hiddenTools = new Set<string>()

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
    if ((spec as any).hidden) {
      hiddenTools.add(toolName)
    }
  }
  agentGateway.setToolMocks(fns, syntheticDefs, hiddenTools)
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

// ---------------------------------------------------------------------------
// Workspace File Management Endpoints (files/ directory)
// ---------------------------------------------------------------------------

import { FileIndexEngine } from './file-index-engine'

let fileIndexEngine: FileIndexEngine | null = null
function getFileIndexEngine(): FileIndexEngine {
  if (!fileIndexEngine) {
    fileIndexEngine = new FileIndexEngine(AGENT_DIR)
  }
  return fileIndexEngine
}

const FILES_DIR = join(AGENT_DIR, 'files')

function resolveFilesPath(subPath: string): string | null {
  const resolved = resolve(FILES_DIR, subPath)
  if (!resolved.startsWith(resolve(FILES_DIR))) return null
  return resolved
}

function walkFilesTree(dir: string, rootDir: string): any[] {
  if (!existsSync(dir)) return []
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
        children: walkFilesTree(absPath, rootDir),
      })
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

// Recursive file tree for the file browser UI
app.get('/agent/workspace/tree', (c) => {
  mkdirSync(FILES_DIR, { recursive: true })
  const tree = walkFilesTree(FILES_DIR, resolve(FILES_DIR))
  return c.json({ tree })
})

// Read a file from files/
app.get('/agent/workspace/files/*', (c) => {
  const subPath = c.req.path.replace('/agent/workspace/files/', '')
  if (!subPath) return c.json({ error: 'Path required' }, 400)

  const resolved = resolveFilesPath(subPath)
  if (!resolved) return c.json({ error: 'Path outside files directory' }, 400)
  if (!existsSync(resolved)) return c.json({ error: 'File not found' }, 404)

  const content = readFileSync(resolved, 'utf-8')
  return c.json({ path: subPath, content, bytes: content.length })
})

// Write/create a file in files/
app.put('/agent/workspace/files/*', async (c) => {
  const subPath = c.req.path.replace('/agent/workspace/files/', '')
  if (!subPath) return c.json({ error: 'Path required' }, 400)

  const resolved = resolveFilesPath(subPath)
  if (!resolved) return c.json({ error: 'Path outside files directory' }, 400)

  const { content } = await c.req.json()
  const dir = dirname(resolved)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolved, content, 'utf-8')

  return c.json({ ok: true, path: subPath, bytes: content.length })
})

// Delete a file from files/
app.delete('/agent/workspace/files/*', (c) => {
  const subPath = c.req.path.replace('/agent/workspace/files/', '')
  if (!subPath) return c.json({ error: 'Path required' }, 400)

  const resolved = resolveFilesPath(subPath)
  if (!resolved) return c.json({ error: 'Path outside files directory' }, 400)
  if (!existsSync(resolved)) return c.json({ error: 'File not found' }, 404)

  unlinkSync(resolved)
  return c.json({ ok: true, deleted: subPath })
})

// Create a directory
app.post('/agent/workspace/mkdir', async (c) => {
  const { path: dirPath } = await c.req.json() as { path: string }
  if (!dirPath) return c.json({ error: 'Path required' }, 400)

  const resolved = resolveFilesPath(dirPath)
  if (!resolved) return c.json({ error: 'Path outside files directory' }, 400)

  mkdirSync(resolved, { recursive: true })
  return c.json({ ok: true, path: dirPath })
})

// Upload files (multipart/form-data)
app.post('/agent/workspace/upload', async (c) => {
  try {
    const formData = await c.req.formData()
    const targetDir = (formData.get('directory') as string) || ''
    const uploaded: string[] = []

    for (const [key, value] of formData.entries()) {
      if (key === 'directory') continue
      if (typeof value === 'string') continue
      const file = value as unknown as { name: string; arrayBuffer(): Promise<ArrayBuffer> }

      const fileName = file.name
      const filePath = targetDir ? `${targetDir}/${fileName}` : fileName
      const resolved = resolveFilesPath(filePath)
      if (!resolved) continue

      const dir = dirname(resolved)
      mkdirSync(dir, { recursive: true })

      const buffer = await file.arrayBuffer()
      writeFileSync(resolved, Buffer.from(buffer))
      uploaded.push(filePath)
    }

    return c.json({ ok: true, uploaded, count: uploaded.length })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Download a file
app.get('/agent/workspace/download/*', (c) => {
  const subPath = c.req.path.replace('/agent/workspace/download/', '')
  if (!subPath) return c.json({ error: 'Path required' }, 400)

  const resolved = resolveFilesPath(subPath)
  if (!resolved) return c.json({ error: 'Path outside files directory' }, 400)
  if (!existsSync(resolved)) return c.json({ error: 'File not found' }, 404)

  const content = readFileSync(resolved)
  const fileName = subPath.split('/').pop() || 'download'

  return new Response(content, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': String(content.length),
    },
  })
})

// Search files via RAG engine
app.post('/agent/workspace/search', async (c) => {
  try {
    const { query, limit = 10, path_filter } = await c.req.json() as {
      query: string; limit?: number; path_filter?: string
    }
    if (!query) return c.json({ error: 'Query required' }, 400)

    const engine = getFileIndexEngine()
    const results = await engine.search(query, limit, path_filter)
    return c.json({
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
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Re-index files (manual trigger)
app.post('/agent/workspace/reindex', async (c) => {
  try {
    const engine = getFileIndexEngine()
    const stats = await engine.reindex()
    return c.json({ ok: true, ...stats })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Tool catalog and search — powers the "Tools" tab in the web UI
import { MCP_CATALOG, MCP_CATEGORIES, isPreinstalledMcpId, getPreinstalledPackages } from './mcp-catalog'
import { isComposioEnabled, searchComposioToolkits, findComposioToolkit, initComposioSession, registerToolkitProxyTools } from './composio'

// Agent Templates API — powers the templates gallery
import { getTemplateSummaries, getAgentTemplateById, TEMPLATE_CATEGORIES } from './agent-templates'

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

app.get('/agent/skills/:name', (c) => {
  const name = c.req.param('name')
  if (!name || name.includes('/') || name.includes('..')) {
    return c.json({ error: 'Invalid skill name' }, 400)
  }

  const filePath = join(AGENT_DIR, 'skills', `${name}.md`)
  if (!existsSync(filePath)) {
    return c.json({ error: `Skill "${name}" not found` }, 404)
  }

  const raw = readFileSync(filePath, 'utf-8')
  return c.json({ name, content: raw })
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

app.get('/agent/templates/:id', (c) => {
  const template = getAgentTemplateById(c.req.param('id'))
  if (!template) return c.json({ error: 'Template not found' }, 404)
  return c.json({ template })
})

app.post('/agent/mcp-servers/toggle', async (c) => {
  const { serverId, enabled, env } = await c.req.json() as {
    serverId: string
    enabled: boolean
    env?: Record<string, string>
  }

  const entry = MCP_CATALOG.find((e) => e.id === serverId)
  if (!entry || !entry.preinstalled) {
    const allowed = getPreinstalledPackages().map(e => e.id).join(', ')
    return c.json({ error: `MCP server "${serverId}" is not available. Only preinstalled servers are supported: ${allowed}` }, 400)
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

// ---------------------------------------------------------------------------
// Unified Tools API — powers the "Tools" tab
// ---------------------------------------------------------------------------

app.get('/agent/tools/status', (c) => {
  if (!agentGateway) {
    return c.json({ tools: [] })
  }
  const mcpMgr = agentGateway.getMcpClientManager()
  const serverInfo = mcpMgr.getServerInfo()

  const tools = serverInfo.map((s) => {
    const catalogEntry = MCP_CATALOG.find((e) => e.id === s.name)
    const isComposioProxy = s.config.command === 'composio-proxy'
    return {
      id: s.name,
      name: catalogEntry?.name || s.name,
      source: isComposioProxy ? 'managed' as const : (catalogEntry ? 'catalog' as const : 'custom' as const),
      status: 'running' as const,
      toolCount: s.toolCount,
      tools: s.toolNames,
      composioToolkit: isComposioProxy ? s.name : catalogEntry?.composioToolkit,
    }
  })

  return c.json({ tools })
})

app.get('/agent/tools/search', async (c) => {
  const query = c.req.query('q') || ''
  if (!query.trim()) {
    return c.json({ results: [] })
  }

  const installedNames = new Set<string>()
  if (agentGateway) {
    for (const s of agentGateway.getMcpClientManager().getServerInfo()) {
      installedNames.add(s.name)
    }
  }

  const results: Array<Record<string, any>> = []
  const seenSlugs = new Set<string>()

  if (isComposioEnabled()) {
    try {
      const composioToolkits = await searchComposioToolkits(query)
      for (const tk of composioToolkits.slice(0, 5)) {
        seenSlugs.add(tk.slug.toLowerCase().replace(/[-_\s]/g, ''))
        results.push({
          id: tk.slug,
          name: tk.name,
          description: `${tk.name} — managed OAuth integration. No credentials needed.`,
          source: 'managed',
          installed: installedNames.has(tk.slug.toLowerCase()),
          authType: 'oauth',
          composioToolkit: tk.slug,
          icon: tk.logo,
        })
      }
    } catch { /* Composio unavailable */ }
  }

  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2)
  const scored: Array<{ entry: typeof MCP_CATALOG[0]; score: number }> = []
  for (const entry of MCP_CATALOG) {
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
  for (const { entry } of scored.slice(0, 5)) {
    const entryNorm = entry.id.toLowerCase().replace(/[-_\s]/g, '')
    if (seenSlugs.has(entryNorm)) continue
    seenSlugs.add(entryNorm)
    results.push({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      source: 'catalog',
      installed: installedNames.has(entry.id),
      authType: entry.authType === 'composio' ? 'oauth' : (Object.keys(entry.requiredEnv).length > 0 ? 'api_key' : 'none'),
      requiredEnv: Object.keys(entry.requiredEnv).length > 0 ? entry.requiredEnv : undefined,
      composioToolkit: entry.composioToolkit,
      icon: entry.icon,
    })
  }

  return c.json({ results })
})

app.post('/agent/tools/install', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const { id, env } = await c.req.json() as {
    id: string
    env?: Record<string, string>
  }

  const mcpMgr = agentGateway.getMcpClientManager()

  if (isComposioEnabled()) {
    const composioToolkit = await findComposioToolkit(id)
    if (composioToolkit) {
      try {
        const userId = process.env.USER_ID || 'default'
        const projectId = process.env.PROJECT_ID || 'default'
        await initComposioSession(userId, projectId)
        const proxy = await registerToolkitProxyTools(mcpMgr, composioToolkit.slug)
        return c.json({
          ok: true,
          id: composioToolkit.slug.toLowerCase(),
          source: 'managed',
          toolCount: proxy.toolCount,
          tools: proxy.toolNames,
        })
      } catch (err: any) {
        return c.json({ error: `Failed to connect: ${err.message}` }, 500)
      }
    }
  }

  const catalogEntry = MCP_CATALOG.find((e) => e.id === id)
  if (!catalogEntry || !catalogEntry.preinstalled) {
    const allowed = getPreinstalledPackages().map(e => e.id).join(', ')
    return c.json({ error: `MCP server "${id}" is not available. Only preinstalled servers are supported: ${allowed}` }, 400)
  }

  try {
    const serverEnv = env || {}
    await mcpMgr.hotAddServer(id, {
      command: 'npx',
      args: [catalogEntry.package, ...catalogEntry.defaultArgs],
      env: Object.keys(serverEnv).length > 0 ? serverEnv : undefined,
    })
    return c.json({ ok: true, id, source: 'catalog' })
  } catch (err: any) {
    return c.json({ error: `Failed to install: ${err.message}` }, 500)
  }
})

app.delete('/agent/tools/:id', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const id = c.req.param('id')
  const mcpMgr = agentGateway.getMcpClientManager()

  if (mcpMgr.hasProxyToolGroup(id)) {
    mcpMgr.removeProxyToolGroup(id)
    return c.json({ ok: true, removed: id })
  }

  if (!mcpMgr.isRunning(id)) {
    return c.json({ error: `Tool "${id}" is not running` }, 404)
  }

  try {
    await mcpMgr.hotRemoveServer(id)
    return c.json({ ok: true, removed: id })
  } catch (err: any) {
    return c.json({ error: `Failed to uninstall: ${err.message}` }, 500)
  }
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
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
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

app.post('/agent/dynamic-app/edit', async (c) => {
  const body = await c.req.json() as {
    action: 'update' | 'add' | 'delete' | 'move'
    surfaceId: string
    componentId?: string
    componentIds?: string[]
    changes?: Record<string, unknown>
    component?: Record<string, unknown>
    parentId?: string
    newParentId?: string
    index?: number
  }

  if (!body.surfaceId || !body.action) {
    return c.json({ error: 'Missing surfaceId or action' }, 400)
  }

  const manager = getDynamicAppManager()
  const surfaceState = manager.getSurface(body.surfaceId)
  if (!surfaceState) {
    return c.json({ error: `Surface "${body.surfaceId}" does not exist` }, 404)
  }

  const components = surfaceState.components

  switch (body.action) {
    case 'update': {
      if (!body.componentId || !body.changes) {
        return c.json({ error: 'Missing componentId or changes for update action' }, 400)
      }
      const existing = components.get(body.componentId)
      if (!existing) {
        return c.json({ error: `Component "${body.componentId}" not found` }, 404)
      }
      const updated = { ...existing, ...body.changes, id: body.componentId, component: (body.changes.component || existing.component) as any }
      const result = manager.updateComponents(body.surfaceId, [updated as any])
      return c.json(result)
    }

    case 'add': {
      if (!body.component || !body.parentId) {
        return c.json({ error: 'Missing component or parentId for add action' }, 400)
      }
      const id = (body.component.id as string) || `comp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const newComp = { ...body.component, id } as any
      const parent = components.get(body.parentId)
      if (!parent) {
        return c.json({ error: `Parent "${body.parentId}" not found` }, 404)
      }
      const updatedParent = { ...parent }
      const childIds = Array.isArray(updatedParent.children) ? [...updatedParent.children] : []
      const idx = typeof body.index === 'number' ? Math.min(body.index, childIds.length) : childIds.length
      childIds.splice(idx, 0, id)
      updatedParent.children = childIds
      const result = manager.updateComponents(body.surfaceId, [newComp, updatedParent])
      return c.json({ ...result, newComponentId: id })
    }

    case 'delete': {
      const ids = body.componentIds || (body.componentId ? [body.componentId] : [])
      if (ids.length === 0) {
        return c.json({ error: 'Missing componentId or componentIds for delete action' }, 400)
      }
      const result = manager.deleteComponents(body.surfaceId, ids)
      return c.json(result)
    }

    case 'move': {
      if (!body.componentId || !body.newParentId) {
        return c.json({ error: 'Missing componentId or newParentId for move action' }, 400)
      }
      const updatedParents: any[] = []
      for (const [, comp] of components) {
        if (Array.isArray(comp.children) && comp.children.includes(body.componentId)) {
          const updated = { ...comp, children: comp.children.filter((id: string) => id !== body.componentId) }
          updatedParents.push(updated)
          break
        }
        if (comp.child === body.componentId) {
          const updated = { ...comp }
          delete updated.child
          updatedParents.push(updated)
          break
        }
      }
      const newParent = components.get(body.newParentId)
      if (!newParent) {
        return c.json({ error: `New parent "${body.newParentId}" not found` }, 404)
      }
      const updatedNewParent = { ...newParent }
      const newChildIds = Array.isArray(updatedNewParent.children) ? [...updatedNewParent.children] : []
      const idx = typeof body.index === 'number' ? Math.min(body.index, newChildIds.length) : newChildIds.length
      newChildIds.splice(idx, 0, body.componentId)
      updatedNewParent.children = newChildIds
      updatedParents.push(updatedNewParent)
      const result = manager.updateComponents(body.surfaceId, updatedParents)
      return c.json(result)
    }

    default:
      return c.json({ error: `Unknown action "${body.action}"` }, 400)
  }
})

// Test setup endpoint: creates pre-configured test surfaces for E2E testing
app.post('/agent/dynamic-app/test-setup', async (c) => {
  const manager = getDynamicAppManager()
  const body = await c.req.json() as { scenario: string }
  const scenario = body.scenario

  if (scenario === 'expense-form') {
    const surfaceId = 'test_expense'
    manager.createSurface(surfaceId, 'Expense Form Test')
    manager.applyApiSchema(surfaceId, [
      { name: 'Expense', fields: [
        { name: 'description', type: 'String' },
        { name: 'amount', type: 'Float' },
        { name: 'category', type: 'String' },
      ] },
    ])
    manager.seedApiData(surfaceId, 'Expense', [
      { description: 'Lunch', amount: 12.50, category: 'Food' },
      { description: 'Bus pass', amount: 45, category: 'Transport' },
      { description: 'Movie ticket', amount: 18.99, category: 'Entertainment' },
    ])
    manager.queryApiData(surfaceId, 'Expense', {}, '/expenses')
    manager.updateComponents(surfaceId, [
      { id: 'root', component: 'Column', children: ['header', 'metrics', 'form_card', 'list_card'], gap: 'lg' },
      { id: 'header', component: 'Row', children: ['title', 'badge'], align: 'center', justify: 'between' },
      { id: 'title', component: 'Text', text: 'Expense Tracker', variant: 'h2' },
      { id: 'badge', component: 'Badge', text: 'Test', variant: 'outline' },
      { id: 'metrics', component: 'Grid', columns: 2, children: ['m_count', 'm_total'] },
      { id: 'm_count', component: 'Metric', label: 'Count', value: { path: '/expenseCount' } },
      { id: 'm_total', component: 'Metric', label: 'Total', value: { path: '/expenseTotal' }, unit: '$' },
      { id: 'form_card', component: 'Card', title: 'Add Expense', child: 'form_row' },
      { id: 'form_row', component: 'Row', children: ['desc_input', 'amt_input', 'cat_select', 'add_btn'], gap: 'sm', align: 'end' },
      { id: 'desc_input', component: 'TextField', label: 'Description', placeholder: 'e.g. Coffee', dataPath: '/newDesc' },
      { id: 'amt_input', component: 'TextField', label: 'Amount', placeholder: '0.00', type: 'number', dataPath: '/newAmt' },
      { id: 'cat_select', component: 'Select', label: 'Category', placeholder: 'Select...', dataPath: '/newCat', options: [
        { label: 'Food', value: 'Food' },
        { label: 'Transport', value: 'Transport' },
        { label: 'Entertainment', value: 'Entertainment' },
      ] },
      { id: 'add_btn', component: 'Button', label: 'Add Expense', action: { name: 'add_expense', mutation: {
        endpoint: '/api/expenses', method: 'POST',
        body: { description: { path: '/newDesc' }, amount: { path: '/newAmt' }, category: { path: '/newCat' } },
      } } },
      { id: 'list_card', component: 'Card', title: 'Expenses', child: 'expense_list' },
      { id: 'expense_list', component: 'DataList', children: { path: '/expenses', templateId: 'expense_row' }, emptyText: 'No expenses yet' },
      { id: 'expense_row', component: 'Row', children: ['exp_desc', 'exp_amt', 'exp_cat', 'exp_del'], align: 'center', justify: 'between' },
      { id: 'exp_desc', component: 'Text', text: { path: 'description' } },
      { id: 'exp_amt', component: 'Text', text: { path: 'amount' }, variant: 'large' },
      { id: 'exp_cat', component: 'Badge', text: { path: 'category' }, variant: 'secondary' },
      { id: 'exp_del', component: 'Button', label: 'Delete', variant: 'destructive', size: 'sm', action: { name: 'delete_expense', mutation: {
        endpoint: '/api/expenses/:id', method: 'DELETE', params: { id: { path: 'id' } },
      } } },
    ] as any)
    manager.registerHooks(surfaceId, 'Expense', {
      afterCreate: [{ action: 'recompute', source: 'Expense', operation: 'count', target: '/expenseCount' },
                     { action: 'recompute', source: 'Expense', operation: 'sum', field: 'amount', target: '/expenseTotal' }],
      afterDelete: [{ action: 'recompute', source: 'Expense', operation: 'count', target: '/expenseCount' },
                     { action: 'recompute', source: 'Expense', operation: 'sum', field: 'amount', target: '/expenseTotal' }],
    })
    return c.json({ ok: true, surfaceId })

  } else if (scenario === 'pipeline-where') {
    const surfaceId = 'test_pipeline_where'
    manager.createSurface(surfaceId, 'Pipeline (where prop)')
    manager.applyApiSchema(surfaceId, [
      { name: 'Lead', fields: [
        { name: 'name', type: 'String' },
        { name: 'company', type: 'String' },
        { name: 'value', type: 'Float' },
        { name: 'stage', type: 'String', default: 'new' },
      ] },
    ])
    manager.seedApiData(surfaceId, 'Lead', [
      { name: 'Alice Chen', company: 'Acme Corp', value: 25000, stage: 'new' },
      { name: 'Bob Smith', company: 'Globex', value: 40000, stage: 'new' },
      { name: 'Carol Davis', company: 'Initech', value: 55000, stage: 'qualified' },
      { name: 'Dave Wilson', company: 'Umbrella', value: 32000, stage: 'qualified' },
      { name: 'Eve Brown', company: 'Wayne Ent', value: 78000, stage: 'closed' },
      { name: 'Frank Lee', company: 'Stark Ind', value: 95000, stage: 'closed' },
    ])
    manager.queryApiData(surfaceId, 'Lead', {}, '/leads')
    manager.updateComponents(surfaceId, [
      { id: 'root', component: 'Column', children: ['header', 'board'], gap: 'lg' },
      { id: 'header', component: 'Row', children: ['title', 'badge'], align: 'center', justify: 'between' },
      { id: 'title', component: 'Text', text: 'CRM Pipeline', variant: 'h2' },
      { id: 'badge', component: 'Badge', text: 'where prop test', variant: 'outline' },
      { id: 'board', component: 'Grid', columns: 3, gap: 'md', children: ['new_col', 'qual_col', 'closed_col'] },
      { id: 'new_col', component: 'Card', title: 'New', child: 'new_list' },
      { id: 'new_list', component: 'DataList', children: { path: '/leads', templateId: 'lead_card' }, where: { stage: 'new' }, emptyText: 'No new leads' },
      { id: 'qual_col', component: 'Card', title: 'Qualified', child: 'qual_list' },
      { id: 'qual_list', component: 'DataList', children: { path: '/leads', templateId: 'lead_card' }, where: { stage: 'qualified' }, emptyText: 'No qualified leads' },
      { id: 'closed_col', component: 'Card', title: 'Closed', child: 'closed_list' },
      { id: 'closed_list', component: 'DataList', children: { path: '/leads', templateId: 'lead_card' }, where: { stage: 'closed' }, emptyText: 'No closed leads' },
      { id: 'lead_card', component: 'Card', title: { path: 'name' }, description: { path: 'company' }, children: ['lead_actions'] },
      { id: 'lead_actions', component: 'Row', children: ['lead_value', 'lead_qualify_btn', 'lead_close_btn', 'lead_back_btn', 'lead_del_btn'], align: 'center', gap: 'sm' },
      { id: 'lead_value', component: 'Text', text: { path: 'value' }, variant: 'muted' },
      { id: 'lead_qualify_btn', component: 'Button', label: 'Qualify', size: 'sm', variant: 'outline', action: { name: 'qualify', mutation: {
        endpoint: '/api/leads/:id', method: 'PATCH', body: { stage: 'qualified' }, params: { id: { path: 'id' } },
      } } },
      { id: 'lead_close_btn', component: 'Button', label: 'Close', size: 'sm', variant: 'default', action: { name: 'close', mutation: {
        endpoint: '/api/leads/:id', method: 'PATCH', body: { stage: 'closed' }, params: { id: { path: 'id' } },
      } } },
      { id: 'lead_back_btn', component: 'Button', label: 'Back', size: 'sm', variant: 'outline', action: { name: 'back_to_new', mutation: {
        endpoint: '/api/leads/:id', method: 'PATCH', body: { stage: 'new' }, params: { id: { path: 'id' } },
      } } },
      { id: 'lead_del_btn', component: 'Button', label: 'Delete', size: 'sm', variant: 'destructive', action: { name: 'delete', mutation: {
        endpoint: '/api/leads/:id', method: 'DELETE', params: { id: { path: 'id' } },
      } } },
    ] as any)
    return c.json({ ok: true, surfaceId })

  } else if (scenario === 'pipeline-queries') {
    const surfaceId = 'test_pipeline_queries'
    manager.createSurface(surfaceId, 'Pipeline (server queries)')
    manager.applyApiSchema(surfaceId, [
      { name: 'Lead', fields: [
        { name: 'name', type: 'String' },
        { name: 'company', type: 'String' },
        { name: 'value', type: 'Float' },
        { name: 'stage', type: 'String', default: 'new' },
      ] },
    ])
    manager.seedApiData(surfaceId, 'Lead', [
      { name: 'Alice Chen', company: 'Acme Corp', value: 25000, stage: 'new' },
      { name: 'Bob Smith', company: 'Globex', value: 40000, stage: 'new' },
      { name: 'Carol Davis', company: 'Initech', value: 55000, stage: 'qualified' },
      { name: 'Dave Wilson', company: 'Umbrella', value: 32000, stage: 'qualified' },
      { name: 'Eve Brown', company: 'Wayne Ent', value: 78000, stage: 'closed' },
      { name: 'Frank Lee', company: 'Stark Ind', value: 95000, stage: 'closed' },
    ])
    manager.queryApiData(surfaceId, 'Lead', { where: { stage: 'new' } }, '/newLeads')
    manager.queryApiData(surfaceId, 'Lead', { where: { stage: 'qualified' } }, '/qualifiedLeads')
    manager.queryApiData(surfaceId, 'Lead', { where: { stage: 'closed' } }, '/closedLeads')
    manager.updateComponents(surfaceId, [
      { id: 'root', component: 'Column', children: ['header', 'board'], gap: 'lg' },
      { id: 'header', component: 'Row', children: ['title', 'badge'], align: 'center', justify: 'between' },
      { id: 'title', component: 'Text', text: 'CRM Pipeline', variant: 'h2' },
      { id: 'badge', component: 'Badge', text: 'server queries test', variant: 'outline' },
      { id: 'board', component: 'Grid', columns: 3, gap: 'md', children: ['new_col', 'qual_col', 'closed_col'] },
      { id: 'new_col', component: 'Card', title: 'New', child: 'new_list' },
      { id: 'new_list', component: 'DataList', children: { path: '/newLeads', templateId: 'lead_card' }, emptyText: 'No new leads' },
      { id: 'qual_col', component: 'Card', title: 'Qualified', child: 'qual_list' },
      { id: 'qual_list', component: 'DataList', children: { path: '/qualifiedLeads', templateId: 'lead_card' }, emptyText: 'No qualified leads' },
      { id: 'closed_col', component: 'Card', title: 'Closed', child: 'closed_list' },
      { id: 'closed_list', component: 'DataList', children: { path: '/closedLeads', templateId: 'lead_card' }, emptyText: 'No closed leads' },
      { id: 'lead_card', component: 'Card', title: { path: 'name' }, description: { path: 'company' }, children: ['lead_actions'] },
      { id: 'lead_actions', component: 'Row', children: ['lead_value', 'lead_qualify_btn', 'lead_close_btn', 'lead_del_btn'], align: 'center', gap: 'sm' },
      { id: 'lead_value', component: 'Text', text: { path: 'value' }, variant: 'muted' },
      { id: 'lead_qualify_btn', component: 'Button', label: 'Qualify', size: 'sm', variant: 'outline', action: { name: 'qualify', mutation: {
        endpoint: '/api/leads/:id', method: 'PATCH', body: { stage: 'qualified' }, params: { id: { path: 'id' } },
      } } },
      { id: 'lead_close_btn', component: 'Button', label: 'Close', size: 'sm', variant: 'default', action: { name: 'close', mutation: {
        endpoint: '/api/leads/:id', method: 'PATCH', body: { stage: 'closed' }, params: { id: { path: 'id' } },
      } } },
      { id: 'lead_del_btn', component: 'Button', label: 'Delete', size: 'sm', variant: 'destructive', action: { name: 'delete', mutation: {
        endpoint: '/api/leads/:id', method: 'DELETE', params: { id: { path: 'id' } },
      } } },
    ] as any)
    return c.json({ ok: true, surfaceId })
  }

  return c.json({ error: `Unknown scenario "${scenario}". Available: expense-form, pipeline-where, pipeline-queries` }, 400)
})

// Proxy requests to managed API runtimes (per-surface data layer)
app.all('/agent/dynamic-app/api/:surfaceId/*', async (c) => {
  const surfaceId = c.req.param('surfaceId')
  const manager = getDynamicAppManager()

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

  // Try tool-backed runtime first, then SQLite-backed runtime
  const toolRuntime = manager.getToolRuntime(surfaceId)
  if (toolRuntime) {
    const toolResponse = await toolRuntime.getApp().fetch(subRequest.clone())
    if (toolResponse.status !== 404) return toolResponse
  }

  const runtime = manager.getRuntime(surfaceId)
  if (!runtime || !runtime.isReady()) {
    if (!toolRuntime) {
      return c.json({ error: `No API runtime for surface "${surfaceId}"` }, 404)
    }
    return c.json({ error: `Route not found` }, 404)
  }

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

if (IS_POOL_MODE && !poolAssigned) {
  logTiming('Pool mode: skipping project init, server ready for assignment')
} else {
  // Runs for both normal (non-pool) startup AND self-assigned cold-start pods.
  // Self-assigned pods have poolAssigned=true and need full init to restore
  // their workspace from S3 and start the gateway.
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
