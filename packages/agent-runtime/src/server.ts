// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Runtime Server
 *
 * Runs inside each agent's Knative pod, providing:
 * - Claude Code agent with agent-building MCP tools
 * - Agent Gateway process (heartbeat, channels, skills)
 * - Health check endpoint for Kubernetes probes
 * - S3 file synchronization for persistent storage
 *
 * This mirrors runtime but replaces the Vite dev server
 * with an Agent Gateway that makes the configured agent "alive."
 */

import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { resolve, dirname, join, extname } from 'path'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  statSync,
  rmSync,
  renameSync,
  cpSync,
} from 'fs'
import {
  createRuntimeApp, traceOperation,
  initializeS3Sync,
  initializePostgresBackup,
  configureAIProxy,
  StreamBufferStore,
} from '@shogo/shared-runtime'
import { getModelTier, resolveModelId } from '@shogo/model-catalog'
import { seedWorkspaceDefaults, seedWorkspaceFromTemplate, seedLSPConfig, seedRuntimeTemplate, ensureWorkspaceDeps, seedTechStack, runTechStackSetup } from './workspace-defaults'
import { AgentGateway } from './gateway'
import { deriveApiUrl, getInternalHeaders } from './internal-api'
import { userMessage } from './pi-adapter'
import { fileURLToPath } from 'url'
import { WebChatAdapter } from './channels/webchat'
import { WebhookAdapter } from './channels/webhook'
import { pushCanvasRuntimeError, getCanvasRuntimeErrors, clearCanvasRuntimeErrors } from './canvas-runtime-errors'
import { WhatsAppAdapter } from './channels/whatsapp'
import { TeamsAdapter } from './channels/teams'
import { CanvasFileWatcher } from './canvas-file-watcher'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MONOREPO_ROOT = resolve(__dirname, '../../..')

// =============================================================================
// Configuration
// =============================================================================

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.env.AGENT_DIR || process.env.PROJECT_DIR || '/app/workspace'
const SCHEMAS_PATH = process.env.SCHEMAS_PATH || '/app/.schemas'
const PORT = parseInt(process.env.PORT || '8080', 10)

async function reportHeartbeatComplete(projectId: string): Promise<void> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return

  const url = `${apiUrl}/api/internal/heartbeat/complete`
  const res = await fetch(url, {
    method: 'POST',
    headers: getInternalHeaders(),
    body: JSON.stringify({ projectId }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`Heartbeat complete report failed: HTTP ${res.status}`)
  }
}

// =============================================================================
// Shared Server Framework (handles OTEL, CORS, auth, health, pool/assign)
// =============================================================================

let agentGateway: AgentGateway | null = null
let s3SyncInstance: import('@shogo/shared-runtime').S3Sync | null = null

const { app, state, logTiming } = await createRuntimeApp({
  name: 'agent-runtime',
  workDir: WORKSPACE_DIR,
  runtimeType: 'unified',
  internalPaths: ['/agent/heartbeat/trigger'],
  authPrefixes: ['/agent', '/pool'],
  async onAssign(projectId, envVars) {
    // Clean workspace to prevent cross-project file leakage
    for (const subdir of ['files', 'memory', 'skills']) {
      const dirPath = join(WORKSPACE_DIR, subdir)
      if (existsSync(dirPath)) {
        rmSync(dirPath, { recursive: true, force: true })
        mkdirSync(dirPath, { recursive: true })
      }
    }

    // Run essential initialization (workspace files, S3 sync, config)
    await initializeEssentials()

    // Start gateway in background — don't block the assign response
    startGateway().catch((error) => {
      console.error(`[agent-runtime] Background gateway start failed for ${projectId}:`, error.message)
    })
  },
  getActivityStats() {
    const sm = agentGateway?.getSessionManager()
    const stats = sm?.getAllStats() ?? []
    const now = Date.now()
    const lastSessionActivity = stats.reduce(
      (max: number, s) => Math.max(max, now - (s.idleSeconds ?? 0) * 1000),
      state.poolAssignedAt ?? state.serverStartTime
    )
    return { activeSessions: stats.length, lastActivityAt: lastSessionActivity }
  },
  getHealthExtra: () => ({
    gateway: agentGateway?.getStatus() ?? null,
  }),
})

// Readiness probe
app.get('/ready', (c) => c.json({ ready: true }))

// =============================================================================
// Agent Workspace Bootstrap
// =============================================================================

function ensureWorkspaceFiles(): void {
  const templateMarker = join(WORKSPACE_DIR, '.template')
  const templateIdFromEnv = process.env.TEMPLATE_ID
  const templateIdFromFile = existsSync(templateMarker) ? readFileSync(templateMarker, 'utf-8').trim() : undefined
  const templateId = templateIdFromEnv || templateIdFromFile

  if (templateId) {
    const seeded = seedWorkspaceFromTemplate(WORKSPACE_DIR, templateId, process.env.AGENT_NAME)
    if (seeded) {
      logTiming(`Workspace seeded from template: ${templateId}`)
    } else {
      logTiming(`Template "${templateId}" not found, falling back to defaults`)
      seedWorkspaceDefaults(WORKSPACE_DIR)
      seedLSPConfig(WORKSPACE_DIR)
      logTiming('Workspace defaults seeded')
    }
  } else {
    seedWorkspaceDefaults(WORKSPACE_DIR)
    seedLSPConfig(WORKSPACE_DIR)
    logTiming('Workspace defaults seeded')
  }

  // Migrate legacy APP layout: if package.json exists at workspace root (no AGENTS.md),
  // this is a legacy APP project — move app files into project/ subdirectory
  const legacyPkgJson = join(WORKSPACE_DIR, 'package.json')
  const agentsMd = join(WORKSPACE_DIR, 'AGENTS.md')
  if (existsSync(legacyPkgJson) && !existsSync(agentsMd)) {
    const projectDir = join(WORKSPACE_DIR, 'project')
    mkdirSync(projectDir, { recursive: true })
    const appFiles = ['package.json', 'bun.lock', 'tsconfig.json', 'vite.config.ts', 'tailwind.config.ts', 'postcss.config.js', 'components.json', '.gitignore']
    for (const f of appFiles) {
      const src = join(WORKSPACE_DIR, f)
      if (existsSync(src)) renameSync(src, join(projectDir, f))
    }
    for (const d of ['src', 'prisma', 'dist', 'public', 'node_modules']) {
      const src = join(WORKSPACE_DIR, d)
      if (existsSync(src)) renameSync(src, join(projectDir, d))
    }
    seedWorkspaceDefaults(WORKSPACE_DIR)
    logTiming('Migrated legacy APP layout into project/ subdirectory')
  }

  // Seed tech stack if specified via env var or marker file.
  // For backward compat: existing canvasMode 'code' projects without a tech stack get react-app.
  const techStackMarker = join(WORKSPACE_DIR, '.tech-stack')
  const techStackIdFromEnv = process.env.TECH_STACK_ID
  const techStackIdFromFile = existsSync(techStackMarker) ? readFileSync(techStackMarker, 'utf-8').trim() : undefined
  let techStackId = techStackIdFromEnv || techStackIdFromFile

  if (!techStackId) {
    for (const configCandidate of [join(WORKSPACE_DIR, 'config.json'), join(WORKSPACE_DIR, '.shogo', 'config.json')]) {
      if (existsSync(configCandidate)) {
        try {
          const config = JSON.parse(readFileSync(configCandidate, 'utf-8'))
          if (config.canvasMode === 'code') {
            techStackId = 'react-app'
            break
          }
        } catch { /* ignore parse errors */ }
      }
    }
  }

  if (techStackId) {
    seedTechStack(WORKSPACE_DIR, techStackId)
    logTiming(`Tech stack seeded: ${techStackId}`)
  }

  // Seed runtime-template (Vite + React + Tailwind + shadcn/ui) if not already present
  // and the tech stack is a JS/Node-based stack (or react-app specifically).
  // For non-JS stacks like python-data, we skip the runtime template.
  const jsStacks = new Set(['react-app', 'threejs-game', 'phaser-game'])
  if (!techStackId || jsStacks.has(techStackId)) {
    seedRuntimeTemplate(WORKSPACE_DIR)
  }
}

