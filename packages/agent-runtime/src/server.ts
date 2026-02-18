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
import { z } from 'zod'
import { resolve, dirname, join } from 'path'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'fs'
import {
  initializeS3Sync,
  initializePostgresBackup,
  verifyPreviewToken,
  configureAIProxy,
  buildClaudeCodeEnv,
  createSessionManager,
  extractUserText,
  findLastUserMessage,
  streamSdkToUI,
  type ModelTier,
  type V2SessionOptions,
} from '@shogo/shared-runtime'
import { buildAgentSystemPrompt } from './system-prompt'
import { AgentGateway } from './gateway'
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
  mkdirSync(AGENT_DIR, { recursive: true })
  mkdirSync(join(AGENT_DIR, 'memory'), { recursive: true })
  mkdirSync(join(AGENT_DIR, 'skills'), { recursive: true })

  const defaults: Record<string, string> = {
    'AGENTS.md': `# Agent Instructions

## Core Behavior
- Respond concisely and helpfully
- When monitoring detects issues, alert immediately
- Batch non-urgent updates

## Priorities
1. Urgent alerts — respond immediately
2. Scheduled checks — run on heartbeat
3. User messages — respond promptly
`,
    'SOUL.md': `# Soul

You are a helpful, reliable AI agent. You communicate clearly and concisely.
You always explain what you're about to do before taking action.

## Boundaries
- Never execute destructive commands without explicit confirmation
- Never share credentials in channel messages
- Respect quiet hours for non-urgent notifications
`,
    'IDENTITY.md': `# Identity

- **Name:** Agent
- **Emoji:** 🤖
- **Tagline:** Your personal AI assistant
`,
    'USER.md': `# User

- **Name:** (not set)
- **Timezone:** UTC
`,
    'HEARTBEAT.md': '',
    'TOOLS.md': `# Tools

Notes about available tools and conventions for this agent.
`,
    'MEMORY.md': `# Memory

Long-lived facts and learnings are stored here.
`,
    'config.json': JSON.stringify(
      {
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: {
          provider: 'anthropic',
          name: 'claude-sonnet-4-5',
        },
      },
      null,
      2
    ),
  }

  for (const [filename, content] of Object.entries(defaults)) {
    const filepath = join(AGENT_DIR, filename)
    if (!existsSync(filepath)) {
      writeFileSync(filepath, content, 'utf-8')
      logTiming(`Created default ${filename}`)
    }
  }
}

// =============================================================================
// AI Proxy Configuration
// =============================================================================

let aiProxy = configureAIProxy({ logPrefix: 'agent-runtime' })
if (aiProxy.useProxy) {
  Object.assign(process.env, aiProxy.env)
}
let claudeCodeEnv = buildClaudeCodeEnv(aiProxy, {
  PROJECT_ID: currentProjectId!,
  AGENT_DIR,
  RUNTIME_PORT: String(PORT),
})

// =============================================================================
// Claude Code Session Management
// =============================================================================

function getModelFromAgentMode(agentMode?: string): ModelTier {
  if (agentMode === 'haiku' || agentMode === 'fast') return 'haiku'
  if (agentMode === 'opus' || agentMode === 'deep') return 'opus'
  return 'sonnet'
}

function buildAgentSessionOptions(modelName: ModelTier): V2SessionOptions {
  const model =
    modelName === 'haiku'
      ? 'claude-haiku-4-5-20251001'
      : modelName === 'opus'
        ? 'claude-opus-4-6'
        : 'claude-sonnet-4-5-20250929'

  return {
    model,
    cwd: AGENT_DIR,
    allowedTools: [
      'Read', 'Write', 'Edit', 'MultiEdit', 'Bash',
      'TodoWrite', 'Glob', 'Grep', 'mcp__shogo__*',
    ],
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    settingSources: ['project' as const, 'local' as const],
    includePartialMessages: true,
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
    canUseTool: async (toolName: string, input: Record<string, unknown>) => {
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
        const path = input?.file_path as string
        if (path) {
          const resolved = resolve(AGENT_DIR, path)
          if (!resolved.startsWith(AGENT_DIR) && !resolved.startsWith('/tmp')) {
            return { behavior: 'deny' as const, message: 'Path outside allowed directories' }
          }
        }
      }
      return { behavior: 'allow' as const }
    },
    env: claudeCodeEnv,
  }
}

let sessions = createSessionManager({
  buildSessionOptions: buildAgentSessionOptions,
  defaultModel: (process.env.AGENT_MODEL || 'sonnet') as ModelTier,
  logPrefix: 'agent-runtime',
})

// =============================================================================
// Write CLAUDE.md for Claude Code to load
// =============================================================================

