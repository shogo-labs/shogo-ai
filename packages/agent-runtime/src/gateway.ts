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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Message, UserMessage } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import type { ChannelAdapter, IncomingMessage, AgentStatus, ChannelStatus, StreamChunkConfig, SandboxConfig } from './types'
import { loadSkills, loadBundledSkills, matchSkill, type Skill } from './skills'
import { runAgentLoop, type LoopDetectorConfig, type ToolContext } from './agent-loop'
import { createAllTools, createHeartbeatTools } from './gateway-tools'
import { HookEmitter, loadAllHooks } from './hooks'
import { parseSlashCommand, type SlashCommandContext } from './slash-commands'
import { SessionManager, type SessionManagerConfig } from './session-manager'
import { SqliteSessionPersistence } from './sqlite-session-persistence'
import { CronManager, type CronJob } from './cron-manager'
import { userMessage } from './pi-adapter'
import { BlockChunker } from './block-chunker'
import { MCPClientManager, type MCPServerConfig } from './mcp-client'
import {
  OPTIMIZED_CANVAS_EXAMPLES,
  OPTIMIZED_MEMORY_GUIDE,
  OPTIMIZED_PERSONALITY_GUIDE,
  OPTIMIZED_TOOL_PLANNING_GUIDE,
  OPTIMIZED_SESSION_SUMMARY_GUIDE,
  OPTIMIZED_SKILL_MATCHING_GUIDE,
} from './optimized-prompts'

export interface GatewayConfig {
  heartbeatInterval: number
  heartbeatEnabled: boolean
  quietHours: { start: string; end: string; timezone: string }
  channels: Array<{ type: string; config: Record<string, string> }>
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
}

const CANVAS_TOOLS_GUIDE_PREFIX = `## Canvas (Dynamic UI)

You have canvas tools that let you build interactive UIs the user can see in real time.
Use them whenever a visual display would be more helpful than plain text.

### Quick Reference — Building a CRUD App (recommended approach)

When the user asks for any kind of data app (task tracker, todo list, inventory, CRM, etc.), follow these 4 steps:

**Step 1: canvas_create** — Create a surface
  canvas_create({ surfaceId: "my_app", title: "My App" })

**Step 2: canvas_api_schema** — Define data model + auto-generate CRUD API
  canvas_api_schema({ surfaceId: "my_app", models: [{
    name: "Task", fields: [
      { name: "title", type: "String" },
      { name: "status", type: "String", default: "todo" },
      { name: "priority", type: "String", default: "medium" }
    ]
  }]})
  → Creates REST endpoints: GET/POST /api/tasks, GET/PATCH/DELETE /api/tasks/:id

**Step 3: canvas_api_seed** — Populate sample data
  canvas_api_seed({ surfaceId: "my_app", model: "Task", records: [
    { title: "First task", priority: "high" },
    { title: "Second task", status: "done" }
  ]})

**Step 3b: canvas_api_query** — Push data into the data model for binding
  canvas_api_query({ surfaceId: "my_app", model: "Task", dataPath: "/tasks" })
  → Now { path: "/tasks" } is available for component data binding

**Step 4: canvas_update** — Build the UI with DataList + form + mutation buttons
  canvas_update({ surfaceId: "my_app", components: [
    { id: "root", component: "Column", children: ["header", "add_section", "task_list"], gap: "md", padding: "4" },
    { id: "header", component: "Text", text: "My Tasks", variant: "h3" },

    // --- Add form: TextField writes to data model, Button reads from it ---
    { id: "add_section", component: "Card", child: "add_form", title: "Add Task" },
    { id: "add_form", component: "Row", children: ["add_input", "add_btn"], gap: "sm", align: "end" },
    { id: "add_input", component: "TextField", placeholder: "Task title...", dataPath: "/newTaskTitle" },
    { id: "add_btn", component: "Button", label: "Add Task",
      action: { name: "add", mutation: { endpoint: "/api/tasks", method: "POST",
        body: { title: { path: "/newTaskTitle" } } } } },

    // --- DataList: renders template for each item, with per-row actions ---
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
  ]})

### Key Patterns

**Data Binding:**
- \`{ path: "/field" }\` (with leading /) reads from the ROOT data model
- \`{ path: "field" }\` (NO leading /) reads from the CURRENT ITEM inside a DataList template

**DataList (repeating template):**
- Set children to: \`{ path: "/items", templateId: "template_id" }\`
- The template component + its descendants render once per item
- Use for any list with per-item buttons (Table cannot have buttons in rows)

**Mutations (frontend-handled CRUD, no agent round-trip):**
- POST: \`{ mutation: { endpoint: "/api/tasks", method: "POST", body: { title: "..." } } }\`
- PATCH: \`{ mutation: { endpoint: "/api/tasks/:id", method: "PATCH", params: { id: { path: "id" } }, body: { status: "done" } } }\`
- DELETE: \`{ mutation: { endpoint: "/api/tasks/:id", method: "DELETE", params: { id: { path: "id" } } } }\`

**Form inputs → Mutation body:**
- Set \`dataPath: "/newTitle"\` on TextField to write user input to the data model
- Reference it in mutation body: \`{ title: { path: "/newTitle" } }\`

### Component Types

**Layout:** Column, Row, Grid, Card, ScrollArea, Tabs, TabPanel, Accordion, AccordionItem
**Display:** Text, Badge, Image, Icon, Separator, Progress, Skeleton, Alert
**Data:** Table (read-only), Metric, Chart, DataList (repeating with actions)
**Interactive:** Button, TextField, Select, Checkbox, ChoicePicker

Use \`canvas_components({ action: "detail", type: "Card" })\` to look up props for any component.

### Other Tools
- **canvas_data** — Manually push data: \`canvas_data({ surfaceId: "app", path: "/key", value: data })\`
- **canvas_action_wait** — Wait for user button clicks (for non-mutation actions)
- **canvas_delete** — Remove a surface
- **canvas_components** — Discover components and their props

### IMPORTANT
- When canvas tools return status: "rendered" or "data_updated", the UI is already live.
- Do NOT rebuild surfaces that are working — use canvas_update to modify specific components.
- Table is read-only. For lists needing edit/delete buttons, always use DataList.

`

