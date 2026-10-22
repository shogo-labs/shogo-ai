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
import {
  assistantWindowStart,
  foldTurnMiddle,
  lastTurnStart,
  protectedStart as protectedStartOf,
  summariseTurn,
  turnAwareCompactionEnabled,
} from './turn-boundary'
import { collectCompactionFacts, renderCompactionFacts } from './compaction-facts'

/** Rough per-image token cost (a ~1MP image on Anthropic is ~1,600 tokens). */
const IMAGE_TOKEN_ESTIMATE = 1_600

/**
 * Everything the provider is billed for, not just prose: tool-call arguments
 * (write_file/edit_file bodies are often the bulk of a long turn) and images.
 * Undercounting these kept autocompact from ever firing and left sessions
 * stuck on "prompt is too long".
 *
 * Exported so the mid-turn compactor measures requests with the same ruler the
 * session does — a second estimator is how the dock and the wire drifted.
 */
export function estimateMessageTokens(msg: Message): number {
  const content = (msg as any).content
  if (typeof content === 'string') return Math.ceil(content.length / 4)
  if (!Array.isArray(content)) return 0
  let chars = 0
  let tokens = 0
  for (const block of content) {
    if (block?.type === 'text') chars += block.text?.length ?? 0
    else if (block?.type === 'thinking') chars += block.thinking?.length ?? 0
    else if (block?.type === 'toolCall') {
      chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length
    } else if (block?.type === 'image') tokens += IMAGE_TOKEN_ESTIMATE
  }
  return tokens + Math.ceil(chars / 4)
}

/**
 * Index at which a compaction splits: the first `user` message at or after
 * `length - keepRecentMessages`, so the kept tail starts on a clean turn
 * boundary instead of mid tool-result chain.
 */
export function splitIndexForCompaction(messages: Message[], keepRecentMessages: number): number | null {
  if (messages.length <= keepRecentMessages) return null
  let splitIndex = messages.length - keepRecentMessages
  while (splitIndex > 0 && splitIndex < messages.length) {
    if (messages[splitIndex].role === 'user') break
    splitIndex++
  }
  if (splitIndex >= messages.length - 1) {
    splitIndex = Math.max(0, messages.length - keepRecentMessages)
    while (splitIndex < messages.length && messages[splitIndex].role === 'toolResult') {
      splitIndex++
    }
  }
  return splitIndex > 0 && splitIndex < messages.length ? splitIndex : null
}

/** Estimated tokens of a message array, using the same ruler as `estimateMessageTokens`. */
export function estimateMessageArrayTokens(messages: Message[], tokensPerMessage = 0): number {
  let tokens = 0
  for (const msg of messages) tokens += Math.max(tokensPerMessage, estimateMessageTokens(msg))
  return tokens
}

/**
 * Split index that also bounds the *kept tail* by tokens.
 *
 * `splitIndexForCompaction` keeps a fixed number of messages, which assumes the
 * recent ones are small. Production says otherwise: a single tool result can be
 * 300k tokens, so ten kept messages can still exceed the cap the compaction was
 * called to enforce — the request stays over budget and the next one overruns
 * the model's window. This folds *more* (the split moves later) until the tail
 * fits `tailBudgetTokens`, always keeping at least `minKeepMessages`.
 *
 * Returns `null` when there is nothing to fold away, so a short conversation is
 * never compacted just because it holds one large message.
 */
export function splitIndexForTokenBudget(
  messages: Message[],
  opts: { tailBudgetTokens: number; minKeepMessages: number; maxKeepMessages: number; tokensPerMessage?: number },
): number | null {
  const countSplit = splitIndexForCompaction(messages, opts.maxKeepMessages)
  if (countSplit === null) return null

  const tokensOf = (msg: Message) => Math.max(opts.tokensPerMessage ?? 0, estimateMessageTokens(msg))
  const minKeep = Math.max(1, opts.minKeepMessages)
  // Split index above which fewer than `minKeep` messages would survive.
  const hardMax = Math.max(1, messages.length - minKeep)

  let split = Math.min(countSplit, hardMax)
  let tailTokens = 0
  for (let i = split; i < messages.length; i++) tailTokens += tokensOf(messages[i])

  while (split < hardMax && tailTokens > opts.tailBudgetTokens) {
    tailTokens -= tokensOf(messages[split])
    split++
  }
  // Never hand the provider a tail that starts mid tool-result chain: a
  // toolResult whose toolCall was summarized away is an invalid request, so
  // the result is folded too (the tail then keeps only what follows it).
  while (split < messages.length - 1 && messages[split].role === 'toolResult') {
    tailTokens -= tokensOf(messages[split])
    split++
  }

  return split > 0 && split < messages.length ? split : countSplit
}

