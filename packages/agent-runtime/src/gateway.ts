// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Gateway
 *
 * The core runtime loop that makes an agent "alive." Manages:
 * - Heartbeat timer (periodic agent turns reading HEARTBEAT.md)
 * - Channel adapters (Telegram, Discord, etc.)
 * - Session management (per-channel message queuing with multi-turn history)
 * - Skill loading and trigger matching
 * - Memory persistence
 * - Hook event system
 * - Slash command handling
 * - BOOT.md startup execution
 * - Webhook event queue
 *
 * Uses Pi Agent Core for the agentic tool-call loop, supporting
 * multi-provider LLMs (Anthropic, OpenAI, Google, xAI, Groq, etc.).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { Message, ImageContent } from '@mariozechner/pi-ai'
import type { StreamFn, AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@sinclair/typebox'
import type { ChannelAdapter, IncomingMessage, AgentStatus, ChannelStatus, StreamChunkConfig, SandboxConfig } from './types'
import { loadAllSkills, migrateFromLegacySkills, matchSkill, buildSkillsPromptSection, type Skill } from './skills'
import { SkillServerManager } from './skill-server-manager'
import { setLoadedSkills } from './gateway-tools'
import { runAgentLoop, type LoopDetectorConfig, type ToolContext } from './agent-loop'
import { createTools, createHeartbeatTools, textResult } from './gateway-tools'
import { PermissionEngine, parseSecurityPolicy } from './permission-engine'
import { getDynamicAppManager } from './dynamic-app-manager'
import { HookEmitter, loadAllHooks } from './hooks'
import { parseSlashCommand, type SlashCommandContext } from './slash-commands'
import { SessionManager, type SessionManagerConfig } from './session-manager'
import { SqliteSessionPersistence } from './sqlite-session-persistence'
import { BlockChunker } from './block-chunker'
import { CanvasStreamParser } from './canvas-stream-parser'
import { CanvasCodeStreamParser } from './canvas-code-stream-parser'
import { BASIC_CANVAS_TOOLS_GUIDE, BASIC_CANVAS_EXAMPLES } from './canvas-prompt'
import { CANVAS_V2_GUIDE, CANVAS_V2_BACKEND_GUIDE, CANVAS_V2_REACT_GUIDE, CANVAS_V2_EXAMPLES } from './canvas-v2-prompt'
import { CanvasFileWatcher } from './canvas-file-watcher'
import { CODE_AGENT_GENERAL_GUIDE } from './code-agent-prompt'
import { MCPClientManager, type MCPServerConfig, type RemoteMCPServerConfig } from './mcp-client'
import { initComposioSession, resetComposioSession, isComposioEnabled, isComposioInitialized } from './composio'
import { deriveApiUrl, getInternalHeaders } from './internal-api'
import type { FilePart } from './file-attachment-utils'
import { parseFileAttachments } from './file-attachment-utils'
import {
  OPTIMIZED_MEMORY_GUIDE,
  OPTIMIZED_PERSONALITY_GUIDE,
  OPTIMIZED_TOOL_PLANNING_GUIDE,
  OPTIMIZED_SESSION_SUMMARY_GUIDE,
  OPTIMIZED_SKILL_MATCHING_GUIDE,
  OPTIMIZED_MCP_DISCOVERY_GUIDE,
  OPTIMIZED_CONSTRAINT_AWARENESS_GUIDE,
} from './optimized-prompts'
import { resolveWorkspaceConfigFilePath } from './workspace-defaults'

function isComposioTool(name: string): boolean {
  return /^[A-Z]+_/.test(name)
}

function extractToolkitName(name: string): string {
  const p = name.split('_')[0]
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : name
}

function hasErrorInResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  return 'error' in (result as any)
}

const AUTH_ERROR_PATTERNS = [
  'unauthorized', 'forbidden', 'not_authed', 'invalid_auth',
  'token expired', 'refresh token', 'invalid_grant', 'expired',
  'revoked', 'auth_expired', 'authexpired', 'credentials',
  'oauth', 'access denied', 'authentication failed',
]

function isAuthError(raw: string): boolean {
  const l = raw.toLowerCase()
  return AUTH_ERROR_PATTERNS.some(p => l.includes(p))
}

function toUserMessage(toolkit: string, raw: string): string {
  const l = raw.toLowerCase()
  if (l.includes('tool') && l.includes('not found'))
    return `${toolkit} integration tools failed to load. Try reconnecting ${toolkit} from the Capabilities tab.`
  if (l.includes('not found') || l.includes('404'))
    return `${toolkit} could not access the requested resource — it may be private or require additional permissions. Check your org's third-party access settings.`
  if (isAuthError(raw))
    return `${toolkit} authorization failed or connection expired. Please reconnect from the Capabilities tab.`
  if (l.includes('rate limit') || l.includes('429'))
    return `${toolkit} rate limit reached. Please wait a moment and try again.`
  return `${toolkit} encountered an issue: ${raw.length > 120 ? raw.slice(0, 120) + '...' : raw}`
}

export type VisualMode = 'canvas' | 'app' | 'none'

export interface GatewayConfig {
  heartbeatInterval: number
  heartbeatEnabled: boolean
  quietHours: { start: string; end: string; timezone: string }
  channels: Array<{ type: string; config: Record<string, string>; model?: string }>
  /** Model configuration: provider + name (e.g. { provider: 'anthropic', name: 'claude-sonnet-4-5' }) */
  model: { provider: string; name: string }
  maxSessionMessages?: number
  /** Session management configuration */
  session?: Partial<SessionManagerConfig>
  /** Loop detection configuration (false to disable) */
  loopDetection?: Partial<LoopDetectorConfig> | false
  /** Streaming chunk configuration for progressive channel responses */
  streamChunk?: Partial<StreamChunkConfig>
  /** Docker sandbox configuration for exec tool isolation */
  sandbox?: Partial<SandboxConfig>
  /** Main session IDs that bypass sandbox (direct owner chats) */
  mainSessionIds?: string[]
  /** MCP servers to spawn on gateway start — tools from these become available to the agent */
  mcpServers?: Record<string, MCPServerConfig>
  /** Remote MCP servers (HTTP/StreamableHTTP) to connect on gateway start */
  remoteMcpServers?: Record<string, RemoteMCPServerConfig>
  /** Active visual mode: canvas, app, or none (default: 'none') */
  activeMode?: VisualMode
  /** Modes this project is allowed to use (default: all modes for paid, ['canvas','none'] for basic) */
  allowedModes?: VisualMode[]
  /** Whether web search & browser tools are enabled (default: true) */
  webEnabled?: boolean
  /** Whether shell/exec tool is enabled (default: true) */
  shellEnabled?: boolean
  /** Whether cron/scheduling tool is enabled (default: true) */
  cronEnabled?: boolean
  /** Whether image generation tool is enabled (default: true) */
  imageGenEnabled?: boolean
  /** Whether memory tools are enabled (default: true) */
  memoryEnabled?: boolean
  /** Whether canvas tools are enabled (default: true). Automatically set false when switching to app/none mode. */
  canvasEnabled?: boolean
  /** Canvas rendering mode: 'json' = v1 declarative JSON, 'code' = v2 agent-written React code */
  canvasMode?: 'json' | 'code'
}

const PERSONALITY_EVOLUTION_GUIDE_PREFIX = `## Personality Self-Update (MUST use read_file + edit_file)

When the user changes your personality, tone, role, name, or boundaries, you MUST:
1. \`read_file\` the target file first
2. \`edit_file\` to make a **targeted** change to the relevant section

**NEVER** use \`write_file\` to overwrite the entire file — always use \`edit_file\` to change only the relevant section.
**NEVER** write personality/role/boundary changes to MEMORY.md — memory is for facts and conversation logs only.

### Which File to Edit
- **SOUL.md** — Tone, communication style, and boundaries (e.g. "be more formal", "never run shell commands")
- **AGENTS.md** — Role definition, operating instructions, and capabilities (e.g. "you're my DevOps guy", safety rules)
- **IDENTITY.md** — Name, avatar, emoji, and tagline (e.g. "call me Atlas")

### Example

User: "Be more formal and professional from now on"

\`\`\`
read_file({ path: "SOUL.md" })
edit_file({
  path: "SOUL.md",
  old_string: "## Tone\\n- Direct and helpful, not verbose",
  new_string: "## Tone\\n- Formal and professional at all times"
})
\`\`\`

User: "Call me Atlas and focus on climate science"

\`\`\`
read_file({ path: "IDENTITY.md" })
edit_file({
  path: "IDENTITY.md",
  old_string: "- **Name:** Shogo",
  new_string: "- **Name:** Atlas"
})
\`\`\`

### When to Update
- User explicitly corrects your tone, style, or boundaries (e.g. "be more formal")
- User establishes a new, lasting boundary (e.g. "don't suggest code changes")
- User assigns a new name, role, or domain focus

### When NOT to Update
- One-off requests or trivial conversation
- Information already present in the file
- Temporary context that doesn't reflect a lasting change

`