const PERSONALITY_EVOLUTION_GUIDE_PREFIX = `## Personality Self-Update

You have a \`personality_update\` tool that lets you improve your own behavior files.

### When to Use
- User explicitly corrects your tone, style, or boundaries (e.g. "be more formal")
- User establishes a new, lasting boundary (e.g. "don't suggest code changes")
- You discover a persistent user preference that should shape future interactions

### When NOT to Use
- One-off requests or trivial conversation
- Information already present in your SOUL.md
- Temporary context that doesn't reflect a lasting change

### How It Works
- Specify the file (SOUL.md, AGENTS.md, or IDENTITY.md), the section heading, and the new content
- Include a reasoning field explaining why the update improves your behavior
- Max 1 update per session, 3 per day — be selective
- The Boundaries section in SOUL.md can never be removed, only appended to
- All updates are logged to daily memory with [personality-update] tag

`

export class AgentGateway {
  private workspaceDir: string
  private projectId: string
  private config: GatewayConfig
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private channels: Map<string, ChannelAdapter> = new Map()
  private skills: Skill[] = []
  private configSkills: Array<{ name: string; trigger?: string; description?: string }> = []
  private running = false
  private lastHeartbeatTick: Date | null = null
  private nextHeartbeatTick: Date | null = null
  private hookEmitter: HookEmitter = new HookEmitter()
  private pendingEvents: string[] = []
  private sessionManager: SessionManager
  private cronManager: CronManager
  private sessionPersistence: SqliteSessionPersistence | null = null
  private mcpClientManager: MCPClientManager = new MCPClientManager()
  /** Optional custom stream function, injected for testing */
  private _streamFn?: StreamFn
  /** Optional log callback for forwarding gateway events to the UI Logs tab */
  private _onLog?: (line: string) => void
  /** Per-section prompt overrides set by DSPy optimization via POST /agent/prompt-override */
  private promptOverrides = new Map<string, string>()

