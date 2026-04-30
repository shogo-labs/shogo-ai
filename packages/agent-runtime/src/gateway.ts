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
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { Message, ImageContent } from '@mariozechner/pi-ai'
import type { StreamFn, AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@sinclair/typebox'
import type { ChannelAdapter, IncomingMessage, AgentStatus, ChannelStatus, StreamChunkConfig, SandboxConfig } from './types'
import { loadAllSkills, migrateFromLegacySkills, matchSkill, buildSkillsPromptSection, type Skill } from './skills'
import { loadQuickActions, buildQuickActionsPromptSection, type QuickAction } from './quick-actions'
import { SkillServerManager } from './skill-server-manager'
import { setLoadedSkills } from './gateway-tools'
import { runAgentLoop, type LoopDetectorConfig, type ToolContext } from './agent-loop'
import { createTools, textResult } from './gateway-tools'
import { PermissionEngine, parseSecurityPolicy } from './permission-engine'
import { HookEmitter, loadAllHooks } from './hooks'
import { parseSlashCommand, type SlashCommandContext } from './slash-commands'
import { SessionManager, type SessionManagerConfig, applyToolResultBudget, snipConsumedResults } from './session-manager'
import { microcompact } from './microcompact'
import {
  type ContentReplacementState,
  createContentReplacementState,
  stableTransformContext,
} from './stable-compaction'
import {
  fingerprintMessages,
  fingerprintSystem,
  fingerprintTools,
  formatPositions,
} from './prefix-fingerprint'
import { SqliteSessionPersistence } from './sqlite-session-persistence'
import { BlockChunker } from './block-chunker'
import { CANVAS_FILE_REFERENCE } from './canvas-v2-prompt'
import { CanvasFileWatcher } from './canvas-file-watcher'
import { CanvasBuildManager } from './canvas-build-manager'
import {
  inferProviderFromModel as catalogInferProvider,
  resolveModelId,
  AGENT_MODE_DEFAULTS,
  setAgentModeOverrides,
  isAutoModel,
  AUTO_MODEL_ID,
} from '@shogo/model-catalog'
import { selectModelForSpawn, buildAutoTierMap, formatRoutingLog, type SpawnClassificationInput } from './model-router'
import { CODE_AGENT_GENERAL_GUIDE } from './code-agent-prompt'
import { UI_UX_DESIGN_GUIDE } from './ui-ux-guide-prompt'
import { MCPClientManager, type MCPServerConfig, type RemoteMCPServerConfig } from './mcp-client'
import { WorkspaceLSPManager, resolveBin } from '@shogo/shared-runtime'
import { initComposioSession, resetComposioSession, isComposioEnabled, isComposioInitialized } from './composio'
import { deriveApiUrl, getInternalHeaders } from './internal-api'
import type { FilePart } from './file-attachment-utils'
import { parseFileAttachments } from './file-attachment-utils'
import {
  SELF_EVOLUTION_GUIDE,
  BROWSER_TOOL_GUIDE,
} from './optimized-prompts'
import { resolveWorkspaceConfigFilePath } from './workspace-defaults'
import { FileStateCache } from './file-state-cache'
import { SUBAGENT_GUIDE } from './subagent-prompts'
import { buildGuideRegistry, CAPABILITIES_INDEX } from './guide-registry'
import { AgentManager } from './agent-manager'
import { TeamManager } from './team-manager'
import { isInQuietHours } from './quiet-hours'
import {
  PREVIEW_SUBDIR,
  BUILD_LOG_FILE,
  CONSOLE_LOG_FILE,
  previewBuildLogPath,
  previewConsoleLogPath,
} from './runtime-log-paths'

const QUICK_ACTION_GUIDE = `## Quick Actions

You can register quick actions that appear as one-click prompt shortcuts in the user's chat UI.
They are stored in \`.shogo/quick-actions.json\`.

When you notice a user sending a prompt that looks like a repeatable workflow (committing code, running tests, deploying, generating reports, etc.), proactively offer to save it as a quick action using the \`quick_action\` tool.

Example: if a user says "review all my pending changes and commit them", register:
- label: "Commit" (1-2 words, max 20 chars)
- prompt: "Please review all pending changes and commit them" (faithful to what the user said)

Constraints: max 10 quick actions, labels must be unique. To view or edit existing actions, read/edit \`.shogo/quick-actions.json\` directly.`

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

/**
 * Infer the LLM provider from a model ID string. Delegates to the
 * shared model catalog which handles aliases and prefix matching.
 */
function inferProviderFromModel(modelId: string, configProvider: string): string {
  return catalogInferProvider(modelId, configProvider)
}

/**
 * Resolve UI-facing model aliases (basic/advanced) to concrete model IDs
 * so pi-ai can find them in its model registry and pick the correct API.
 */
function resolveModelAlias(modelId: string): string {
  return resolveModelId(modelId)
}

/**
 * Resolve the thinking/reasoning level for a turn. The 'basic' agent mode
 * uses claude-haiku which benefits from medium reasoning effort.
 */
function resolveThinkingLevel(modelOverride?: string): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  const envLevel = process.env.AGENT_THINKING_LEVEL as any
  if (modelOverride === 'basic') {
    return (process.env.AGENT_BASIC_THINKING_LEVEL as any) || 'medium'
  }
  return envLevel || 'medium'
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
  /** Active visual mode: canvas, app, or none (default: 'canvas') */
  activeMode?: VisualMode
  /** Modes this project is allowed to use (default: all modes for paid, ['canvas','none'] for basic) */
  allowedModes?: VisualMode[]
  /** Whether web search tool is enabled (default: true) */
  webEnabled?: boolean
  /** Whether browser automation tool is enabled (default: true) */
  browserEnabled?: boolean
  /** Playwright browser extension token for CDP connect mode */
  browserExtensionToken?: string
  /** Whether shell/exec tool is enabled (default: true) */
  shellEnabled?: boolean
  // heartbeat tools are gated by heartbeatEnabled (above)
  /** Whether image generation tool is enabled (default: true) */
  imageGenEnabled?: boolean
  /** Whether memory tools are enabled (default: true) */
  memoryEnabled?: boolean
  /** Whether quick action registration is enabled (default: true) */
  quickActionsEnabled?: boolean
  /** Whether canvas tools are enabled (default: true). Automatically set false when switching to app/none mode. */
  canvasEnabled?: boolean
  /** Canvas rendering mode: 'json' = v1 declarative JSON, 'code' = v2 agent-written React code */
  canvasMode?: 'json' | 'code'
  /** Prompt profile: 'full' = all sections (default), 'swe' = minimal coding-only profile for SWE evals, 'general' = workspace + tools + skills (no personality/canvas) */
  promptProfile?: 'full' | 'swe' | 'general'
  /** Enable coordinator mode (leader only delegates, never does work directly) */
  coordinatorMode?: boolean
}