// AI proxy is configured by the shared framework (state.aiProxy)

// =============================================================================
// Agent Gateway Instance
// =============================================================================

let gatewayReadyResolve: (() => void) | null = null
let gatewayReadyPromise: Promise<void> | null = null

// =============================================================================
// Stream Buffer Store (SSE reconnect support)
// =============================================================================

const streamBufferStore = new StreamBufferStore()

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

// Hono app, CORS, auth middleware, /health, /pool/activity, /pool/assign are
// provided by createRuntimeApp(). Agent-specific routes follow below.

// Register WhatsApp webhook routes (must be before any auth middleware)
WhatsAppAdapter.registerWebhookRoutes(app)

// Register Webhook/HTTP channel routes
WebhookAdapter.registerRoutes(app, () => {
  if (!agentGateway) return null
  const adapter = agentGateway.getChannel('webhook')
  return adapter && adapter.getStatus().connected ? adapter as any : null
})

// Hot-connect a channel at runtime (called by MCP tool after writing config.json)
app.post('/agent/channels/hot-connect', async (c) => {
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
TeamsAdapter.registerRoutes(app, () => {
  if (!agentGateway) return undefined
  return agentGateway.getChannel('teams') as any
})

// Register WebChat embeddable widget routes
WebChatAdapter.registerRoutes(app, () => {
  if (!agentGateway) return null
  const adapter = agentGateway.getChannel('webchat')
  return adapter && adapter.getStatus().connected ? adapter as any : null
})

// /health, /ready, /pool/activity, /pool/assign are provided by createRuntimeApp()

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

// Read agent config
app.get('/agent/config', (c) => {
  const configPath = join(WORKSPACE_DIR, 'config.json')
  try {
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      return c.json(config)
    }
  } catch {}
  return c.json({})
})

// Update agent config — deep-merge fields into config.json and hot-reload the gateway
app.patch('/agent/config', async (c) => {
  const body = await c.req.json() as Record<string, unknown>
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Request body must be a JSON object' }, 400)
  }
  try {
    const configPath = join(WORKSPACE_DIR, 'config.json')
    let fileConfig: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      try {
        fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch {
        fileConfig = {}
      }
    }

    // Support flat convenience aliases for the nested model key
    if (('modelName' in body || 'modelProvider' in body) && !('model' in body)) {
      const existing = (fileConfig.model ?? {}) as Record<string, string>
      body.model = {
        ...existing,
        ...(body.modelName ? { name: body.modelName as string } : {}),
        ...(body.modelProvider ? { provider: body.modelProvider as string } : {}),
      }
      delete body.modelName
      delete body.modelProvider
    }

    // Deep merge (one level) for known nested object keys so partial
    // updates like { model: { name: "..." } } preserve existing fields
    const NESTED_KEYS = ['model', 'quietHours', 'session', 'loopDetection', 'streamChunk', 'sandbox'] as const
    for (const key of NESTED_KEYS) {
      if (key in body && body[key] && typeof body[key] === 'object' && !Array.isArray(body[key])
          && fileConfig[key] && typeof fileConfig[key] === 'object' && !Array.isArray(fileConfig[key])) {
        body[key] = { ...(fileConfig[key] as any), ...(body[key] as any) }
      }
    }

    Object.assign(fileConfig, body)
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')
    agentGateway?.reloadConfig()

    // Sync heartbeat fields to the API's agent_configs DB table so the
    // local scheduler picks them up. Fire-and-forget.
    if ('heartbeatEnabled' in body || 'heartbeatInterval' in body) {
      const toolsProxyUrl = process.env.TOOLS_PROXY_URL
      const projectId = state.currentProjectId || process.env.PROJECT_ID
      const runtimeToken = process.env.RUNTIME_AUTH_SECRET
      if (toolsProxyUrl && projectId && runtimeToken) {
        const apiBase = toolsProxyUrl.replace(/\/api(\/.*)?$/, '/api')
        fetch(`${apiBase}/projects/${projectId}/heartbeat/sync`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-runtime-token': runtimeToken },
          body: JSON.stringify({
            heartbeatEnabled: fileConfig.heartbeatEnabled,
            heartbeatInterval: fileConfig.heartbeatInterval,
          }),
        }).catch(() => {})
      }
    }

    return c.json({ ok: true })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to update config' }, 500)
  }
})

// Channel connect — persist to config.json and hot-connect via the gateway
app.post('/agent/channels/connect', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const { type, config: channelConfig, model } = await c.req.json() as {
    type: string
    config: Record<string, string>
    model?: string
  }

  if (!type || !channelConfig) {
    return c.json({ error: 'type and config are required' }, 400)
  }

  const validTypes = ['telegram', 'discord', 'slack', 'whatsapp', 'email', 'webhook', 'webchat', 'teams']
  if (!validTypes.includes(type)) {
    return c.json({ error: `Invalid channel type: ${type}. Must be one of: ${validTypes.join(', ')}` }, 400)
  }

  const channelModel = (model === 'basic' || model === 'advanced') ? model : 'basic'

  if (channelModel === 'advanced') {
    const proxyUrl = process.env.AI_PROXY_URL
    const proxyToken = process.env.AI_PROXY_TOKEN
    if (proxyUrl && proxyToken) {
      try {
        const accessUrl = `${proxyUrl.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '/v1')}/access`
        const accessRes = await fetch(accessUrl, {
          headers: { 'Authorization': `Bearer ${proxyToken}` },
          signal: AbortSignal.timeout(5000),
        })
        if (accessRes.ok) {
          const access = await accessRes.json() as { hasAdvancedModelAccess?: boolean }
          if (!access.hasAdvancedModelAccess) {
            return c.json({ error: 'Advanced model requires a Pro or higher subscription. Use "basic" or upgrade your plan.' }, 403)
          }
        }
      } catch {
        return c.json({ error: 'Unable to verify plan access. Please try again.' }, 503)
      }
    }
  }

  try {
    const configPath = join(WORKSPACE_DIR, 'config.json')
    let fileConfig: Record<string, any> = {}
    if (existsSync(configPath)) {
      try {
        fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch {
        console.error('[agent-runtime] config.json is invalid JSON, starting with empty config')
        fileConfig = {}
      }
    }

    fileConfig.channels = fileConfig.channels || []
    const channelEntry = { type, config: channelConfig, model: channelModel }
    const existing = fileConfig.channels.findIndex((ch: any) => ch.type === type)
    if (existing >= 0) {
      fileConfig.channels[existing] = channelEntry
    } else {
      fileConfig.channels.push(channelEntry)
    }

    await agentGateway.connectChannel(type, channelConfig)

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')

    return c.json({ ok: true, type, message: `${type} channel connected` })
  } catch (error: any) {
    return c.json({ error: error.message || `Failed to connect ${type}` }, 500)
  }
})

