// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mid-turn context summarization — the layer that fires *between tool calls*.
 *
 * Why this exists
 * ---------------
 * Every cheap layer (tool-result budget, microcompact, snip) can run per API
 * call, but LLM summarization could only ever run at a turn boundary. A turn
 * that started at 150k and grew to 400k over 40 tool calls therefore never hit
 * a summarizer: `checkpointOldToolResults` cleared old tool results, but
 * assistant text, thinking, user messages and the protected 3-turn window
 * survived, so the request kept growing with no summary (an opus-5-5 turn
 * really did reach 400k in production with nothing summarized).
 *
 * `transformContext` — invoked by pi-agent-core before EVERY API call in the
 * loop — is the only point we control between tool calls, so the decision
 * lives here and is driven by the actual size of the request that is about to
 * go on the wire.
 *
 * Cache rules this class enforces (see stable-compaction.ts for the write-once
 * invariant it must not weaken)
 * ------------------------------------------------------------------------
 * 1. ONE prefix rewrite per compaction. The emitted array (summary prefix +
 *    surviving tail) is memoized at the moment of compaction and re-emitted by
 *    identity for every later call in the turn — byte-identical, so calls
 *    after the summary are cache reads.
 * 2. A second summary inside the same turn is allowed only after
 *    `minDeltaTokens` (default 40k) of new context, otherwise a long turn
 *    thrashes the cache at ~3.5x cost.
 * 3. There is deliberately **no time-based cooldown**. A compaction lands the
 *    request at ~40% of the cap (`compactionTailBudgetTokens`), so being over
 *    the cap again means at least 60% of the cap — 120k on a 200k cap — of new
 *    context has arrived, which is 3x `minDeltaTokens`. A wall-clock cooldown
 *    therefore never adds protection the delta guard doesn't already give, and
 *    it lets the estimate sit *above* the cap for its whole duration: measured
 *    on a 40/60/90-tool-call turn, the old 60s cooldown peaked at 211k/227k/228k
 *    against a 205k ceiling, and removing it alone brought all three to 203.7k.
 * 4. It runs only when the cheap layers were not enough — the caller passes
 *    the post-cheap-layer estimate, so a request that checkpointing already
 *    brought under the cap is never summarized.
 */

import type { Message } from '@mariozechner/pi-ai'
import {
  buildSummaryPrefixMessages,
  estimateMessageTokens,
  splitIndexForCompaction,
  splitIndexForTokenBudget,
} from './session-manager.js'

/** New context required before a second compaction in the same turn. */
export const DEFAULT_AUTOCOMPACT_MIN_DELTA_TOKENS = 40_000

/**
 * Messages kept verbatim when a mid-turn compaction fires. Deliberately
 * smaller than the turn-boundary `keepRecentMessages` (10): the head is what
 * blew past the cap, and the split lands on a `user` message, so the recent
 * turn survives while the ring drops well below the cap.
 */
export const MIDTURN_KEEP_RECENT_MESSAGES = 4

export interface ContextSummarizedEvent {
  trigger: 'auto' | 'manual'
  /** What fired it: the request being over the cap, or a long idle gap (SHO-259). */
  reason: 'cap' | 'idle'
  /** Estimated request size (messages + prompt overhead) before / after. */
  tokensBefore: number
  tokensAfter: number
  messagesBefore: number
  messagesAfter: number
  summaryChars: number
}

export interface MidTurnAutocompactOptions {
  /** Fire when the estimate of the request about to be sent exceeds this. */
  autoCompactTokens: number
  /** Messages kept verbatim after the summary. */
  keepRecentMessages: number
  /**
   * Token ceiling for the kept tail (the messages left verbatim). When set, the
   * split folds more than `keepRecentMessages` would, so a tail holding a giant
   * tool result cannot leave the request at the size the compaction was called
   * to fix.
   */
  tailBudgetTokens?: number
  /** Messages that always survive, however large (default: 1). */
  minKeepMessages?: number
  /** Summarize a head, folding into `previousSummary` when continuing. */
  summarize: (head: Message[], previousSummary?: string) => Promise<string>
  /**
   * Persist the compaction on the session. `splitIndex` is relative to
   * `session.messages`; `replaceSummary` is set when the new summary already
   * folds in the previous one.
   */
  apply: (summary: string, splitIndex: number, opts: { replaceSummary: boolean }) => void
  /** System prompt + tool schema tokens, counted in the trigger and the event. */
  promptOverheadTokens?: number
  minDeltaTokens?: number
  /**
   * Summarize after a gap longer than this between two model calls, even under
   * the cap (SHO-259): the prompt cache is already cold after that wait, so
   * the rewrite is free and makes the next (full) cache write smaller. 0 or
   * unset disables it.
   */
  idleCompactAfterMs?: number
  /**
   * Floor for the idle rule. Below it the kept tail is the whole context, so a
   * summary would fold nothing and only lose detail.
   */
  idleCompactFloorTokens?: number
  /** Injectable clock (tests). */
  now?: () => number
  /** Injected for tests. */
}

interface Memo {
  summary: string
  prefix: Message[]
  /** Loop-array index where the surviving tail starts. */
  tailStart: number
  /** Identity of the first surviving message — a cheap "still the same tail". */
  tailFirst: Message | undefined
  tailCount: number
}

export class MidTurnAutocompactor {
  private memo: Memo | null = null
  /**
   * Loop index that maps to `session.messages[0]`: 0 before the first
   * compaction, the split index of the most recent one afterwards. Keeps the
   * second compaction in a turn from re-summarizing what is already summarized.
   */
  private baseIndex = 0
  private lastCompactionTokens = 0
  /**
   * When the previous `transform` returned. A gap longer than
   * `idleCompactAfterMs` means the loop was off the model (a `wait`, a
   * blocking subagent/project call, a long `exec`) and the prompt cache is
   * cold, so the summary is free and the next cache write is smaller.
   */
  private lastTransformAt = 0
  private manualRequested = false
  private compacting = false

