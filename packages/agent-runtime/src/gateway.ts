/**
 * Agent Gateway
 *
 * The core runtime loop that makes an agent "alive." Follows the OpenClaw pattern:
 *   inputs -> queue -> agent turn -> actions -> persisted state -> repeat
 *
 * Manages:
 * - Heartbeat timer (periodic agent turns reading HEARTBEAT.md)
 * - Channel adapters (Telegram, Discord, etc.)
 * - Session management (per-channel message queuing)
 * - Skill loading and trigger matching
 * - Memory persistence
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { ChannelAdapter, IncomingMessage, AgentStatus, ChannelStatus } from './types'
import { loadSkills, matchSkill, type Skill } from './skills'

export interface GatewayConfig {
  heartbeatInterval: number
  heartbeatEnabled: boolean
  quietHours: { start: string; end: string; timezone: string }
  channels: Array<{ type: string; config: Record<string, string> }>
  model: { provider: string; name: string }
}

interface SessionState {
  channelId: string
  queue: IncomingMessage[]
  processing: boolean
  history: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>
}

export class AgentGateway {
  private workspaceDir: string
  private projectId: string
  private config: GatewayConfig
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private channels: Map<string, ChannelAdapter> = new Map()
  private sessions: Map<string, SessionState> = new Map()
  private skills: Skill[] = []
  private running = false
  private lastHeartbeatTick: Date | null = null
  private nextHeartbeatTick: Date | null = null

  constructor(workspaceDir: string, projectId: string) {
    this.workspaceDir = workspaceDir
    this.projectId = projectId
    this.config = this.loadConfig()
  }

  private loadConfig(): GatewayConfig {
    const defaults: GatewayConfig = {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
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

    // Load skills
    this.skills = loadSkills(join(this.workspaceDir, 'skills'))
    console.log(`[AgentGateway] Loaded ${this.skills.length} skills`)

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

    console.log('[AgentGateway] Started successfully')
  }

  async stop(): Promise<void> {
    console.log('[AgentGateway] Stopping...')
    this.running = false

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    for (const [name, adapter] of this.channels) {
      try {
        await adapter.disconnect()
        console.log(`[AgentGateway] Disconnected ${name}`)
      } catch (error: any) {
        console.error(`[AgentGateway] Error disconnecting ${name}:`, error.message)
      }
    }
    this.channels.clear()

    console.log('[AgentGateway] Stopped')
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
    // Crosses midnight
    return currentTime >= startTime || currentTime < endTime
  }

  async heartbeatTick(): Promise<string> {
    this.lastHeartbeatTick = new Date()
    const intervalMs = this.config.heartbeatInterval * 1000
    this.nextHeartbeatTick = new Date(Date.now() + intervalMs)

    // Read HEARTBEAT.md
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

    // Run agent turn with the heartbeat checklist
    const response = await this.agentTurn(
      `[HEARTBEAT]\nYou are performing a scheduled heartbeat check. Review the following checklist and take action as needed. If everything is fine, respond with exactly "HEARTBEAT_OK". If something needs attention, describe the issue and any actions taken.\n\n${checklist}`
    )

    if (response !== 'HEARTBEAT_OK') {
      console.log('[AgentGateway] Heartbeat alert:', response.substring(0, 200))
      await this.deliverAlert(response)
    } else {
      console.log('[AgentGateway] Heartbeat OK')
    }

    // Log to daily memory
    this.appendDailyMemory(`Heartbeat: ${response === 'HEARTBEAT_OK' ? 'All clear' : response.substring(0, 200)}`)

    return response
  }

  async triggerHeartbeat(): Promise<string> {
    return this.heartbeatTick()
  }

  // ---------------------------------------------------------------------------
  // Message Processing
  // ---------------------------------------------------------------------------

  async processMessage(input: IncomingMessage): Promise<void> {
    const sessionId = input.channelId || 'default'
    let session = this.sessions.get(sessionId)

    if (!session) {
      session = {
        channelId: sessionId,
        queue: [],
        processing: false,
        history: [],
      }
      this.sessions.set(sessionId, session)
    }

    session.queue.push(input)

    if (!session.processing) {
      await this.processQueue(session)
    }
  }

  private async processQueue(session: SessionState): Promise<void> {
    session.processing = true

    while (session.queue.length > 0) {
      const message = session.queue.shift()!

      try {
        // Check for skill match
        const matchedSkill = matchSkill(this.skills, message.text)
        let prompt = message.text

        if (matchedSkill) {
          prompt = `[Skill: ${matchedSkill.name}]\n${matchedSkill.content}\n\n[User Message]\n${message.text}`
        }

        const response = await this.agentTurn(prompt)

        session.history.push(
          { role: 'user', content: message.text, timestamp: Date.now() },
          { role: 'assistant', content: response, timestamp: Date.now() }
        )

        // Send response back through the channel
        if (message.channelId && this.channels.has(message.channelType || '')) {
          const adapter = this.channels.get(message.channelType!)
          await adapter?.sendMessage(message.channelId, response)
        }

        // Append to daily memory
        this.appendDailyMemory(
          `${message.channelType || 'test'}: "${message.text.substring(0, 100)}" -> "${response.substring(0, 100)}"`
        )
      } catch (error: any) {
        console.error('[AgentGateway] Message processing error:', error.message)
      }
    }

    session.processing = false
  }

  /** Process a test message (from the builder preview panel) */
  async processTestMessage(text: string): Promise<string> {
    const matchedSkill = matchSkill(this.skills, text)
    let prompt = text

    if (matchedSkill) {
      prompt = `[Skill: ${matchedSkill.name}]\n${matchedSkill.content}\n\n[User Message]\n${text}`
    }

    return this.agentTurn(prompt)
  }

  // ---------------------------------------------------------------------------
  // Agent Turn (LLM call)
  // ---------------------------------------------------------------------------

  private async agentTurn(prompt: string): Promise<string> {
    const context = this.loadBootstrapContext()
    const fullPrompt = `${context}\n\n${prompt}`

    // Use ANTHROPIC_BASE_URL if set (AI proxy), otherwise direct Anthropic API
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      console.error('[AgentGateway] No ANTHROPIC_API_KEY set for agent turns')
      return 'HEARTBEAT_OK'
    }

    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
    const messagesUrl = `${baseUrl}/v1/messages`

    try {
      const response = await fetch(messagesUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.model.name,
          max_tokens: 4096,
          system: this.loadBootstrapContext(),
          messages: [{ role: 'user', content: prompt }],
        }),
      })

      if (!response.ok) {
        const error = await response.text()
        console.error('[AgentGateway] API error:', error)
        return 'HEARTBEAT_OK'
      }

      const data = (await response.json()) as {
        content: Array<{ type: string; text?: string }>
      }
      const text = data.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')

      return text || 'HEARTBEAT_OK'
    } catch (error: any) {
      console.error('[AgentGateway] Agent turn failed:', error.message)
      return 'HEARTBEAT_OK'
    }
  }

  private loadBootstrapContext(): string {
    const files = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md']
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

    // Load recent memory
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
    // Dynamic import of channel adapters
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
}
