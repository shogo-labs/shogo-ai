/**
 * Session Manager — TTL-Aware Pruning, Compaction, and Persistence
 *
 * Manages conversation session lifecycle with:
 * 1. TTL-based expiry for inactive sessions
 * 2. Token-aware compaction (estimates context size, compacts when threshold hit)
 * 3. LLM-powered summarization of old messages
 * 4. Configurable retention policies
 * 5. Optional disk persistence (survives pod restarts)
 * 6. Tool result pruning (soft trim + hard clear) for cost control
 *
 * Uses Pi AI's Message types for full multi-provider compatibility.
 */

import type { Message, UserMessage, AssistantMessage, ToolResultMessage, TextContent } from '@mariozechner/pi-ai'

// ---------------------------------------------------------------------------
// Session Persistence Interface
// ---------------------------------------------------------------------------

export interface SessionPersistence {
  save(id: string, session: SerializedSession): Promise<void>
  load(id: string): Promise<SerializedSession | null>
  delete(id: string): Promise<void>
  loadAll(): Promise<SerializedSession[]>
}

export interface SerializedSession {
  id: string
  messages: Message[]
  compactedSummary: string | null
  createdAt: number
  lastActivityAt: number
  totalMessages: number
  compactionCount: number
  modelOverride?: string
  metadata: Record<string, any>
}

// ---------------------------------------------------------------------------
// Tool Result Pruning Config
// ---------------------------------------------------------------------------

export interface PruningConfig {
  /** Number of recent assistant turns whose tool results are protected (default: 3) */
  keepLastTurns: number
  /** Max characters for a single tool result before soft trimming (default: 4000) */
  softTrimMaxChars: number
  /** Turns older than this get tool results replaced with a placeholder (default: 8) */
  hardClearAfterTurns: number
}