function writeAgentConfigFiles(): void {
  const claudeMdPath = resolve(AGENT_DIR, 'CLAUDE.md')
  const systemPromptContent = buildAgentSystemPrompt(AGENT_DIR)
  writeFileSync(claudeMdPath, systemPromptContent, 'utf-8')
  logTiming('Wrote CLAUDE.md')

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

// =============================================================================
// Hono Server
// =============================================================================

const app = new Hono()

app.use('*', cors({ origin: '*' }))

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
  aiProxy = configureAIProxy({ logPrefix: 'agent-runtime' })
  if (aiProxy.useProxy) {
    Object.assign(process.env, aiProxy.env)
  }
  claudeCodeEnv = buildClaudeCodeEnv(aiProxy, {
    PROJECT_ID: currentProjectId,
    AGENT_DIR,
    RUNTIME_PORT: String(PORT),
  })

  // 4. Recreate session manager with updated config
  sessions = createSessionManager({
    buildSessionOptions: buildAgentSessionOptions,
    defaultModel: (process.env.AGENT_MODEL || 'sonnet') as ModelTier,
    logPrefix: 'agent-runtime',
  })

  // 5. Run project-specific initialization
  try {
    await initialize()
    poolAssigned = true
    const duration = Date.now() - startTime
    logTiming(`Pool assignment complete for ${projectId} (${duration}ms)`)
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

// Builder chat endpoint — same pattern as project-runtime
const chatSchema = z.object({
  messages: z.array(z.any()),
  system: z.string().optional(),
  agentMode: z.string().optional(),
  themeContext: z.string().optional(),
})

app.post('/agent/chat', async (c) => {
  const body = await c.req.json()
  console.log('[agent-runtime] /agent/chat received body keys:', Object.keys(body))
  console.log('[agent-runtime] messages count:', body.messages?.length, 'first msg role:', body.messages?.[0]?.role)
  const lastMsg = body.messages?.slice(-1)?.[0]
  console.log('[agent-runtime] last msg:', JSON.stringify(lastMsg).slice(0, 500))
  const parsed = chatSchema.safeParse(body)
  if (!parsed.success) {
    console.log('[agent-runtime] Parse failed:', JSON.stringify(parsed.error.issues.map(i => i.message)))
    return c.json({ error: 'Invalid request', details: parsed.error }, 400)
  }

  const { messages, system, agentMode } = parsed.data
  const modelName = getModelFromAgentMode(agentMode)

  if (sessions.isActive(modelName)) {
    await sessions.interrupt(modelName)
  }

  const session = sessions.getOrCreate(modelName)

  const lastUserMessage = findLastUserMessage(messages)
  if (!lastUserMessage) {
    return c.json({ error: 'No user message found' }, 400)
  }

  const userText = extractUserText(lastUserMessage)

  const agentStatus = agentGateway?.getStatus()
  let contextPrefix = ''
  if (agentStatus) {
    contextPrefix += `[Agent Status]\nRunning: ${agentStatus.running}\nChannels: ${agentStatus.channels.length} connected\nHeartbeat: ${agentStatus.heartbeat.enabled ? `every ${agentStatus.heartbeat.intervalSeconds}s` : 'disabled'}\n\n`
  }
  if (system) {
    contextPrefix += `[Additional Instructions]\n${system}\n\n`
  }
  const fullUserText = contextPrefix ? `${contextPrefix}${userText}` : userText

  sessions.markActive(modelName)

  console.log('[agent-runtime] Sending to session:', fullUserText.slice(0, 200))
  await session.send(fullUserText)

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        await streamSdkToUI(session, writer, {
          logPrefix: 'agent-runtime',
          onQueryCreated: (query) => sessions.setActiveQuery(modelName, query),
        })
      } catch (error: any) {
        console.error('[agent-runtime] Chat error:', error.message)
        writer.write({
          type: 'error',
          errorText: error.message || 'Agent chat error',
        } as any)
      } finally {
        sessions.markInactive(modelName)
        sessions.deleteActiveQuery(modelName)
      }
    },
  })

  return createUIMessageStreamResponse({ stream })
})

// Test chat endpoint — send a message to the running agent (not the builder)
app.post('/agent/test', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const { message } = await c.req.json()
  if (!message || typeof message !== 'string') {
    return c.json({ error: 'message (string) is required' }, 400)
  }

  try {
    const response = await agentGateway.processTestMessage(message)
    return c.json({ response })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
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

async function initialize(): Promise<void> {
  logTiming('Initializing...')

  // Bootstrap workspace files
  ensureWorkspaceFiles()
  logTiming('Workspace files ready')

  // Write CLAUDE.md and .mcp.json
  writeAgentConfigFiles()

  // Initialize S3 sync if configured
  if (process.env.S3_WORKSPACES_BUCKET || process.env.S3_BUCKET) {
    try {
      const result = await initializeS3Sync(AGENT_DIR)
      if (result) {
        logTiming('S3 sync initialized')
      }
    } catch (error: any) {
      console.error('[agent-runtime] S3 sync init failed:', error.message)
    }
  }

  // Initialize Postgres backup if configured
  if (process.env.DATABASE_URL && (process.env.S3_WORKSPACES_BUCKET || process.env.S3_BUCKET)) {
    try {
      const pgBackup = await initializePostgresBackup()
      if (pgBackup) {
        logTiming('Postgres backup initialized')
      }
    } catch (error: any) {
      console.error(
        '[agent-runtime] Postgres backup init failed:',
        error.message
      )
    }
  }

  // Start agent gateway
  agentGateway = new AgentGateway(AGENT_DIR, currentProjectId!)
  await agentGateway.start()
  logTiming('Agent gateway started')
}

// =============================================================================
// Start Server
// =============================================================================

if (IS_POOL_MODE) {
  // Pool mode: skip project-specific initialization, just start the server.
  // Pre-warm Claude Code session eagerly so it's hot when a project is assigned.
  logTiming('Pool mode: skipping project init, server ready for assignment')
  setTimeout(() => {
    sessions.prewarm().catch((err) => {
      console.error('[agent-runtime] Pool pre-warm error:', err.message)
    })
  }, 1000)
} else {
  // Normal mode: run full project-specific initialization
  initialize()
    .then(() => {
      logTiming(`Starting server on port ${PORT}`)
    })
    .catch((error) => {
      console.error('[agent-runtime] Initialization failed:', error)
    })

  setTimeout(() => {
    sessions.prewarm().catch((err) => {
      console.error('[agent-runtime] Pre-warm error:', err.message)
    })
  }, 2000)
}

export default {
  port: PORT,
  fetch: app.fetch,
}
