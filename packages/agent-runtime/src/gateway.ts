/**
 * Agent Gateway
 *
 * The core runtime loop that makes an agent "alive." Follows the OpenClaw pattern:
 *   inputs -> queue -> agent turn -> actions -> persisted state -> repeat
 *
 * Manages:
 * - Heartbeat timer (periodic agent turns reading HEARTBEAT.md)
 * - Channel adapters (Telegram, Discord, etc.)
 * - Session management (per-channel message queuing with multi-turn history)
 * - Skill loading and trigger matching
 * - Memory persistence
 * - Hook event system
 * - Slash command handling
 * - BOOT.md startup execution
 * - Webhook event queue
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { ChannelAdapter, IncomingMessage, AgentStatus, ChannelStatus } from './types'
import { loadSkills, matchSkill, type Skill } from './skills'
import { runAgentLoop, type AnthropicMessage, type ToolContext, type LoopDetectorConfig } from './agent-loop'
import { getAllTools, getHeartbeatTools } from './gateway-tools'
import { HookEmitter, loadAllHooks } from './hooks'
import { parseSlashCommand, type SlashCommandContext } from './slash-commands'
import {
  ModelFailoverProvider,
  createFailoverProvider,
  FailoverExhaustedError,
  type ModelProfile,
  type ModelFallback,
} from './model-failover'
import { SessionManager, type SessionManagerConfig } from './session-manager'
import { CronManager, type CronJob } from './cron-manager'

export interface GatewayConfig {
  heartbeatInterval: number
  heartbeatEnabled: boolean
  quietHours: { start: string; end: string; timezone: string }
  channels: Array<{ type: string; config: Record<string, string> }>
  model: { provider: string; name: string }
  maxSessionMessages?: number
  /** Model failover configuration */
  modelProfiles?: ModelProfile[]
  modelFallbacks?: ModelFallback[]
  /** Session management configuration */
  session?: Partial<SessionManagerConfig>
  /** Loop detection configuration (false to disable) */
  loopDetection?: Partial<LoopDetectorConfig> | false
}

export class AgentGateway {
  private workspaceDir: string
  private projectId: string
  private config: GatewayConfig
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private channels: Map<string, ChannelAdapter> = new Map()
  private skills: Skill[] = []
  private running = false
  private lastHeartbeatTick: Date | null = null
  private nextHeartbeatTick: Date | null = null
  private hookEmitter: HookEmitter = new HookEmitter()
  /** Pending events from webhooks to be included in the next heartbeat */
  private pendingEvents: string[] = []
  private failoverProvider: ModelFailoverProvider | null = null
  private sessionManager: SessionManager
  private cronManager: CronManager

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

    // Initialize model failover
    this.initFailoverProvider()

    // Load skills
    this.skills = loadSkills(join(this.workspaceDir, 'skills'))
    console.log(`[AgentGateway] Loaded ${this.skills.length} skills`)

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
    const hours = now.getHours()
    const minutes = now.getMinutes()
    const currentTime = hours * 60 + minutes