const DEFAULT_PRUNING: PruningConfig = {
  keepLastTurns: 3,
  softTrimMaxChars: 4000,
  hardClearAfterTurns: 8,
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionManagerConfig {
  /** Max session idle time before expiry in seconds (default: 3600 = 1 hour) */
  sessionTtlSeconds: number
  /** Max messages before triggering compaction (default: 30) */
  maxMessages: number
  /** Estimated tokens per message for cost tracking (default: 150) */
  estimatedTokensPerMessage: number
  /** Max estimated tokens before forcing compaction (default: 30000) */
  maxEstimatedTokens: number
  /** Number of recent messages to keep uncompacted (default: 10) */
  keepRecentMessages: number
  /** Interval in seconds between pruning sweeps (default: 300 = 5 min) */
  pruneIntervalSeconds: number
  /** Tool result pruning config (false to disable) */
  pruning?: Partial<PruningConfig> | false
}

export interface ManagedSession {
  id: string
  messages: Message[]
  /** Compacted summary of older messages (prepended to context) */
  compactedSummary: string | null
  createdAt: number
  lastActivityAt: number
  /** Total messages processed (including compacted ones) */
  totalMessages: number
  /** Number of compactions performed */
  compactionCount: number
  modelOverride?: string
  stopRequested: boolean
  metadata: Record<string, any>
}

export interface SessionStats {
  id: string
  messageCount: number
  estimatedTokens: number
  compactedSummary: boolean
  compactionCount: number
  totalMessages: number
  idleSeconds: number
  createdAt: string
}

export interface CompactionResult {
  sessionId: string
  messagesBefore: number
  messagesAfter: number
  compactedCount: number
  summary: string
}

/** Function signature for the summarization backend */
export type SummarizeFn = (messages: Message[]) => Promise<string>

const DEFAULT_CONFIG: SessionManagerConfig = {
  sessionTtlSeconds: 3600,
  maxMessages: 30,
  estimatedTokensPerMessage: 150,
  maxEstimatedTokens: 30_000,
  keepRecentMessages: 10,
  pruneIntervalSeconds: 300,
}

export class SessionManager {
  private sessions: Map<string, ManagedSession> = new Map()
  private config: SessionManagerConfig
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private summarizeFn: SummarizeFn | null = null
  private persistence: SessionPersistence | null = null

  constructor(config: Partial<SessionManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Set the summarization function (called during compaction) */
  setSummarizeFn(fn: SummarizeFn): void {
    this.summarizeFn = fn
  }

  /** Set the persistence backend for durable sessions */
  setPersistence(persistence: SessionPersistence): void {
    this.persistence = persistence
  }

  /** Load all persisted sessions from disk into memory */
  async restoreSessions(): Promise<number> {
    if (!this.persistence) return 0

    const serialized = await this.persistence.loadAll()
    let restored = 0
    for (const data of serialized) {
      if (!this.sessions.has(data.id)) {
        this.sessions.set(data.id, {
          ...data,
          stopRequested: false,
          metadata: data.metadata || {},
        })
        restored++
      }
    }
    if (restored > 0) {
      console.log(`[SessionManager] Restored ${restored} sessions from disk`)
    }
    return restored
  }

  /** Start periodic pruning of expired sessions */
  startPruning(): void {
    if (this.pruneTimer) return
    this.pruneTimer = setInterval(
      () => this.pruneExpired(),
      this.config.pruneIntervalSeconds * 1000
    )
  }

  /** Stop periodic pruning */
  stopPruning(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
  }

  /** Get or create a session */
  getOrCreate(id: string): ManagedSession {
    let session = this.sessions.get(id)
    if (!session) {
      session = {
        id,
        messages: [],
        compactedSummary: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        totalMessages: 0,
        compactionCount: 0,
        stopRequested: false,
        metadata: {},
      }
      this.sessions.set(id, session)
    }
    return session
  }

  /** Async version that checks disk persistence before creating a new session */
  async getOrCreateAsync(id: string): Promise<ManagedSession> {
    let session = this.sessions.get(id)
    if (session) return session

    if (this.persistence) {
      const data = await this.persistence.load(id)
      if (data) {
        session = { ...data, stopRequested: false, metadata: data.metadata || {} }
        this.sessions.set(id, session)
        return session
      }
    }

    return this.getOrCreate(id)
  }

  /** Get a session (returns undefined if not found) */
  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id)
  }

  /** Touch a session to update its last activity timestamp */
  touch(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      session.lastActivityAt = Date.now()
    }
  }

  /** Add messages to a session and check if compaction is needed */
  addMessages(id: string, ...msgs: Message[]): boolean {
    const session = this.getOrCreate(id)
    session.messages.push(...msgs)
    session.lastActivityAt = Date.now()
    session.totalMessages += msgs.length
    this.persistSession(session)
    return this.needsCompaction(session)
  }

  /** Clear a session's history (keeps the session alive) */
  clearHistory(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      session.messages = []
      session.compactedSummary = null
      session.lastActivityAt = Date.now()
    }
  }

  /** Delete a session entirely */
  delete(id: string): boolean {
    return this.sessions.delete(id)
  }

  /** Check if a session needs compaction */
  needsCompaction(session: ManagedSession): boolean {
    if (session.messages.length > this.config.maxMessages) return true
    const estimatedTokens = this.estimateTokens(session)
    return estimatedTokens > this.config.maxEstimatedTokens
  }

  /** Estimate the token count for a session's context */
  estimateTokens(session: ManagedSession): number {
    let tokens = 0
    if (session.compactedSummary) {
      tokens += Math.ceil(session.compactedSummary.length / 4)
    }
    tokens += session.messages.length * this.config.estimatedTokensPerMessage
    return tokens
  }

  /**
   * Compact a session by summarizing old messages and keeping only recent ones.
   * If no summarizeFn is set, uses a simple text extraction fallback.
   */
  async compact(id: string): Promise<CompactionResult | null> {
    const session = this.sessions.get(id)
    if (!session) return null

    const { keepRecentMessages } = this.config
    if (session.messages.length <= keepRecentMessages) return null

    const toCompact = session.messages.slice(0, -keepRecentMessages)
    const toKeep = session.messages.slice(-keepRecentMessages)

    let summary: string
    if (this.summarizeFn) {
      try {
        summary = await this.summarizeFn(toCompact)
      } catch (err: any) {
        console.error(`[SessionManager] Summarization failed for ${id}:`, err.message)
        summary = this.fallbackSummarize(toCompact)
      }
    } else {
      summary = this.fallbackSummarize(toCompact)
    }

    const existingSummary = session.compactedSummary
      ? `${session.compactedSummary}\n\n`
      : ''

    session.compactedSummary = `${existingSummary}${summary}`
    session.messages = toKeep
    session.compactionCount++
    session.lastActivityAt = Date.now()
    this.persistSession(session)

    return {
      sessionId: id,
      messagesBefore: toCompact.length + toKeep.length,
      messagesAfter: toKeep.length,
      compactedCount: toCompact.length,
      summary,
    }
  }

  /**
   * Build the full message array for an agent call, including compacted summary.
   * Returns messages WITHOUT the new prompt — the agent loop handles prompt separately.
   * Applies tool result pruning if configured.
   */
  buildHistory(id: string): Message[] {
    const session = this.sessions.get(id)
    if (!session) return []

    const msgs: Message[] = []

    if (session.compactedSummary) {
      msgs.push({
        role: 'user',
        content: `[Previous conversation summary]\n${session.compactedSummary}`,
        timestamp: Date.now(),
      } as UserMessage)
      msgs.push({
        role: 'assistant',
        content: [{ type: 'text', text: 'Understood, I have the context from our previous conversation.' }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'system',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      } as AssistantMessage)
    }

    msgs.push(...session.messages)

    if (this.config.pruning !== false) {
      return pruneToolResults(msgs, typeof this.config.pruning === 'object' ? this.config.pruning : {})
    }

    return msgs
  }

  /** Prune all sessions that have exceeded their TTL */
  pruneExpired(): string[] {
    const now = Date.now()
    const ttlMs = this.config.sessionTtlSeconds * 1000
    const pruned: string[] = []

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > ttlMs) {
        this.sessions.delete(id)
        this.persistence?.delete(id).catch((err) => {
          console.error(`[SessionManager] Failed to delete persisted session ${id}:`, err.message)
        })
        pruned.push(id)
      }
    }

    if (pruned.length > 0) {
      console.log(`[SessionManager] Pruned ${pruned.length} expired sessions: ${pruned.join(', ')}`)
    }

    return pruned
  }

  /** Get stats for all sessions */
  getAllStats(): SessionStats[] {
    const now = Date.now()
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      messageCount: s.messages.length,
      estimatedTokens: this.estimateTokens(s),
      compactedSummary: !!s.compactedSummary,
      compactionCount: s.compactionCount,
      totalMessages: s.totalMessages,
      idleSeconds: Math.floor((now - s.lastActivityAt) / 1000),
      createdAt: new Date(s.createdAt).toISOString(),
    }))
  }

  /** Get total session count */
  get sessionCount(): number {
    return this.sessions.size
  }

  /** Destroy all sessions and stop pruning */
  destroy(): void {
    this.stopPruning()
    this.sessions.clear()
  }

  private persistSession(session: ManagedSession): void {
    if (!this.persistence) return
    const { stopRequested, ...data } = session
    this.persistence.save(session.id, data).catch((err) => {
      console.error(`[SessionManager] Failed to persist session ${session.id}:`, err.message)
    })
  }

  private extractText(msg: Message): string {
    if (msg.role === 'user') {
      return typeof msg.content === 'string'
        ? msg.content
        : (msg.content as any[])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join(' ')
    }
    if (msg.role === 'assistant') {
      return msg.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join(' ')
    }
    if (msg.role === 'toolResult') {
      return msg.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join(' ')
    }
    return ''
  }

  private fallbackSummarize(messages: Message[]): string {
    const parts: string[] = []
    for (const msg of messages) {
      const text = this.extractText(msg)
      if (text) {
        const trimmed = text.length > 200 ? text.substring(0, 200) + '...' : text
        parts.push(`${msg.role}: ${trimmed}`)
      }
    }
    return `[Compacted ${messages.length} messages]\n${parts.join('\n')}`
  }
}