  constructor(private readonly opts: MidTurnAutocompactOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** Ask for a compaction at the next step (the dock's manual button). */
  requestManual(): void {
    this.manualRequested = true
  }

  /** Whether a manual request is still pending (used to answer the route). */
  get hasPendingManualRequest(): boolean {
    return this.manualRequested
  }

  /** True once this turn has folded anything away. */
  get didCompact(): boolean {
    return this.memo !== null
  }

  /**
   * Transform the messages for one API call. Never throws: a compaction that
   * fails returns the messages untouched so the turn keeps running.
   */
  async transform(messages: Message[]): Promise<{
    messages: Message[]
    event: ContextSummarizedEvent | null
  }> {
    try {
      return await this.transformOnce(messages)
    } finally {
      // Start the idle clock when the call to the model would begin: the gap
      // before the *next* transform is time this loop spent off the model.
      this.lastTransformAt = this.now()
    }
  }

  private async transformOnce(messages: Message[]): Promise<{
    messages: Message[]
    event: ContextSummarizedEvent | null
  }> {
    // After a compaction in this turn the wire gets the memoized array; its
    // size (not the raw loop array's) is what the next request costs.
    const wire = this.memo ? this.withMemo(messages) : messages
    const estimate = this.estimate(wire)
    const reason = this.compactionReason(estimate)
    if (reason === null) return { messages: wire, event: null }

    const splitIndex =
      (this.opts.tailBudgetTokens
        ? splitIndexForTokenBudget(messages, {
            tailBudgetTokens: this.opts.tailBudgetTokens,
            minKeepMessages: this.opts.minKeepMessages ?? 1,
            maxKeepMessages: this.opts.keepRecentMessages,
          })
        : null) ?? splitIndexForCompaction(messages, this.opts.keepRecentMessages)
    if (splitIndex === null) {
      // Nothing to fold away (too few messages) — honest no-op.
      this.manualRequested = false
      return { messages: wire, event: null }
    }

    const continuing = this.memo !== null
    const head = messages.slice(this.baseIndex, splitIndex)
    if (head.length === 0) {
      this.manualRequested = false
      return { messages: wire, event: null }
    }

    this.compacting = true
    try {
      const summary = await this.opts.summarize(head, this.memo?.summary)
      if (!summary.trim()) {
        this.manualRequested = false
        return { messages: wire, event: null }
      }
      const trigger: 'auto' | 'manual' = this.manualRequested ? 'manual' : 'auto'
      this.opts.apply(summary, splitIndex - this.baseIndex, { replaceSummary: continuing })

      const prefix = buildSummaryPrefixMessages(summary)
      this.memo = {
        summary,
        prefix,
        tailStart: splitIndex,
        tailFirst: messages[splitIndex],
        tailCount: messages.length - splitIndex,
      }
      this.baseIndex = splitIndex

      const emitted = [...prefix, ...messages.slice(splitIndex)]
      const tokensAfter = this.estimate(emitted)
      this.lastCompactionTokens = tokensAfter
      this.manualRequested = false

      return {
        messages: emitted,
        event: {
          trigger,
          reason,
          tokensBefore: estimate,
          tokensAfter,
          messagesBefore: wire.length,
          messagesAfter: emitted.length,
          summaryChars: summary.length,
        },
      }
    } catch (err: any) {
      console.warn(`[MidTurnAutocompact] Summarization failed, keeping raw context: ${err?.message}`)
      this.manualRequested = false
      return { messages: wire, event: null }
    } finally {
      this.compacting = false
    }
  }

  private compactionReason(estimate: number): 'cap' | 'idle' | null {
    if (this.manualRequested && !this.compacting) return 'cap'
    if (this.idleGapOverThreshold() && estimate > (this.opts.idleCompactFloorTokens ?? 0)) return 'idle'
    if (estimate <= this.opts.autoCompactTokens) return null
    if (this.lastCompactionTokens > 0) {
      const minDelta = this.opts.minDeltaTokens ?? DEFAULT_AUTOCOMPACT_MIN_DELTA_TOKENS
      if (estimate - this.lastCompactionTokens < minDelta) return null
    }
    return 'cap'
  }

  /**
   * Whether the loop has been off the model long enough that the prompt cache
   * is cold. The idle path deliberately bypasses `minDeltaTokens`: there is no
   * warm cache to protect, so the delta guard has nothing to buy.
   */
  private idleGapOverThreshold(): boolean {
    const afterMs = this.opts.idleCompactAfterMs ?? 0
    if (afterMs <= 0 || this.lastTransformAt === 0) return false
    return this.now() - this.lastTransformAt > afterMs
  }

  /**
   * The memoized prefix plus the surviving tail of the live message array.
   * The tail is located by identity, so a rebuilt array (history rewrite) still
   * emits exactly the messages it emitted before.
   */
  private withMemo(messages: Message[]): Message[] {
    const memo = this.memo!
    let tailStart = memo.tailStart
    if (messages[tailStart] !== memo.tailFirst) {
      const found = memo.tailFirst ? messages.indexOf(memo.tailFirst) : -1
      tailStart = found >= 0 ? found : Math.max(0, messages.length - memo.tailCount)
    }
    return [...memo.prefix, ...messages.slice(tailStart)]
  }

  private estimate(messages: Message[]): number {
    let tokens = 0
    for (const msg of messages) tokens += estimateMessageTokens(msg)
    return tokens + (this.opts.promptOverheadTokens ?? 0)
  }
}