  constructor(workspaceDir: string, projectId: string) {
    this.workspaceDir = workspaceDir
    this.projectId = projectId
    this.config = this.loadConfig()
    this.sessionManager = new SessionManager(this.config.session)
    this.cronManager = new CronManager({
      persistPath: join(workspaceDir, 'cron.json'),
      onJobFire: (job) => this.agentTurn(
        `[CRON: ${job.name}]\n${job.prompt}`,
        `cron:${job.name}`
      ),
    })
  }

  /** Inject a custom streamFn (used in tests to mock the LLM) */
  setStreamFn(fn: StreamFn): void {
    this._streamFn = fn
  }

  /** Set a log callback for forwarding gateway events to the UI Logs tab */
  setLogCallback(fn: (line: string) => void): void {
    this._onLog = fn
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
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      maxSessionMessages: 30,
    }
    const configPath = join(this.workspaceDir, 'config.json')
    if (existsSync(configPath)) {
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
    console.log('[AgentGateway] Starting...')
    this.running = true

    // Load skills from filesystem, bundled, and config.json
    this.skills = loadSkills(join(this.workspaceDir, 'skills'))
    const workspaceSkillNames = new Set(this.skills.map((s) => s.name))
    const bundled = loadBundledSkills(workspaceSkillNames)
    this.skills = [...this.skills, ...bundled]
    this.configSkills = this.loadConfigSkills()
    console.log(`[AgentGateway] Loaded ${this.skills.length} skills (${workspaceSkillNames.size} workspace + ${bundled.length} bundled), ${this.configSkills.length} config skills`)

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

    // Start heartbeat
    if (this.config.heartbeatEnabled && this.config.heartbeatInterval > 0) {
      this.startHeartbeat()
    }

    // Start cron manager
    this.cronManager.start()
    const cronJobs = this.cronManager.listJobs()
    if (cronJobs.length > 0) {
      console.log(`[AgentGateway] Loaded ${cronJobs.length} cron jobs`)
    }

    // Start configured MCP servers
    if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
      try {
        await this.mcpClientManager.startAll(this.config.mcpServers)
      } catch (error: any) {
        console.error('[AgentGateway] MCP server startup error:', error.message)
      }
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

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    this.cronManager.stop()
    this.sessionManager.destroy()
    this.sessionPersistence?.close()
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

  private startHeartbeat(): void {
    const intervalMs = this.config.heartbeatInterval * 1000
    console.log(
      `[AgentGateway] Heartbeat enabled: every ${this.config.heartbeatInterval}s`
    )

    this.nextHeartbeatTick = new Date(Date.now() + intervalMs)

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.heartbeatTick()
      } catch (error: any) {
        console.error('[AgentGateway] Heartbeat error:', error.message)
      }
    }, intervalMs)
  }

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
    const intervalMs = this.config.heartbeatInterval * 1000
    this.nextHeartbeatTick = new Date(Date.now() + intervalMs)

    const heartbeatPath = join(this.workspaceDir, 'HEARTBEAT.md')
    if (!existsSync(heartbeatPath)) {
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

        if (matchedSkill) {
          prompt = `[Skill: ${matchedSkill.name}]\n${matchedSkill.content}\n\n[User Message]\n${message.text}`
        }

        const adapter = (message.channelId && this.channels.has(message.channelType || ''))
          ? this.channels.get(message.channelType!)
          : undefined
        const streamTarget = adapter && message.channelId && this.config.streamChunk
          ? { adapter, channelId: message.channelId }
          : undefined

        const response = await this.agentTurn(prompt, sessionId, false, streamTarget)

        // Store user + assistant messages in session
        this.sessionManager.addMessages(
          sessionId,
          userMessage(prompt),
          {
            role: 'assistant',
            content: [{ type: 'text', text: response }],
            api: 'anthropic-messages',
            provider: this.config.model.provider,
            model: this.config.model.name,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          } as any
        )

        if (this.sessionManager.needsCompaction(session)) {
          await this.hookEmitter.emit(
            HookEmitter.createEvent('compaction', 'before', sessionId, {
              messageCount: session.messages.length,
              workspaceDir: this.workspaceDir,
            })
          )
          const compactResult = await this.sessionManager.compact(sessionId)
          if (compactResult) {
            console.log(
              `[AgentGateway] Session ${sessionId} compacted: ${compactResult.messagesBefore} -> ${compactResult.messagesAfter} messages`
            )
            await this.hookEmitter.emit(
              HookEmitter.createEvent('compaction', 'after', sessionId, {
                messagesBefore: compactResult.messagesBefore,
                messagesAfter: compactResult.messagesAfter,
                summary: compactResult.summary.substring(0, 200),
                workspaceDir: this.workspaceDir,
              })
            )
          }
        }

        if (adapter && message.channelId && !streamTarget) {
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
    const agentsPath = join(this.workspaceDir, 'AGENTS.md')
    if (!existsSync(agentsPath)) return true
    const content = readFileSync(agentsPath, 'utf-8')
    return content.includes('Respond concisely and helpfully') && content.includes('# Agent Instructions')
  }

  async processChatMessage(text: string): Promise<string> {
    this.emitLog(`Chat message received: "${text.substring(0, 100)}"`)

    if (this.isUnconfigured()) {
      this.emitLog('Agent is not configured — returning setup guidance')
      return 'This agent has not been configured yet. Describe what you want your agent to do and it will set up the identity, skills, and heartbeat for you.'
    }

    const matchedSkill = matchSkill(this.skills, text)
    let prompt: string

    if (matchedSkill) {
      this.emitLog(`Matched skill: ${matchedSkill.name}`)
      prompt = `[Skill: ${matchedSkill.name}]\n${matchedSkill.content}\n\n[User Message]\n${text}`
    } else {
      prompt = `[Chat — User Message]\nThis is a direct message from a user, NOT a heartbeat trigger. Respond conversationally and helpfully. Do NOT respond with HEARTBEAT_OK.\n\n${text}`
    }

    const response = await this.agentTurn(prompt, 'chat')
    this.emitLog(`Chat response: "${response.substring(0, 100)}"`)

    this.sessionManager.addMessages(
      'chat',
      userMessage(prompt),
      {
        role: 'assistant',
        content: [{ type: 'text', text: response }],
        api: 'anthropic-messages',
        provider: this.config.model.provider,
        model: this.config.model.name,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      } as any
    )

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
    options?: { modelOverride?: string },
  ): Promise<void> {
    if (options?.modelOverride) {
      const session = this.sessionManager.getOrCreate('chat')
      session.modelOverride = options.modelOverride
    }
    this.emitLog(`Chat message received (stream): "${text.substring(0, 100)}"`)

    if (this.isUnconfigured()) {
      this.emitLog('Agent is not configured — returning setup guidance')
      const msg = 'This agent has not been configured yet. Describe what you want your agent to do and it will set up the identity, skills, and heartbeat for you.'
      const tid = `text-${Date.now()}`
      writer.write({ type: 'text-start', id: tid })
      writer.write({ type: 'text-delta', id: tid, delta: msg })
      writer.write({ type: 'text-end', id: tid })
      return
    }

    const matchedSkill = matchSkill(this.skills, text)
    let prompt: string

    if (matchedSkill) {
      this.emitLog(`Matched skill: ${matchedSkill.name}`)
      prompt = `[Skill: ${matchedSkill.name}]\n${matchedSkill.content}\n\n[User Message]\n${text}`
    } else {
      prompt = `[Chat — User Message]\nThis is a direct message from a user, NOT a heartbeat trigger. Respond conversationally and helpfully. Do NOT respond with HEARTBEAT_OK.\n\n${text}`
    }

    const response = await this.agentTurn(prompt, 'chat', false, undefined, writer)
    this.emitLog(`Chat response (stream): "${response.substring(0, 100)}"`)

    this.sessionManager.addMessages(
      'chat',
      userMessage(prompt),
      {
        role: 'assistant',
        content: [{ type: 'text', text: response }],
        api: 'anthropic-messages',
        provider: this.config.model.provider,
        model: this.config.model.name,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      } as any
    )

    this.appendDailyMemory(`chat: "${text.substring(0, 100)}" -> "${response.substring(0, 100)}"`)
  }

  async processWebhookMessage(text: string): Promise<string> {
    return this.agentTurn(text, 'webhook')
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
  ): Promise<string> {
    const systemPrompt = this.loadBootstrapContext()
    const session = this.sessionManager.getOrCreate(sessionId)
    const modelId = session.modelOverride || this.config.model.name
    const provider = this.config.model.provider

    const toolContext: ToolContext = {
      workspaceDir: this.workspaceDir,
      channels: this.channels,
      config: this.config,
      projectId: this.projectId,
      cronManager: this.cronManager,
      sessionId,
      sandbox: this.config.sandbox,
      mainSessionIds: this.config.mainSessionIds,
    }

    const baseTools = isHeartbeat
      ? createHeartbeatTools(toolContext)
      : createAllTools(toolContext)

    const mcpTools = this.mcpClientManager.getTools()
    const tools = mcpTools.length > 0 ? [...baseTools, ...mcpTools] : baseTools

    const history = this.sessionManager.buildHistory(sessionId)

    // Typing indicator: send once before the turn and periodically
    let typingInterval: ReturnType<typeof setInterval> | undefined
    if (streamTarget?.adapter.sendTyping) {
      streamTarget.adapter.sendTyping(streamTarget.channelId).catch(() => {})
      typingInterval = setInterval(() => {
        streamTarget.adapter.sendTyping?.(streamTarget.channelId).catch(() => {})
      }, 4000)
    }

    // Streaming: set up block chunker if a channel target is provided
    let chunker: BlockChunker | undefined
    const streamedChunks: string[] = []
    if (streamTarget) {
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

    // UI stream writer: track current text block for delta streaming
    let uiTextId: string | null = null

    try {
      const hookEmitter = this.hookEmitter
      const result = await runAgentLoop({
        provider,
        model: modelId,
        system: systemPrompt,
        history,
        prompt,
        tools,
        maxIterations: isHeartbeat ? 5 : 6,
        loopDetection: this.config.loopDetection,
        streamFn: this._streamFn,
        onToolCall: (name, input) => {
          console.log(`[AgentGateway] Tool call: ${name}`, JSON.stringify(input).substring(0, 200))
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
        onBeforeToolCall: async (toolName, args, toolCallId) => {
          // Close any open text block before a tool call
          if (uiWriter && uiTextId) {
            uiWriter.write({ type: 'text-end', id: uiTextId })
            uiTextId = null
          }
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-start', toolCallId, toolName, dynamic: true })
            uiWriter.write({ type: 'tool-input-delta', toolCallId, inputTextDelta: JSON.stringify(args) })
            uiWriter.write({ type: 'tool-input-available', toolCallId, toolName, input: args, dynamic: true })
          }
          await hookEmitter.emit(
            HookEmitter.createEvent('tool', 'before', sessionId, {
              toolName, args, toolCallId, workspaceDir: this.workspaceDir,
            })
          )
        },
        onAfterToolCall: async (toolName, args, result, isError, toolCallId) => {
          if (uiWriter) {
            uiWriter.write({
              type: 'tool-output-available',
              toolCallId,
              output: isError ? { error: typeof result === 'string' ? result : JSON.stringify(result) } : (result ?? { success: true }),
            })
          }
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

      // Flush any remaining buffered text
      chunker?.flush()
      chunker?.dispose()

      // Close any open UI text block
      if (uiWriter && uiTextId) {
        uiWriter.write({ type: 'text-end', id: uiTextId })
        uiTextId = null
      }

      // Emit usage metrics so SSE consumers (eval runner, frontend) can track costs
      if (uiWriter) {
        uiWriter.write({
          type: 'data-step-usage' as any,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheWriteTokens: result.cacheWriteTokens,
          iterations: result.iterations,
          toolCallCount: result.toolCalls.length,
        })
      }

      if (result.loopBreak) {
        console.warn(
          `[AgentGateway] Loop detected in session ${sessionId}: ${result.loopBreak.pattern}`
        )
      }

      const totalInput = result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens
      if (result.toolCalls.length > 0) {
        console.log(
          `[AgentGateway] Agent turn: ${result.iterations} iterations, ${result.toolCalls.length} tool calls, ${totalInput}+${result.outputTokens} tokens (${result.cacheReadTokens} cached)`
        )
      }

      this.sessionManager.touch(sessionId)

      return result.text || 'HEARTBEAT_OK'
    } catch (error: any) {
      console.error('[AgentGateway] Agent turn failed:', error.message)
      chunker?.dispose()
      return 'HEARTBEAT_OK'
    } finally {
      if (typingInterval) clearInterval(typingInterval)
    }
  }

  private loadBootstrapContext(): string {
    const files = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md']
    const parts: string[] = []

    for (const filename of files) {
      const filepath = join(this.workspaceDir, filename)
      if (existsSync(filepath)) {
        const content = readFileSync(filepath, 'utf-8').trim()
        if (content) {
          parts.push(content)
        }
      }
    }

    const memoryPath = join(this.workspaceDir, 'MEMORY.md')
    if (existsSync(memoryPath)) {
      const memory = readFileSync(memoryPath, 'utf-8').trim()
      if (memory) {
        parts.push(`## Memory\n${memory}`)
      }
    }

    const canvasExamples = this.promptOverrides.get('canvas_examples') ?? OPTIMIZED_CANVAS_EXAMPLES
    const personalityGuide = this.promptOverrides.get('personality_guide') ?? OPTIMIZED_PERSONALITY_GUIDE
    const toolPlanningGuide = this.promptOverrides.get('tool_planning_guide') ?? OPTIMIZED_TOOL_PLANNING_GUIDE
    const memoryGuide = this.promptOverrides.get('memory_guide') ?? OPTIMIZED_MEMORY_GUIDE
    const skillMatchingGuide = this.promptOverrides.get('skill_matching_guide') ?? OPTIMIZED_SKILL_MATCHING_GUIDE

    parts.push(CANVAS_TOOLS_GUIDE_PREFIX + canvasExamples)
    parts.push(PERSONALITY_EVOLUTION_GUIDE_PREFIX + personalityGuide)
    parts.push(toolPlanningGuide)
    parts.push(memoryGuide)
    parts.push(skillMatchingGuide)

    return parts.join('\n\n---\n\n')
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
      default:
        throw new Error(`Unknown channel type: ${type}`)
    }

    adapter.onMessage((msg) => this.processMessage(msg))
    await adapter.connect(config)
    this.channels.set(type, adapter)
    console.log(`[AgentGateway] Connected channel: ${type}`)
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
      channelStatuses.push(adapter.getStatus())
    }

    // Merge skills from filesystem with skills declared in config.json
    const fsSkills = this.skills.map((s) => ({
      name: s.name,
      trigger: s.trigger,
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
        nextTick: this.nextHeartbeatTick?.toISOString() ?? null,
        quietHours: this.config.quietHours,
      },
      channels: channelStatuses,
      skills: [...fsSkills, ...configSkills],
      model: this.config.model,
      sessions: this.sessionManager.getAllStats(),
      cronJobs: this.cronManager.listJobs().map((j) => ({
        name: j.name,
        intervalSeconds: j.intervalSeconds,
        enabled: j.enabled,
        lastRunAt: j.lastRunAt ?? null,
      })),
    }
  }

  reloadConfig(): void {
    const prevEnabled = this.config.heartbeatEnabled
    this.config = this.loadConfig()
    const wsSkills = loadSkills(join(this.workspaceDir, 'skills'))
    const wsNames = new Set(wsSkills.map((s) => s.name))
    this.skills = [...wsSkills, ...loadBundledSkills(wsNames)]
    this.configSkills = this.loadConfigSkills()

    // Auto-start heartbeat if it was just enabled via config change
    if (this.config.heartbeatEnabled && !prevEnabled && this.config.heartbeatInterval > 0) {
      this.startHeartbeat()
    }
  }

  private loadConfigSkills(): Array<{ name: string; trigger?: string; description?: string }> {
    const configPath = join(this.workspaceDir, 'config.json')
    if (!existsSync(configPath)) return []
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

  getCronManager(): CronManager {
    return this.cronManager
  }

  getSessionManager(): SessionManager {
    return this.sessionManager
  }

  getMCPClientManager(): MCPClientManager {
    return this.mcpClientManager
  }
}