// ---------------------------------------------------------------------------
// Tool Result Pruning
// ---------------------------------------------------------------------------

/**
 * Prune oversized tool results from a message history to control token costs.
 *
 * Two-layer approach:
 * - Soft trim: truncate tool results exceeding softTrimMaxChars to head+tail
 * - Hard clear: replace very old tool results with a placeholder
 *
 * Recent turns (within keepLastTurns) are never pruned.
 */
export function pruneToolResults(
  messages: Message[],
  config: Partial<PruningConfig> = {},
): Message[] {
  const cfg = { ...DEFAULT_PRUNING, ...config }

  let turnCount = 0
  const turnBoundaries: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      turnCount++
      turnBoundaries.push(i)
    }
  }

  const protectedTurnStart = turnBoundaries.length >= cfg.keepLastTurns
    ? turnBoundaries[cfg.keepLastTurns - 1]
    : 0
  const hardClearStart = turnBoundaries.length >= cfg.hardClearAfterTurns
    ? turnBoundaries[cfg.hardClearAfterTurns - 1]
    : -1

  return messages.map((msg, idx) => {
    if (msg.role !== 'toolResult') return msg
    if (idx >= protectedTurnStart) return msg

    const totalChars = msg.content
      .filter((c): c is TextContent => c.type === 'text')
      .reduce((sum, c) => sum + c.text.length, 0)

    if (hardClearStart >= 0 && idx < hardClearStart) {
      return {
        ...msg,
        content: [{ type: 'text', text: `[Tool result cleared — ${totalChars} chars]` }],
      } as ToolResultMessage
    }

    if (totalChars > cfg.softTrimMaxChars) {
      return {
        ...msg,
        content: msg.content.map((c) => {
          if (c.type !== 'text') return c
          if (c.text.length <= cfg.softTrimMaxChars) return c
          const headSize = Math.floor(cfg.softTrimMaxChars * 0.7)
          const tailSize = cfg.softTrimMaxChars - headSize - 50
          return {
            type: 'text' as const,
            text: c.text.substring(0, headSize)
              + `\n\n[... ${c.text.length - headSize - tailSize} chars trimmed ...]\n\n`
              + c.text.substring(c.text.length - tailSize),
          }
        }),
      } as ToolResultMessage
    }

    return msg
  })
}