// Update channel model — change model tier without reconnecting
app.patch('/agent/channels/:type/model', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const type = c.req.param('type')
  const { model } = await c.req.json() as { model: string }

  if (!model || typeof model !== 'string') {
    return c.json({ error: 'model must be a valid model ID string' }, 400)
  }

  const resolvedModel = resolveModelId(model)
  const tier = getModelTier(resolvedModel)
  if (tier !== 'economy') {
    const proxyUrl = process.env.AI_PROXY_URL
    const proxyToken = process.env.AI_PROXY_TOKEN
    if (proxyUrl && proxyToken) {
      try {
        const accessUrl = `${proxyUrl.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '/v1')}/access`
        const accessRes = await fetch(accessUrl, {
          headers: { 'Authorization': `Bearer ${proxyToken}` },
          signal: AbortSignal.timeout(5000),
        })
        if (accessRes.ok) {
          const access = await accessRes.json() as { hasAdvancedModelAccess?: boolean }
          if (!access.hasAdvancedModelAccess) {
            return c.json({ error: `Model '${model}' requires a Pro or higher subscription.` }, 403)
          }
        }
      } catch {
        return c.json({ error: 'Unable to verify plan access. Please try again.' }, 503)
      }
    }
  }

  try {
    const configPath = join(WORKSPACE_DIR, 'config.json')
    let fileConfig: Record<string, any> = {}
    if (existsSync(configPath)) {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
    }

    const channels = fileConfig.channels || []
    const idx = channels.findIndex((ch: any) => ch.type === type)
    if (idx < 0) {
      return c.json({ error: `Channel "${type}" not found in config` }, 404)
    }

    channels[idx].model = model
    fileConfig.channels = channels
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')
    agentGateway.reloadConfig()

    return c.json({ ok: true, type, model })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to update model' }, 500)
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

    const configPath = join(WORKSPACE_DIR, 'config.json')
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
  if (!agentGateway || gatewayReadyPromise) {
    if (gatewayReadyPromise) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Gateway startup timeout')), 30_000)
      )
      try {
        await Promise.race([gatewayReadyPromise, timeout])
      } catch {
        return c.json({ error: 'Agent gateway still starting, please retry' }, 503)
      }
    }
    if (!agentGateway) {
      return c.json({ error: 'Agent gateway not running' }, 503)
    }
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

  // Save uploaded files to the agent's files/ directory so they're accessible
  // to the agent via its workspace tools (read_file, list_files, etc.)
  if (userFileParts.length > 0) {
    mkdirSync(FILES_DIR, { recursive: true })
    const savedPaths: string[] = []
    for (const fp of userFileParts) {
      try {
        const url = fp.url!
        const base64Match = url.match(/^data:[^;]*;base64,(.+)$/)
        if (!base64Match) continue

        const mediaType = fp.mediaType || 'application/octet-stream'
        const ext = mimeToExtension(mediaType)
        const baseName = fp.name
          ? fp.name.replace(/[^a-zA-Z0-9._-]/g, '_')
          : `upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`
        const resolved = resolveFilesPath(baseName)
        if (!resolved) continue

        const dir = dirname(resolved)
        mkdirSync(dir, { recursive: true })
        writeFileSync(resolved, Buffer.from(base64Match[1], 'base64'))
        savedPaths.push(baseName)
        console.log(`[AgentChat] Saved uploaded file to files/${baseName}`)

        try { getIndexEngine().indexFile('files', baseName).catch(() => {}) } catch { /* best-effort */ }
      } catch (err: any) {
        console.error(`[AgentChat] Failed to save uploaded file:`, err.message)
      }
    }
    if (savedPaths.length > 0) {
      const note = savedPaths.map(p => `files/${p}`).join(', ')
      userText = (userText || '') + `\n\n[Uploaded file(s) saved to workspace: ${note}]`
    }
  }

  // Use the DB chatSessionId as the runtime session key so that different
  // chat sessions within the same project get isolated conversation history.
  const chatSessionKey = body.chatSessionId || 'chat'

  // Seed the chat session with prior conversation history from the request.
  // AI SDK clients and eval runners send the full message array each turn;
  // the session is the authoritative store so we only seed when it's empty
  // to avoid duplicating messages on subsequent turns.
  if (allMessages.length > 1) {
    const sessionMgr = agentGateway!.getSessionManager()
    const session = sessionMgr.getOrCreate(chatSessionKey)
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
            sessionMgr.addMessages(chatSessionKey, userMessage(effectiveText))
          } else {
            if (!text) continue
            sessionMgr.addMessages(chatSessionKey, userMessage(text))
          }
        } else if (msg.role === 'assistant') {
          if (!text) continue
          sessionMgr.addMessages(chatSessionKey, {
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

  const modelOverride = (body.agentMode as string | undefined) || undefined
  const interactionMode = body.interactionMode as 'agent' | 'plan' | 'ask' | undefined
  const confirmedPlan = body.confirmedPlan || undefined

  if (body.timezone && typeof body.timezone === 'string') {
    agentGateway!.setUserTimezone(body.timezone)
  }

  const chatUserId = c.req.header('X-User-Id') || body.userId || undefined

  // Create a buffer that lives independently of the HTTP connection.
  // The agent writes into this buffer via a background consumer so that
  // a client disconnect (e.g. page refresh) does NOT cancel the agent.
  console.log(`[AgentChat] Creating stream buffer for session: ${chatSessionKey}`)
  const bufWriter = streamBufferStore.create(chatSessionKey)

  trackStreamStart()
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        writer.write({ type: 'start-step' })
        await agentGateway!.processChatMessageStream(userText || '', writer, {
          modelOverride,
          fileParts: userFileParts.length > 0 ? userFileParts : undefined,
          userId: chatUserId,
          interactionMode,
          confirmedPlan,
          chatSessionId: chatSessionKey,
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
      } finally {
        trackStreamEnd()
      }
    },
  })

  const response = createUIMessageStreamResponse({ stream })
  if (response.body) {
    // Consume the agent's stream in the background, feeding chunks into
    // the buffer. This reader is NOT tied to the HTTP response — the agent
    // keeps running even if the client disconnects.
    const bgReader = response.body.getReader()
    ;(async () => {
      try {
        while (true) {
          const { done, value } = await bgReader.read()
          if (done) break
          bufWriter.append(value)
        }
        console.log(`[AgentChat] Background stream completed for session: ${chatSessionKey}`)
      } catch (err: any) {
        console.log(`[AgentChat] Background stream error for session: ${chatSessionKey}:`, err?.message || err)
      } finally {
        bufWriter.complete()
      }
    })()

    // The client reads from a replay stream backed by the buffer.
    // If this client disconnects, only the replay subscriber is removed;
    // the background reader + agent keep running.
    const replayStream = streamBufferStore.createReplayStream(chatSessionKey)!
    const wrappedStream = wrapStreamWithKeepalive(replayStream, 15_000)
    return new Response(wrappedStream, {
      status: response.status,
      headers: response.headers,
    })
  }
  return response
})