/**
 * The two messages that stand in for everything a compaction folded away.
 *
 * One builder for both the turn-boundary history (`buildHistory`) and the
 * mid-turn compactor, so a summary looks byte-identical to the provider
 * whichever path wrote it.
 */
export function buildSummaryPrefixMessages(summary: string): Message[] {
  return [
    {
      role: 'user',
      content: `[Previous conversation summary]\n${summary}`,
      timestamp: Date.now(),
    } as UserMessage,
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Understood, I have the context from our previous conversation.' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'system',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    } as AssistantMessage,
  ]
}

// ---------------------------------------------------------------------------
// Session Persistence Interface
// ---------------------------------------------------------------------------

export interface SessionPersistence {
  save(id: string, session: SerializedSession): Promise<void>
  load(id: string): Promise<SerializedSession | null>
  delete(id: string): Promise<void>
  loadAll(): Promise<SerializedSession[]>
  /**
   * Optional cheap scan for reclamation: ids of stored sessions untouched
   * since `cutoffMs` whose copy holds no messages. Implementations should avoid
   * parsing the whole store — the sweep runs every few minutes.
   */
  listMessageLessIds?(cutoffMs: number): Promise<string[]>
  /** Optional size of the store in bytes, for a growth warning. */
  sizeBytes?(): number
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
  /** Native provider hint paired with `modelOverride` (e.g. `anthropic`).
   *  Persisted so a reloaded session keeps native routing; older sessions
   *  simply lack it and fall back to id-based inference. */
  modelProvider?: string
  /** Maximum Auto tier permitted after a plan/entitlement rejection. */
  autoTierCeiling?: 'economy' | 'standard' | 'premium'
  /** Timestamp of the last Auto entitlement downgrade. */
  autoTierCeilingUpdatedAt?: number
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
  /**
   * Days a *message-less* session may sit before its persisted copy is
   * reclaimed (default: 30). A session that holds messages is never
   * reclaimed by age — a conversation never loses its history because it
   * went quiet (SHO-137). 0 disables reclamation.
   */
  emptySessionRetentionDays?: number
  /** Tool result pruning config (false to disable) */
  pruning?: Partial<PruningConfig> | false
  /**
   * The *model's* context window in tokens. The summarize threshold is
   * derived from it (minus output/buffer reserve) and capped at
   * `AGENT_AUTOCOMPACT_TOKENS` — see `resolveAutoCompactTokens`.
   * Leave unset to inherit the 200k cap.
   */
  contextWindowTokens?: number
  /** Max output tokens reserved for the model response (default: 16384) */
  maxOutputTokens?: number
  /** Buffer tokens reserved for system prompt and safety margin (default: 15000) */
  bufferTokens?: number
  /** Max tokens passed to the summarizer per call (default: 24000) */
  summarizeChunkTokens?: number
  /** Max consecutive summarization failures before circuit breaker trips (default: 3) */
  maxSummarizeFailures?: number
  /**
   * Token budget for the messages kept verbatim behind a summary
   * (default: 40% of the autocompact threshold).
   */
  compactionTailBudgetTokens?: number
  /** Messages that always survive a compaction, however large (default: 2) */
  compactionMinKeepMessages?: number
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
  /** Native provider hint paired with `modelOverride` (see SerializedSession). */
  modelProvider?: string
  /** Maximum Auto tier permitted after a plan/entitlement rejection. */
  autoTierCeiling?: 'economy' | 'standard' | 'premium'
  /** Timestamp of the last Auto entitlement downgrade. */
  autoTierCeilingUpdatedAt?: number
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

// ---------------------------------------------------------------------------
// Auto-compact budget
// ---------------------------------------------------------------------------

/**
 * Hard cap on the context we are willing to send on ONE request, independent
 * of how large the model's window is. Documented next to
 * `DEFAULT_INLOOP_CONTEXT_BUDGET_TOKENS` (stable-compaction.ts) for the same
 * reason: every step of an agent turn re-sends the whole context, so a 1M
 * window is never a reason to send 1M tokens.
 *
 * Override with `AGENT_AUTOCOMPACT_TOKENS`.
 */
export const DEFAULT_AUTOCOMPACT_TOKENS = 200_000

/** Default output + safety reserve subtracted from a model's window. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384
const DEFAULT_BUFFER_TOKENS = 15_000
/** Window assumed when the catalog does not know the model's real one. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000

/**
 * The token count at which LLM summarization fires: the model's window minus
 * the output/buffer reserve, capped at `AGENT_AUTOCOMPACT_TOKENS` (200k).
 *
 * `contextWindowTokens` is the *model's* window (from the catalog, or an
 * explicit override); the cap is what keeps a 1M-window model — haiku-5-5,
 * opus-5-5 — summarizing at 200k instead of at 968k. An unknown model keeps
 * the historical 200k window.
 */
export function resolveAutoCompactTokens(input: {
  contextWindowTokens?: number
  maxOutputTokens?: number
  bufferTokens?: number
} = {}): number {
  const fromEnv = Number(process.env.AGENT_AUTOCOMPACT_TOKENS)
  const cap = Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : DEFAULT_AUTOCOMPACT_TOKENS
  const windowTokens = input.contextWindowTokens && input.contextWindowTokens > 0
    ? input.contextWindowTokens
    : DEFAULT_CONTEXT_WINDOW_TOKENS
  const reserve =
    (input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) + (input.bufferTokens ?? DEFAULT_BUFFER_TOKENS)
  const room = windowTokens - reserve
  // A window smaller than the reserve (tiny test models) keeps its own
  // negative/zero threshold rather than silently inheriting the 200k cap.
  return room > 0 ? Math.min(room, cap) : room
}

/** A chat session other chats in this workspace may be running. */
export interface ChatSessionSummary {
  id: string
  /** Chat title from the request's `chatSessionName`, when one was sent. */
  title?: string
  /** First user message, used as a fallback label. */
  firstUserText?: string
  lastActivityAt: number
  messageCount: number
}

/** `run:` pipelines and the literal `pipeline` session are not user chats. */
function isChatSessionId(id: string): boolean {
  return id !== 'pipeline' && !id.startsWith('run:')
}

export interface CompactionResult {
  sessionId: string
  messagesBefore: number
  messagesAfter: number
  compactedCount: number
  summary: string
  /** Deterministic files/tools/state block appended to the summary. */
  facts?: string
  /** Files the facts block recorded (for telemetry). */
  filesTouched?: string[]
  /** Tool names the facts block recorded (for telemetry). */
  toolsUsed?: string[]
  /** Rounds folded by the oversized-turn valve (0 when it did not fire). */
  foldedRounds?: number
}

/**
 * A single turn is folded in the middle once it exceeds this share of the
 * context budget. Keeping it verbatim is impossible; summarizing it away is
 * the bug this file exists to fix, so the middle rounds become one line each.
 */
export const TURN_KEEP_MAX_RATIO = 0.4

/**
 * Function signature for the summarization backend.
 *
 * Called once per chunk of the head being folded away. `previousSummary` is
 * the running fold (undefined for the first chunk), so a 400k head survives
 * as a real summary instead of the first 12k characters of it.
 */
export type SummarizeFn = (messages: Message[], previousSummary?: string) => Promise<string>

/** Max tokens of message text handed to the summarizer in one call. */
export const DEFAULT_SUMMARIZE_CHUNK_TOKENS = 24_000

/** Days a message-less persisted session is kept before reclamation. */
export const DEFAULT_EMPTY_SESSION_RETENTION_DAYS = 30

/** Log a growth warning once the session store passes this size. */
export const SESSION_STORE_WARN_BYTES = 512 * 1024 * 1024

const DEFAULT_CONFIG: SessionManagerConfig = {
  sessionTtlSeconds: 3600,
  maxMessages: 30,
  estimatedTokensPerMessage: 150,
  maxEstimatedTokens: 100_000,
  keepRecentMessages: 10,
  pruneIntervalSeconds: 300,
  emptySessionRetentionDays: DEFAULT_EMPTY_SESSION_RETENTION_DAYS,
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

  /**
   * Pin the summarize threshold to a specific model's window for the next
   * turn. Called per turn from the gateway with the resolved model's catalog
   * window, since one gateway serves sessions on different models.
   */
  setContextWindowTokens(tokens: number | undefined): void {
    this.config.contextWindowTokens = tokens && tokens > 0 ? tokens : undefined
  }

  /**
   * Token threshold above which Layer 4 autocompact triggers: the model's
   * window minus the output/buffer reserve, capped at
   * `AGENT_AUTOCOMPACT_TOKENS` (default 200k).
   */
  get autocompactThreshold(): number {
    return resolveAutoCompactTokens({
      contextWindowTokens: this.config.contextWindowTokens,
      maxOutputTokens: this.config.maxOutputTokens,
      bufferTokens: this.config.bufferTokens,
    })
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
      () => {
        this.pruneExpired()
        // Bounded growth without touching a conversation: only rows that never
        // held a message are reclaimed (SHO-137).
        void this.reclaimEmptySessions().catch(() => {})
      },
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

  /**
   * Load a persisted session into memory *without* creating one when nothing
   * is stored. The difference matters: `getOrCreate` on a cold pod fabricates
   * an empty session that the next `persistSession` writes over the good copy
   * (SHO-137). Callers that want "whatever is on disk, or nothing" use this.
   */
  async loadSession(id: string): Promise<ManagedSession | null> {
    const loaded = this.sessions.get(id)
    if (loaded) return loaded
    if (!this.persistence) return null
    const data = await this.persistence.load(id)
    if (!data) return null
    const session: ManagedSession = { ...data, stopRequested: false, metadata: data.metadata || {} }
    this.sessions.set(id, session)
    return session
  }

  /** Async version that checks disk persistence before creating a new session */
  async getOrCreateAsync(id: string): Promise<ManagedSession> {
    const loaded = await this.loadSession(id)
    if (loaded) return loaded
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

  /** Remove these exact message objects (by identity) from a session and persist. */
  removeMessages(id: string, msgs: Iterable<Message>): number {
    const session = this.sessions.get(id)
    if (!session) return 0
    const drop = new Set(msgs)
    const before = session.messages.length
    session.messages = session.messages.filter((m) => !drop.has(m))
    const removed = before - session.messages.length
    if (removed > 0) {
      session.totalMessages = Math.max(0, session.totalMessages - removed)
      this.persistSession(session)
    }
    return removed
  }

  /**
   * Merge `patch` into a session's metadata and persist. Used to durably track
   * the thread's running background processes (so the list survives restart).
   * No-op if the session is not loaded.
   */
  setSessionMetadata(id: string, patch: Record<string, any>): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.metadata = { ...session.metadata, ...patch }
    this.persistSession(session)
  }

  /** Persist the maximum Auto tier allowed for a session after a rejection. */
  setAutoTierCeiling(id: string, ceiling: ManagedSession['autoTierCeiling']): void {
    const session = this.sessions.get(id)
    if (!session || !ceiling) return
    const now = Date.now()
    session.autoTierCeiling = ceiling
    session.autoTierCeilingUpdatedAt = now
    session.lastActivityAt = now
    this.persistSession(session)
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

  /**
   * Wipe a session for real — memory *and* the persisted copy. Only for a
   * deliberate delete (the user removed the chat, or history was cleared), so
   * `pruneExpired()` must never call it: idle time does not destroy history.
   */
  async deleteSession(id: string): Promise<boolean> {
    const known = this.sessions.delete(id)
    if (this.persistence) {
      try {
        await this.persistence.delete(id)
      } catch (err: any) {
        console.error(`[SessionManager] Failed to delete persisted session ${id}:`, err?.message ?? err)
      }
    }
    return known
  }

  /**
   * Install a durable summary for a session, e.g. the API's copy of what an
   * evicted conversation was about. Never replaces a longer existing summary
   * (a compaction already folded this turn's history into it).
   */
  setCompactedSummary(id: string, summary: string | null, opts: { replace?: boolean } = {}): void {
    const session = this.getOrCreate(id)
    const next = summary?.trim() ? summary.trim() : null
    if (!next) return
    if (session.compactedSummary && !opts.replace) return
    session.compactedSummary = next
    this.persistSession(session)
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
      tokens += Math.max(this.config.estimatedTokensPerMessage, estimateMessageTokens(msg))
    }
    return tokens
  }

  /** Estimated tokens of a message array, using the same ruler as `estimateTokens`. */
  estimateMessagesTokens(messages: Message[]): number {
    let tokens = 0
    for (const msg of messages) {
      tokens += Math.max(this.config.estimatedTokensPerMessage, estimateMessageTokens(msg))
    }
    return tokens
  }

  /**
   * Token budget for the messages kept verbatim behind a summary. 40% of the
   * autocompact threshold by default, so the request after a compaction lands
   * well below the cap instead of immediately needing another one.
   */
  get compactionTailBudgetTokens(): number {
    if (this.config.compactionTailBudgetTokens) return this.config.compactionTailBudgetTokens
    const threshold = this.autocompactThreshold
    return threshold > 0 ? Math.max(1, Math.floor(threshold * 0.4)) : Number.MAX_SAFE_INTEGER
  }

  /** Split index bounded by the message count *and* the tail token budget. */
  splitIndexForCompactionTokens(messages: Message[], maxKeepMessages: number): number | null {
    return (
      splitIndexForTokenBudget(messages, {
        tailBudgetTokens: this.compactionTailBudgetTokens,
        minKeepMessages: this.config.compactionMinKeepMessages ?? 2,
        maxKeepMessages,
        tokensPerMessage: this.config.estimatedTokensPerMessage,
      }) ?? splitIndexForCompaction(messages, maxKeepMessages)
    )
  }

  /**
   * Summarize a head of history in chunks and fold each chunk into a running
   * summary (map-reduce). The old single-shot path sent `12k chars` of a head
   * that could be 400k tokens — a "successful" summarize that dropped the
   * decisions it exists to preserve.
   *
   * `previousSummary` continues an earlier fold (a second mid-turn
   * compaction), so the new summary supersedes the old one instead of
   * duplicating it.
   */
  async summarizeHead(head: Message[], previousSummary?: string): Promise<string> {
    if (head.length === 0) return '(summary unavailable)'
    const chunkBudget = this.config.summarizeChunkTokens ?? DEFAULT_SUMMARIZE_CHUNK_TOKENS
    const chunks: Message[][] = []
    let current: Message[] = []
    let currentTokens = 0
    for (const msg of head) {
      const tokens = Math.max(this.config.estimatedTokensPerMessage, estimateMessageTokens(msg))
      if (current.length > 0 && currentTokens + tokens > chunkBudget) {
        chunks.push(current)
        current = []
        currentTokens = 0
      }
      current.push(msg)
      currentTokens += tokens
    }
    if (current.length > 0) chunks.push(current)

    if (!this.summarizeFn || this.circuitBreakerTripped) return this.fallbackSummarize(head)

    const maxFailures = this.config.maxSummarizeFailures ?? 3
    let summary: string | undefined = previousSummary
    for (const chunk of chunks) {
      try {
        summary = await this.summarizeFn(chunk, summary)
        this.consecutiveSummarizeFailures = 0
      } catch (err: any) {
        this.consecutiveSummarizeFailures++
        console.error(
          `[SessionManager] Summarization failed (${this.consecutiveSummarizeFailures}/${maxFailures}):`,
          err.message,
        )
        if (this.consecutiveSummarizeFailures >= maxFailures) {
          this.circuitBreakerTripped = true
          console.warn(`[SessionManager] Circuit breaker tripped — falling back to extractive summary`)
          return this.fallbackSummarize(head)
        }
        // A failed chunk must not silently drop its content: keep the
        // extractive text for that chunk and keep folding.
        const extract = this.fallbackSummarize(chunk)
        summary = summary ? `${summary}\n\n${extract}` : extract
      }
    }
    return summary ?? this.fallbackSummarize(head)
  }

  /**
   * Compact a session by summarizing old messages and keeping only recent ones.
   * If no summarizeFn is set, uses a simple text extraction fallback.
   *
   * Includes a circuit breaker: after maxSummarizeFailures consecutive failures
   * the summarizer is bypassed and fallback is used until resetCircuitBreaker().
   *
   * The split lands on a **turn start** (`lastTurnStart`), so the previous turn
   * is never cut in half — that cut was the 516 → 12 collapse: the head ended
   * mid-turn, leaving a `toolResult` whose `toolCall` had been summarized away
   * (SHO-122). A turn too large to keep is folded, never summarized away.
   *
   * @param extraContext Optional extra context (e.g. file state summary) appended to the compacted summary.
   * @param aggressiveKeep Override keepRecentMessages (for reactive compaction after errors).
   */
  async compact(id: string, extraContext?: string, aggressiveKeep?: number): Promise<CompactionResult | null> {
    const session = this.sessions.get(id)
    if (!session) return null

    const keepRecentMessages = aggressiveKeep ?? this.config.keepRecentMessages
    const splitIndex = turnAwareCompactionEnabled()
      ? this.turnBoundarySplit(session.messages, keepRecentMessages)
      : this.splitIndexForCompactionTokens(session.messages, keepRecentMessages)

    if (splitIndex === null) {
      // Nothing older than the current turn to summarize. If that one turn is
      // over the budget it is still folded in the middle — the request has to
      // fit, and cutting the turn is what this card exists to stop.
      const folded = this.foldOversizedTurn(id)
      if (folded.foldedRounds === 0) return null
      return {
        sessionId: id,
        messagesBefore: folded.messagesBefore,
        messagesAfter: folded.messagesAfter,
        compactedCount: folded.messagesBefore - folded.messagesAfter,
        summary: '',
        foldedRounds: folded.foldedRounds,
      }
    }

    const toCompact = session.messages.slice(0, splitIndex)
    if (toCompact.length === 0) return null

    const summary = await this.summarizeHead(toCompact)
    const result = this.applyCompaction(id, { summary, splitIndex, extraContext })
    if (!result) return null

    // Budget safety valve: the kept turn alone may still exceed its share of
    // the budget. Fold its middle rounds rather than summarizing it away.
    const folded = this.foldOversizedTurn(id)
    if (folded.foldedRounds > 0) {
      const after = this.sessions.get(id)
      const messagesAfter = after?.messages.length ?? result.messagesAfter
      result.messagesAfter = messagesAfter
      result.compactedCount = result.messagesBefore - messagesAfter
      result.foldedRounds = folded.foldedRounds
    }
    return result
  }

  /**
   * Split index at the start of the most recent turn, with
   * `minKeepMessages` as a floor: whole turns are kept until at least that
   * many messages survive. Never returns a mid-turn index.
   */
  turnBoundarySplit(messages: Message[], minKeepMessages: number): number | null {
    if (messages.length < 2) return null
    let split = lastTurnStart(messages)
    const floor = Math.min(Math.max(1, minKeepMessages), messages.length - 1)
    while (split > 0 && messages.length - split < floor) {
      const previous = lastTurnStart(messages.slice(0, split))
      if (previous === 0 || previous === split) break
      split = previous
    }
    return split > 0 && split < messages.length ? split : null
  }

  /** Char budget the layers measure against (40% of it is a turn's share). */
  get contextBudgetChars(): number {
    return this.autocompactThreshold * 4
  }

  /**
   * Fold the middle rounds of an oversized turn in place.
   *
   * Runs against the session's current turn (the last turn start). A turn
   * larger than `TURN_KEEP_MAX_RATIO` of the context budget cannot be kept
   * verbatim and cannot be summarized away without losing the work, so the
   * rounds between its first and last are replaced by one line each that keeps
   * the tool name and arguments and drops only the output.
   */
  foldOversizedTurn(id: string, from?: number): {
    foldedRounds: number
    messagesBefore: number
    messagesAfter: number
  } {
    const session = this.sessions.get(id)
    if (!session) return { foldedRounds: 0, messagesBefore: 0, messagesAfter: 0 }
    const start = from ?? lastTurnStart(session.messages)
    const messagesBefore = session.messages.length
    const maxChars = Math.floor(this.contextBudgetChars * TURN_KEEP_MAX_RATIO)
    const summary = summariseTurn(session.messages, start)
    if (summary.chars <= maxChars) return { foldedRounds: 0, messagesBefore, messagesAfter: messagesBefore }

    const folded = foldTurnMiddle(session.messages, start, { maxChars })
    if (folded.foldedRounds === 0) return { foldedRounds: 0, messagesBefore, messagesAfter: messagesBefore }

    session.messages = folded.messages
    session.lastActivityAt = Date.now()
    this.persistSession(session)
    return { foldedRounds: folded.foldedRounds, messagesBefore, messagesAfter: session.messages.length }
  }

  /**
   * Apply an already-computed summary: drop `splitIndex` messages of head,
   * prepend the summary, persist. Shared by turn-boundary compaction and the
   * mid-turn compactor so both produce the same session shape.
   *
   * The deterministic facts block (`compaction-facts.ts`) is appended here, not
   * requested from the model, so the files and tool names survive a lazy or
   * wrong summary.
   */
  applyCompaction(
    id: string,
    opts: { summary: string; splitIndex: number; extraContext?: string; replaceSummary?: boolean },
  ): CompactionResult | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const { summary, splitIndex, extraContext, replaceSummary } = opts
    if (splitIndex <= 0 || splitIndex >= session.messages.length) return null

    const toCompact = session.messages.slice(0, splitIndex)
    const toKeep = session.messages.slice(splitIndex)
    if (toCompact.length === 0) return null

    const existingSummary = session.compactedSummary && !replaceSummary
      ? `${session.compactedSummary}\n\n`
      : ''

    const factData = collectCompactionFacts(toCompact)
    const facts = renderCompactionFacts(factData)
    const extraSuffix = extraContext ? `\n\n${extraContext}` : ''
    session.compactedSummary = `${existingSummary}${summary}\n\n${facts}${extraSuffix}`
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
      facts,
      filesTouched: factData.files.map((f) => f.path),
      toolsUsed: factData.tools.map((t) => t.name),
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
      msgs.push(...buildSummaryPrefixMessages(session.compactedSummary))
    }

    msgs.push(...session.messages)

    if (this.config.pruning !== false) {
      return pruneToolResults(msgs, typeof this.config.pruning === 'object' ? this.config.pruning : {})
    }

    return msgs
  }

