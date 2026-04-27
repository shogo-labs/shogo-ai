// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
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
  keepLastTurns: 4,
  softTrimMaxChars: 8000,
  hardClearAfterTurns: 12,
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionManagerConfig {
  /** Max session idle time before expiry in seconds (default: 3600 = 1 hour) */
  sessionTtlSeconds: number
  /** @deprecated No longer used — compaction is purely token-based via autocompactThreshold */
  maxMessages: number
  /** Estimated tokens per message for cost tracking (default: 150) */
  estimatedTokensPerMessage: number
  /** @deprecated Use contextWindowTokens/maxOutputTokens/bufferTokens instead */
  maxEstimatedTokens: number
  /** Number of recent messages to keep uncompacted (default: 10) */
  keepRecentMessages: number
  /** Interval in seconds between pruning sweeps (default: 300 = 5 min) */
  pruneIntervalSeconds: number
  /** Tool result pruning config (false to disable) */
  pruning?: Partial<PruningConfig> | false
  /** Model context window size in tokens for auto-compact threshold (default: 200000) */
  contextWindowTokens?: number
  /** Max output tokens reserved for the model response (default: 16384) */
  maxOutputTokens?: number
  /** Buffer tokens reserved for system prompt and safety margin (default: 15000) */
  bufferTokens?: number
  /** Max consecutive summarization failures before circuit breaker trips (default: 3) */
  maxSummarizeFailures?: number
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
  maxEstimatedTokens: 100_000,
  keepRecentMessages: 10,
  pruneIntervalSeconds: 300,
}

export class SessionManager {
  private sessions: Map<string, ManagedSession> = new Map()
  private config: SessionManagerConfig
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private summarizeFn: SummarizeFn | null = null
  private persistence: SessionPersistence | null = null
  private consecutiveSummarizeFailures = 0
  private circuitBreakerTripped = false