    const [startH, startM] = this.config.quietHours.start.split(':').map(Number)
    const [endH, endM] = this.config.quietHours.end.split(':').map(Number)
    const startTime = startH * 60 + startM
    const endTime = endH * 60 + endM

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
      return 'HEARTBEAT_OK'
    }

    console.log('[AgentGateway] Running heartbeat...')

    // Include any pending webhook events
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
      await this.deliverAlert(response)

      await this.hookEmitter.emit(
        HookEmitter.createEvent('heartbeat', 'alert', 'heartbeat', {
          workspaceDir: this.workspaceDir,
          alertText: response,
        })
      )
    } else {
      console.log('[AgentGateway] Heartbeat OK')
    }

    this.appendDailyMemory(`Heartbeat: ${response === 'HEARTBEAT_OK' ? 'All clear' : response.substring(0, 200)}`)

    return response
  }

  async triggerHeartbeat(): Promise<string> {
    return this.heartbeatTick()
  }

  /** Queue an event for the next heartbeat tick */
  queuePendingEvent(text: string): void {
    this.pendingEvents.push(text)
  }

  // ---------------------------------------------------------------------------
  // Message Processing
  // ---------------------------------------------------------------------------

  async processMessage(input: IncomingMessage): Promise<void> {
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

  /** Queue state is tracked separately from message history (SessionManager) */
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
        // Check for slash commands first
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

        // Check for skill match
        const matchedSkill = matchSkill(this.skills, message.text)
        let prompt = message.text

        if (matchedSkill) {
          prompt = `[Skill: ${matchedSkill.name}]\n${matchedSkill.content}\n\n[User Message]\n${message.text}`
        }

        const response = await this.agentTurn(prompt, sessionId)

        // Store in session history via session manager
        this.sessionManager.addMessages(
          sessionId,
          { role: 'user', content: prompt },
          { role: 'assistant', content: response }
        )

        // Auto-compact if needed
        if (this.sessionManager.needsCompaction(session)) {
          const result = await this.sessionManager.compact(sessionId)
          if (result) {
            console.log(
              `[AgentGateway] Session ${sessionId} compacted: ${result.messagesBefore} → ${result.messagesAfter} messages`
            )
          }
        }

        // Send response back through the channel
        if (message.channelId && this.channels.has(message.channelType || '')) {
          const adapter = this.channels.get(message.channelType!)
          await adapter?.sendMessage(message.channelId, response)
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

  /** Process a test message (from the builder preview panel) */
  async processTestMessage(text: string): Promise<string> {
    const matchedSkill = matchSkill(this.skills, text)
    let prompt = text

    if (matchedSkill) {
      prompt = `[Skill: ${matchedSkill.name}]\n${matchedSkill.content}\n\n[User Message]\n${text}`
    }

    const response = await this.agentTurn(prompt, 'test')

    this.sessionManager.addMessages(
      'test',
      { role: 'user', content: prompt },
      { role: 'assistant', content: response }
    )

    this.appendDailyMemory(`test: "${text.substring(0, 100)}" -> "${response.substring(0, 100)}"`)

    return response
  }

  /** Run an isolated agent turn for a webhook trigger */
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
  // Agent Turn (Agentic Tool-Call Loop)
  // ---------------------------------------------------------------------------

  private async agentTurn(
    prompt: string,
    sessionId: string = 'default',
    isHeartbeat: boolean = false
  ): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      console.error('[AgentGateway] No ANTHROPIC_API_KEY set for agent turns')
      return 'HEARTBEAT_OK'
    }

    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
    const systemPrompt = this.loadBootstrapContext()
    const session = this.sessionManager.getOrCreate(sessionId)
    const model = session.modelOverride || this.config.model.name
    const tools = isHeartbeat ? getHeartbeatTools() : getAllTools()

    // Build message history using session manager (includes compacted summary)
    const messages = this.sessionManager.buildMessages(
      sessionId,
      { role: 'user', content: prompt }
    )

    const toolContext: ToolContext = {
      workspaceDir: this.workspaceDir,
      channels: this.channels,
      config: this.config,
      projectId: this.projectId,
      cronManager: this.cronManager,
    }

    try {
      const result = await runAgentLoop({
        apiKey,
        baseUrl,
        model,
        system: systemPrompt,
        messages,
        tools,
        toolContext,
        maxIterations: isHeartbeat ? 5 : 10,
        loopDetection: this.config.loopDetection,
        onToolCall: (name, input) => {
          console.log(`[AgentGateway] Tool call: ${name}`, JSON.stringify(input).substring(0, 200))
        },
      })

      if (result.loopBreak) {
        console.warn(
          `[AgentGateway] Loop detected in session ${sessionId}: ${result.loopBreak.pattern}`
        )
      }

      if (result.toolCalls.length > 0) {
        console.log(
          `[AgentGateway] Agent turn: ${result.iterations} iterations, ${result.toolCalls.length} tool calls, ${result.inputTokens}+${result.outputTokens} tokens`
        )
      }

      this.sessionManager.touch(sessionId)

      return result.text || 'HEARTBEAT_OK'
    } catch (error: any) {
      if (error instanceof FailoverExhaustedError) {
        console.error(
          `[AgentGateway] All models exhausted: ${error.failovers.join(', ')}`
        )
      } else {
        console.error('[AgentGateway] Agent turn failed:', error.message)
      }
      return 'HEARTBEAT_OK'
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
    const channelStatuses: ChannelStatus[] = []
    for (const [type, adapter] of this.channels) {
      channelStatuses.push(adapter.getStatus())
    }

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
      skills: this.skills.map((s) => ({
        name: s.name,
        trigger: s.trigger,
        description: s.description,
      })),
      model: this.config.model,
    }
  }

  /** Reload configuration from disk */
  reloadConfig(): void {
    this.config = this.loadConfig()
    this.skills = loadSkills(join(this.workspaceDir, 'skills'))
  }

  /** Get the hook emitter (for server.ts to emit events) */
  getHookEmitter(): HookEmitter {
    return this.hookEmitter
  }
}