  /**
   * Evict idle sessions from *memory*.
   *
   * This is a memory bound, never a data bound: the persisted copy is left
   * alone, so a conversation that goes quiet overnight is still there when a
   * background task or a person wakes it (SHO-137). Deleting the row here used
   * to wipe the only durable copy — `.shogo/sessions.db` is S3-synced, so every
   * replica went with it, and the next wake turn started from nothing.
   *
   * Persisted growth is bounded deliberately instead: `reclaimEmptySessions()`
   * drops rows that hold no messages, and `deleteSession()` wipes one when the
   * user actually deletes the chat. A session with messages is never removed
   * for being old.
   */
  pruneExpired(): string[] {
    const now = Date.now()
    const ttlMs = this.config.sessionTtlSeconds * 1000
    const pruned: string[] = []

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > ttlMs) {
        this.sessions.delete(id)
        pruned.push(id)
      }
    }

    if (pruned.length > 0) {
      console.log(`[SessionManager] Evicted ${pruned.length} idle session(s) from memory: ${pruned.join(', ')}`)
    }

    return pruned
  }

  /**
   * Reclaim persisted sessions that never held a message and have been idle
   * past `emptySessionRetentionDays`. These are the rows chat creation leaves
   * behind; they cost disk and S3 sync forever and carry nothing a turn needs.
   * A session with messages is skipped, whatever its age.
   */
  async reclaimEmptySessions(now = Date.now()): Promise<string[]> {
    const days = this.config.emptySessionRetentionDays ?? DEFAULT_EMPTY_SESSION_RETENTION_DAYS
    if (!this.persistence || !days || days <= 0) return []
    const cutoff = now - days * 24 * 60 * 60 * 1000
    const reclaimed: string[] = []
    let candidates: string[]
    try {
      candidates = this.persistence.listMessageLessIds
        ? await this.persistence.listMessageLessIds(cutoff)
        : (await this.persistence.loadAll())
            .filter((data) => data.messages.length === 0 && data.lastActivityAt <= cutoff)
            .map((data) => data.id)
    } catch (err: any) {
      console.error('[SessionManager] Failed to scan persisted sessions:', err?.message ?? err)
      return []
    }
    for (const id of candidates) {
      try {
        await this.persistence.delete(id)
        this.sessions.delete(id)
        reclaimed.push(id)
      } catch (err: any) {
        console.error(`[SessionManager] Failed to reclaim empty session ${id}:`, err?.message ?? err)
      }
    }
    if (reclaimed.length > 0) {
      console.log(`[SessionManager] Reclaimed ${reclaimed.length} empty persisted session(s)`)
    }
    // The store is meant to be bounded, but it now holds conversations forever
    // by design (SHO-137). If reclaiming empty rows is not enough, say so with
    // numbers instead of letting it grow invisibly.
    const bytes = this.persistence.sizeBytes?.()
    if (bytes !== undefined && bytes > SESSION_STORE_WARN_BYTES) {
      console.warn(
        `[SessionManager] sessions.db is ${(bytes / 1024 / 1024).toFixed(1)}MB ` +
          `(> ${(SESSION_STORE_WARN_BYTES / 1024 / 1024).toFixed(0)}MB); ` +
          `conversation history is never deleted by age, so this is retention to review, not a bug to prune`,
      )
    }
    return reclaimed
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

  /**
   * Chat sessions active within `sinceMs` — the sessions another turn could
   * be running in. Skips `run:` project-call/pipeline sessions, which are not
   * user chats. Reuses `extractText` for the first-user-message fallback label.
   */
  listChatSessions(sinceMs: number): ChatSessionSummary[] {
    const cutoff = Date.now() - sinceMs
    const chats: ChatSessionSummary[] = []
    for (const session of this.sessions.values()) {
      if (!isChatSessionId(session.id)) continue
      if (session.lastActivityAt < cutoff) continue
      const cachedTitle = session.metadata?.title
      const title = typeof cachedTitle === 'string' && cachedTitle.trim() ? cachedTitle.trim() : undefined
      const firstUser = session.messages.find((msg) => msg.role === 'user')
      const firstUserText = firstUser ? this.extractText(firstUser).trim() || undefined : undefined
      chats.push({
        id: session.id,
        title,
        firstUserText,
        lastActivityAt: session.lastActivityAt,
        messageCount: session.messages.length,
      })
    }
    return chats.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  /**
   * Get full detail for a single session, including the actual compacted
   * summary text (not just a boolean). Returns null if the session does
   * not exist in memory.
   */
  getDetail(id: string): (Omit<SessionStats, 'compactedSummary'> & {
    compactedSummary: string | null
    lastActivityAt: number
  }) | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return {
      id: s.id,
      messageCount: s.messages.length,
      estimatedTokens: this.estimateTokens(s),
      compactedSummary: s.compactedSummary,
      compactionCount: s.compactionCount,
      totalMessages: s.totalMessages,
      idleSeconds: Math.floor((Date.now() - s.lastActivityAt) / 1000),
      createdAt: new Date(s.createdAt).toISOString(),
      lastActivityAt: s.lastActivityAt,
    }
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
    // `content` is a string for plain user/assistant text and a block array for
    // tool calls/results, so every role has to handle both shapes: a resumed
    // session hydrated from JSON has assistant text as strings, and a summarizer
    // that assumed blocks threw mid-turn instead of compacting.
    const content = (msg as any).content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((c: any) => c?.type === 'text')
      .map((c: any) => c.text)
      .join(' ')
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

  // `keepLastTurns` counts assistant messages, which are tool *rounds*: on a
  // 12-round turn the window closed while the turn was still running. The
  // turn start is applied on top so the previous turn survives whole.
  const protectedTurnStart = protectedStartOf(messages, cfg.keepLastTurns)
  const assistantBoundary = assistantWindowStart(messages, cfg.hardClearAfterTurns)
  const hardClearStart = assistantBoundary > 0 && assistantBoundary < protectedTurnStart
    ? assistantBoundary
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

  // Turn-anchored: the previous turn is one unit, never trimmed from the
  // middle. See turn-boundary.ts.
  const protectedStart = protectedStartOf(messages, BUDGET_PROTECTED_TURNS)

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
  const protectedStart = protectedStartOf(messages, protectedTurns)

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