export class AgentGateway {
  private workspaceDir: string
  private projectId: string
  private config: GatewayConfig
  private currentUserId: string | undefined
  private channels: Map<string, ChannelAdapter> = new Map()
  private skills: Skill[] = []
  private quickActions: QuickAction[] = []
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
  /** Current guide registry built during loadBootstrapContext, consumed by tool context */
  private currentGuideRegistry?: Map<string, string>
  /** Per-section prompt breakdown from the last loadBootstrapContext() call */
  lastPromptBreakdown?: Array<{ label: string; zone: 'stable' | 'dynamic'; chars: number; estTokens: number }>
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
    contextWindowTokens: number
    estimatedContextTokens: number
    model: string
  } | null = null
  /** Optional label for eval tracing — included in log prefix when set */
  private evalLabel: string | null = null
  /** Manages the per-workspace skill server process (.shogo/server/) */
  private skillServerManager: SkillServerManager
  /** Multi-language LSP manager for read_lints diagnostics */
  private lspManager: WorkspaceLSPManager | null = null
  /** Tracks files the agent has read across turns for cache-aware compaction */
  private fileStateCache = new FileStateCache()
  /**
   * Per-session compaction-decision state for the per-API-call transformContext.
   *
   * pi-agent-core's agent loop re-reads `agent.state.messages` before every LLM
   * request. Without this state, re-running the three cheap compaction layers
   * (budget / microcompact / snip) produces different bytes for the same
   * historical tool_result on each call, which invalidates the prompt cache
   * prefix and forces a full re-write every request (observed ~3.5x cache-write
   * amplification in a 6-call turn).
   *
   * The state is write-once per tool_call_id, guaranteeing byte-identical
   * output for any id once it's been "decided". See stable-compaction.ts for
   * the invariant proof. Reset whenever sessionManager.compact() rewrites the
   * prefix (the surviving tool_use_ids are a subset, but the summary message
   * changes the wire prefix upstream of them anyway, so keeping stale state
   * gains nothing and prune on reset is simpler).
   */
  private contentReplacementStates = new Map<string, ContentReplacementState>()
  /**
   * Per-session user-turn counter used only by prefix-cache debug logging.
   * Bumped once on entry to `runTurn`. Paired with a per-turn call counter
   * (closure-scoped inside runTurn) so log lines read `turn=T call=N`.
   * Not consulted for correctness; safe to clear or leave stale.
   */
  private turnCounters = new Map<string, number>()
  /** Shared index engine for workspace-wide search (code + files) */
  private indexEngine: import('./index-engine').IndexEngine | null = null
  /** Workspace knowledge graph for structural analysis */
  private workspaceGraph: import('./workspace-graph').WorkspaceGraph | null = null
  /** Canvas v2 file watcher — shared singleton from CanvasFileWatcher.getInstance() */
  private get canvasFileWatcher(): CanvasFileWatcher {
    return CanvasFileWatcher.getInstance(this.workspaceDir)
  }
  /** Canvas build manager — runs per-workspace Vite builds */
  private canvasBuildManager: CanvasBuildManager | null = null
  /** Tracks the current high-level task description for remote status */
  private _currentTask: string | null = null
  /** Tracks the last tool name invoked for remote status */
  private _lastTool: string | null = null
  /** Dynamic sub-agent registry and lifecycle manager */
  public agentManager = new AgentManager()
  private teamManager?: TeamManager
  /** Per-session shell cwd tracking — persists cd across exec calls */
  private shellCwd = new Map<string, string>()

  constructor(workspaceDir: string, projectId: string) {
    this.workspaceDir = workspaceDir
    this.projectId = projectId
    this.config = this.loadConfig()
    this.sessionManager = new SessionManager(this.config.session)
    this.mcpClientManager.setWorkspaceDir(workspaceDir)
    this.skillServerManager = new SkillServerManager({ workspaceDir })

    // Apply admin-configured agent model overrides from injected env vars
    const envOverrides: Record<string, string> = {}
    if (process.env.AGENT_BASIC_MODEL) envOverrides.basic = process.env.AGENT_BASIC_MODEL
    if (process.env.AGENT_ADVANCED_MODEL) envOverrides.advanced = process.env.AGENT_ADVANCED_MODEL
    if (Object.keys(envOverrides).length > 0) {
      setAgentModeOverrides(envOverrides)
    }

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
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
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
    this.quickActions = loadQuickActions(this.workspaceDir)
    this.configSkills = this.loadConfigSkills()
    setLoadedSkills(this.skills)
    console.log(`[AgentGateway] Loaded ${this.skills.length} skills, ${this.configSkills.length} config skills, ${this.quickActions.length} quick actions`)

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

    // The API server (root server.tsx) is owned by PreviewManager — see
    // server.ts. The shim below just exposes its status to tools/prompts.
    try {
      const { started, port } = await this.skillServerManager.start()
      if (started) {
        console.log(`[AgentGateway] API server already running on port ${port}`)
      }
    } catch (error: any) {
      console.error('[AgentGateway] API server status check error:', error.message)
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

    if (this.sessionPersistence) {
      this.agentManager.attachPersistence(this.sessionPersistence)
      this.teamManager = new TeamManager(this.sessionPersistence)
    }

    // Wire up LLM-powered summarization for context compaction
    this.sessionManager.setSummarizeFn(async (messages) => {
      const { resolveModel: rm, resolveApiKey: rak } = await import('./pi-adapter')
      const { runAgentLoop: summarizeLoop } = await import('./agent-loop')
      const provider = this.config.model.provider
      const apiKey = rak(provider)
      if (!apiKey) throw new Error('No API key for summarization')

      const messageTexts = messages.map(m => {
        if (m.role === 'user') {
          const content = typeof m.content === 'string' ? m.content : (m.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
          return `User: ${content.substring(0, 500)}`
        }
        if (m.role === 'assistant') {
          const text = m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
          return `Assistant: ${text.substring(0, 500)}`
        }
        if (m.role === 'toolResult') {
          const text = m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
          return `Tool result: ${text.substring(0, 200)}`
        }
        return ''
      }).filter(Boolean).join('\n')

      const result = await summarizeLoop({
        provider,
        model: 'claude-haiku-4-5',
        system: 'Summarize the following conversation excerpt concisely. Preserve: key decisions, files edited, errors encountered, and current task state. Be factual and specific. Output only the summary.',
        history: [],
        prompt: messageTexts.substring(0, 12000),
        tools: [],
        maxIterations: 1,
        loopDetection: false,
        thinkingLevel: 'off',
      })
      return result.text || '(summary unavailable)'
    })

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

    // Start LSP for canvas code diagnostics (fire-and-forget — don't block startup)
    if (this.config.canvasMode === 'code') {
      this.startLSP().catch(err => {
        console.warn(`${this.logPrefix} LSP startup failed (non-fatal):`, err.message)
      })
    }

    // Start canvas build manager for Vite builds (fire-and-forget)
    if (this.config.canvasMode === 'code') {
      // Self-heal: ensure src/main.tsx matches the canonical slim version.
      // Older workspaces baked the iframe bridge (toast / theme / SSE / error
      // forwarding) into main.tsx; that's now served live from
      // /agent/canvas/bridge.js, so the user-bundled file should only render
      // <App />. If it has drifted, rewrite it before kicking off the build.
      let needsRebuild = false
      try {
        const { migrateRuntimeTemplate } = require('./canvas-bridge-migration')
        const result = migrateRuntimeTemplate(this.workspaceDir)
        if (result.rewrote) needsRebuild = true
      } catch (err) {
        console.warn(`${this.logPrefix} Canvas bridge migration failed (non-fatal):`, (err as Error).message)
      }

      const watcher = this.canvasFileWatcher
      this.canvasBuildManager = new CanvasBuildManager(this.workspaceDir, {
        onBuildComplete: () => watcher.broadcastReload(),
        onBuildError: (err) => console.error(`${this.logPrefix} Canvas build error:`, err),
      })
      watcher.setOnRebuild(() => this.canvasBuildManager?.triggerRebuild())
      this.canvasBuildManager.start().then(() => {
        // If the migration rewrote main.tsx, queue a rebuild so the slim
        // version replaces the stale dist/ output.
        if (needsRebuild) this.canvasBuildManager?.triggerRebuild()
      }).catch(err => {
        console.warn(`${this.logPrefix} Canvas build manager startup failed (non-fatal):`, err.message)
      })
    }

    // Pre-warm unified index engine for workspace-wide search (fire-and-forget)
    try {
      const { IndexEngine, createDefaultConfig } = require('./index-engine')
      const engine = new IndexEngine(createDefaultConfig(this.workspaceDir))
      this.indexEngine = engine
      engine.reindexBackground()

      // Initialize workspace knowledge graph (shares the same SQLite DB)
      try {
        const { WorkspaceGraph } = require('./workspace-graph')
        const { createDefaultExtractors } = require('./graph-extractors')
        const { CodeExtractor } = require('./code-extractor')
        const graph = new WorkspaceGraph(engine)
        const extractors = createDefaultExtractors()
        for (const ext of extractors) graph.registerExtractor(ext)
        engine.setGraph(graph)
        this.workspaceGraph = graph

        // Pre-load Tree-sitter grammars then build graph + detect flows
        const codeExt = extractors.find((e: any) => e instanceof CodeExtractor)
        const preloadPromise = codeExt?.preload?.() ?? Promise.resolve()
        preloadPromise.then(() => {
          setTimeout(() => {
            try {
              graph.buildGraph()
              // Detect execution flows after graph is built
              try {
                const { traceFlows, storeFlows } = require('./flow-detector')
                const flows = traceFlows(graph)
                storeFlows(graph, flows)
              } catch (e: any) {
                console.warn(`${this.logPrefix} Flow detection failed (non-fatal):`, e.message)
              }
            } catch (e: any) {
              console.warn(`${this.logPrefix} Graph build failed (non-fatal):`, e.message)
            }
          }, 5000)
        }).catch((e: any) => {
          console.warn(`${this.logPrefix} Tree-sitter preload failed (non-fatal):`, e.message)
        })
      } catch (err: any) {
        console.warn(`${this.logPrefix} Workspace graph init failed (non-fatal):`, err.message)
      }
    } catch (err: any) {
      console.warn(`${this.logPrefix} Index engine pre-warm failed (non-fatal):`, err.message)
    }

    console.log('[AgentGateway] Started successfully')
    this.emitLog('Agent gateway started')
  }

  private async startLSP(): Promise<void> {
    try {
      const thisDir = dirname(fileURLToPath(import.meta.url))
      const pkgDir = join(thisDir, '..')
      const searchDirs = [pkgDir, thisDir, this.workspaceDir]

      const tsResult = resolveBin('typescript-language-server', searchDirs, 'lib/cli.mjs')
      const pyResult = resolveBin('pyright', searchDirs)

      this.lspManager = new WorkspaceLSPManager({
        projectDir: this.workspaceDir,
        tsServerBin: tsResult?.resolved,
        pyrightBin: pyResult?.resolved,
      })
      await this.lspManager.startAll()
      console.log(`${this.logPrefix} LSP ready for workspace: ${this.workspaceDir}`)
    } catch (err: any) {
      console.warn(`${this.logPrefix} LSP init failed:`, err.message)
      this.lspManager = null
    }
  }

  async stop(): Promise<void> {
    console.log('[AgentGateway] Stopping...')
    this.running = false

    this.lspManager?.stop()
    this.lspManager = null

    this.sessionManager.destroy()
    this.sessionPersistence?.close()
    await this.skillServerManager.stop()
    this.canvasBuildManager?.stop()
    await this.mcpClientManager.stopAll()

    this.workspaceGraph = null
    try { this.indexEngine?.close() } catch { /* best-effort */ }
    this.indexEngine = null

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


  private checkQuietHours(): boolean {
    const { start, end, timezone } = this.config.quietHours
    return isInQuietHours(start || null, end || null, timezone || null)
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

    if (this.checkQuietHours()) {
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

    const heartbeatSummary = response === 'HEARTBEAT_OK' ? 'Routine check — all clear' : response.substring(0, 300)
    this.appendDailyMemory(`Heartbeat: ${response === 'HEARTBEAT_OK' ? 'All clear' : response.substring(0, 200)}`)
    this.appendHeartbeatLog(heartbeatSummary)

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
    return `[Agent Setup — First Message]\nThis is a brand new agent that has not been configured yet. The user's message below describes what they want the agent to do. Use your tools to set up the agent:\n\n1. Write AGENTS.md with all sections: # Identity (name, emoji, tagline), # Personality (tone, boundaries), # User (preferences), and # Operating Instructions (specific to this use case — IMPORTANT: replace the default content)\n2. Write HEARTBEAT.md with a relevant checklist if the agent should run autonomously\n3. Create any relevant skills in the skills/ directory\n4. Update config.json if heartbeat should be enabled\n\nAfter setting up, give the user a brief summary of what you configured.\n\n[User Message]\n${userText}`
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
      confirmedPlan?: { name: string; overview: string; plan: string; todos?: Array<{ id: string; content: string }>; filepath?: string }
      chatSessionId?: string
    },
  ): Promise<void> {
    const sessionId = options?.chatSessionId || 'chat'
    if (options?.modelOverride) {
      const session = this.sessionManager.getOrCreate(sessionId)
      session.modelOverride = options.modelOverride
    }

    if (options?.userId) {
      this.currentUserId = options.userId
      if (isComposioEnabled()) {
        const workspaceId = process.env.WORKSPACE_ID || 'default'
        await initComposioSession(options.userId, workspaceId, this.projectId)
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
      const todoList = (cp.todos ?? []).map(t => `- [ ] ${t.content}`).join('\n')
      const planContext = [
        'The user has confirmed the following plan. Execute it step by step:',
        '',
        `## ${cp.name}`,
        cp.overview,
        cp.filepath ? `Saved plan: ${cp.filepath}` : '',
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

    const interactionMode = options?.confirmedPlan ? 'agent' : (options?.interactionMode || 'agent')
    console.log(`[Gateway][processChatMessageStream] resolved interactionMode: ${interactionMode} (options had: ${options?.interactionMode ?? '(undefined)'}), sessionId: ${sessionId}, activeSkill: ${activeSkill ?? '(none)'}`)
    const response = await this.agentTurn(prompt, sessionId, false, undefined, writer, activeSkill, images, interactionMode)
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
        // History wipe = prefix rewrite. Drop per-session compaction state
        // so fresh decisions are taken against the new (empty) history.
        this.contentReplacementStates.delete(sessionId)
        this.turnCounters.delete(sessionId)
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
    // Wait for any in-flight turn on this session to finish so the new turn
    // reads a fully-updated session history (critical for "continue" after stop).
    const prevTurn = this.turnLocks.get(sessionId)
    if (prevTurn) {
      await prevTurn.catch(() => {})
    }

    this._currentTask = isHeartbeat ? 'heartbeat' : prompt.slice(0, 120)
    const turnPromise = this._agentTurnInner(prompt, sessionId, isHeartbeat, streamTarget, uiWriter, activeSkill, images, interactionMode)
    this.turnLocks.set(sessionId, turnPromise)
    try {
      return await turnPromise
    } finally {
      this._currentTask = null
      if (this.turnLocks.get(sessionId) === turnPromise) {
        this.turnLocks.delete(sessionId)
      }
    }
  }

  private async _agentTurnInner(
    prompt: string,
    sessionId: string = 'default',
    isHeartbeat: boolean = false,
    streamTarget?: { adapter: ChannelAdapter; channelId: string },
    uiWriter?: { write(chunk: Record<string, any>): void },
    activeSkill?: { name: string },
    images?: ImageContent[],
    interactionMode: 'agent' | 'plan' | 'ask' = 'agent',
  ): Promise<string> {
    // Reload skills and quick actions from disk so any files created/edited/deleted by file tools are picked up
    this.skills = loadAllSkills(this.workspaceDir)
    this.quickActions = loadQuickActions(this.workspaceDir)
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
    let systemPrompt = this.loadBootstrapContext(sessionId)
    if (activeSkill) {
      this.promptOverrides.delete('mcp_discovery_guide')
    }

    console.log(`[Gateway][_agentTurnInner] building system prompt — interactionMode: ${interactionMode}, sessionId: ${sessionId}`)
    // Interaction mode system prompt injection
    if (interactionMode === 'plan') {
      const planModePrompt = [
        '## PLAN MODE ACTIVE',
        '',
        'Plan mode is active. You MUST NOT edit source files, run mutating commands, or otherwise change the workspace before the user clicks Build. This supersedes all other instructions.',
        'Exception: you may create or update the plan artifact using create_plan/update_plan; those tools only write under .shogo/plans/ for user review.',
        '',
        'Your job:',
        '1. Research the user\'s request using read-only tools (read_file, search, web, etc.)',
        '2. If you need more information, ask clarifying questions using ask_user',
        '3. If the request is too broad, ask 1-2 narrowing questions using ask_user',
        '4. If there are multiple valid approaches, ask the user which they prefer',
        '5. When you have enough context, call create_plan with a structured plan',
        '6. If the user asks to modify, refine, or extend an existing plan, use update_plan with the plan\'s filepath instead of creating a new one',
        '7. The plan should be concise, specific, and actionable — cite file paths and code snippets',
        '8. Do NOT make any changes until the user confirms the plan',
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

    if (this.config.coordinatorMode) {
      const { COORDINATOR_SYSTEM_PROMPT } = await import('./coordinator-prompt')
      systemPrompt += '\n\n' + COORDINATOR_SYSTEM_PROMPT
    }

    const session = this.sessionManager.getOrCreate(sessionId)
    const modelAlias = session.modelOverride || this.config.model.name
    const autoRouting = isAutoModel(modelAlias)

    let provider: string
    let modelId: string

    if (autoRouting) {
      const autoTiers = buildAutoTierMap()
      const estimatedTokens = this.sessionManager.estimateTokens(session)
      const classInput: SpawnClassificationInput = {
        prompt,
        subagentType: 'main-agent',
        toolNames: [],
        contextTokens: estimatedTokens,
      }
      const routingDecision = selectModelForSpawn(classInput, {
        ceilingModel: autoTiers.premium,
        availableModels: autoTiers,
      })
      modelId = routingDecision.selectedModel
      provider = inferProviderFromModel(modelId, this.config.model.provider)
      console.log(`${this.logPrefix} ${formatRoutingLog(routingDecision, prompt)}`)
      if (uiWriter) {
        uiWriter.write({ type: 'data-routing-decision', data: routingDecision })
      }
    } else {
      const effectiveAlias = modelAlias
      provider = inferProviderFromModel(effectiveAlias, this.config.model.provider)
      modelId = resolveModelAlias(effectiveAlias)
      console.log(`${this.logPrefix} LLM turn: model=${modelId} (alias=${modelAlias}) provider=${provider} baseUrl=${process.env[provider === 'openai' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL'] || '(not set)'}`)
    }

    // Reset per-turn state and wire/clear the SSE writer for permission requests.
    // When there's no uiWriter (heartbeat, channel, webhook turns),
    // clear the callback so "ask" decisions fail closed instead of writing
    // to a stale stream from a previous UI turn.
    if (this.permissionEngine) {
      this.permissionEngine.resetTurn()
      this.permissionEngine.setSseCallback(
        uiWriter ? (event) => uiWriter.write(event) : undefined
      )
    }

    if (this.config.browserExtensionToken) {
      process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = this.config.browserExtensionToken
    } else {
      delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
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
      // Always provide the watcher so live file events (file.changed /
      // file.deleted) are broadcast to SSE subscribers (e.g. the IDE tab
      // for Cursor-style live editing). The watcher is a cheap per-
      // workspace singleton; no downside to making it always-on.
      canvasFileWatcher: this.canvasFileWatcher,
      lspManager: this.lspManager ?? undefined,
      fileStateCache: this.fileStateCache,
      agentManager: this.agentManager,
      skillServerManager: this.skillServerManager,
      sessionPersistence: this.sessionPersistence ?? undefined,
      teamManager: this.teamManager,
      indexEngine: this.indexEngine ?? undefined,
      workspaceGraph: this.workspaceGraph ?? undefined,
      effectiveModel: modelId,
      autoRouting,
      shellState: sessionId ? {
        getCwd: () => this.shellCwd.get(sessionId!) || this.workspaceDir,
        setCwd: (cwd: string) => this.shellCwd.set(sessionId!, cwd),
      } : undefined,
      guideRegistry: this.currentGuideRegistry,
      toolMockFns: this.toolMocks.size > 0 ? this.toolMocks : undefined,
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

    const baseTools = createTools(toolContext)

    const mcpTools = this.mcpClientManager.getTools()
    let assembledTools = mcpTools.length > 0 ? [...baseTools, ...mcpTools] : baseTools

    // Suppress MCP Playwright tools — built-in browser tool has feature parity
    assembledTools = assembledTools.filter(t => !t.name.startsWith('mcp_playwright_'))

    // Capability toggles (independent of mode)
    if (this.config.webEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'web')
    }
    if (this.config.browserEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'browser')
    }
    if (this.config.shellEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'exec')
    }
    if (this.config.heartbeatEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'heartbeat_configure' && t.name !== 'heartbeat_status')
    }
    if (this.config.imageGenEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'generate_image')
    }
    if (this.config.memoryEnabled === false) {
      assembledTools = assembledTools.filter(t => !t.name.startsWith('memory_'))
    }
    if (this.config.quickActionsEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'quick_action')
    }
    // Code analysis tools are only available via subagents (code-reviewer, explore)
    const CODE_REVIEW_ONLY_TOOLS = new Set(['detect_changes', 'review_context', 'impact_radius'])
    assembledTools = assembledTools.filter(t => !CODE_REVIEW_ONLY_TOOLS.has(t.name))

    // Tools delegated to dedicated subagents — removed from the main agent to
    // reduce per-request token cost. Keep small/action-oriented integration,
    // channel, and heartbeat tools available to the main agent as well:
    // Haiku reliably used them directly in the persona/agentic pipelines, but
    // often fails to infer that a subagent should be spawned for simple "connect
    // my email" or "set up a reminder" requests.
    const SUBAGENT_ONLY_TOOLS = new Set([
      'browser',                                                                       // -> browser subagent
      'generate_image', 'transcribe_audio',                                            // -> media subagent
      'server_sync',                                                                   // -> devops subagent
    ])
    assembledTools = assembledTools.filter(t => !SUBAGENT_ONLY_TOOLS.has(t.name))

    // Interaction mode tool restrictions
    if (interactionMode === 'ask') {
      assembledTools = []
    } else if (interactionMode === 'plan') {
      const PLAN_MODE_ALLOWED = new Set([
        'read_file', 'search',
        'web',
        'memory_read', 'memory_search',
        'ask_user', 'todo_write', 'create_plan', 'update_plan',
        'skill',
      ])
      assembledTools = assembledTools.filter(t => PLAN_MODE_ALLOWED.has(t.name))
    }

    if (this.config.coordinatorMode) {
      const { COORDINATOR_READONLY_TOOLS } = await import('./coordinator-prompt')
      assembledTools = assembledTools.filter(t => COORDINATOR_READONLY_TOOLS.has(t.name))
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

        const realExecute = tool.execute
        return {
          ...tool,
          execute: async (_id: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
            const result = mockFn(params)
            if (result === '__passthrough') return realExecute(_id, params, signal, onUpdate)
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

    // Multi-layer context compaction pipeline (Layers 1-4)
    const contextBudgetChars = (this.sessionManager.autocompactThreshold) * 4
    let history = this.sessionManager.buildHistory(sessionId)
    history = applyToolResultBudget(history, contextBudgetChars)
    const mc = microcompact(history)
    history = mc.messages
    history = snipConsumedResults(history)

    if (mc.tokensSaved > 0) {
      console.log(`${this.logPrefix} Microcompact saved ~${mc.tokensSaved} tokens for session ${sessionId}`)
    }

    // Layer 4: LLM autocompact if still over threshold after cheap layers
    if (this.sessionManager.estimateTokens(session) > this.sessionManager.autocompactThreshold) {
      const fileStateSummary = this.fileStateCache.size > 0
        ? this.fileStateCache.getSummary(this.workspaceDir)
        : undefined
      const preCompactResult = await this.sessionManager.compact(sessionId, fileStateSummary)
      if (preCompactResult) {
        console.log(
          `${this.logPrefix} Pre-turn autocompact: ${preCompactResult.messagesBefore} -> ${preCompactResult.messagesAfter} messages`
        )
        // Autocompact rewrites the prefix — drop stable-compaction state so
        // the new transformContext decisions are taken against the new history.
        this.contentReplacementStates.delete(sessionId)
        history = this.sessionManager.buildHistory(sessionId)
        history = applyToolResultBudget(history, contextBudgetChars)
        history = microcompact(history).messages
        history = snipConsumedResults(history)
      }
    }

    // Populate fork-mode context so subagent tools can access the parent's state
    toolContext.renderedSystemPrompt = systemPrompt
    toolContext.sessionMessages = history

    // Emit team snapshot + agent registry for UI hydration on reload
    if (uiWriter && this.teamManager) {
      try {
        const teams = this.teamManager.listTeams(sessionId)
        for (const team of teams) {
          uiWriter.write({
            type: 'data-team-snapshot',
            data: {
              team,
              members: this.teamManager.listMembers(team.id),
              tasks: this.teamManager.listTasks(team.id),
              messages: this.teamManager.getRecentMessages(team.id, 50),
            },
          })
        }
      } catch (err: any) {
        console.warn(`${this.logPrefix} Failed to emit team snapshot:`, err.message)
      }
    }
    if (uiWriter && this.agentManager) {
      try {
        const types = this.agentManager.listTypes()
        uiWriter.write({ type: 'data-agent-types', data: { types } })
      } catch { /* ignore */ }
    }

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
    const toolHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()

    const streamedToolCalls = new Set<string>()

    const turnAbort = new AbortController()
    this.turnAbortControllers.set(sessionId, turnAbort)

    try {
      const hookEmitter = this.hookEmitter
      let runningContextEstimate = this.sessionManager.estimateTokens(session)
      const contextWindowTokens = this.sessionManager.contextWindowTokens

      // Throttle data-context-usage emissions — at most once per 5s during
      // long-running agent turns with many tool calls. Without this, every
      // tool execution emits an update, flooding the client SSE stream.
      let lastContextUsageEmitMs = 0
      const CONTEXT_USAGE_THROTTLE_MS = 5_000
      const emitContextUsage = () => {
        const now = Date.now()
        if (uiWriter && now - lastContextUsageEmitMs >= CONTEXT_USAGE_THROTTLE_MS) {
          lastContextUsageEmitMs = now
          uiWriter.write({
            type: 'data-context-usage',
            data: { inputTokens: runningContextEstimate, contextWindowTokens },
          } as any)
        }
      }

      // Always emit the initial estimate immediately
      if (uiWriter) {
        lastContextUsageEmitMs = Date.now()
        uiWriter.write({
          type: 'data-context-usage',
          data: { inputTokens: runningContextEstimate, contextWindowTokens },
        } as any)
      }

      // Prompt breakdown: compute tool schema size and emit per-section breakdown
      if (this.lastPromptBreakdown) {
        const toolSchemaChars = tools.reduce((sum, t) => {
          const schema = JSON.stringify({ name: t.name, description: t.description, input_schema: t.parameters })
          return sum + schema.length
        }, 0)
        const toolSchemaEstTokens = Math.ceil(toolSchemaChars / 4)

        const breakdown = this.lastPromptBreakdown
        const totalChars = breakdown.reduce((s, sec) => s + sec.chars, 0)
        const totalEstTokens = breakdown.reduce((s, sec) => s + sec.estTokens, 0)
        const grandEstTokens = totalEstTokens + toolSchemaEstTokens

        const lines = ['[AgentGateway] Prompt breakdown:']
        const maxLabel = Math.max(...breakdown.map(s => s.label.length), 'tool-schemas (XX)'.length)
        for (const sec of breakdown) {
          const tag = sec.zone === 'stable' ? 'S' : 'D'
          lines.push(`  ${sec.label.padEnd(maxLabel)} [${tag}]: ${sec.chars.toLocaleString().padStart(7)} chars ~${sec.estTokens.toLocaleString().padStart(6)} tok`)
        }
        lines.push(`  ${''.padEnd(maxLabel + 30, '─')}`)
        lines.push(`  ${'System prompt total'.padEnd(maxLabel)}    : ${totalChars.toLocaleString().padStart(7)} chars ~${totalEstTokens.toLocaleString().padStart(6)} tok`)
        lines.push(`  ${`Tool schemas (${tools.length})`.padEnd(maxLabel)}    : ${toolSchemaChars.toLocaleString().padStart(7)} chars ~${toolSchemaEstTokens.toLocaleString().padStart(6)} tok`)
        lines.push(`  ${'Grand total'.padEnd(maxLabel)}    :                ~${grandEstTokens.toLocaleString().padStart(6)} tok`)
        console.log(lines.join('\n'))

        const breakdownPayload = {
          sections: breakdown,
          totalChars,
          totalEstTokens,
          toolSchemaChars,
          toolSchemaEstTokens,
          toolCount: tools.length,
          grandEstTokens,
        }

        if (uiWriter) {
          uiWriter.write({ type: 'data-prompt-breakdown', data: breakdownPayload } as any)
        }
      }

      const maxIterations = parseInt(process.env.AGENT_MAX_ITERATIONS || '200', 10)

      // --- Prefix-cache debug: turn-start snapshot ---
      // Emits short hashes of the three inputs Anthropic keys its prompt
      // cache on: tools, system (split stable/dynamic), and history prefix.
      // Compare across turns: anything that changes here is a cache-break
      // cause. `stable` changing is the smoking gun for wasted cache.
      const turnNum = (this.turnCounters.get(sessionId) ?? 0) + 1
      this.turnCounters.set(sessionId, turnNum)
      let apiCallNum = 0

      // Reset per-turn edit tracking so read_lints auto-scope starts clean.
      this.fileStateCache.resetTurn()

      const result = await runAgentLoop({
        provider,
        model: modelId,
        system: systemPrompt,
        history,
        prompt,
        images,
        tools,
        maxIterations,
        loopDetection: this.config.loopDetection,
        streamFn: this._streamFn,
        thinkingLevel: resolveThinkingLevel(autoRouting ? undefined : session.modelOverride),
        signal: turnAbort.signal,
        onContextOverflow: async () => {
          console.warn(`${this.logPrefix} Layer 5: Reactive compaction for session ${sessionId}`)
          const fileStateSummary = this.fileStateCache.size > 0
            ? this.fileStateCache.getSummary(this.workspaceDir)
            : undefined
          const r = await this.sessionManager.compact(sessionId, fileStateSummary, 4)
          if (!r) return null
          console.log(`${this.logPrefix} Reactive compaction: ${r.messagesBefore} -> ${r.messagesAfter} messages`)
          // LLM autocompact rewrites the prefix — drop per-session replacement
          // decisions so fresh ones are taken against the new history. Keeping
          // stale entries is correctness-safe (inert) but wastes memory and
          // can mis-freeze an id that survived into the summary.
          this.contentReplacementStates.delete(sessionId)
          let h = this.sessionManager.buildHistory(sessionId)
          h = applyToolResultBudget(h, contextBudgetChars)
          h = microcompact(h).messages
          h = snipConsumedResults(h)
          return h
        },
        // Per-API-call transform. This runs before EVERY LLM request inside
        // the agent loop (every tool-use iteration). The stable wrapper makes
        // compaction decisions monotone and write-once per tool_call_id so
        // the prompt-cache prefix stays byte-identical across calls for any
        // id that's already been decided. See stable-compaction.ts.
        transformContext: (messages) => {
          let state = this.contentReplacementStates.get(sessionId)
          if (!state) {
            state = createContentReplacementState()
            this.contentReplacementStates.set(sessionId, state)
          }
          const result = stableTransformContext(messages, state, contextBudgetChars)
          return result.messages
        },
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
          runningContextEstimate += Math.ceil(delta.length / 4)
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
          this._lastTool = toolName
          if (uiWriter && uiTextId) {
            uiWriter.write({ type: 'text-end', id: uiTextId })
            uiTextId = null
          }
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-start', toolCallId, toolName, dynamic: true })
            streamedToolCalls.add(toolCallId)
          }
        },
        onToolCallDelta: (toolName, delta, toolCallId) => {
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-delta', toolCallId, inputTextDelta: delta })
          }
        },
        onToolCallEnd: (_toolName, toolCallId) => {
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
          if (uiWriter && !toolHeartbeatTimers.has(toolCallId)) {
            const startedAt = Date.now()
            const timer = setInterval(() => {
              try {
                uiWriter.write({
                  type: 'data-tool-progress',
                  data: {
                    toolCallId,
                    toolName,
                    elapsedMs: Date.now() - startedAt,
                    status: 'running',
                  },
                } as any)
              } catch {
                clearInterval(timer)
                toolHeartbeatTimers.delete(toolCallId)
              }
            }, 15_000)
            toolHeartbeatTimers.set(toolCallId, timer)
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
          const timer = toolHeartbeatTimers.get(toolCallId)
          if (timer) {
            clearInterval(timer)
            toolHeartbeatTimers.delete(toolCallId)
          }
          if (isError) {
            console.error(`${this.logPrefix} Tool error: ${toolName}`, JSON.stringify(result).substring(0, 500))
          } else {
            console.log(`${this.logPrefix} Tool result: ${toolName}`, JSON.stringify(result).substring(0, 300))
          }
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
          const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? '')
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
          runningContextEstimate += Math.ceil((argsStr.length + resultStr.length) / 4)
          emitContextUsage()

          await hookEmitter.emit(
            HookEmitter.createEvent('tool', 'after', sessionId, {
              toolName, args, result, isError, toolCallId, workspaceDir: this.workspaceDir,
            })
          )
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

      // Persist messages to session FIRST — before any uiWriter calls that
      // could throw due to client disconnect.  This ensures "continue" after
      // stop always has the interrupted turn's context.
      this.sessionManager.addMessages(sessionId, ...result.newMessages)

      if (this.sessionManager.needsCompaction(session)) {
        const fileStateSummary = this.fileStateCache.size > 0
          ? this.fileStateCache.getSummary(this.workspaceDir)
          : undefined
        const compactResult = await this.sessionManager.compact(sessionId, fileStateSummary)
        if (compactResult) {
          console.log(
            `${this.logPrefix} Post-turn compaction: ${compactResult.messagesBefore} -> ${compactResult.messagesAfter} messages`
          )
          // Prefix rewritten — drop stable-compaction state. Next turn's
          // transformContext takes fresh decisions against the new history.
          this.contentReplacementStates.delete(sessionId)
        }
      }

      this.sessionManager.touch(sessionId)

      // Emit final context usage so the client always gets the most up-to-date value
      // even if the throttle timer hasn't fired recently.
      if (uiWriter) {
        uiWriter.write({
          type: 'data-context-usage',
          data: { inputTokens: runningContextEstimate, contextWindowTokens },
        } as any)
      }

      // Store usage for callers (server.ts includes it in the `finish` event)
      const estimatedContextTokens = this.sessionManager.estimateTokens(session)
      const effectiveModel = result.effectiveModelId || modelId
      this._lastTurnUsage = {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        iterations: result.iterations,
        toolCallCount: result.toolCalls.length,
        contextWindowTokens: this.sessionManager.contextWindowTokens,
        estimatedContextTokens,
        model: effectiveModel,
      }

      // UI notifications below may throw if the client disconnected (stop).
      // Wrap in try/catch so session persistence above is never affected.
      try {
        chunker?.flush()
        chunker?.dispose()

        if (uiWriter && uiTextId) {
          uiWriter.write({ type: 'text-end', id: uiTextId })
          uiTextId = null
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
          const isIterationLimit = /maximum iteration limit/i.test(msg)
          const isProviderError = /api error|api key|auth|unauthorized|forbidden|rate.limit|overloaded|timeout|billing|insufficient.credits|usage limit/i.test(msg)
          const isBillingError = /billing|insufficient.credits|usage limit|upgrade your plan|usage.based pricing/i.test(msg)
          console.error(
            `${this.logPrefix} Agent error for session ${sessionId}: ${msg} (${result.toolCalls.length} tool calls, ${result.outputTokens} output tokens)`
          )
          chunker?.dispose()
          if (uiWriter) {
            const errorText = isIterationLimit
              ? 'I reached my iteration limit before finishing the task. Send a follow-up message like "continue" to pick up where I left off.'
              : isBillingError
                ? 'Usage limit reached. Enable usage-based pricing, upgrade your plan, or check your AI provider settings.'
                : isProviderError
                  ? `AI provider error: ${msg}`
                  : `I encountered an issue processing your message: ${msg}`
            uiWriter.write({ type: 'error', errorText } as any)
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
      } catch (uiErr: any) {
        console.warn(`${this.logPrefix} Post-loop UI write failed (session messages already persisted): ${uiErr.message}`)
        chunker?.dispose()
      }

      if (result.text) return result.text
      if (isHeartbeat) return 'HEARTBEAT_OK'
      console.warn(`${this.logPrefix} Empty model response for session ${sessionId} (${result.iterations} iterations, ${result.toolCalls.length} tool calls, ${result.outputTokens} output tokens)`)
      return 'Sorry, I was unable to generate a response. Please try again.'
    } catch (error: any) {
      console.error(`${this.logPrefix} Agent turn failed:`, error.message, error.stack?.split('\n').slice(0, 3).join('\n'))
      chunker?.dispose()
      try {
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
      } catch { /* writer may be dead — ignore */ }
      if (isHeartbeat) return 'HEARTBEAT_OK'
      return `Sorry, I encountered an error processing your message. Please try again.`
    } finally {
      this.turnAbortControllers.delete(sessionId)
      if (typingInterval) clearInterval(typingInterval)
      for (const timer of toolHeartbeatTimers.values()) {
        clearInterval(timer)
      }
      toolHeartbeatTimers.clear()
    }
  }

  private buildShellNavLines(): string[] {
    const lines = [
      '',
      '### Shell Navigation',
      'Shell state is persistent — `cd` in one exec call carries over to the next.',
    ]
    if (this.permissionEngine) {
      switch (this.permissionEngine.mode) {
        case 'strict':
          lines.push('You may only run commands within the workspace directory. Do not navigate outside it.')
          break
        case 'balanced':
          lines.push('You may navigate within the workspace directory tree. Navigation outside the workspace requires user approval.')
          break
        case 'full_autonomy':
          lines.push('You may navigate to any directory on the system.')
          break
      }
    }
    return lines
  }

  private buildSWEPrompt(sessionId?: string): string {
    const parts: string[] = []
    const currentCwd = (sessionId && this.shellCwd.get(sessionId)) || this.workspaceDir

    const now = new Date()
    parts.push([
      '## Current Context',
      `- Today: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `- Year: ${now.getFullYear()}`,
      `- Timezone: ${this.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      `- Working directory: \`${currentCwd}\``,
      '',
      'All file paths are relative to the working directory. Do NOT assume paths like `/workspace`, `/home/user`, or `/repo` — use the working directory above.',
      ...this.buildShellNavLines(),
    ].join('\n'))

    const workspaceTree = this.buildWorkspaceTreeContext()
    if (workspaceTree) {
      parts.push(workspaceTree)
    }

    parts.push(CODE_AGENT_GENERAL_GUIDE)
    if (this.config.browserEnabled !== false) {
      parts.push(BROWSER_TOOL_GUIDE)
    }
    parts.push(SUBAGENT_GUIDE)

    if (sessionId) {
      const teamCtx = this.buildTeamContext(sessionId)
      if (teamCtx) parts.push(teamCtx)
    }

    return parts.join('\n\n---\n\n')
  }

  /**
   * General prompt profile for non-SWE benchmarks (GAIA, WebArena, Terminal-Bench).
   * Includes workspace context, coding guide, and skills — but skips personality,
   * canvas, templates, memory, and other Shogo-specific sections.
   */
  private buildGeneralPrompt(sessionId?: string): string {
    const parts: string[] = []
    const currentCwd = (sessionId && this.shellCwd.get(sessionId)) || this.workspaceDir

    const now = new Date()
    parts.push([
      '## Current Context',
      `- Today: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `- Year: ${now.getFullYear()}`,
      `- Timezone: ${this.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      `- Working directory: \`${currentCwd}\``,
      '',
      'All file paths are relative to the working directory. Do NOT assume paths like `/workspace`, `/home/user`, or `/repo` — use the working directory above.',
      ...this.buildShellNavLines(),
    ].join('\n'))

    const workspaceTree = this.buildWorkspaceTreeContext()
    if (workspaceTree) {
      parts.push(workspaceTree)
    }

    parts.push(CODE_AGENT_GENERAL_GUIDE)
    if (this.config.browserEnabled !== false) {
      parts.push(BROWSER_TOOL_GUIDE)
    }
    parts.push(SELF_EVOLUTION_GUIDE)

    if (this.skills.length > 0) {
      const skillsSection = buildSkillsPromptSection(this.skills)
      if (skillsSection) {
        parts.push(skillsSection)
      }
    }

    if (this.config.quickActionsEnabled !== false) {
      parts.push(QUICK_ACTION_GUIDE)
      if (this.quickActions.length > 0) {
        const qaSection = buildQuickActionsPromptSection(this.quickActions)
        if (qaSection) parts.push(qaSection)
      }
    }

    parts.push(SUBAGENT_GUIDE)

    if (sessionId) {
      const teamCtx = this.buildTeamContext(sessionId)
      if (teamCtx) parts.push(teamCtx)
    }

    return parts.join('\n\n---\n\n')
  }

  private loadBootstrapContext(sessionId?: string): string {
    if (this.config.promptProfile === 'swe') {
      return this.buildSWEPrompt(sessionId)
    }
    if (this.config.promptProfile === 'general') {
      return this.buildGeneralPrompt(sessionId)
    }

    // =========================================================================
    // Prompt cache optimization: sections are ordered by stability so that
    // Anthropic's prompt cache can reuse the prefix across turns. Most-stable
    // content (tool guides, coding guide, canvas guides) comes first; per-turn
    // dynamic content (date, workspace tree, installed tools) comes last.
    // The PROMPT_CACHE_STABLE_BOUNDARY marker below separates the two zones —
    // everything before it is expected to stay identical across turns.
    // =========================================================================

    const stableParts: string[] = []
    const dynamicParts: string[] = []
    const sections: Array<{ label: string; zone: 'stable' | 'dynamic'; chars: number; estTokens: number }> = []

    const pushStable = (label: string, content: string) => {
      stableParts.push(content)
      sections.push({ label, zone: 'stable', chars: content.length, estTokens: Math.ceil(content.length / 4) })
    }
    const pushDynamic = (label: string, content: string) => {
      dynamicParts.push(content)
      sections.push({ label, zone: 'dynamic', chars: content.length, estTokens: Math.ceil(content.length / 4) })
    }

    // ---- STABLE ZONE: rarely changes within a session ----

    // 1. Mode-specific canvas/tool guides (changes only on mode switch)
    const activeMode = this.config.activeMode || 'canvas'
    if (activeMode !== 'canvas') {
      pushStable('canvas-file-reference', CANVAS_FILE_REFERENCE)
    }

    // 2. General coding guide (always the same)
    pushStable('code-agent-guide', CODE_AGENT_GENERAL_GUIDE)

    // 3. Capabilities Index — compact pointers to on-demand guides served by read_guide tool.
    // Full guide content lives in guide-registry.ts and is returned by the read_guide tool,
    // saving ~4,600 tokens per turn compared to inlining all guides.
    this.currentGuideRegistry = buildGuideRegistry(this.promptOverrides)
    pushStable('capabilities-index', CAPABILITIES_INDEX)

    pushStable('action-tools-guide', [
      '## Action Tools',
      '',
      'When the user asks you to connect an integration, configure a channel, or set up a scheduled reminder, use the relevant tool immediately instead of only describing what you would do.',
      '- Credentials or hostnames in the user message are permission to call `channel_connect` for email, Slack, Discord, Telegram, etc.',
      '- For managed integrations such as GitHub or Google Calendar, call `tool_search`/`mcp_search`, then `tool_install`/`mcp_install`, then use the installed tools.',
      '- For recurring reminders, digests, check-ins, or autonomous routines, call `heartbeat_configure` and write or update `HEARTBEAT.md` with the exact checklist.',
      '- If you need a missing detail such as timezone or channel name, call `ask_user` instead of asking only in prose.',
      '- A successful final response should summarize what you configured, not ask whether to start.',
    ].join('\n'))

    if (this.config.quickActionsEnabled !== false) {
      pushStable('quick-action-guide', QUICK_ACTION_GUIDE)
    }

    // 4. Security permissions guide (stable once mode is set)
    if (this.permissionEngine) {
      pushStable('security-permissions', [
        '## Security Permissions',
        '',
        'This agent runs with a security permission system. Some tool calls may be blocked or require user approval through a UI dialog (not through chat).',
        '- If a tool result says "Permission denied", the action is permanently blocked. Tell the user it is not available. Do NOT ask them to approve it.',
        '- If a tool result says the user "declined" an action, they already decided via the security dialog. Acknowledge it briefly and move on. Do NOT ask again or request confirmation in chat.',
        '- Never try to work around permission denials by re-running the same tool or asking the user to confirm in text.',
      ].join('\n'))
    }

    // 5. Error notification guide (always the same)
    pushStable('error-notification-guide', [
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

    // Separator tells the AI proxy to split the system prompt into two Anthropic
    // system blocks: the stable prefix gets cache_control, the dynamic suffix
    // does not. Without this, the entire prompt is one block whose cache is
    // invalidated every turn because the dynamic content changes.
    const CACHE_BOUNDARY = '\n\n<|CACHE_BOUNDARY|>\n\n'

    // ---- DYNAMIC ZONE: changes between turns or sessions ----

    // 6. Project identity files (change when user edits them)
    // SOUL.md, USER.md, IDENTITY.md were consolidated into AGENTS.md but are
    // still read here for backwards compatibility with existing workspaces.
    const files = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md']
    for (const filename of files) {
      const filepath = resolveWorkspaceConfigFilePath(this.workspaceDir, filename)
      if (filepath) {
        const content = readFileSync(filepath, 'utf-8').trim()
        if (content) {
          pushDynamic(filename.toLowerCase().replace('.md', ''), content)
        }
      }
    }

    // 6b. STACK.md — preview-truncated to save tokens. The full file is
    // available to the agent via read_file when it needs the complete reference.
    const STACK_PREVIEW_WORDS = 200
    const stackPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'STACK.md')
    if (stackPath) {
      const fullStack = readFileSync(stackPath, 'utf-8').trim()
      if (fullStack) {
        const words = fullStack.split(/\s+/)
        if (words.length <= STACK_PREVIEW_WORDS) {
          pushDynamic('stack', fullStack)
        } else {
          const preview = words.slice(0, STACK_PREVIEW_WORDS).join(' ')
          const relativePath = stackPath.startsWith(this.workspaceDir)
            ? stackPath.slice(this.workspaceDir.length + 1)
            : stackPath
          pushDynamic('stack', [
            preview,
            '',
            `(Truncated — ${words.length} words total. Full reference: \`read_file({ path: "${relativePath}" })\`)`,
          ].join('\n'))
        }
      }
    }

    // 7. Memory (changes frequently)
    const memoryPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'MEMORY.md')
    if (memoryPath) {
      const memory = readFileSync(memoryPath, 'utf-8').trim()
      if (memory) {
        pushDynamic('memory', `## Memory\n${memory}`)
      }
    }

    // 7b. Recent heartbeat activity (lets agent answer questions about autonomous work)
    const heartbeatLogPath = join(this.workspaceDir, 'HEARTBEAT_LOG.md')
    if (existsSync(heartbeatLogPath)) {
      const heartbeatLog = readFileSync(heartbeatLogPath, 'utf-8').trim()
      if (heartbeatLog) {
        pushDynamic('heartbeat-log', `## Recent Autonomous Activity\nThese are your recent heartbeat check results. Reference them when users ask about your autonomous activity.\n\n${heartbeatLog}`)
      }
    }

    // APP_MODE_DISABLED: app template context injection removed (was reading .app-template)

    // 7c. Runtime build + console log tails (canvas mode only — Vite preview pipeline)
    if (activeMode === 'canvas') {
      const previewUrl = this.buildPreviewUrlContext()
      if (previewUrl) {
        pushDynamic('preview-url', previewUrl)
      }
      const runtimeLogs = this.buildRuntimeLogsContext()
      if (runtimeLogs) {
        pushDynamic('runtime-logs', runtimeLogs)
      }
    }

    // 8. Agent template context (stable per-project, but read from disk)
    const agentTemplatePath = join(this.workspaceDir, '.template')
    if (existsSync(agentTemplatePath)) {
      const agentTemplate = readFileSync(agentTemplatePath, 'utf-8').trim()
      if (agentTemplate) {
        const humanName = agentTemplate.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        pushDynamic('agent-template', [
          '## Agent Template Context',
          '',
          `This agent was created from the **${humanName}** template (\`${agentTemplate}\`).`,
          'Your configuration files (AGENTS.md, HEARTBEAT.md, skills/) are already',
          'set up with template-specific instructions. Follow the instructions in AGENTS.md.',
          '',
        ].join('\n'))
      }
    }

    // 9. Current date/time context (changes every turn)
    const now = new Date()
    const currentCwd = (sessionId && this.shellCwd.get(sessionId)) || this.workspaceDir
    pushDynamic('current-context', [
      '## Current Context',
      `- Today: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `- Year: ${now.getFullYear()}`,
      `- Timezone: ${this.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      `- Working directory: \`${currentCwd}\``,
      '',
      'All file paths are relative to the working directory.',
      'When users mention dates without a year, default to the current or next occurrence (never a past date).',
      ...this.buildShellNavLines(),
    ].join('\n'))

    const modeLabel = activeMode === 'none' ? 'chat' : activeMode
    pushDynamic('current-mode', `\n## Current Mode\nActive visual mode: **${modeLabel}**.\n`)

    // 10. Dynamic workspace context (changes as files are added/removed)
    const installedToolsContext = this.buildInstalledToolsContext()
    if (installedToolsContext) {
      pushDynamic('installed-tools', installedToolsContext)
    }

    const uploadedFilesContext = this.buildUploadedFilesContext()
    if (uploadedFilesContext) {
      pushDynamic('uploaded-files', uploadedFilesContext)
    }

    const workspaceTree = this.buildWorkspaceTreeContext()
    if (workspaceTree) {
      pushDynamic('workspace-tree', workspaceTree)
    }

    // 11. Skills and skill server (can change when skills are installed)
    if (this.skills.length > 0) {
      const skillsSection = buildSkillsPromptSection(this.skills)
      if (skillsSection) {
        pushDynamic('skills', skillsSection)
      }
    }

    // 11b. Quick actions (can change when agent registers new ones)
    if (this.config.quickActionsEnabled !== false && this.quickActions.length > 0) {
      const qaSection = buildQuickActionsPromptSection(this.quickActions)
      if (qaSection) {
        pushDynamic('quick-actions', qaSection)
      }
    }

    const skillServerSection = this.buildSkillServerPromptSection()
    if (skillServerSection) {
      pushDynamic('skill-server', skillServerSection)
    }

    // 12. Active team context (persisted in SQLite, survives session resets)
    if (sessionId) {
      const teamCtx = this.buildTeamContext(sessionId)
      if (teamCtx) pushDynamic('team-context', teamCtx)
    }

    this.lastPromptBreakdown = sections

    const stableText = stableParts.join('\n\n---\n\n')
    const dynamicText = dynamicParts.join('\n\n---\n\n')
    return dynamicText ? stableText + CACHE_BOUNDARY + dynamicText : stableText
  }

  /**
   * URL block describing where the running preview app is reachable.
   *
   * This exists because the QA subagent contract requires a URL, and the main
   * agent previously had no reliable way to discover one (it was inventing
   * paths under .shogo/ and reading `vite.config.ts`, where the template
   * hardcodes port 5173 — a value that is always overridden at runtime by
   * whichever launcher spawned the process).
   *
   * Two ways this block gets a URL, in priority order:
   *   1. `PUBLIC_PREVIEW_URL` env var — set by the launcher (knative API or
   *      local RuntimeManager). This is the authoritative URL the user /
   *      browser sees. Trust it unconditionally when present.
   *   2. A built `dist/index.html` under the workspace — indicates the
   *      standalone agent-runtime is self-serving the app on its own port
   *      (`process.env.PORT`). Fall back to localhost in that case.
   *
   * Intentionally positive-only: do NOT name the hallucinated paths / ports
   * this replaces. Naming "don't use X" still puts X in the model's working
   * set.
   *
   * Returns null only when neither signal is present — no point telling the
   * agent about a URL that won't load.
   */
  private buildPreviewUrlContext(): string | null {
    const publicUrl = process.env.PUBLIC_PREVIEW_URL?.trim() || ''

    const runtimePort = parseInt(process.env.PORT || '8080', 10)
    const internalUrl = `http://localhost:${runtimePort}/`

    // dist/ may live at either workspaceDir/project/dist (k8s layout, where
    // the project lives in a /project subdir) or workspaceDir/dist (local
    // RuntimeManager layout, where workspaceDir === projectDir).
    const hasDist =
      existsSync(join(this.workspaceDir, 'project', 'dist', 'index.html')) ||
      existsSync(join(this.workspaceDir, 'dist', 'index.html'))

    if (publicUrl.length === 0 && !hasDist) return null

    const externalUrl = publicUrl.length > 0 ? publicUrl : internalUrl
    const hasDistinctPublic = publicUrl.length > 0 && publicUrl !== internalUrl

    const lines: string[] = [
      '## Running App Preview',
      '',
      `The user's app is running and reachable at **${externalUrl}**.`,
    ]
    if (hasDistinctPublic) {
      lines.push(`Internal (from inside this runtime): \`${internalUrl}\`.`)
    }
    lines.push(
      '',
      'When the user asks you to QA / test / try the app, spawn the **browser_qa** subagent and pass this URL as the target. This block is the single source of truth for the preview URL — do not read it from `vite.config.ts`, `package.json`, or any other file; those values are overridden by the launcher.',
    )
    return lines.join('\n')
  }

  /**
   * Last lines of `project/.build.log` and `project/.console.log` (Vite/API preview + runtime console).
   * Used only when canvas mode is active; returns null if both files are missing or empty.
   */
  private buildRuntimeLogsContext(): string | null {
    const LINE_LIMIT = 30
    const MAX_BLOCK_CHARS = 3000
    const buildPath = previewBuildLogPath(this.workspaceDir)
    const consolePath = previewConsoleLogPath(this.workspaceDir)

    let buildTail = ''
    if (existsSync(buildPath)) {
      try {
        const raw = readFileSync(buildPath, 'utf-8')
        const joined = raw.split(/\r?\n/).slice(-LINE_LIMIT).join('\n').trimEnd()
        buildTail =
          joined.length > MAX_BLOCK_CHARS ? joined.slice(-MAX_BLOCK_CHARS) : joined
      } catch {
        buildTail = ''
      }
    }

    let consoleTail = ''
    if (existsSync(consolePath)) {
      try {
        const raw = readFileSync(consolePath, 'utf-8')
        const joined = raw.split(/\r?\n/).slice(-LINE_LIMIT).join('\n').trimEnd()
        consoleTail =
          joined.length > MAX_BLOCK_CHARS ? joined.slice(-MAX_BLOCK_CHARS) : joined
      } catch {
        consoleTail = ''
      }
    }

    if (!buildTail && !consoleTail) {
      return null
    }

    const buildLogRelative = `${PREVIEW_SUBDIR}/${BUILD_LOG_FILE}`
    const consoleLogRelative = `${PREVIEW_SUBDIR}/${CONSOLE_LOG_FILE}`
    const buildLogAbsolute = buildPath
    const consoleLogAbsolute = consolePath

    const lines: string[] = [
      '## Runtime Logs (auto-injected, last ~30 lines each)',
      '',
      [
        'These tails are refreshed every turn. Both logs live under the **`project/`** app template directory (same folder as `package.json` for the preview).',
        `**Build:** \`${buildLogRelative}\` — full path \`${buildLogAbsolute}\`.`,
        `**Console:** \`${consoleLogRelative}\` — full path \`${consoleLogAbsolute}\`.`,
        'Use `read_file` with paths relative to the workspace root (e.g. `read_file({ path: \'project/.build.log\' })` and `read_file({ path: \'project/.console.log\' })`).',
        'Shell `exec` depends on cwd — prefer absolute paths or `cd` into the workspace first.',
        'The console file is cleared when the preview **starts** or **restarts** (fresh build session).',
      ].join(' '),
      '',
      `### Build log (\`${buildLogRelative}\`)`,
      `On disk: \`${buildLogAbsolute}\`. Written by the preview pipeline (Vite dev server + template API stdout/stderr). Lines use prefixes such as \`[stdout]\`, \`[stderr]\`, \`[api-stdout]\`. If the last lines show an error, fix it before claiming work is done.`,
      '',
      '```',
      buildTail || '(empty)',
      '```',
      '',
      `### Console log (\`${consoleLogRelative}\`)`,
      [
        `On disk: \`${consoleLogAbsolute}\`. Lines include forwarded preview/Vite output and gateway lifecycle events (\`emitLog\`) — same lines the user sees in the mobile app "Logs" tab.`,
      ].join(' '),
      '',
      '```',
      consoleTail || '(empty)',
      '```',
    ]

    return lines.join('\n')
  }

  /**
   * Build a system prompt section describing active teams, their members,
   * and task state.  Queried from the persistent SQLite TeamManager so
   * the agent retains awareness across conversation / pipeline resets.
   */
  private buildTeamContext(sessionId: string): string | null {
    if (!this.teamManager) return null

    const teams = this.teamManager.listTeams(sessionId)
    if (teams.length === 0) return null

    const sections: string[] = ['## Active Team Context']

    for (const team of teams) {
      const members = this.teamManager.listMembers(team.id)
      const tasks = this.teamManager.listTasks(team.id)

      sections.push(`### Team: ${team.name} (id: \`${team.id}\`)`)
      if (team.description) sections.push(team.description)

      if (members.length > 0) {
        sections.push('**Members:**')
        for (const m of members) {
          const status = m.isActive ? 'active' : 'inactive'
          sections.push(`- \`${m.name}\` (agent: \`${m.agentId}\`, ${status})`)
        }
      }

      if (tasks.length > 0) {
        sections.push('**Tasks:**')
        for (const t of tasks) {
          const deps = t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(', ')}]` : ''
          const owner = t.owner ? ` (owner: ${t.owner})` : ''
          sections.push(`- #${t.id} ${t.subject} — **${t.status}**${owner}${deps}`)
        }
      }
    }

    sections.push(
      '',
      'Use `send_team_message`, `task_create`, `task_update`, `task_list`, `team_delete` and other team tools to interact with this team.',
    )

    return sections.join('\n')
  }

  /**
   * Build a system prompt section describing the project's API server
   * (root `server.tsx`). If the server is healthy, tells the agent the
   * base URL and active routes; otherwise gives instructions for adding
   * models and tools to bring it up to date.
   */
  private buildSkillServerPromptSection(): string | null {
    if (this.config.shellEnabled === false) return null

    const phase = this.skillServerManager.phase
    const genError = this.skillServerManager.lastGenerateError
    const activeRoutes = this.skillServerManager.getActiveRoutes()
    const schemaModels = this.skillServerManager.getSchemaModels()
    const url = this.skillServerManager.url

    const regenGuide = [
      '### How schema regeneration works',
      '',
      'When you edit `prisma/schema.prisma` using `write_file` or `edit_file`,',
      'the tool **automatically** runs the full pipeline before returning:',
      '1. Runs `bun run generate` — refreshes routes, types, hooks, the API client, and the Prisma client',
      '2. Runs `prisma db push` — applies the schema additively to `prisma/dev.db`',
      '3. Restarts `server.tsx` so it loads the new routes',
      '4. Returns the list of **active routes** in the tool response',
      '',
      '**The tool response tells you exactly which routes are live.** Use those exact paths in your code.',
      '',
      '**Important:** ALWAYS read the existing `prisma/schema.prisma` first and APPEND your new models. Do not replace the file or remove existing models.',
      '',
      '`server.tsx` is **auto-generated** by the SDK from `shogo.config.json` —',
      'do NOT edit it. For custom non-CRUD routes (proxies, aggregations,',
      'webhooks, auth flows), edit `custom-routes.ts` at the project root.',
      'Saving that file triggers a fast restart (no regenerate, no db push)',
      'so changes are live in under a second.',
      '',
      'If you ever see a route 404 or need to force a refresh, use the `server_sync` tool:',
      '```',
      'server_sync({})',
      '```',
      'It returns the current phase, active routes, and schema models.',
      '',
      '**Do NOT** manually run `prisma generate`, `shogo generate`, or `npm run db:generate` — it is all automatic.',
    ].join('\n')

    if (this.skillServerManager.isRunning) {
      const lines = [
        '## Project Server',
        '',
        `Your project\'s backend (\`server.tsx\` at the project root) is running at **${url}** (status: **healthy**).`,
        '',
        'This is a Hono API backed by SQLite via Prisma. Each model in `prisma/schema.prisma` gets CRUD routes at',
        '`/api/{model-name-plural}` (GET list, GET /:id, POST, PATCH /:id, DELETE /:id).',
      ]

      if (activeRoutes.length > 0) {
        lines.push('')
        lines.push('**Currently active routes:**')
        for (const r of activeRoutes) {
          lines.push(`- \`${url}/api/${r}\``)
        }
      }

      const pendingModels = schemaModels.filter(m => {
        const kebab = m.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
        let expected: string
        if (kebab.endsWith('y')) expected = kebab.slice(0, -1) + 'ies'
        else if (kebab.endsWith('s') || kebab.endsWith('x') || kebab.endsWith('ch') || kebab.endsWith('sh')) expected = kebab + 'es'
        else expected = kebab + 's'
        return !activeRoutes.includes(expected)
      })

      if (pendingModels.length > 0) {
        lines.push('')
        lines.push(`**Schema models without routes yet (regeneration pending):** ${pendingModels.join(', ')}`)
        lines.push('These routes will appear after the regeneration pipeline finishes.')
      }

      lines.push('')
      lines.push(`Use the \`web\` tool with the full URL (e.g. \`web({ url: "${url}/api/${activeRoutes[0] || 'leads'}" })\`) to interact with it from agent tools.`)
      lines.push('')
      lines.push('To add new models, **append** them to `prisma/schema.prisma` (do not replace the file).')
      lines.push('To add custom business logic for a model (validation, side-effects), create or edit `src/lib/hooks/{model}.ts`.')
      lines.push('For custom API routes beyond CRUD (external proxies, aggregation, webhooks), edit `custom-routes.ts` at the project root — it exports a Hono `app` mounted under `/api/`. Do NOT edit `server.tsx`; it is auto-generated by the SDK and overwritten on regenerate.')
      lines.push('')
      lines.push(regenGuide)

      return lines.join('\n')
    }

    if (phase === 'generating' || phase === 'restarting') {
      const lines = [
        `## Project Server (${phase === 'generating' ? 'Generating...' : 'Restarting...'})`,
        '',
        `The API server is currently ${phase}. It will be available shortly at \`${url}\`.`,
      ]

      if (activeRoutes.length > 0) {
        lines.push('')
        lines.push('**Routes from last generation:**')
        for (const r of activeRoutes) lines.push(`- \`/api/${r}\``)
        lines.push('')
        lines.push('These may 404 until the restart completes. Wait a few seconds and retry.')
      }

      if (schemaModels.length > 0) {
        lines.push('')
        lines.push(`**Schema models:** ${schemaModels.join(', ')}`)
      }

      lines.push('')
      lines.push(regenGuide)
      return lines.join('\n')
    }

    if (phase === 'crashed' && genError) {
      return [
        '## Project Server (Error)',
        '',
        'The last code generation failed:',
        '```',
        genError,
        '```',
        'Fix the issue in `prisma/schema.prisma` (or `custom-routes.ts`) and save — the runtime will retry automatically. Do not edit `server.tsx`; it is regenerated from `shogo.config.json`.',
        '',
        regenGuide,
      ].join('\n')
    }

    return [
      '## Project Server (Available)',
      '',
      'Your project ships with its own backend (Hono + Prisma + SQLite). Edit `prisma/schema.prisma` to add models — the runtime regenerates routes and restarts the server automatically.',
      '',
      'To add a model, append it to `prisma/schema.prisma`:',
      '```prisma',
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
      'That\'s it — **everything else is automatic**: code generation, database migration,',
      `and server restart on \`${url}\`.`,
      'Each model gets full CRUD at `/api/{model-name-plural}`.',
      '',
      'For custom API routes beyond CRUD (proxies, aggregation, webhooks), edit `custom-routes.ts` at the project root. `server.tsx` is auto-generated — do not edit it.',
      '',
      regenGuide,
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
    lines.push('')
    lines.push('**From canvas code:** These tools are also callable from React code via `import { useTools } from \'@shogo-ai/sdk/tools\'`. Use `const { execute } = useTools()` then `await execute(\'TOOL_NAME\', { ...args })`. This is the preferred pattern when building apps that need ongoing access to integration data.')

    return lines.join('\n')
  }

  /**
   * Build a context section listing files the user has uploaded to files/.
   * Included in the system prompt so the agent knows what data is available
   * and can proactively use search/read_file to access it.
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
        'Use `search` to search content, or `read_file` with path `files/<name>` to read them.',
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

  /**
   * Wire the runtime's `PreviewManager` (owner of the API server) into
   * the gateway's prompt builder + tools. Called from server.ts after
   * both have been constructed.
   *
   * Once we finish the refactor, the gateway should hold a
   * `PreviewManager` reference directly and the `SkillServerManager`
   * shim can be deleted entirely.
   */
  attachApiServer(pm: import('./preview-manager').PreviewManager): void {
    this.skillServerManager.attach(pm)
  }

  getSkillServerPort(): number | null {
    // Return the configured port regardless of running state. The shim's
    // `.port` already falls back to the resolved `API_SERVER_PORT` /
    // `SKILL_SERVER_PORT` / 3001 chain when the manager hasn't attached
    // yet, so callers (eg. the runtime-checks endpoint) probe the right
    // port even while the API server is still booting. Returning `null`
    // here used to short-circuit a stale `?? 4100` fallback that targeted
    // the retired skill server's port — no longer correct now that the
    // port is dynamic per-project.
    return this.skillServerManager.port
  }

  getSkillServerPhase(): string {
    return this.skillServerManager.phase
  }

  getSkillServerActiveRoutes(): string[] {
    return this.skillServerManager.getActiveRoutes()
  }

  getSkillServerSchemaModels(): string[] {
    return this.skillServerManager.getSchemaModels()
  }

  async syncSkillServer(): Promise<{ ok: boolean; phase: string }> {
    return this.skillServerManager.sync()
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

  private appendHeartbeatLog(summary: string): void {
    const logPath = join(this.workspaceDir, 'HEARTBEAT_LOG.md')
    const timestamp = new Date().toISOString()
    const entry = `- [${timestamp}] ${summary}\n`
    const MAX_ENTRIES = 20

    try {
      let content = ''
      if (existsSync(logPath)) {
        content = readFileSync(logPath, 'utf-8')
      }

      const lines = content.split('\n').filter(l => l.startsWith('- ['))
      lines.push(entry.trim())
      const recent = lines.slice(-MAX_ENTRIES)

      writeFileSync(logPath, `# Recent Heartbeat Activity\n\n${recent.join('\n')}\n`, 'utf-8')
    } catch (error: any) {
      console.error('[AgentGateway] Failed to write heartbeat log:', error.message)
    }
  }

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

    // Compute memory/context file stats
    const memoryFiles = ['AGENTS.md', 'TOOLS.md', 'STACK.md', 'HEARTBEAT.md', 'MEMORY.md']
    let memoryFileCount = 0
    let memoryTotalSize = 0
    let memoryLastModified: Date | null = null

    for (const filename of memoryFiles) {
      const filepath = resolveWorkspaceConfigFilePath(this.workspaceDir, filename)
      if (filepath) {
        try {
          const st = statSync(filepath)
          if (st.size > 0) {
            memoryFileCount++
            memoryTotalSize += st.size
            if (!memoryLastModified || st.mtime > memoryLastModified) {
              memoryLastModified = st.mtime
            }
          }
        } catch { /* skip */ }
      }
    }

    const memoryDir = join(this.workspaceDir, 'memory')
    if (existsSync(memoryDir)) {
      try {
        for (const entry of readdirSync(memoryDir)) {
          if (!entry.endsWith('.md')) continue
          const fp = join(memoryDir, entry)
          const st = statSync(fp)
          if (st.isFile() && st.size > 0) {
            memoryFileCount++
            memoryTotalSize += st.size
            if (!memoryLastModified || st.mtime > memoryLastModified) {
              memoryLastModified = st.mtime
            }
          }
        }
      } catch { /* skip */ }
    }

    const activeTurnCount = this.turnLocks.size

    return {
      running: this.running,
      status: activeTurnCount > 0 ? 'active' : this.running ? 'idle' : 'stopped',
      currentTask: this._currentTask,
      lastTool: this._lastTool,
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
      memory: {
        fileCount: memoryFileCount,
        totalSizeBytes: memoryTotalSize,
        lastModified: memoryLastModified?.toISOString() ?? null,
      },
    }
  }

  reloadConfig(): void {
    const prevEnabled = this.config.heartbeatEnabled
    this.config = this.loadConfig()
    this.skills = loadAllSkills(this.workspaceDir)
    this.quickActions = loadQuickActions(this.workspaceDir)
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

  /**
   * Reconnect the index engine and workspace graph database handles.
   * Call after the .shogo/ directory has been deleted and recreated
   * (e.g. between eval runs).
   */
  reconnectIndex(): void {
    if (this.indexEngine) {
      this.indexEngine.reconnect()
      if (this.workspaceGraph) {
        this.workspaceGraph.reconnect()
      }
    }
  }

  getActiveMode(): VisualMode {
    return this.config.activeMode || 'canvas'
  }

  setActiveMode(mode: VisualMode): void {
    this.config.activeMode = mode
  }

  getAllowedModes(): VisualMode[] {
    return this.config.allowedModes || ['canvas', 'none']
  }

  /** Map of sessionId -> AbortController for cancelling in-progress agent turns */
  private turnAbortControllers = new Map<string, AbortController>()

  /** Per-session turn lock: ensures sequential turn execution so a "continue"
   *  after stop always sees the interrupted turn's messages in the session. */
  private turnLocks = new Map<string, Promise<unknown>>()

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