export class AgentGateway {
  private workspaceDir: string
  private projectId: string
  private config: GatewayConfig
  private currentUserId: string | undefined
  private channels: Map<string, ChannelAdapter> = new Map()
  private skills: Skill[] = []
  private configSkills: Array<{ name: string; trigger?: string; description?: string }> = []
  private running = false
  private lastHeartbeatTick: Date | null = null
  private hookEmitter: HookEmitter = new HookEmitter()
  private pendingEvents: string[] = []
  private sessionManager: SessionManager
  private sessionPersistence: SqliteSessionPersistence | null = null
  private mcpClientManager: MCPClientManager = new MCPClientManager()
  /** Optional custom stream function, injected for testing */
  private _streamFn?: StreamFn
  /** Optional log callback for forwarding gateway events to the UI Logs tab */
  private _onLog?: (line: string) => void
  /** Per-section prompt overrides set by DSPy optimization via POST /agent/prompt-override */
  private promptOverrides = new Map<string, string>()
  /** Tool execute overrides for eval mocking (tool name -> mock fn) */
  private toolMocks = new Map<string, (params: Record<string, any>) => any>()
  /** Synthetic tool definitions for mocked MCP tools that don't exist in the base tool set */
  private syntheticTools = new Map<string, { description: string; paramKeys: string[] }>()
  /** Tools that have mock responses but should not appear until promoted via tool_install */
  private hiddenMockTools = new Set<string>()
  /** Hidden mocks promoted to visible after tool_install is called during a turn */
  private promotedMockTools: AgentTool[] = []
  /** User's IANA timezone, set from chat requests. Falls back to server timezone. */
  private userTimezone: string | null = null
  /** Permission engine for local-mode security guardrails */
  private permissionEngine: PermissionEngine | null = null
  /** Callback to push permission-related SSE events to the connected client */
  private _permissionSseCallback?: (event: Record<string, any>) => void
  /** Usage from the most recent agentTurn (consumed by server.ts for the finish event) */
  private _lastTurnUsage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    iterations: number
    toolCallCount: number
  } | null = null
  /** Optional label for eval tracing — included in log prefix when set */
  private evalLabel: string | null = null
  /** Manages the per-workspace skill server process (.shogo/server/) */
  private skillServerManager: SkillServerManager
  /** Canvas v2 file watcher — shared singleton from CanvasFileWatcher.getInstance() */
  private get canvasFileWatcher(): CanvasFileWatcher {
    return CanvasFileWatcher.getInstance(this.workspaceDir)
  }

  constructor(workspaceDir: string, projectId: string) {
    this.workspaceDir = workspaceDir
    this.projectId = projectId
    this.config = this.loadConfig()
    this.sessionManager = new SessionManager(this.config.session)
    this.mcpClientManager.setWorkspaceDir(workspaceDir)
    this.skillServerManager = new SkillServerManager({ workspaceDir })

    // Initialize permission engine in local mode
    if (process.env.SHOGO_LOCAL_MODE === 'true') {
      const pref = parseSecurityPolicy(process.env.SECURITY_POLICY)
      this.permissionEngine = new PermissionEngine({
        preference: pref,
        workspaceDir,
      })
      console.log(`[AgentGateway] Permission engine initialized: mode=${pref.mode}`)
    }

  }

  /** Inject a custom streamFn (used in tests to mock the LLM) */
  setStreamFn(fn: StreamFn): void {
    this._streamFn = fn
  }

  /** Set a log callback for forwarding gateway events to the UI Logs tab */
  setLogCallback(fn: (line: string) => void): void {
    this._onLog = fn
  }

  setUserTimezone(tz: string): void {
    this.userTimezone = tz
  }

  /** Set an eval label for log tracing (used by eval runner) */
  setEvalLabel(label: string | null): void {
    this.evalLabel = label
  }

  /** Log prefix — includes eval label when set for traceability */
  private get logPrefix(): string {
    return this.evalLabel ? `[AgentGateway][${this.evalLabel}]` : '[AgentGateway]'
  }

  /** Set the SSE writer callback so the permission engine can push approval requests to the UI */
  setPermissionSseCallback(cb: (event: Record<string, any>) => void): void {
    this._permissionSseCallback = cb
    if (this.permissionEngine) {
      this.permissionEngine.setSseCallback(cb)
    }
  }

  /** Get the permission engine (used by server.ts for the approval response endpoint) */
  getPermissionEngine(): PermissionEngine | null {
    return this.permissionEngine
  }

  /** Install tool-level execute overrides (for eval mocking). Preserves tool schema. */
  setToolMocks(
    mocks: Record<string, (params: Record<string, any>) => any>,
    syntheticDefs?: Record<string, { description: string; paramKeys: string[] }>,
    hiddenTools?: Set<string>,
  ): void {
    this.toolMocks.clear()
    this.syntheticTools.clear()
    this.hiddenMockTools.clear()
    this.promotedMockTools = []
    for (const [name, fn] of Object.entries(mocks)) {
      this.toolMocks.set(name, fn)
    }
    if (syntheticDefs) {
      for (const [name, def] of Object.entries(syntheticDefs)) {
        this.syntheticTools.set(name, def)
      }
    }
    if (hiddenTools) {
      for (const name of hiddenTools) {
        this.hiddenMockTools.add(name)
      }
    }
  }

  clearToolMocks(): void {
    this.toolMocks.clear()
    this.syntheticTools.clear()
    this.hiddenMockTools.clear()
    this.promotedMockTools = []
  }

  /** After mock tool_install returns, promote hidden mock tools listed in the response */
  _promoteHiddenMocksFromInstall(result: any): void {
    const tools = result?.tools
    if (!Array.isArray(tools)) return
    for (const entry of tools) {
      const toolName = typeof entry === 'string' ? entry : entry?.name
      if (!toolName) continue
      if (!this.hiddenMockTools.has(toolName)) continue
      if (this.promotedMockTools.some(t => t.name === toolName)) continue
      const mockFn = this.toolMocks.get(toolName)
      if (!mockFn) continue
      const synDef = this.syntheticTools.get(toolName)
      const paramProps: Record<string, any> = {}
      if (synDef?.paramKeys) {
        for (const key of synDef.paramKeys) {
          paramProps[key] = Type.Optional(Type.String({ description: key }))
        }
      }
      paramProps['input'] = Type.Optional(Type.String({ description: 'Input data or query' }))
      this.promotedMockTools.push({
        name: toolName,
        description: synDef?.description || `External integration tool: ${toolName}`,
        label: toolName.replace(/__/g, ' > ').replace(/_/g, ' '),
        parameters: Type.Object(paramProps),
        execute: async (_id: string, params: any) => {
          const r = mockFn(params)
          return textResult(r)
        },
      })
      this.hiddenMockTools.delete(toolName)
    }
  }

  /** Consume usage data from the most recent agent turn (returns null if none available) */
  consumeLastTurnUsage() {
    const usage = this._lastTurnUsage
    this._lastTurnUsage = null
    return usage
  }

  /** Replace prompt sections at runtime (used by DSPy optimization pipeline) */
  setPromptOverrides(overrides: Record<string, string>): void {
    this.promptOverrides.clear()
    for (const [key, value] of Object.entries(overrides)) {
      this.promptOverrides.set(key, value)
    }
  }

  private emitLog(line: string): void {
    const ts = new Date().toISOString()
    const formatted = `[${ts}] ${line}`
    this._onLog?.(formatted)
  }

  private loadConfig(): GatewayConfig {
    const defaults: GatewayConfig = {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
      maxSessionMessages: 30,
      activeMode: 'canvas',
      canvasMode: 'code',
      allowedModes: ['canvas', 'none'],
      mainSessionIds: ['chat'],
    }
    const configPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'config.json')
    if (configPath) {
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
        return {
          ...defaults,
          ...raw,
          heartbeatInterval: raw.heartbeat?.intervalMs
            ? Math.round(raw.heartbeat.intervalMs / 1000)
            : raw.heartbeatInterval ?? defaults.heartbeatInterval,
          heartbeatEnabled: raw.heartbeat?.enabled ?? raw.heartbeatEnabled ?? defaults.heartbeatEnabled,
          channels: Array.isArray(raw.channels) ? raw.channels : [],
        }
      } catch (error: any) {
        console.error('[AgentGateway] Failed to parse config.json:', error.message)
      }
    }
    return defaults
  }

  async start(): Promise<void> {
    if (this.running) {
      console.warn('[AgentGateway] start() called but gateway is already running — skipping')
      return
    }
    console.log('[AgentGateway] Starting...')
    this.running = true

    migrateFromLegacySkills(this.workspaceDir)
    this.skills = loadAllSkills(this.workspaceDir)
    this.configSkills = this.loadConfigSkills()
    setLoadedSkills(this.skills)
    console.log(`[AgentGateway] Loaded ${this.skills.length} skills, ${this.configSkills.length} config skills`)

    // Load hooks
    try {
      const hooks = await loadAllHooks(this.workspaceDir)
      this.hookEmitter.register(hooks)
      console.log(`[AgentGateway] Loaded ${hooks.length} hooks`)
    } catch (error: any) {
      console.error('[AgentGateway] Failed to load hooks:', error.message)
    }

    // Connect channels
    for (const channelConfig of this.config.channels) {
      try {
        await this.connectChannel(channelConfig.type, channelConfig.config)
      } catch (error: any) {
        console.error(
          `[AgentGateway] Failed to connect ${channelConfig.type}:`,
          error.message
        )
      }
    }

    if (this.config.heartbeatEnabled) {
      console.log(
        `[AgentGateway] Heartbeat enabled (externally scheduled, interval ${this.config.heartbeatInterval}s)`
      )
    }

    // Start configured MCP servers (stdio + remote)
    if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
      try {
        await this.mcpClientManager.startAll(this.config.mcpServers)
      } catch (error: any) {
        console.error('[AgentGateway] MCP server startup error:', error.message)
      }
    }

    if (this.config.remoteMcpServers && Object.keys(this.config.remoteMcpServers).length > 0) {
      try {
        await this.mcpClientManager.startAllRemote(this.config.remoteMcpServers)
      } catch (error: any) {
        console.error('[AgentGateway] Remote MCP server startup error:', error.message)
      }
    }

    // Start the skill server if .shogo/server/ exists
    try {
      const { started, port } = await this.skillServerManager.start()
      if (started) {
        console.log(`[AgentGateway] Skill server running on port ${port}`)
      }
    } catch (error: any) {
      console.error('[AgentGateway] Skill server startup error:', error.message)
    }

    // Composio session init is deferred to per-request (processChatMessageStream)
    // so it uses the real authenticated user ID, not a static default.
    if (isComposioEnabled()) {
      console.log('[AgentGateway] Composio enabled — session will init on first chat request with user context')
    }

    // Initialize session persistence and restore sessions
    this.sessionPersistence = new SqliteSessionPersistence(this.workspaceDir)
    this.sessionManager.setPersistence(this.sessionPersistence)
    await this.sessionManager.restoreSessions()

    // Start session pruning
    this.sessionManager.startPruning()

    // Run BOOT.md if it exists
    await this.runBootMd()

    // Emit gateway:startup hook
    await this.hookEmitter.emit(
      HookEmitter.createEvent('gateway', 'startup', 'system', {
        workspaceDir: this.workspaceDir,
        projectId: this.projectId,
      })
    )

    console.log('[AgentGateway] Started successfully')
    this.emitLog('Agent gateway started')
  }

  async stop(): Promise<void> {
    console.log('[AgentGateway] Stopping...')
    this.running = false

    this.sessionManager.destroy()
    this.sessionPersistence?.close()
    await this.skillServerManager.stop()
    await this.mcpClientManager.stopAll()

    for (const [name, adapter] of this.channels) {
      try {
        await adapter.disconnect()
        console.log(`[AgentGateway] Disconnected ${name}`)
      } catch (error: any) {
        console.error(`[AgentGateway] Error disconnecting ${name}:`, error.message)
      }
    }
    this.channels.clear()

    await this.hookEmitter.emit(
      HookEmitter.createEvent('gateway', 'shutdown', 'system', {
        workspaceDir: this.workspaceDir,
      })
    )

    console.log('[AgentGateway] Stopped')
  }

  // ---------------------------------------------------------------------------
  // BOOT.md
  // ---------------------------------------------------------------------------

  private async runBootMd(): Promise<void> {
    const bootPath = join(this.workspaceDir, 'BOOT.md')
    if (!existsSync(bootPath)) return

    const bootContent = readFileSync(bootPath, 'utf-8').trim()
    if (!bootContent) return

    console.log('[AgentGateway] Running BOOT.md...')
    try {
      const response = await this.agentTurn(
        `[BOOT]\nYou are starting up. Execute the following startup instructions:\n\n${bootContent}`,
        'boot'
      )
      console.log('[AgentGateway] BOOT.md result:', response.substring(0, 200))
    } catch (error: any) {
      console.error('[AgentGateway] BOOT.md execution failed:', error.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------


  private isInQuietHours(): boolean {
    if (!this.config.quietHours.start || !this.config.quietHours.end) {
      return false
    }

    const now = new Date()
    const tz = this.config.quietHours.timezone || 'UTC'
    let hours: number
    let minutes: number
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
      const timeStr = fmt.format(now)
      const [h, m] = timeStr.split(':').map(Number)
      hours = h % 24
      minutes = m
    } catch {
      hours = now.getUTCHours()
      minutes = now.getUTCMinutes()
    }
    const currentTime = hours * 60 + minutes

    const [startH, startM] = this.config.quietHours.start.split(':').map(Number)
    const [endH, endM] = this.config.quietHours.end.split(':').map(Number)
    const startTime = startH * 60 + startM
    const endTime = endH * 60 + endM

    // Log the comparison for debugging
    const currentStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    console.log(`[AgentGateway] Quiet hours check: current=${currentStr} (${tz}), window=${this.config.quietHours.start}-${this.config.quietHours.end}`)

    if (startTime <= endTime) {
      return currentTime >= startTime && currentTime < endTime
    }
    return currentTime >= startTime || currentTime < endTime
  }

  async heartbeatTick(): Promise<string> {
    this.lastHeartbeatTick = new Date()

    const heartbeatPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'HEARTBEAT.md')
    if (!heartbeatPath) {
      return 'HEARTBEAT_OK'
    }

    const checklist = readFileSync(heartbeatPath, 'utf-8').trim()
    if (!checklist) {
      return 'HEARTBEAT_OK'
    }

    if (this.isInQuietHours()) {
      console.log('[AgentGateway] Heartbeat skipped (quiet hours)')
      this.emitLog('Heartbeat skipped (quiet hours)')
      return 'HEARTBEAT_OK'
    }

    console.log('[AgentGateway] Running heartbeat...')
    this.emitLog('Running heartbeat...')

    let pendingSection = ''
    if (this.pendingEvents.length > 0) {
      pendingSection = `\n\n[Pending Events]\n${this.pendingEvents.join('\n')}`
      this.pendingEvents = []
    }

    const response = await this.agentTurn(
      `[HEARTBEAT]\nYou are performing a scheduled heartbeat check. Review the following checklist and take action as needed. If everything is fine, respond with exactly "HEARTBEAT_OK". If something needs attention, describe the issue and any actions taken.\n\n${checklist}${pendingSection}`,
      'heartbeat',
      true
    )

    await this.hookEmitter.emit(
      HookEmitter.createEvent('heartbeat', 'tick', 'heartbeat', {
        workspaceDir: this.workspaceDir,
        response,
        hadAlert: response !== 'HEARTBEAT_OK',
      })
    )

    if (response !== 'HEARTBEAT_OK') {
      console.log('[AgentGateway] Heartbeat alert:', response.substring(0, 200))
      this.emitLog(`Heartbeat alert: ${response.substring(0, 200)}`)
      await this.deliverAlert(response)

      await this.hookEmitter.emit(
        HookEmitter.createEvent('heartbeat', 'alert', 'heartbeat', {
          workspaceDir: this.workspaceDir,
          alertText: response,
        })
      )
    } else {
      console.log('[AgentGateway] Heartbeat OK')
      this.emitLog('Heartbeat OK')
    }

    this.appendDailyMemory(`Heartbeat: ${response === 'HEARTBEAT_OK' ? 'All clear' : response.substring(0, 200)}`)

    return response
  }

  async triggerHeartbeat(): Promise<string> {
    return this.heartbeatTick()
  }

  queuePendingEvent(text: string): void {
    this.pendingEvents.push(text)
  }

  // ---------------------------------------------------------------------------
  // Message Processing
  // ---------------------------------------------------------------------------

  async processMessage(input: IncomingMessage): Promise<void> {
    this.emitLog(`Channel message from ${input.channelType || 'unknown'}: "${(input.text || '').substring(0, 100)}"`)
    const sessionId = input.channelId || 'default'
    const qs = this.getQueueState(sessionId)
    this.sessionManager.getOrCreate(sessionId)

    await this.hookEmitter.emit(
      HookEmitter.createEvent('message', 'received', sessionId, {
        workspaceDir: this.workspaceDir,
        from: input.senderId,
        content: input.text,
        channelId: input.channelId,
        channelType: input.channelType,
      })
    )

    qs.queue.push(input)

    if (!qs.processing) {
      await this.processQueue(sessionId, qs)
    }
  }

  private queueState: Map<string, { queue: IncomingMessage[]; processing: boolean }> = new Map()

  private getQueueState(sessionId: string) {
    let state = this.queueState.get(sessionId)
    if (!state) {
      state = { queue: [], processing: false }
      this.queueState.set(sessionId, state)
    }
    return state
  }

  private async processQueue(
    sessionId: string,
    qs: { queue: IncomingMessage[]; processing: boolean }
  ): Promise<void> {
    qs.processing = true
    const session = this.sessionManager.getOrCreate(sessionId)
    session.stopRequested = false

    while (qs.queue.length > 0 && !session.stopRequested) {
      const message = qs.queue.shift()!

      // Apply channel-configured model (defaults to 'basic' for safe billing).
      // Only accept known values to prevent config.json tampering from bypassing tiers.
      if (message.channelType) {
        const channelDef = this.config.channels.find(c => c.type === message.channelType)
        const model = channelDef?.model
        session.modelOverride = (model === 'basic' || model === 'advanced') ? model : 'basic'
      }

      try {
        const cmdResult = parseSlashCommand(message.text, this.buildSlashContext(sessionId))
        if (cmdResult.handled) {
          const response = cmdResult.response || ''

          if (cmdResult.hookEvent) {
            await this.hookEmitter.emit(
              HookEmitter.createEvent(
                cmdResult.hookEvent.type,
                cmdResult.hookEvent.action,
                sessionId,
                {
                  ...cmdResult.hookEvent.context,
                  senderId: message.senderId,
                  channelType: message.channelType,
                }
              )
            )
          }

          if (cmdResult.hookEvent?.action === 'stop') {
            session.stopRequested = true
          }

          if (response && message.channelId && this.channels.has(message.channelType || '')) {
            const adapter = this.channels.get(message.channelType!)
            await adapter?.sendMessage(message.channelId, response)
          }

          continue
        }

        const matchedSkill = matchSkill(this.skills, message.text)
        let prompt = message.text
        let activeSkill: { name: string } | undefined

        if (matchedSkill) {
          prompt = [
            `[Skill: ${matchedSkill.name}]`,
            `A saved skill matched this request. Follow its instructions for this integration.`,
            `You can still use tool_search if you need additional tools or integrations beyond what the skill provides.`,
            ``,
            matchedSkill.content,
            ``,
            `[User Message]`,
            message.text,
          ].join('\n')
          activeSkill = { name: matchedSkill.name }
        }

        const adapter = (message.channelId && this.channels.has(message.channelType || ''))
          ? this.channels.get(message.channelType!)
          : undefined
        const streamTarget = adapter && message.channelId
          ? { adapter, channelId: message.channelId }
          : undefined

        const response = await this.agentTurn(prompt, sessionId, false, streamTarget, undefined, activeSkill)

        if (adapter && message.channelId && !this.config.streamChunk) {
          await adapter.sendMessage(message.channelId, response)
        }

        await this.hookEmitter.emit(
          HookEmitter.createEvent('message', 'sent', sessionId, {
            workspaceDir: this.workspaceDir,
            to: message.channelId,
            content: response,
            channelType: message.channelType,
          })
        )

        this.appendDailyMemory(
          `${message.channelType || 'test'}: "${message.text.substring(0, 100)}" -> "${response.substring(0, 100)}"`
        )
      } catch (error: any) {
        console.error('[AgentGateway] Message processing error:', error.message)
      }
    }

    qs.processing = false
  }

  private isUnconfigured(): boolean {
    if (this.skills.length > 0 || this.configSkills.length > 0) return false
    const agentsPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'AGENTS.md')
    if (!agentsPath) return true
    const content = readFileSync(agentsPath, 'utf-8')
    return content.includes('Respond concisely and helpfully') && content.includes('# Agent Instructions')
  }

  private buildSetupPrompt(userText: string): string {
    return `[Agent Setup — First Message]\nThis is a brand new agent that has not been configured yet. The user's message below describes what they want the agent to do. Use your tools to set up the agent:\n\n1. Write IDENTITY.md with a fitting name, emoji, and tagline\n2. Write SOUL.md with personality, tone, and boundaries appropriate for this use case\n3. Write AGENTS.md with specific operating instructions and priorities (IMPORTANT: replace the default content)\n4. Write HEARTBEAT.md with a relevant checklist if the agent should run autonomously\n5. Create any relevant skills in the skills/ directory\n6. Update config.json if heartbeat should be enabled\n\nAfter setting up, give the user a brief summary of what you configured.\n\n[User Message]\n${userText}`
  }

  private buildChatPrompt(text: string): { prompt: string; activeSkill?: { name: string } } {
    const matchedSkill = matchSkill(this.skills, text)
    if (matchedSkill) {
      this.emitLog(`Matched skill: ${matchedSkill.name}`)
      const prompt = [
        `[Skill: ${matchedSkill.name}]`,
        `A saved skill matched this request. Follow its instructions for this integration.`,
        `You can still use tool_search if you need additional tools or integrations beyond what the skill provides.`,
        ``,
        matchedSkill.content,
        ``,
        `[User Message]`,
        text,
      ].join('\n')
      return { prompt, activeSkill: { name: matchedSkill.name } }
    }
    return { prompt: `[Chat — User Message]\nThis is a direct message from a user, NOT a heartbeat trigger. Respond conversationally and helpfully. Do NOT respond with HEARTBEAT_OK.\n\n${text}` }
  }

  async processChatMessage(text: string): Promise<string> {
    this.emitLog(`Chat message received: "${text.substring(0, 100)}"`)

    let prompt: string
    let activeSkill: { name: string } | undefined
    if (this.isUnconfigured()) {
      prompt = this.buildSetupPrompt(text)
      this.emitLog('Agent is not configured — running setup from user message')
    } else {
      const result = this.buildChatPrompt(text)
      prompt = result.prompt
      activeSkill = result.activeSkill
    }

    const response = await this.agentTurn(prompt, 'chat', false, undefined, undefined, activeSkill)
    this.emitLog(`Chat response: "${response.substring(0, 100)}"`)

    this.appendDailyMemory(`chat: "${text.substring(0, 100)}" -> "${response.substring(0, 100)}"`)

    return response
  }

  /**
   * Streaming variant of processChatMessage that pipes text deltas and
   * tool call events to a UI message stream writer (AI SDK protocol).
   */
  async processChatMessageStream(
    text: string,
    writer: { write(chunk: Record<string, any>): void },
    options?: {
      modelOverride?: string
      fileParts?: FilePart[]
      userId?: string
      interactionMode?: 'agent' | 'plan' | 'ask'
      confirmedPlan?: { name: string; overview: string; plan: string; todos: Array<{ id: string; content: string }> }
    },
  ): Promise<void> {
    if (options?.modelOverride) {
      const session = this.sessionManager.getOrCreate('chat')
      session.modelOverride = options.modelOverride
    }

    if (options?.userId) {
      this.currentUserId = options.userId
      if (isComposioEnabled()) {
        await initComposioSession(options.userId, this.projectId)
      }
    }

    this.emitLog(`Chat message received (stream): "${text.substring(0, 100)}"`)

    let images: ImageContent[] | undefined
    let effectiveText = text
    if (options?.fileParts && options.fileParts.length > 0) {
      const parsed = parseFileAttachments(options.fileParts)
      if (parsed.images.length > 0) {
        images = parsed.images
        this.emitLog(`Attached ${parsed.images.length} image(s) for vision`)
      }
      if (parsed.textContext) {
        effectiveText = text
          ? `${text}\n\n${parsed.textContext}`
          : parsed.textContext
      }
    }

    // If a confirmed plan is present, prepend it as context to the user's message
    if (options?.confirmedPlan) {
      const cp = options.confirmedPlan
      const todoList = cp.todos.map(t => `- [ ] ${t.content}`).join('\n')
      const planContext = [
        'The user has confirmed the following plan. Execute it step by step:',
        '',
        `## ${cp.name}`,
        cp.overview,
        '',
        cp.plan,
        '',
        '## Tasks',
        todoList,
        '',
        'Proceed with execution now.',
      ].join('\n')
      effectiveText = effectiveText
        ? `${planContext}\n\n---\n\nUser message: ${effectiveText}`
        : planContext
    }

    let prompt: string
    let activeSkill: { name: string } | undefined
    if (this.isUnconfigured()) {
      prompt = this.buildSetupPrompt(effectiveText)
      this.emitLog('Agent is not configured — running setup from user message')
    } else {
      const result = this.buildChatPrompt(effectiveText)
      prompt = result.prompt
      activeSkill = result.activeSkill
    }

    const interactionMode = options?.interactionMode || 'agent'
    const response = await this.agentTurn(prompt, 'chat', false, undefined, writer, activeSkill, images, interactionMode)
    this.emitLog(`Chat response (stream): "${response.substring(0, 100)}"`)

    this.appendDailyMemory(`chat: "${text.substring(0, 100)}" -> "${response.substring(0, 100)}"`)
  }

  async processWebhookMessage(text: string): Promise<string> {
    return this.agentTurn(text, 'webhook')
  }

  async processCanvasAction(event: { surfaceId: string; name: string; context?: Record<string, unknown> }): Promise<string> {
    const { surfaceId, name, context } = event
    const { _sendToAgent, ...cleanContext } = context ?? {}
    const contextStr = Object.keys(cleanContext).length > 0
      ? `\nContext: ${JSON.stringify(cleanContext, null, 2)}`
      : ''
    const prompt = [
      `[Canvas Action] The user clicked "${name}" on surface "${surfaceId}".${contextStr}`,
      `Process this action and update the canvas accordingly.`,
    ].join('\n')
    return this.agentTurn(prompt, 'canvas-action')
  }

  private buildSlashContext(sessionId: string): SlashCommandContext {
    const session = this.sessionManager.getOrCreate(sessionId)
    return {
      sessionKey: sessionId,
      workspaceDir: this.workspaceDir,
      clearHistory: () => {
        this.sessionManager.clearHistory(sessionId)
      },
      getMessages: () => [...session.messages],
      reloadConfig: () => this.reloadConfig(),
      setModelOverride: (model: string) => {
        session.modelOverride = model
      },
      getStatus: () => this.getStatus(),
    }
  }

  // ---------------------------------------------------------------------------
  // Agent Turn (Pi Agent Core)
  // ---------------------------------------------------------------------------

  private async agentTurn(
    prompt: string,
    sessionId: string = 'default',
    isHeartbeat: boolean = false,
    streamTarget?: { adapter: ChannelAdapter; channelId: string },
    uiWriter?: { write(chunk: Record<string, any>): void },
    activeSkill?: { name: string },
    images?: ImageContent[],
    interactionMode: 'agent' | 'plan' | 'ask' = 'agent',
  ): Promise<string> {
    // Reload skills from disk so any files created/edited/deleted by file tools are picked up
    this.skills = loadAllSkills(this.workspaceDir)
    setLoadedSkills(this.skills)

    // Start the skill server if it was just created (no-op if already running)
    if (!this.skillServerManager.isRunning) {
      this.skillServerManager.start().catch(() => {})
    }

    if (activeSkill) {
      const skillOverride = [
        `## Tool Discovery — Skill Active`,
        ``,
        `The skill "${activeSkill.name}" has been loaded for this request.`,
        `Follow the skill's instructions directly for this integration:`,
        `- Call \`tool_install\` for managed OAuth integrations, or \`mcp_install\` for MCP servers, as the skill directs`,
        `- Proceed to execution with the tools listed in the skill`,
        ``,
        `You can still use \`tool_search\` if you need additional tools, integrations, or skills beyond what the skill provides.`,
      ].join('\n')
      this.promptOverrides.set('mcp_discovery_guide', skillOverride)
    }
    let systemPrompt = this.loadBootstrapContext()
    if (activeSkill) {
      this.promptOverrides.delete('mcp_discovery_guide')
    }

    // Interaction mode system prompt injection
    if (interactionMode === 'plan') {
      const planModePrompt = [
        '## PLAN MODE ACTIVE',
        '',
        'Plan mode is active. You MUST NOT make any edits, run commands, write files, or otherwise make changes. This supersedes all other instructions.',
        '',
        'Your job:',
        '1. Research the user\'s request using read-only tools (read_file, grep, glob, web, etc.)',
        '2. If you need more information, ask clarifying questions using ask_user',
        '3. If the request is too broad, ask 1-2 narrowing questions using ask_user',
        '4. If there are multiple valid approaches, ask the user which they prefer',
        '5. When you have enough context, call create_plan with a structured plan',
        '6. The plan should be concise, specific, and actionable — cite file paths and code snippets',
        '7. Do NOT make any changes until the user confirms the plan',
      ].join('\n')
      systemPrompt = planModePrompt + '\n\n---\n\n' + systemPrompt
    } else if (interactionMode === 'ask') {
      const askModePrompt = [
        '## ASK MODE ACTIVE',
        '',
        'Ask mode is active. You are in a read-only conversational mode. Answer the user\'s questions directly using your knowledge and conversation context. You have no tools available. Do not attempt to make changes, run commands, or take any actions. Just provide helpful, informative answers.',
      ].join('\n')
      systemPrompt = askModePrompt + '\n\n---\n\n' + systemPrompt
    }

    const session = this.sessionManager.getOrCreate(sessionId)
    const modelId = session.modelOverride || this.config.model.name
    const provider = this.config.model.provider

    // Reset per-turn state and wire/clear the SSE writer for permission requests.
    // When there's no uiWriter (cron, heartbeat, channel, webhook turns),
    // clear the callback so "ask" decisions fail closed instead of writing
    // to a stale stream from a previous UI turn.
    if (this.permissionEngine) {
      this.permissionEngine.resetTurn()
      this.permissionEngine.setSseCallback(
        uiWriter ? (event) => uiWriter.write(event) : undefined
      )
    }

    const toolContext: ToolContext = {
      workspaceDir: this.workspaceDir,
      channels: this.channels,
      config: this.config,
      projectId: this.projectId,
      sessionId,
      sandbox: this.config.sandbox,
      mainSessionIds: this.config.mainSessionIds,
      mcpClientManager: this.mcpClientManager,
      connectChannel: (type, config) => this.connectChannel(type, config),
      disconnectChannel: (type) => this.disconnectChannel(type),
      permissionEngine: this.permissionEngine ?? undefined,
      userId: this.currentUserId,
      aiProxyUrl: process.env.AI_PROXY_URL,
      aiProxyToken: process.env.AI_PROXY_TOKEN,
      uiWriter,
      canvasFileWatcher: this.config.canvasMode === 'code'
        ? this.canvasFileWatcher
        : undefined,
      updateHeartbeatConfig: async (config) => {
        const apiUrl = deriveApiUrl()
        if (!apiUrl) return
        const url = `${apiUrl}/api/internal/heartbeat/config/${this.projectId}`
        const res = await fetch(url, {
          method: 'PUT',
          headers: getInternalHeaders(),
          body: JSON.stringify(config),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) {
          throw new Error(`Heartbeat config update failed: HTTP ${res.status}`)
        }
        this.reloadConfig()
      },
    }

    const baseTools = isHeartbeat
      ? createHeartbeatTools(toolContext)
      : createTools(toolContext)

    const mcpTools = this.mcpClientManager.getTools()
    let assembledTools = mcpTools.length > 0 ? [...baseTools, ...mcpTools] : baseTools

    // Strip skill and preview tools from heartbeat runs
    if (isHeartbeat) {
      assembledTools = assembledTools.filter(t =>
        t.name !== 'skill' &&
        t.name !== 'preview_status' && t.name !== 'preview_restart'
      )
    }

    // Capability toggles (independent of mode)
    if (this.config.webEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'web' && t.name !== 'browser')
    }
    if (this.config.shellEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'exec')
    }
    if (this.config.cronEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'cron')
    }
    if (this.config.imageGenEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'generate_image')
    }
    if (this.config.memoryEnabled === false) {
      assembledTools = assembledTools.filter(t => !t.name.startsWith('memory_'))
    }
    if (this.config.canvasMode === 'code') {
      assembledTools = assembledTools.filter(t => !t.name.startsWith('canvas_') || t.name === 'canvas_lint')
    }

    // Interaction mode tool restrictions
    if (interactionMode === 'ask') {
      assembledTools = []
    } else if (interactionMode === 'plan') {
      const PLAN_MODE_ALLOWED = new Set([
        'read_file', 'glob', 'grep', 'ls', 'list_files', 'search_files',
        'web', 'browser',
        'memory_read', 'memory_search',
        'ask_user', 'todo_write', 'create_plan',
        'canvas_inspect', 'canvas_components',
        'skill',
      ])
      assembledTools = assembledTools.filter(t => PLAN_MODE_ALLOWED.has(t.name))
    }

    let staticTools = assembledTools
    if (this.toolMocks.size > 0) {
      const existingNames = new Set(assembledTools.map(t => t.name))
      const gateway = this

      // Wrap existing tools with mock interceptors
      staticTools = assembledTools.map(tool => {
        const mockFn = this.toolMocks.get(tool.name)
        if (!mockFn) return tool

        // Special handling for tool_install: promote hidden mocks listed in the response
        if (tool.name === 'tool_install') {
          return {
            ...tool,
            execute: async (_id: string, params: any) => {
              const result = mockFn(params)
              gateway._promoteHiddenMocksFromInstall(result)
              return textResult(result)
            },
          }
        }

        return {
          ...tool,
          execute: async (_id: string, params: any) => {
            const result = mockFn(params)
            return textResult(result)
          },
        }
      })

      // Inject synthetic tool definitions for mocked tools not in the base set
      // Skip hidden tools — they become available only after tool_install promotes them
      for (const [name, mockFn] of this.toolMocks) {
        if (existingNames.has(name)) continue
        if (this.hiddenMockTools.has(name)) continue
        const synDef = this.syntheticTools.get(name)
        const paramProps: Record<string, any> = {}
        if (synDef?.paramKeys) {
          for (const key of synDef.paramKeys) {
            paramProps[key] = Type.Optional(Type.String({ description: key }))
          }
        }
        paramProps['input'] = Type.Optional(Type.String({ description: 'Input data or query' }))
        const syntheticTool: AgentTool = {
          name,
          description: synDef?.description || `External integration tool: ${name}`,
          label: name.replace(/__/g, ' > ').replace(/_/g, ' '),
          parameters: Type.Object(paramProps),
          execute: async (_id: string, params: any) => {
            const result = mockFn(params)
            return textResult(result)
          },
        }
        staticTools.push(syntheticTool)
      }
    }

    // Dynamic tools proxy: pi-agent-core uses tools.find() and iterates tools.
    // When tool_install hot-adds servers mid-turn, their tools must be visible
    // immediately. This proxy merges staticTools with live MCP tools on access.
    // Also includes promotedMockTools (hidden mocks promoted via mock tool_install).
    const mcpMgr = this.mcpClientManager
    const promoted = this.promotedMockTools
    const staticNames = new Set(staticTools.map(t => t.name))
    const tools = new Proxy(staticTools, {
      get(target, prop, receiver) {
        if (prop === 'find' || prop === 'filter' || prop === 'map' ||
            prop === 'forEach' || prop === 'some' || prop === 'every' ||
            prop === Symbol.iterator || prop === 'length' ||
            prop === 'slice' || prop === 'concat' || prop === 'includes') {
          const liveMcpTools = mcpMgr.getTools().filter(t => !staticNames.has(t.name))
          const promotedNew = promoted.filter(t => !staticNames.has(t.name))
          const extras = [...liveMcpTools, ...promotedNew]
          const merged = extras.length > 0 ? [...target, ...extras] : target
          if (prop === 'length') return merged.length
          if (prop === Symbol.iterator) return merged[Symbol.iterator].bind(merged)
          return (merged as any)[prop].bind(merged)
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as AgentTool[]

    const history = this.sessionManager.buildHistory(sessionId)

    // Typing indicator: send once before the turn and periodically
    let typingInterval: ReturnType<typeof setInterval> | undefined
    if (streamTarget?.adapter.sendTyping) {
      streamTarget.adapter.sendTyping(streamTarget.channelId).catch(() => {})
      typingInterval = setInterval(() => {
        streamTarget.adapter.sendTyping?.(streamTarget.channelId).catch(() => {})
      }, 4000)
    }

    // Streaming: set up block chunker only if streamChunk config is enabled
    let chunker: BlockChunker | undefined
    const streamedChunks: string[] = []
    if (streamTarget && this.config.streamChunk) {
      chunker = new BlockChunker(
        (chunk) => {
          streamedChunks.push(chunk)
          streamTarget.adapter.sendMessage(streamTarget.channelId, chunk).catch((err) => {
            console.error('[AgentGateway] Stream chunk send failed:', err.message)
          })
        },
        this.config.streamChunk,
      )
    }

    // UI stream writer: track current text/reasoning blocks for delta streaming
    let uiTextId: string | null = null
    let uiReasoningId: string | null = null
    let pendingToolkitError: string | null = null

    // Gate map: onBeforeToolCall stores a promise per toolCallId that
    // resolves once the tool-input-start SSE events have had time to
    // flush to the client.  onAfterToolCall awaits this promise before
    // writing tool-output events, preventing React from batching all
    // tool events into a single render that skips the loading state.
    const toolFlushGates = new Map<string, Promise<void>>()

    // Canvas streaming: track active parsers and which tool calls already
    // sent their tool-input-start via the streaming path.
    const canvasParsers = new Map<string, CanvasStreamParser>()
    const canvasCodeParsers = new Map<string, CanvasCodeStreamParser>()
    const streamedToolCalls = new Set<string>()

    try {
      const hookEmitter = this.hookEmitter
      const result = await runAgentLoop({
        provider,
        model: modelId,
        system: systemPrompt,
        history,
        prompt,
        images,
        tools,
        maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS || '50', 10),
        loopDetection: this.config.loopDetection,
        streamFn: this._streamFn,
        thinkingLevel: 'medium',
        onToolCall: (name, input) => {
          console.log(`${this.logPrefix} Tool call: ${name}`, JSON.stringify(input).substring(0, 200))
        },
        onThinkingStart: () => {
          if (uiWriter) {
            uiReasoningId = `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
            uiWriter.write({ type: 'reasoning-start', id: uiReasoningId })
          }
        },
        onThinkingDelta: (delta) => {
          if (uiWriter && uiReasoningId) {
            uiWriter.write({ type: 'reasoning-delta', id: uiReasoningId, delta })
          }
        },
        onThinkingEnd: () => {
          if (uiWriter && uiReasoningId) {
            uiWriter.write({ type: 'reasoning-end', id: uiReasoningId })
            uiReasoningId = null
          }
        },
        onTextDelta: (delta) => {
          if (chunker) chunker.push(delta)
          if (uiWriter) {
            if (!uiTextId) {
              uiTextId = `text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              uiWriter.write({ type: 'text-start', id: uiTextId })
            }
            uiWriter.write({ type: 'text-delta', id: uiTextId, delta })
          }
        },
        onToolCallStart: (toolName, toolCallId) => {
          if (uiWriter && uiTextId) {
            uiWriter.write({ type: 'text-end', id: uiTextId })
            uiTextId = null
          }
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-start', toolCallId, toolName, dynamic: true })
            streamedToolCalls.add(toolCallId)
          }
          if (toolName === 'canvas_update') {
            const manager = getDynamicAppManager()
            const parser = new CanvasStreamParser({
              onSurfaceId: () => {},
              onComponents: (components) => {
                const sid = parser.getSurfaceId()
                if (sid) {
                  manager.streamPreviewComponents(sid, components as any)
                  if (uiWriter) {
                    uiWriter.write({
                      type: 'data-canvas-preview',
                      data: { surfaceId: sid, components },
                    } as any)
                  }
                }
              },
            })
            canvasParsers.set(toolCallId, parser)
          }
          if ((toolName === 'write_file' || toolName === 'edit_file') && this.config.canvasMode === 'code') {
            const watcher = this.canvasFileWatcher
            const codeParser = new CanvasCodeStreamParser(
              toolName as 'write_file' | 'edit_file',
              {
                onPreview: (surfaceId, code) => {
                  const title = surfaceId.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                  watcher.broadcast({ type: 'renderCode', surfaceId, title, code })
                },
                getCurrentCode: (surfaceId) => {
                  const init = watcher.getInitEvent()
                  return init.surfaces?.find(s => s.surfaceId === surfaceId)?.code
                },
              },
            )
            canvasCodeParsers.set(toolCallId, codeParser)
          }
        },
        onToolCallDelta: (toolName, delta, toolCallId) => {
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-delta', toolCallId, inputTextDelta: delta })
          }
          const parser = canvasParsers.get(toolCallId)
          if (parser) {
            parser.feed(delta)
          }
          const codeParser = canvasCodeParsers.get(toolCallId)
          if (codeParser) {
            codeParser.feed(delta)
          }
        },
        onToolCallEnd: (_toolName, toolCallId) => {
          canvasParsers.delete(toolCallId)
          const codeParser = canvasCodeParsers.get(toolCallId)
          if (codeParser) {
            codeParser.flush()
            canvasCodeParsers.delete(toolCallId)
          }
        },
        onBeforeToolCall: async (toolName, args, toolCallId) => {
          if (uiWriter && uiTextId) {
            uiWriter.write({ type: 'text-end', id: uiTextId })
            uiTextId = null
          }
          if (uiWriter && !streamedToolCalls.has(toolCallId)) {
            uiWriter.write({ type: 'tool-input-start', toolCallId, toolName, dynamic: true })
            uiWriter.write({ type: 'tool-input-delta', toolCallId, inputTextDelta: JSON.stringify(args) })
          }
          streamedToolCalls.delete(toolCallId)
          // Store a flush gate that resolves after a short delay, giving
          // the HTTP layer time to deliver the tool-input-start chunk to
          // the client before tool-output-available arrives.
          // NOTE: the pi-agent-core event system does NOT await this
          // callback before firing tool_execution_end, so onAfterToolCall
          // must explicitly await this gate.
          toolFlushGates.set(
            toolCallId,
            new Promise(resolve => setTimeout(resolve, 30)),
          )
          await hookEmitter.emit(
            HookEmitter.createEvent('tool', 'before', sessionId, {
              toolName, args, toolCallId, workspaceDir: this.workspaceDir,
            })
          )
        },
        onAfterToolCall: async (toolName, args, result, isError, toolCallId) => {
          // Wait for onBeforeToolCall's flush gate so the client receives
          // tool-input-start in a separate HTTP chunk before we send the output.
          const gate = toolFlushGates.get(toolCallId)
          if (gate) {
            await gate
            toolFlushGates.delete(toolCallId)
          }
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-available', toolCallId, toolName, input: args, dynamic: true })
            // ask_user is a UI-driven tool: suppress tool-output-available so the widget
            // stays in interactive (input-available) state until the user submits their
            // answer as the next user message.
            if (toolName === 'ask_user') return
            uiWriter.write({
              type: 'tool-output-available',
              toolCallId,
              output: isError ? { error: typeof result === 'string' ? result : JSON.stringify(result) } : (result ?? { success: true }),
            })

            if (isComposioTool(toolName) && !pendingToolkitError) {
              if (isError || hasErrorInResult(result)) {
                const toolkit = extractToolkitName(toolName)
                const rawStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
                let cleanError = rawStr
                try { const p = JSON.parse(rawStr); if (p?.error) cleanError = String(p.error) } catch {}
                pendingToolkitError = toolkit
                const authError = isAuthError(cleanError)
                uiWriter.write({
                  type: 'data-tool-error',
                  id: `tool-err-${toolCallId}`,
                  data: { toolkitName: toolkit, error: toUserMessage(toolkit, cleanError), isAuthError: authError },
                } as any)
              }
            }
          }
          await hookEmitter.emit(
            HookEmitter.createEvent('tool', 'after', sessionId, {
              toolName, args, result, isError, toolCallId, workspaceDir: this.workspaceDir,
            })
          )
          if (!isError && toolName.startsWith('mcp_')) {
            try {
              getDynamicAppManager().handleToolCallInvalidation(toolName)
            } catch { /* non-critical */ }
          }
        },
        onAgentEnd: async (loopResult) => {
          await hookEmitter.emit(
            HookEmitter.createEvent('agent', 'end', sessionId, {
              iterations: loopResult.iterations,
              toolCallCount: loopResult.toolCalls.length,
              inputTokens: loopResult.inputTokens,
              outputTokens: loopResult.outputTokens,
              loopDetected: !!loopResult.loopBreak,
              workspaceDir: this.workspaceDir,
            })
          )
        },
      })

      // Flush any remaining buffered text
      chunker?.flush()
      chunker?.dispose()

      // Close any open UI text block
      if (uiWriter && uiTextId) {
        uiWriter.write({ type: 'text-end', id: uiTextId })
        uiTextId = null
      }

      // Store usage for callers (server.ts includes it in the `finish` event)
      this._lastTurnUsage = {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        iterations: result.iterations,
        toolCallCount: result.toolCalls.length,
      }

      if (result.loopBreak) {
        console.warn(
          `${this.logPrefix} Loop detected in session ${sessionId}: ${result.loopBreak.pattern}`
        )
      }

      const totalInput = result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens
      if (result.toolCalls.length > 0) {
        console.log(
          `${this.logPrefix} Agent turn: ${result.iterations} iterations, ${result.toolCalls.length} tool calls, ${totalInput}+${result.outputTokens} tokens (${result.cacheReadTokens} cached)`
        )
      }

      if (result.error) {
        const msg = result.error.message || 'An unexpected error occurred'
        const isProviderError = /api error|api key|auth|unauthorized|forbidden|rate.limit|overloaded|timeout/i.test(msg)
        console.error(
          `${this.logPrefix} Agent error for session ${sessionId}: ${msg} (${result.toolCalls.length} tool calls, ${result.outputTokens} output tokens)`
        )
        chunker?.dispose()
        if (uiWriter) {
          uiWriter.write({
            type: 'error',
            errorText: isProviderError
              ? `AI provider error: ${msg}`
              : `I encountered an issue processing your message: ${msg}`,
          } as any)
        }
      } else if (result.outputTokens === 0 && result.toolCalls.length === 0 && !isHeartbeat) {
        console.error(
          `${this.logPrefix} Agent returned 0 tokens for session ${sessionId} — possible context corruption (${session.compactionCount} compactions, ${session.messages.length} messages, model: ${modelId}, provider: ${provider})`
        )
        if (uiWriter) {
          uiWriter.write({
            type: 'error',
            errorText: 'I encountered an issue processing your message. Please try starting a new conversation.',
          } as any)
        }
      }

      // Store full messages (including tool calls and tool results) in the
      // session so subsequent turns have complete context about prior actions.
      this.sessionManager.addMessages(sessionId, ...result.newMessages)

      if (this.sessionManager.needsCompaction(session)) {
        const compactResult = await this.sessionManager.compact(sessionId)
        if (compactResult) {
          console.log(
            `${this.logPrefix} Session ${sessionId} compacted: ${compactResult.messagesBefore} -> ${compactResult.messagesAfter} messages`
          )
        }
      }

      this.sessionManager.touch(sessionId)

      if (result.text) return result.text
      if (isHeartbeat) return 'HEARTBEAT_OK'
      console.warn(`${this.logPrefix} Empty model response for session ${sessionId} (${result.iterations} iterations, ${result.toolCalls.length} tool calls, ${result.outputTokens} output tokens)`)
      return 'Sorry, I was unable to generate a response. Please try again.'
    } catch (error: any) {
      console.error(`${this.logPrefix} Agent turn failed:`, error.message, error.stack?.split('\n').slice(0, 3).join('\n'))
      chunker?.dispose()
      if (uiWriter) {
        const msg = error.message || 'An unexpected error occurred'
        const isProviderError = /api error|api key|auth|unauthorized|forbidden|rate.limit|overloaded|timeout/i.test(msg)
        uiWriter.write({
          type: 'error',
          errorText: isProviderError
            ? `AI provider error: ${msg}`
            : 'I encountered an issue processing your message. Please try starting a new conversation.',
        } as any)
      }
      if (isHeartbeat) return 'HEARTBEAT_OK'
      return `Sorry, I encountered an error processing your message. Please try again.`
    } finally {
      if (typingInterval) clearInterval(typingInterval)
    }
  }

  private loadBootstrapContext(): string {
    const files = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md']
    const parts: string[] = []

    for (const filename of files) {
      const filepath = resolveWorkspaceConfigFilePath(this.workspaceDir, filename)
      if (filepath) {
        const content = readFileSync(filepath, 'utf-8').trim()
        if (content) {
          parts.push(content)
        }
      }
    }

    const memoryPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'MEMORY.md')
    if (memoryPath) {
      const memory = readFileSync(memoryPath, 'utf-8').trim()
      if (memory) {
        parts.push(`## Memory\n${memory}`)
      }
    }

    // APP_MODE_DISABLED: app template context injection removed (was reading .app-template)

    // Inject agent template context if this project was created from an agent template
    const agentTemplatePath = join(this.workspaceDir, '.template')
    if (existsSync(agentTemplatePath)) {
      const agentTemplate = readFileSync(agentTemplatePath, 'utf-8').trim()
      if (agentTemplate) {
        const humanName = agentTemplate.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        parts.push([
          '## Agent Template Context',
          '',
          `This agent was created from the **${humanName}** template (\`${agentTemplate}\`).`,
          'Your configuration files (AGENTS.md, SOUL.md, IDENTITY.md, HEARTBEAT.md, skills/) are already',
          'set up with template-specific instructions. Follow the instructions in AGENTS.md.',
          '',
          'Canvas surfaces have been pre-built for this template. Use canvas tools directly (canvas_create, canvas_update, etc.)',
          'to update or add surfaces as needed.',
          '',
        ].join('\n'))
      }
    }

    const now = new Date()
    parts.push([
      '## Current Context',
      `- Today: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `- Year: ${now.getFullYear()}`,
      `- Timezone: ${this.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      '',
      'When users mention dates without a year, default to the current or next occurrence (never a past date).',
    ].join('\n'))

    const installedToolsContext = this.buildInstalledToolsContext()
    if (installedToolsContext) {
      parts.push(installedToolsContext)
    }

    const uploadedFilesContext = this.buildUploadedFilesContext()
    if (uploadedFilesContext) {
      parts.push(uploadedFilesContext)
    }

    const workspaceTree = this.buildWorkspaceTreeContext()
    if (workspaceTree) {
      parts.push(workspaceTree)
    }

    const personalityGuide = this.promptOverrides.get('personality_guide') ?? OPTIMIZED_PERSONALITY_GUIDE
    const toolPlanningGuide = this.promptOverrides.get('tool_planning_guide') ?? OPTIMIZED_TOOL_PLANNING_GUIDE
    const memoryGuide = this.promptOverrides.get('memory_guide') ?? OPTIMIZED_MEMORY_GUIDE
    const skillMatchingGuide = this.promptOverrides.get('skill_matching_guide') ?? OPTIMIZED_SKILL_MATCHING_GUIDE

    const activeMode = this.config.activeMode || 'none'
    // Inject mode-specific prompt sections
    if (activeMode === 'canvas') {
      if (this.config.canvasMode === 'code') {
        parts.push(`\n## Canvas Mode — React Code Display

You are in canvas code mode. Write TypeScript React code to \`canvas/*.ts\` files using \`write_file\`, \`edit_file\`, \`delete_file\`. Each file is a separate tab rendered instantly in the canvas panel. Always use \`.ts\` extensions.

**Your workflow in canvas code mode:**
1. Understand what the user wants to display or build
2. If the app needs persistent data, create a skill server by writing \`.shogo/server/schema.prisma\`
3. Write canvas code that fetches from the skill server and renders the UI
4. Use \`edit_file\` to update existing canvas files, \`delete_file\` to remove tabs

**IMPORTANT:** Do NOT switch modes unless the user explicitly asks you to. Stay in canvas mode for all visual work.
`)
      } else {
        parts.push(`\n## Canvas Mode — Declarative Agent Display

You are in canvas mode. You have all canvas tools available directly — use them to build and update canvas surfaces.

**Your workflow in canvas mode:**
1. Understand what the user wants to display or build
2. Do any prerequisite work (fetch data, run commands, search the web, read files, etc.)
3. Use \`canvas_create\` to create surfaces, \`canvas_update\` to build component trees, \`canvas_data\` / \`canvas_data_patch\` to populate data
4. Use \`canvas_api_bind\` to connect live integration data (Gmail, GitHub, Calendar, etc.)
5. Use \`canvas_api_hooks\` for auto-refresh and \`canvas_api_schema\` / \`canvas_api_seed\` for structured data models
6. Use \`canvas_components\` to discover available components and \`canvas_inspect\` to debug existing surfaces

**Live data from integrations:**
When integrations are connected, use \`tool_search\` to discover available actions, then \`canvas_api_bind\` to bind live data directly to canvas components.

**Canvas is view-only** — declarative components for displaying your work output.

**IMPORTANT:** Do NOT switch modes unless the user explicitly asks you to. Stay in canvas mode for all visual work.
`)
      }
    }
    const modeLabel = activeMode === 'none' ? 'chat' : activeMode
    parts.push(`\n## Current Mode\nActive visual mode: **${modeLabel}**.\n`)

    // Mode-specific tool guides
    if (activeMode === 'canvas') {
      if (this.config.canvasMode === 'code') {
        parts.push(this.promptOverrides.get('canvas_v2_guide') ?? CANVAS_V2_GUIDE)
        parts.push(this.promptOverrides.get('canvas_v2_backend_guide') ?? CANVAS_V2_BACKEND_GUIDE)
        parts.push(this.promptOverrides.get('canvas_v2_react_guide') ?? CANVAS_V2_REACT_GUIDE)
        parts.push(this.promptOverrides.get('canvas_v2_examples') ?? CANVAS_V2_EXAMPLES)
      } else {
        parts.push(BASIC_CANVAS_TOOLS_GUIDE)
        parts.push(BASIC_CANVAS_EXAMPLES)
      }
    }
    // General coding guide (edit_file, exec safety, code quality) — always included
    parts.push(CODE_AGENT_GENERAL_GUIDE)
    // APP_MODE_DISABLED: CODE_AGENT_APP_BUILDING_GUIDE no longer injected

    parts.push(PERSONALITY_EVOLUTION_GUIDE_PREFIX + personalityGuide)
    parts.push(toolPlanningGuide)
    parts.push(this.promptOverrides.get('constraint_awareness_guide') ?? OPTIMIZED_CONSTRAINT_AWARENESS_GUIDE)
    if (this.config.memoryEnabled !== false) {
      parts.push(memoryGuide)
    }
    parts.push(skillMatchingGuide)
    parts.push(this.promptOverrides.get('mcp_discovery_guide') ?? OPTIMIZED_MCP_DISCOVERY_GUIDE)

    if (this.permissionEngine) {
      parts.push([
        '## Security Permissions',
        '',
        'This agent runs with a security permission system. Some tool calls may be blocked or require user approval through a UI dialog (not through chat).',
        '- If a tool result says "Permission denied", the action is permanently blocked. Tell the user it is not available. Do NOT ask them to approve it.',
        '- If a tool result says the user "declined" an action, they already decided via the security dialog. Acknowledge it briefly and move on. Do NOT ask again or request confirmation in chat.',
        '- Never try to work around permission denials by re-running the same tool or asking the user to confirm in text.',
      ].join('\n'))
    }

    parts.push([
      '## CRITICAL: Error Notifications (MUST follow)',
      '',
      'You have a tool called `notify_user_error`. You MUST call it whenever:',
      '- A tool returns an error, 404, or access denied',
      '- You cannot complete the task the user asked for',
      '- An integration (GitHub, Slack, Google, etc.) is not working properly',
      '- You detect a configuration or permission issue the user needs to fix',
      '',
      'Usage: `notify_user_error({ title: "GitHub Access Error", message: "The repository CodeGlo/shogo-ai is private or not accessible. Your organization may have OAuth App restrictions enabled. Go to GitHub org Settings > Third-party access to approve." })`',
      '',
      'ALWAYS call notify_user_error BEFORE writing the error explanation in chat.',
      'The title should be short (e.g. "GitHub Access Error", "Slack Auth Expired").',
      'The message should explain what went wrong AND how to fix it.',
      'This shows a prominent toast notification that the user will not miss.',
    ].join('\n'))

    // Inject available skill descriptions
    if (this.skills.length > 0) {
      const skillsSection = buildSkillsPromptSection(this.skills)
      if (skillsSection) {
        parts.push(skillsSection)
      }
    }

    // Inject skill server context
    const skillServerSection = this.buildSkillServerPromptSection()
    if (skillServerSection) {
      parts.push(skillServerSection)
    }

    return parts.join('\n\n---\n\n')
  }

  /**
   * Build a system prompt section describing the skill server.
   * If the server is running, tells the agent the base URL.
   * If not, tells the agent how to create one.
   */
  private buildSkillServerPromptSection(): string | null {
    if (this.config.shellEnabled === false) return null

    if (this.skillServerManager.isRunning) {
      return [
        '## Skill Server',
        '',
        `A skill server is running at **${this.skillServerManager.url}**.`,
        '',
        'This is a Hono API backed by SQLite. To see what endpoints exist,',
        'read `.shogo/server/schema.prisma` — each Prisma model has CRUD routes at',
        '`/api/{model-name-plural}` (GET list, GET /:id, POST, PATCH /:id, DELETE /:id).',
        '',
        'Use the `web` tool with the full URL (e.g. `web({ url: "' + this.skillServerManager.url + '/api/leads" })`) to interact with it.',
        '',
        'To add new models or change the schema, just edit `.shogo/server/schema.prisma`.',
        'Code generation, database migration, and server restart happen **automatically** when the schema file changes.',
        '',
        'Custom business logic goes in `.shogo/server/generated/{model}.hooks.ts` (beforeCreate, afterUpdate, etc.).',
      ].join('\n')
    }

    const phase = this.skillServerManager.phase
    const genError = this.skillServerManager.lastGenerateError

    if (phase === 'generating') {
      return [
        '## Skill Server (Generating...)',
        '',
        'The skill server is currently regenerating from your schema changes.',
        'It will be available shortly at `http://localhost:' + this.skillServerManager.port + '`.',
      ].join('\n')
    }

    if (phase === 'crashed' && genError) {
      return [
        '## Skill Server (Error)',
        '',
        'The last code generation failed:',
        '```',
        genError,
        '```',
        'Fix the issue in `.shogo/server/schema.prisma` and save — it will auto-retry.',
      ].join('\n')
    }

    return [
      '## Skill Server (Available)',
      '',
      'You can create a persistent REST API backed by SQLite for skills that need structured data.',
      'Use this when a skill needs to remember data across conversations (leads, tickets, etc.),',
      'or logic should be deterministic and not burn tokens every time.',
      '',
      'To create the skill server, just write `.shogo/server/schema.prisma` with your models:',
      '```prisma',
      'datasource db {',
      '  provider = "sqlite"',
      '}',
      '',
      'generator client {',
      '  provider = "prisma-client"',
      '  output   = "./generated/prisma"',
      '}',
      '',
      'model Lead {',
      '  id        String   @id @default(cuid())',
      '  name      String',
      '  email     String',
      '  status    String   @default("new")',
      '  createdAt DateTime @default(now())',
      '  updatedAt DateTime @updatedAt',
      '}',
      '```',
      '',
      'That\'s it — **everything else is automatic**: dependency install, code generation,',
      'database creation, and server startup on `http://localhost:' + this.skillServerManager.port + '`.',
      'Each model gets full CRUD at `/api/{model-name-plural}`.',
      '',
      'Custom logic goes in `.shogo/server/generated/{model}.hooks.ts`.',
    ].join('\n')
  }

  /**
   * Build a context section listing currently installed tool integrations.
   * Included in the system prompt so the agent knows what's available
   * and can use installed tools directly without needing to discover them.
   */
  private buildInstalledToolsContext(): string | null {
    const servers = this.mcpClientManager.getServerInfo()
    if (servers.length === 0) return null

    const lines = [
      '## Installed Tools',
      '',
      'The following tool integrations are currently installed and available:',
      '',
    ]

    for (const server of servers) {
      const toolList = server.toolNames.length <= 8
        ? server.toolNames.join(', ')
        : server.toolNames.slice(0, 8).join(', ') + `, ... (+${server.toolNames.length - 8} more)`
      lines.push(`- **${server.name}** (${server.toolCount} tools): ${toolList}`)
    }

    lines.push('')
    lines.push('Use these tools directly — no need to search or install them. Use `tool_uninstall` to remove any you no longer need.')

    return lines.join('\n')
  }

  /**
   * Build a context section listing files the user has uploaded to files/.
   * Included in the system prompt so the agent knows what data is available
   * and can proactively use list_files/search_files/read_file to access it.
   */
  private buildUploadedFilesContext(): string | null {
    const filesDir = join(this.workspaceDir, 'files')
    if (!existsSync(filesDir)) return null

    try {
      const entries = this.walkUploadedFiles(filesDir, '')
      if (entries.length === 0) return null

      const lines = [
        '## Workspace Uploaded Files',
        '',
        'The user has uploaded the following files to the workspace `files/` directory.',
        'Use `list_files` to browse, `search_files` to search content, or `read_file` with path `files/<name>` to read them.',
        '',
      ]

      for (const entry of entries.slice(0, 50)) {
        const sizeStr = entry.size < 1024
          ? `${entry.size}B`
          : entry.size < 1024 * 1024
            ? `${Math.round(entry.size / 1024)}KB`
            : `${(entry.size / (1024 * 1024)).toFixed(1)}MB`
        lines.push(`- \`${entry.path}\` (${sizeStr})`)
      }

      if (entries.length > 50) {
        lines.push(`- ... and ${entries.length - 50} more files`)
      }

      return lines.join('\n')
    } catch {
      return null
    }
  }

  private walkUploadedFiles(
    dir: string,
    prefix: string,
  ): Array<{ path: string; size: number }> {
    const results: Array<{ path: string; size: number }> = []
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const absPath = join(dir, entry.name)
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          results.push(...this.walkUploadedFiles(absPath, relPath))
        } else {
          const stat = statSync(absPath)
          results.push({ path: relPath, size: stat.size })
        }
      }
    } catch {
      // Ignore permission or other errors
    }
    return results
  }

  /**
   * Build a concise workspace file tree so the agent knows what files already
   * exist before deciding to create vs edit. Focuses on user-visible files —
   * skips .shogo internals, node_modules, etc.
   */
  private buildWorkspaceTreeContext(): string | null {
    try {
      const lines: string[] = []
      const SKIP = new Set(['.shogo', 'node_modules', '.git', '.cache', '.next', 'dist', 'build', 'files'])
      const MAX_FILES = 80

      const walk = (dir: string, prefix: string, depth: number) => {
        if (depth > 4 || lines.length >= MAX_FILES) return
        let entries: import('fs').Dirent[]
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch { return }

        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })

        for (const entry of entries) {
          if (lines.length >= MAX_FILES) break
          if (entry.name.startsWith('.') && depth === 0 && entry.name !== '.shogo') continue
          if (SKIP.has(entry.name)) continue

          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            lines.push(`${relPath}/`)
            walk(join(dir, entry.name), relPath, depth + 1)
          } else {
            lines.push(relPath)
          }
        }
      }

      walk(this.workspaceDir, '', 0)
      if (lines.length === 0) return null

      return [
        '## Workspace Files',
        '',
        'Current files in the workspace (use `read_file` before editing existing files):',
        '```',
        ...lines,
        '```',
      ].join('\n')
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Channel Management
  // ---------------------------------------------------------------------------

  async connectChannel(
    type: string,
    config: Record<string, string>
  ): Promise<void> {
    let adapter: ChannelAdapter

    switch (type) {
      case 'telegram': {
        const { TelegramAdapter } = await import('./channels/telegram')
        adapter = new TelegramAdapter(config)
        break
      }
      case 'discord': {
        const { DiscordAdapter } = await import('./channels/discord')
        adapter = new DiscordAdapter(config)
        break
      }
      case 'email': {
        const { EmailAdapter } = await import('./channels/email')
        adapter = new EmailAdapter()
        break
      }
      case 'slack': {
        const { SlackAdapter } = await import('./channels/slack')
        adapter = new SlackAdapter(config)
        break
      }
      case 'whatsapp': {
        const { WhatsAppAdapter } = await import('./channels/whatsapp')
        adapter = new WhatsAppAdapter(config)
        break
      }
      case 'webhook': {
        const { WebhookAdapter } = await import('./channels/webhook')
        adapter = new WebhookAdapter()
        break
      }
      case 'teams': {
        const { TeamsAdapter } = await import('./channels/teams')
        adapter = new TeamsAdapter(config)
        break
      }
      case 'webchat': {
        const { WebChatAdapter } = await import('./channels/webchat')
        adapter = new WebChatAdapter()
        break
      }
      default:
        throw new Error(`Unknown channel type: ${type}`)
    }

    adapter.onMessage((msg) => this.processMessage(msg))
    await adapter.connect(config)
    this.channels.set(type, adapter)
    console.log(`[AgentGateway] Connected channel: ${type}`)
  }

  getChannel(type: string): ChannelAdapter | undefined {
    return this.channels.get(type)
  }

  getMcpClientManager(): MCPClientManager {
    return this.mcpClientManager
  }

  async disconnectChannel(type: string): Promise<void> {
    const adapter = this.channels.get(type)
    if (adapter) {
      await adapter.disconnect()
      this.channels.delete(type)
      console.log(`[AgentGateway] Disconnected channel: ${type}`)
    }
  }

  private async deliverAlert(alertText: string): Promise<void> {
    for (const [type, adapter] of this.channels) {
      try {
        const status = adapter.getStatus()
        if (status.connected) {
          await adapter.sendMessage('default', `[HEARTBEAT ALERT]\n${alertText}`)
        }
      } catch (err: any) {
        console.error(`[AgentGateway] Failed to deliver alert via ${type}:`, err.message)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------------

  private appendDailyMemory(entry: string): void {
    const date = new Date().toISOString().split('T')[0]
    const memoryDir = join(this.workspaceDir, 'memory')
    mkdirSync(memoryDir, { recursive: true })

    const filepath = join(memoryDir, `${date}.md`)
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0]
    const line = `- [${timestamp}] ${entry}\n`

    try {
      if (existsSync(filepath)) {
        const existing = readFileSync(filepath, 'utf-8')
        writeFileSync(filepath, existing + line, 'utf-8')
      } else {
        writeFileSync(filepath, `# ${date}\n\n${line}`, 'utf-8')
      }
    } catch (error: any) {
      console.error('[AgentGateway] Failed to write daily memory:', error.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  getStatus(): AgentStatus {
    // Hot-reload config so the UI always reflects the latest config.json
    this.reloadConfig()

    const channelStatuses: ChannelStatus[] = []
    for (const [type, adapter] of this.channels) {
      const status = adapter.getStatus()
      const channelDef = this.config.channels.find(c => c.type === type)
      if (channelDef?.model) {
        status.model = channelDef.model
      }
      channelStatuses.push(status)
    }

    // Merge skills from filesystem with skills declared in config.json
    const fsSkills = this.skills.map((s) => ({
      name: s.name,
      trigger: s.trigger || '',
      description: s.description,
    }))
    const fsSkillNames = new Set(fsSkills.map((s) => s.name))
    const configSkills = (this.configSkills ?? [])
      .filter((s: any) => s.name && !fsSkillNames.has(s.name))
      .map((s: any) => ({
        name: s.name,
        trigger: s.trigger || '',
        description: s.description || '',
      }))

    return {
      running: this.running,
      heartbeat: {
        enabled: this.config.heartbeatEnabled,
        intervalSeconds: this.config.heartbeatInterval,
        lastTick: this.lastHeartbeatTick?.toISOString() ?? null,
        quietHours: this.config.quietHours,
      },
      channels: channelStatuses,
      skills: [...fsSkills, ...configSkills],
      model: this.config.model,
      sessions: this.sessionManager.getAllStats(),
    }
  }

  reloadConfig(): void {
    const prevEnabled = this.config.heartbeatEnabled
    this.config = this.loadConfig()
    this.skills = loadAllSkills(this.workspaceDir)
    setLoadedSkills(this.skills)
    this.configSkills = this.loadConfigSkills()

  }

  private loadConfigSkills(): Array<{ name: string; trigger?: string; description?: string }> {
    const configPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'config.json')
    if (!configPath) return []
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      return Array.isArray(raw.skills) ? raw.skills : []
    } catch {
      return []
    }
  }

  getHookEmitter(): HookEmitter {
    return this.hookEmitter
  }

  getSessionManager(): SessionManager {
    return this.sessionManager
  }

  getMCPClientManager(): MCPClientManager {
    return this.mcpClientManager
  }

  getActiveMode(): VisualMode {
    return this.config.activeMode || 'none'
  }

  setActiveMode(mode: VisualMode): void {
    this.config.activeMode = mode
  }

  getAllowedModes(): VisualMode[] {
    return this.config.allowedModes || ['canvas', 'none']
  }

  /** Map of sessionId -> AbortController for cancelling in-progress agent turns */
  private turnAbortControllers = new Map<string, AbortController>()

  abortCurrentTurn(sessionId: string): boolean {
    const controller = this.turnAbortControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.turnAbortControllers.delete(sessionId)
      return true
    }
    return false
  }
}