// Reconnect to an active stream — replays buffered SSE events then continues live.
// URL pattern matches the AI SDK's default resume convention: ${api}/${chatId}/stream
app.get('/agent/chat/:chatSessionId/stream', (c) => {
  const chatSessionId = c.req.param('chatSessionId')
  console.log(`[AgentChat] Stream reconnect request for session: ${chatSessionId}, has buffer: ${streamBufferStore.has(chatSessionId)}`)
  const replayStream = streamBufferStore.createReplayStream(chatSessionId)

  if (!replayStream) {
    console.log(`[AgentChat] No active stream buffer for session: ${chatSessionId}`)
    return new Response(null, { status: 204 })
  }

  console.log(`[AgentChat] Replaying stream buffer for session: ${chatSessionId}`)
  const wrappedStream = wrapStreamWithKeepalive(replayStream, 15_000)
  return new Response(wrappedStream, {
    headers: {
      'Content-Type': 'text/x-ai-sdk-ui-stream',
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'no-cache',
    },
  })
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

  const activeMode = agentGateway?.getActiveMode() || 'canvas'
  return c.json({ messages: simplified, activeMode })
})

// Get/set the active visual mode
app.get('/agent/mode', (c) => {
  if (!agentGateway) return c.json({ mode: 'none' })
  return c.json({
    mode: agentGateway.getActiveMode(),
    allowedModes: agentGateway.getAllowedModes(),
  })
})

app.post('/agent/mode', async (c) => {
  if (!agentGateway) return c.json({ error: 'Gateway not ready' }, 503)

  const body = await c.req.json<{ mode: string }>().catch(() => null)
  const mode = body?.mode
  if (mode !== 'canvas' && mode !== 'app' && mode !== 'none') {
    return c.json({ error: 'mode must be "canvas", "app", or "none"' }, 400)
  }

  const allowed = agentGateway.getAllowedModes()
  if (!allowed.includes(mode)) {
    return c.json({ error: `Mode "${mode}" not allowed. Available: ${allowed.join(', ')}` }, 403)
  }

  agentGateway.setActiveMode(mode)
  return c.json({ mode })
})

// ---------------------------------------------------------------------------
// Plans API
// ---------------------------------------------------------------------------

app.get('/agent/plans', async (c) => {
  const plansDir = join(WORKSPACE_DIR, '.shogo', 'plans')
  if (!existsSync(plansDir)) {
    return c.json({ plans: [] })
  }

  const plans: Array<{ filename: string; name: string; overview: string; createdAt: string; status: string }> = []
  try {
    for (const entry of readdirSync(plansDir)) {
      if (!entry.endsWith('.plan.md')) continue
      const filepath = join(plansDir, entry)
      const content = readFileSync(filepath, 'utf-8')
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) continue
      const fm = fmMatch[1]
      const getName = (s: string) => { const m = s.match(/^name:\s*"?([^"\n]*)"?/m); return m?.[1] || '' }
      const getOverview = (s: string) => { const m = s.match(/^overview:\s*"?([^"\n]*)"?/m); return m?.[1] || '' }
      const getCreatedAt = (s: string) => { const m = s.match(/^createdAt:\s*"?([^"\n]*)"?/m); return m?.[1] || '' }
      const getStatus = (s: string) => { const m = s.match(/^status:\s*(\S+)/m); return m?.[1] || 'pending' }
      plans.push({
        filename: entry,
        name: getName(fm),
        overview: getOverview(fm),
        createdAt: getCreatedAt(fm),
        status: getStatus(fm),
      })
    }
  } catch { /* directory unreadable */ }

  plans.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return c.json({ plans })
})

app.get('/agent/plans/:filename', async (c) => {
  const filename = c.req.param('filename')
  if (!filename || !filename.endsWith('.plan.md')) {
    return c.json({ error: 'Invalid plan filename' }, 400)
  }
  const filepath = join(WORKSPACE_DIR, '.shogo', 'plans', filename)
  if (!existsSync(filepath)) {
    return c.json({ error: 'Plan not found' }, 404)
  }
  const content = readFileSync(filepath, 'utf-8')
  return c.json({ filename, content })
})

app.delete('/agent/plans/:filename', async (c) => {
  const filename = c.req.param('filename')
  if (!filename || !filename.endsWith('.plan.md')) {
    return c.json({ error: 'Invalid plan filename' }, 400)
  }
  const filepath = join(WORKSPACE_DIR, '.shogo', 'plans', filename)
  if (!existsSync(filepath)) {
    return c.json({ error: 'Plan not found' }, 404)
  }
  unlinkSync(filepath)
  return c.json({ deleted: true })
})

// Stop/interrupt the current agent turn (and any active code agent task)
app.post('/agent/stop', async (c) => {
  if (!agentGateway) return c.json({ error: 'Gateway not ready' }, 503)

  const body = await c.req.json().catch(() => ({} as any))
  const stopSessionKey = body.chatSessionId || 'chat'
  const aborted = agentGateway.abortCurrentTurn(stopSessionKey)

  // Remove the buffer entirely so resume after stop returns 204 (not a replay)
  streamBufferStore.abort(stopSessionKey)

  return c.json({ stopped: aborted })
})

// ---------------------------------------------------------------------------
// Preview Manager (app mode — lazy init)
// ---------------------------------------------------------------------------

import { PreviewManager } from './preview-manager'

let previewManager: PreviewManager | null = null

function getPreviewManager(): PreviewManager {
  if (!previewManager) {
    const projectDir = join(WORKSPACE_DIR, 'project')
    previewManager = new PreviewManager({
      projectDir,
      runtimePort: parseInt(process.env.PORT || '8080', 10),
    })
  }
  return previewManager
}

// ---------------------------------------------------------------------------
// Canvas File Watcher (canvas v2 mode — lazy init)
// ---------------------------------------------------------------------------

function getCanvasFileWatcher(): CanvasFileWatcher {
  return CanvasFileWatcher.getInstance(WORKSPACE_DIR)
}

app.get('/preview/status', (c) => {
  const pm = getPreviewManager()
  return c.json(pm.getStatus())
})

app.post('/preview/restart', async (c) => {
  const pm = getPreviewManager()
  const result = await pm.restart()
  return c.json(result)
})

app.post('/preview/start', async (c) => {
  const pm = getPreviewManager()
  const result = await pm.start()
  return c.json(result)
})