  constructor(config: Partial<SessionManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Total context window size in tokens (from config, default 200k) */
  get contextWindowTokens(): number {
    return this.config.contextWindowTokens ?? 200_000
  }

  /** Token threshold above which Layer 4 autocompact triggers */
  get autocompactThreshold(): number {
    const contextWindow = this.config.contextWindowTokens ?? 200_000
    const maxOutput = this.config.maxOutputTokens ?? 16_384
    const buffer = this.config.bufferTokens ?? 15_000
    return contextWindow - maxOutput - buffer
  }

  /** Whether the summarization circuit breaker has tripped */
  get isSummarizeCircuitOpen(): boolean {
    return this.circuitBreakerTripped
  }

  /** Reset the circuit breaker (e.g. after a model change or manual override) */
  resetCircuitBreaker(): void {
    this.consecutiveSummarizeFailures = 0
    this.circuitBreakerTripped = false
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

  /** Check if a session needs compaction (purely token-based, no message count limit) */
  needsCompaction(session: ManagedSession): boolean {
    return this.estimateTokens(session) > this.autocompactThreshold
  }

  /** Estimate the token count for a session's context */
  estimateTokens(session: ManagedSession): number {
    let tokens = 0
    if (session.compactedSummary) {
      tokens += Math.ceil(session.compactedSummary.length / 4)
    }
    for (const msg of session.messages) {
      const text = this.extractText(msg)
      tokens += Math.max(this.config.estimatedTokensPerMessage, Math.ceil(text.length / 4))
    }
    return tokens
  }

  /**
   * Compact a session by summarizing old messages and keeping only recent ones.
   * If no summarizeFn is set, uses a simple text extraction fallback.
   *
   * Includes a circuit breaker: after maxSummarizeFailures consecutive failures
   * the summarizer is bypassed and fallback is used until resetCircuitBreaker().
   *
   * @param extraContext Optional extra context (e.g. file state summary) appended to the compacted summary.
   * @param aggressiveKeep Override keepRecentMessages (for reactive compaction after errors).
   */
  async compact(id: string, extraContext?: string, aggressiveKeep?: number): Promise<CompactionResult | null> {
    const session = this.sessions.get(id)
    if (!session) return null

    const keepRecentMessages = aggressiveKeep ?? this.config.keepRecentMessages
    if (session.messages.length <= keepRecentMessages) return null

    let splitIndex = session.messages.length - keepRecentMessages
    while (splitIndex > 0 && splitIndex < session.messages.length) {
      const msg = session.messages[splitIndex]
      if (msg.role === 'user') break
      splitIndex++
    }

    if (splitIndex >= session.messages.length - 1) {
      splitIndex = Math.max(0, session.messages.length - keepRecentMessages)
      while (splitIndex < session.messages.length && session.messages[splitIndex].role === 'toolResult') {
        splitIndex++
      }
    }

    const toCompact = session.messages.slice(0, splitIndex)
    const toKeep = session.messages.slice(splitIndex)

    if (toCompact.length === 0) return null

    let summary: string
    const maxFailures = this.config.maxSummarizeFailures ?? 3
    const useLlm = this.summarizeFn && !this.circuitBreakerTripped

    if (useLlm) {
      try {
        summary = await this.summarizeFn!(toCompact)
        this.consecutiveSummarizeFailures = 0
      } catch (err: any) {
        this.consecutiveSummarizeFailures++
        console.error(
          `[SessionManager] Summarization failed for ${id} (${this.consecutiveSummarizeFailures}/${maxFailures}):`,
          err.message,
        )
        if (this.consecutiveSummarizeFailures >= maxFailures) {
          this.circuitBreakerTripped = true
          console.warn(`[SessionManager] Circuit breaker tripped — falling back to extractive summary`)
        }
        summary = this.fallbackSummarize(toCompact)
      }
    } else {
      summary = this.fallbackSummarize(toCompact)
    }

    const existingSummary = session.compactedSummary
      ? `${session.compactedSummary}\n\n`
      : ''

    const extraSuffix = extraContext ? `\n\n${extraContext}` : ''
    session.compactedSummary = `${existingSummary}${summary}${extraSuffix}`
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
      if (!text) continue

      if (msg.role === 'toolResult') {
        // Tool results: keep error messages in full, truncate success output
        const isError = /error|failed|not found/i.test(text.substring(0, 200))
        const limit = isError ? 800 : 300
        const trimmed = text.length > limit ? text.substring(0, limit) + '...' : text
        parts.push(`toolResult: ${trimmed}`)
      } else {
        const limit = msg.role === 'user' ? 600 : 400
        const trimmed = text.length > limit ? text.substring(0, limit) + '...' : text
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

// ---------------------------------------------------------------------------
// Layer 1: Tool Result Budget
// ---------------------------------------------------------------------------

const TOOL_RESULT_BUDGET_RATIO = 0.4
const BUDGET_PROTECTED_TURNS = 3

/**
 * Proportionally shrink old tool results so they don't consume more than
 * TOOL_RESULT_BUDGET_RATIO of the total context budget. Recent turns
 * (within BUDGET_PROTECTED_TURNS) are never touched.
 *
 * @param frozenIds — tool_call ids whose prior compaction decision is locked
 *   (either already replaced or explicitly preserved in a prior call). They
 *   are excluded from eligibility (never re-compacted) so their content stays
 *   byte-identical across calls — critical for prompt-cache prefix stability.
 *   Their chars still count toward the aggregate budget.
 */
export function applyToolResultBudget(
  messages: Message[],
  contextBudgetChars: number,
  frozenIds?: ReadonlySet<string>,
): Message[] {
  const maxBudget = Math.floor(contextBudgetChars * TOOL_RESULT_BUDGET_RATIO)

  const turnBoundaries: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') turnBoundaries.push(i)
  }
  const protectedStart = turnBoundaries.length >= BUDGET_PROTECTED_TURNS
    ? turnBoundaries[BUDGET_PROTECTED_TURNS - 1]
    : 0

  const eligibleIndices: number[] = []
  let totalCharsForBudget = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'toolResult' || i >= protectedStart) continue
    const chars = msg.content
      .filter((c): c is TextContent => c.type === 'text')
      .reduce((sum, c) => sum + c.text.length, 0)
    if (chars === 0) continue
    // Frozen messages count toward the total budget draw (their content
    // is part of what the model sees) but aren't eligible to be re-compacted.
    totalCharsForBudget += chars
    if (frozenIds?.has((msg as ToolResultMessage).toolCallId)) continue
    eligibleIndices.push(i)
  }

  if (totalCharsForBudget <= maxBudget || eligibleIndices.length === 0) return messages

  const perResultBudget = Math.floor(maxBudget / eligibleIndices.length)
  const eligibleSet = new Set(eligibleIndices)

  return messages.map((msg, idx) => {
    if (!eligibleSet.has(idx)) return msg
    const trm = msg as ToolResultMessage
    return {
      ...trm,
      content: trm.content.map((c) => {
        if (c.type !== 'text' || c.text.length <= perResultBudget) return c
        const headSize = Math.floor(perResultBudget * 0.7)
        const tailSize = perResultBudget - headSize - 60
        if (tailSize <= 0) {
          return { type: 'text' as const, text: c.text.substring(0, perResultBudget) + '\n[... truncated ...]' }
        }
        return {
          type: 'text' as const,
          text: c.text.substring(0, headSize)
            + `\n\n[... ${c.text.length - headSize - tailSize} chars trimmed for budget ...]\n\n`
            + c.text.substring(c.text.length - tailSize),
        }
      }),
    } as ToolResultMessage
  })
}

// ---------------------------------------------------------------------------
// Layer 3: Snip Consumed Results
// ---------------------------------------------------------------------------

/**
 * Replace tool results that have already been processed by a subsequent
 * assistant message with a short placeholder. The assistant's own summary
 * of the tool output is sufficient context — the raw output is redundant.
 *
 * Only snips results older than `protectedTurns` assistant turns from the end.
 */
export function snipConsumedResults(
  messages: Message[],
  protectedTurns = 3,
  frozenIds?: ReadonlySet<string>,
): Message[] {
  const turnBoundaries: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') turnBoundaries.push(i)
  }
  const protectedStart = turnBoundaries.length >= protectedTurns
    ? turnBoundaries[protectedTurns - 1]
    : 0

  return messages.map((msg, idx) => {
    if (msg.role !== 'toolResult') return msg
    if (idx >= protectedStart) return msg
    // Frozen: the prior decision for this tool_call_id is locked. Skipping
    // here guarantees we never re-snip a message whose prior pass chose to
    // preserve it, which would flip its content mid-session and blow cache.
    if (frozenIds?.has((msg as ToolResultMessage).toolCallId)) return msg

    const hasFollowingAssistant = messages
      .slice(idx + 1)
      .some(m => m.role === 'assistant')

    if (!hasFollowingAssistant) return msg

    const totalChars = (msg as ToolResultMessage).content
      .filter((c): c is TextContent => c.type === 'text')
      .reduce((sum, c) => sum + c.text.length, 0)

    if (totalChars < 200) return msg

    return {
      ...msg,
      content: [{ type: 'text', text: `[Tool output processed — ${totalChars} chars, see assistant response]` }],
    } as ToolResultMessage
  })
}