app.post('/preview/stop', (c) => {
  const pm = getPreviewManager()
  pm.stop()
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Template Copy (app mode — extract pre-built archive into project/)
// ---------------------------------------------------------------------------

import { execSync } from 'child_process'

const TEMPLATES_DIR = resolve(MONOREPO_ROOT, 'packages/sdk/templates')
const EXAMPLES_DIR = resolve(MONOREPO_ROOT, 'packages/sdk/examples')

app.post('/templates/copy', async (c) => {
  try {
    const body = await c.req.json() as { template: string; name: string; theme?: string }
    if (!body.template || !body.name) {
      return c.json({ ok: false, error: 'Missing required fields: template, name' }, 400)
    }

    const projectDir = join(WORKSPACE_DIR, 'project')
    mkdirSync(projectDir, { recursive: true })

    for (const d of ['src', 'prisma', '.tanstack']) {
      const p = join(projectDir, d)
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    }

    const archivePath = join(TEMPLATES_DIR, `${body.template}.tar.gz`)
    const examplesPath = join(EXAMPLES_DIR, body.template)

    if (existsSync(archivePath)) {
      execSync(`tar -xzf "${archivePath}" --strip-components=1 -C "${projectDir}"`, {
        stdio: 'pipe',
        timeout: 120_000,
      })
      console.log(`[templates/copy] Extracted "${body.template}" from archive to ${projectDir}`)
    } else if (existsSync(examplesPath)) {
      cpSync(examplesPath, projectDir, {
        recursive: true,
        filter: (src) => !src.includes('node_modules') && !src.includes('.git') && !src.includes('template.json'),
      })
      console.log(`[templates/copy] Copied "${body.template}" from examples to ${projectDir}`)
    } else {
      return c.json({ ok: false, error: `Template "${body.template}" not found in archives or examples` }, 404)
    }

    // Persist app template name so the agent knows what was created
    writeFileSync(join(WORKSPACE_DIR, '.app-template'), body.template, 'utf-8')

    const pkgPath = join(projectDir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      pkg.name = body.name
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
    }

    const envPath = join(projectDir, '.env')
    const envLines = existsSync(envPath) ? readFileSync(envPath, 'utf-8').split('\n') : []
    const filtered = envLines.filter(l => !l.trim().startsWith('DATABASE_URL'))
    const devDbPath = join(projectDir, 'prisma', 'dev.db')
    writeFileSync(envPath, [...filtered, `DATABASE_URL="file:${devDbPath}"`, ''].join('\n'), 'utf-8')

    console.log(`[templates/copy] Prisma schema left as-is (Prisma 7.x adapter mode)`)

    // Rewrite db.tsx to use @prisma/adapter-libsql for SQLite
    // (templates ship with PrismaPg adapter but run on SQLite in the runtime)
    const dbTsxPath = join(projectDir, 'src', 'lib', 'db.tsx')
    if (existsSync(dbTsxPath)) {
      const SQLITE_DB_TSX = `import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '../generated/prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

const adapter = new PrismaLibSql({ url: process.env.DATABASE_URL ?? 'file:./prisma/dev.db' })

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
`
      writeFileSync(dbTsxPath, SQLITE_DB_TSX, 'utf-8')
      console.log(`[templates/copy] Rewrote db.tsx for SQLite with libsql adapter`)
    }

    const pm = getPreviewManager()
    const result = await pm.restart()
    console.log(`[templates/copy] Preview restart result:`, JSON.stringify(result))

    return c.json({ ok: true, message: `Template "${body.template}" extracted and preview restarted` })
  } catch (error: any) {
    console.error(`[templates/copy] Error:`, error)
    return c.json({ ok: false, error: error.message || 'Failed to copy template' }, 500)
  }
})

// ---------------------------------------------------------------------------
// Webhook Ingress Endpoints
// ---------------------------------------------------------------------------

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN

function verifyWebhookAuth(c: any): boolean {
  if (!WEBHOOK_TOKEN) {
    console.warn('[agent-runtime] WEBHOOK_TOKEN not set — rejecting webhook request (fail-closed)')
    return false
  }
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
  const body = await c.req.json().catch(() => ({})) as { evalLabel?: string }
  const sm = agentGateway.getSessionManager()
  sm.clearHistory('chat')
  agentGateway.reloadConfig()
  agentGateway.setActiveMode('canvas')
  agentGateway.setEvalLabel(body.evalLabel ?? null)
  agentGateway.reconnectIndex()
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

// Heartbeat trigger (called by external HeartbeatScheduler).
// ACKs immediately and runs the heartbeat asynchronously so the scheduler
// doesn't block. Reports completion back to the API when done.
app.post('/agent/heartbeat/trigger', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  // Fire-and-forget: run heartbeat asynchronously
  const projectId = state.currentProjectId!
  agentGateway.triggerHeartbeat().then(async () => {
    try {
      await reportHeartbeatComplete(projectId)
    } catch (err: any) {
      console.error('[Heartbeat] Failed to report completion:', err.message)
    }
  }).catch((err: any) => {
    console.error('[Heartbeat] Heartbeat tick failed:', err.message)
  })

  return c.json({ ok: true, async: true })
})

// Permission approval response (local mode security)
app.post('/agent/permission-response', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const engine = agentGateway.getPermissionEngine()
  if (!engine) {
    return c.json({ error: 'Permission engine not active' }, 404)
  }

  try {
    const body = await c.req.json() as {
      id: string
      decision: 'allow_once' | 'always_allow' | 'deny'
      pattern?: string
    }

    if (!body.id || !body.decision) {
      return c.json({ error: 'Missing id or decision' }, 400)
    }

    engine.handleApprovalResponse(body)
    return c.json({ ok: true })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Workspace file read/write endpoints
app.get('/agent/files/:filename', async (c) => {
  const filename = c.req.param('filename')
  const allowedFiles = ['AGENTS.md', 'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md', 'STACK.md', 'config.json']

  if (!allowedFiles.includes(filename)) {
    return c.json({ error: `File not allowed: ${filename}` }, 400)
  }

  try {
    const filepath = join(WORKSPACE_DIR, filename)
    const content = existsSync(filepath) ? readFileSync(filepath, 'utf-8') : ''
    return c.json({ filename, content })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.put('/agent/files/:filename', async (c) => {
  const filename = c.req.param('filename')
  const allowedFiles = ['AGENTS.md', 'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md', 'STACK.md', 'config.json']

  if (!allowedFiles.includes(filename)) {
    return c.json({ error: `File not allowed: ${filename}` }, 400)
  }

  try {
    const { content } = await c.req.json()
    const filepath = join(WORKSPACE_DIR, filename)
    writeFileSync(filepath, content, 'utf-8')
    return c.json({ ok: true, filename })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ---------------------------------------------------------------------------
// Workspace File Management Endpoints (files/ directory)
// ---------------------------------------------------------------------------

import { IndexEngine, createDefaultConfig } from './index-engine'

let indexEngineSingleton: IndexEngine | null = null
function getIndexEngine(): IndexEngine {
  if (!indexEngineSingleton) {
    indexEngineSingleton = new IndexEngine(createDefaultConfig(WORKSPACE_DIR))
  }
  return indexEngineSingleton
}

const FILES_DIR = join(WORKSPACE_DIR, 'files')

function resolveFilesPath(subPath: string): string | null {
  const resolved = resolve(FILES_DIR, subPath)
  if (!resolved.startsWith(resolve(FILES_DIR))) return null
  return resolved
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/html': '.html',
  'text/css': '.css',
  'application/javascript': '.js',
  'application/typescript': '.ts',
}

function mimeToExtension(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType] || `.${mimeType.split('/').pop() || 'bin'}`
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
const DOWNLOAD_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
}

app.get('/agent/workspace/download/*', (c) => {
  const subPath = c.req.path.replace('/agent/workspace/download/', '')
  if (!subPath) return c.json({ error: 'Path required' }, 400)

  let resolved = resolveFilesPath(subPath)
  if (!resolved) return c.json({ error: 'Path outside files directory' }, 400)

  if (!existsSync(resolved)) {
    const wsRoot = resolve(WORKSPACE_DIR, subPath)
    if (wsRoot.startsWith(resolve(WORKSPACE_DIR)) && existsSync(wsRoot) && /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(subPath)) {
      resolved = wsRoot
    } else {
      return c.json({ error: 'File not found' }, 404)
    }
  }

  const content = readFileSync(resolved)
  const fileName = subPath.split('/').pop() || 'download'
  const ext = extname(fileName).toLowerCase()
  const contentType = DOWNLOAD_MIME_TYPES[ext] || 'application/octet-stream'
  const isInline = contentType.startsWith('image/') || contentType === 'application/pdf'

  return new Response(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `${isInline ? 'inline' : 'attachment'}; filename="${fileName}"`,
      'Content-Length': String(content.length),
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
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

    const engine = getIndexEngine()
    const results = await engine.search(query, { source: 'files', limit, pathFilter: path_filter })
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
      stats: engine.getStats('files'),
    })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Re-index files (manual trigger)
app.post('/agent/workspace/reindex', async (c) => {
  try {
    const engine = getIndexEngine()
    const stats = await engine.reindex('files')
    return c.json({ ok: true, ...stats })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Tool catalog and search — powers the "Tools" tab in the web UI
import { MCP_CATALOG, MCP_CATEGORIES, isMcpServerAllowed, getPreinstalledPackages } from './mcp-catalog'
import { isComposioEnabled, findComposioToolkit, initComposioSession, registerToolkitProxyTools } from './composio'

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
      version: s.version || '',
      description: s.description,
      trigger: s.trigger || '',
      tools: s.tools || [],
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

  const destDir = join(WORKSPACE_DIR, '.shogo', 'skills', name)
  mkdirSync(destDir, { recursive: true })

  const srcDir = skill.skillDir
  const { readdirSync: rds, readFileSync: rfs, cpSync: cps } = require('fs')
  for (const entry of rds(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      cps(srcPath, destPath, { recursive: true })
    } else {
      writeFileSync(destPath, rfs(srcPath))
    }
  }

  agentGateway?.reloadConfig()
  return c.json({ ok: true, installed: name })
})

app.get('/agent/skills/:name', (c) => {
  const name = c.req.param('name')
  if (!name || name.includes('/') || name.includes('..')) {
    return c.json({ error: 'Invalid skill name' }, 400)
  }

  const filePath = join(WORKSPACE_DIR, '.shogo', 'skills', name, 'SKILL.md')
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

  const skillDir = join(WORKSPACE_DIR, '.shogo', 'skills', name)
  if (!existsSync(skillDir)) {
    return c.json({ error: `Skill "${name}" not found` }, 404)
  }

  rmSync(skillDir, { recursive: true, force: true })
  agentGateway?.reloadConfig()
  return c.json({ ok: true, removed: name })
})

app.get('/agent/skills/:name/scripts', (c) => {
  const name = c.req.param('name')
  if (!name || name.includes('/') || name.includes('..')) {
    return c.json({ error: 'Invalid skill name' }, 400)
  }

  const scriptsDir = join(WORKSPACE_DIR, '.shogo', 'skills', name, 'scripts')
  if (!existsSync(scriptsDir)) {
    return c.json({ scripts: [] })
  }

  const { statSync: ss } = require('fs')
  const scripts = readdirSync(scriptsDir)
    .filter((f: string) => !f.startsWith('.'))
    .map((f: string) => {
      const ext = f.split('.').pop()?.toLowerCase() || ''
      const runtimeMap: Record<string, string> = { py: 'python3', js: 'node', ts: 'bun', mjs: 'node', sh: 'bash' }
      return { filename: f, runtime: runtimeMap[ext] || ext, size: ss(join(scriptsDir, f)).size }
    })

  return c.json({ skill: name, scripts })
})

app.get('/agent/skills/:name/scripts/:filename', (c) => {
  const name = c.req.param('name')
  const filename = c.req.param('filename')
  if (!name || !filename || name.includes('..') || filename.includes('..') || filename.includes('/')) {
    return c.json({ error: 'Invalid parameters' }, 400)
  }

  const filePath = join(WORKSPACE_DIR, '.shogo', 'skills', name, 'scripts', filename)
  if (!existsSync(filePath)) {
    return c.json({ error: `Script "${filename}" not found` }, 404)
  }

  const content = readFileSync(filePath, 'utf-8')
  return c.json({ skill: name, filename, content })
})

// ---------------------------------------------------------------------------
// External Skill Registry
// ---------------------------------------------------------------------------

app.get('/agent/skill-registry', (c) => {
  const { loadSkillRegistryManifest } = require('./skills')
  const manifest = loadSkillRegistryManifest()
  return c.json({ skills: manifest })
})

app.post('/agent/skill-registry/install', async (c) => {
  const { name, source, dirName } = await c.req.json() as {
    name: string
    source: string
    dirName: string
  }

  if (!source || !dirName) {
    return c.json({ error: 'source and dirName are required' }, 400)
  }
  if (dirName.includes('/') || dirName.includes('..') || source.includes('/') || source.includes('..')) {
    return c.json({ error: 'Invalid source or dirName' }, 400)
  }

  const { loadBundledClaudeCodeSkill } = require('./skills')
  const skill = loadBundledClaudeCodeSkill(source, dirName)
  if (!skill) {
    return c.json({ error: `Skill "${dirName}" not found in source "${source}"` }, 404)
  }

  const destDir = join(WORKSPACE_DIR, '.shogo', 'skills', skill.name)
  mkdirSync(destDir, { recursive: true })

  const srcDir = skill.skillDir
  const { readdirSync: rds, readFileSync: rfs, cpSync: cps } = require('fs')
  for (const entry of rds(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      cps(srcPath, destPath, { recursive: true })
    } else {
      writeFileSync(destPath, rfs(srcPath))
    }
  }

  agentGateway?.reloadConfig()
  return c.json({ ok: true, installed: skill.name, source })
})

// ---------------------------------------------------------------------------
// Quick Actions
// ---------------------------------------------------------------------------

app.get('/agent/quick-actions', (c) => {
  const filePath = join(WORKSPACE_DIR, '.shogo', 'quick-actions.json')
  if (!existsSync(filePath)) {
    return c.json({ actions: [] })
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    const actions = Array.isArray(raw?.actions)
      ? raw.actions.filter((a: any) => typeof a?.label === 'string' && typeof a?.prompt === 'string')
      : []
    return c.json({ actions })
  } catch {
    return c.json({ actions: [] })
  }
})

app.delete('/agent/quick-actions/:label', (c) => {
  const label = decodeURIComponent(c.req.param('label'))
  if (!label) {
    return c.json({ error: 'Label is required' }, 400)
  }

  const filePath = join(WORKSPACE_DIR, '.shogo', 'quick-actions.json')
  if (!existsSync(filePath)) {
    return c.json({ error: 'No quick actions file found' }, 404)
  }

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (!Array.isArray(raw?.actions)) {
      return c.json({ error: 'Invalid quick actions file' }, 500)
    }
    const before = raw.actions.length
    raw.actions = raw.actions.filter((a: any) => a?.label !== label)
    if (raw.actions.length === before) {
      return c.json({ error: `Quick action "${label}" not found` }, 404)
    }
    writeFileSync(filePath, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
    return c.json({ ok: true, removed: label })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

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
  if (!entry || !isMcpServerAllowed(serverId)) {
    const allowed = getPreinstalledPackages().map(e => e.id).join(', ')
    return c.json({ error: `MCP server "${serverId}" is not available. Only preinstalled servers are supported: ${allowed}` }, 400)
  }

  const configPath = join(WORKSPACE_DIR, 'config.json')
  let config: Record<string, any> = {}
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf-8'))
  }

  config.mcpServers = config.mcpServers || {}

  if (enabled) {
    const args = [entry.package, ...entry.defaultArgs]
    const mergedEnv: Record<string, string> = { ...env }

    if (entry.id === 'playwright' && process.env.SHOGO_LOCAL_MODE === 'true') {
      if (!args.includes('--extension')) {
        args.push('--extension')
      }
      const token = env?.PLAYWRIGHT_MCP_EXTENSION_TOKEN || process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
      if (token) {
        mergedEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token
      }
    }

    config.mcpServers[entry.id] = {
      command: 'npx',
      args,
      ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
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
    return {
      id: s.name,
      name: catalogEntry?.name || s.name,
      source: catalogEntry ? 'catalog' as const : 'custom' as const,
      status: 'running' as const,
      toolCount: s.toolCount,
      tools: s.toolNames,
    }
  })

  return c.json({ tools })
})

app.post('/agent/tools/execute', async (c) => {
  if (!agentGateway) {
    return c.json({ ok: false, error: 'Agent gateway not running' }, 503)
  }
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.tool !== 'string') {
    return c.json({ ok: false, error: 'Missing required field: tool (string)' }, 400)
  }
  const { tool, args } = body as { tool: string; args?: Record<string, any> }
  const mcpMgr = agentGateway.getMcpClientManager()
  const result = await mcpMgr.callTool(tool, args || {})
  return c.json(result, result.ok ? 200 : 404)
})

app.get('/agent/tools/schemas', (c) => {
  if (!agentGateway) {
    return c.json({ tools: [] })
  }
  const mcpMgr = agentGateway.getMcpClientManager()
  const allTools = mcpMgr.getTools()
  const schemas = allTools.map((t) => ({
    name: t.name,
    description: t.description || '',
    parameters: t.parameters ?? {},
  }))
  return c.json({ tools: schemas })
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
  const isLocal = process.env.SHOGO_LOCAL_MODE === 'true'
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
      authType: Object.keys(entry.requiredEnv).length > 0 ? 'api_key' : 'none',
      requiredEnv: Object.keys(entry.requiredEnv).length > 0 ? entry.requiredEnv : undefined,
      optionalEnv: entry.optionalEnv && Object.keys(entry.optionalEnv).length > 0 ? entry.optionalEnv : undefined,
      icon: entry.icon,
      isLocalMode: isLocal,
    })
  }

  return c.json({ results })
})

app.post('/agent/tools/install', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const { id, env, extraArgs } = await c.req.json() as {
    id: string
    env?: Record<string, string>
    extraArgs?: string[]
  }

  const mcpMgr = agentGateway.getMcpClientManager()

  if (isComposioEnabled()) {
    const composioToolkit = await findComposioToolkit(id)
    if (composioToolkit) {
      try {
        const userId = c.req.header('X-User-Id') || process.env.USER_ID || 'default'
        const workspaceId = process.env.WORKSPACE_ID || 'default'
        const projectId = process.env.PROJECT_ID || 'default'
        await initComposioSession(userId, workspaceId, projectId)
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
  if (!catalogEntry || !isMcpServerAllowed(id)) {
    const allowed = getPreinstalledPackages().map(e => e.id).join(', ')
    return c.json({ error: `MCP server "${id}" is not available. Only preinstalled servers are supported: ${allowed}` }, 400)
  }

  try {
    const args = [catalogEntry.package, ...catalogEntry.defaultArgs]
    const mergedEnv: Record<string, string> = { ...env }

    if (id === 'playwright' && process.env.SHOGO_LOCAL_MODE === 'true' && extraArgs?.includes('--extension')) {
      if (!args.includes('--extension')) {
        args.push('--extension')
      }
      const token = env?.PLAYWRIGHT_MCP_EXTENSION_TOKEN || process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
      if (token) {
        mergedEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token
      }
    }

    const serverCwd = id === 'playwright' ? FILES_DIR : undefined
    if (serverCwd) mkdirSync(serverCwd, { recursive: true })

    await mcpMgr.hotAddServer(id, {
      command: 'npx',
      args,
      env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
      cwd: serverCwd,
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
    'AGENTS.md', 'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md', 'STACK.md', 'config.json',
  ]

  for (const filename of exportableFiles) {
    const filepath = join(WORKSPACE_DIR, filename)
    if (existsSync(filepath)) {
      exportFiles[filename] = readFileSync(filepath, 'utf-8')
    }
  }

  const skillsDir = join(WORKSPACE_DIR, 'skills')
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
    const filepath = join(WORKSPACE_DIR, filename)
    const dir = require('path').dirname(filepath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(filepath, content, 'utf-8')
    written.push(filename)
  }

  return c.json({ ok: true, imported: written.length, files: written })
})

// Console log for forwarding (matches runtime pattern)
const consoleLogs: string[] = []
const logStreamListeners = new Set<(line: string) => void>()

app.post('/console-log/append', async (c) => {
  const { line } = await c.req.json()
  if (line) {
    consoleLogs.push(line)
    if (consoleLogs.length > 1000) consoleLogs.splice(0, 500)
    for (const listener of logStreamListeners) {
      try { listener(line) } catch {}
    }
  }
  return c.json({ ok: true })
})

app.get('/console-log', (c) => {
  return c.json({ logs: consoleLogs })
})

app.get('/agent/logs/stream', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (text: string) => {
        try { controller.enqueue(encoder.encode(text + '\n')) } catch {}
      }

      for (const line of consoleLogs.slice(-100)) {
        send(line)
      }

      const listener = (line: string) => send(line)
      logStreamListeners.add(listener)

      c.req.raw.signal.addEventListener('abort', () => {
        logStreamListeners.delete(listener)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
})


// =============================================================================
// Skill Server control (used by eval harness to force-sync before runtime checks)
// =============================================================================

app.get('/agent/skill-server/status', (c) => {
  if (!agentGateway) return c.json({ phase: 'unknown' })
  return c.json({ phase: agentGateway.getSkillServerPhase() })
})

app.post('/agent/skill-server/sync', async (c) => {
  if (!agentGateway) return c.json({ ok: false, error: 'gateway not running' }, 503)
  try {
    const result = await agentGateway.syncSkillServer()
    return c.json(result)
  } catch (err: any) {
    return c.json({ ok: false, phase: 'crashed', error: err.message || String(err) }, 500)
  }
})

// =============================================================================
// Template API Proxy (forward /api/* to the template's Hono server)
// =============================================================================

app.all('/api/*', async (c) => {
  const port = agentGateway?.getSkillServerPort() ?? getPreviewManager().apiServerPort
  if (!port) return c.notFound()

  const url = new URL(c.req.url)
  const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`

  try {
    const res = await fetch(target, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      // @ts-ignore - duplex needed for streaming request bodies
      duplex: 'half',
    })
    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    })
  } catch (err: any) {
    console.error(`[api-proxy] Failed to proxy ${c.req.method} ${url.pathname}:`, err.message)
    return c.json({ error: 'Template API server not responding' }, 502)
  }
})

// =============================================================================
// Shared MIME map for static file serving
// =============================================================================

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json', '.mjs': 'application/javascript',
}

// =============================================================================
// Canvas v2 Endpoints
// =============================================================================

app.get('/agent/canvas/stream', (c) => {
  const watcher = getCanvasFileWatcher()

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch {}
      }

      // Replay current state
      send(JSON.stringify(watcher.getInitEvent()))

      // Subscribe to live updates
      const handler = (event: import('./canvas-file-watcher').CanvasEvent) => {
        send(JSON.stringify(event))
      }
      watcher.subscribe(handler)

      // Heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
          watcher.unsubscribe(handler)
        }
      }, 15_000)

      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(heartbeat)
        watcher.unsubscribe(handler)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

app.post('/agent/canvas/error', async (c) => {
  try {
    const body = await c.req.json() as { surfaceId?: string; phase?: string; error?: string }
    if (!body.error) return c.json({ error: 'Missing error field' }, 400)

    pushCanvasRuntimeError({
      surfaceId: body.surfaceId || 'unknown',
      phase: body.phase || 'unknown',
      error: body.error,
      timestamp: Date.now(),
    })

    console.warn(`[canvas-error] ${body.phase} error in ${body.surfaceId}: ${body.error.slice(0, 200)}`)
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }
})

export { getCanvasRuntimeErrors, clearCanvasRuntimeErrors } from './canvas-runtime-errors'

app.post('/agent/canvas/action', async (c) => {
  try {
    const body = await c.req.json() as { surfaceId?: string; name?: string; context?: Record<string, unknown> }
    if (!body.name) return c.json({ error: 'Missing action name' }, 400)

    console.log(`[canvas-action] ${body.surfaceId}/${body.name}`, body.context ? JSON.stringify(body.context).slice(0, 200) : '')

    // TODO: Route canvas actions to the gateway when canvas_action_wait is implemented for v2
    // For now, just acknowledge — the agent can poll for actions or we'll add event routing.

    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }
})

// =============================================================================
// Static File Serving — workspace Vite build output (dist/) at root
// =============================================================================

function getDistDir(): string {
  return join(WORKSPACE_DIR, 'dist')
}

app.get('*', (c) => {
  const urlPath = new URL(c.req.url).pathname

  if (urlPath.startsWith('/agent') || urlPath.startsWith('/pool') ||
      urlPath.startsWith('/health') || urlPath.startsWith('/ready') ||
      urlPath.startsWith('/preview') || urlPath.startsWith('/console-log') ||
      urlPath.startsWith('/api') || urlPath.startsWith('/templates')) {
    return c.notFound()
  }

  const distDir = getDistDir()
  const safePath = urlPath.replace(/\.\./g, '').replace(/\/+/g, '/')
  const filePath = join(distDir, safePath === '/' ? 'index.html' : safePath)

  if (!filePath.startsWith(resolve(distDir))) {
    return c.notFound()
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath).toLowerCase()
    const mime = STATIC_MIME[ext] || 'application/octet-stream'
    return new Response(readFileSync(filePath), {
      headers: {
        'Content-Type': mime,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      },
    })
  }

  // SPA fallback
  const indexPath = join(distDir, 'index.html')
  if (existsSync(indexPath)) {
    return new Response(readFileSync(indexPath), {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
    })
  }

  return c.notFound()
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
      const result = await initializeS3Sync(WORKSPACE_DIR)
      if (result) {
        s3SyncInstance = result.sync
        // If node_modules were seeded from the template (not from S3), mark deps
        // as pre-seeded so S3 sync won't try to tar.gz 37K+ files and OOM.
        if (existsSync(join(WORKSPACE_DIR, 'node_modules', '.bin', 'vite'))) {
          await s3SyncInstance.markDepsPreSeeded()
        }
        logTiming('S3 sync initialized')
      }
    } catch (error: any) {
      console.error('[agent-runtime] S3 sync init failed:', error.message)
    }
  }

  // Ensure workspace has node_modules. If S3 sync is restoring deps in the
  // background, skip the blocking install here — deps will be available
  // before the gateway starts (startGateway awaits waitForDeps).
  if (s3SyncInstance && !s3SyncInstance.areDepsReady()) {
    logTiming('Deps restoring in background — skipping blocking install')
  } else {
    try {
      await ensureWorkspaceDeps(WORKSPACE_DIR)
      logTiming('Workspace deps ready')
    } catch (err: any) {
      console.error('[agent-runtime] Workspace deps install failed:', err.message)
    }
  }

  const techStackMarkerPath = join(WORKSPACE_DIR, '.tech-stack')
  if (existsSync(techStackMarkerPath)) {
    const stackId = readFileSync(techStackMarkerPath, 'utf-8').trim()
    try {
      await runTechStackSetup(WORKSPACE_DIR, stackId)
      logTiming(`Tech stack setup complete: ${stackId}`)
    } catch (err: any) {
      console.error(`[agent-runtime] Tech stack setup failed for ${stackId}:`, err.message)
    }
  }

  logTiming('Essentials complete')

  // Auto-start preview server if an app project was restored from S3.
  // This handles the case where a warm pool pod is re-assigned after eviction
  // and the project files are already present from S3 sync.
  const projectDir = join(WORKSPACE_DIR, 'project')
  if (existsSync(join(projectDir, 'package.json'))) {
    const pm = getPreviewManager()
    const status = pm.getStatus()
    if (!status.running) {
      logTiming('Detected app project restored from S3 — auto-starting preview')
      pm.start().catch((err: any) => {
        console.error('[agent-runtime] Auto-start preview failed:', err.message)
      })
    }
  }
}

/**
 * Start the agent gateway (heavy: loads skills, MCP servers, sessions, BOOT.md).
 * Called after essentials are done — can run in background for warm pool assigns.
 */
let gatewayStarting = false
async function startGateway(): Promise<void> {
  if (gatewayStarting) {
    console.warn('[agent-runtime] startGateway() called while already starting — skipping')
    return
  }
  gatewayStarting = true
  logTiming('Starting agent gateway...')

  gatewayReadyPromise = new Promise<void>((resolve) => { gatewayReadyResolve = resolve })

  // Wait for background deps restoration before starting the gateway.
  // The gateway initializes the LSP and canvas build which need node_modules.
  if (s3SyncInstance && !s3SyncInstance.areDepsReady()) {
    logTiming('Waiting for background deps before starting gateway...')
    await s3SyncInstance.waitForDeps()
    logTiming('Background deps ready')
    // Now run ensureWorkspaceDeps in case the S3 deps didn't fully satisfy
    try {
      await ensureWorkspaceDeps(WORKSPACE_DIR)
    } catch (err: any) {
      console.error('[agent-runtime] Post-deps-restore install failed:', err.message)
    }
  }

  agentGateway = new AgentGateway(WORKSPACE_DIR, state.currentProjectId!)
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

  gatewayReadyResolve?.()
  gatewayReadyResolve = null
  gatewayReadyPromise = null
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
// In-Flight Request Tracking
// =============================================================================

let activeStreams = 0
let isShuttingDown = false

function trackStreamStart(): void { activeStreams++ }
function trackStreamEnd(): void { activeStreams = Math.max(0, activeStreams - 1) }

// =============================================================================
// Graceful Shutdown
// =============================================================================

const DRAIN_TIMEOUT_MS = 30_000

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[agent-runtime] ${signal} received — draining ${activeStreams} active stream(s) (max ${DRAIN_TIMEOUT_MS / 1000}s)`)

  if (activeStreams > 0) {
    const drainStart = Date.now()
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (activeStreams <= 0 || Date.now() - drainStart > DRAIN_TIMEOUT_MS) {
          clearInterval(check)
          if (activeStreams > 0) {
            console.warn(`[agent-runtime] Drain timeout — ${activeStreams} stream(s) still active, proceeding with shutdown`)
          } else {
            console.log(`[agent-runtime] All streams drained in ${Date.now() - drainStart}ms`)
          }
          resolve()
        }
      }, 500)
    })
  }

  streamBufferStore.dispose()

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

if (state.isPoolMode && !state.poolAssigned) {
  logTiming('Pool mode: pre-seeding workspace with runtime template...')
  ensureWorkspaceFiles()
  ensureWorkspaceDeps(WORKSPACE_DIR).then(() => {
    logTiming('Pool mode: workspace pre-seeded, ready for assignment')
  }).catch(err => {
    console.error('[agent-runtime] Pool pre-seed deps failed:', err.message)
  })
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
  idleTimeout: 0,
}
