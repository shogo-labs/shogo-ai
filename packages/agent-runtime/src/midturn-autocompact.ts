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
  /**
   * The prompt overhead (system prompt + advertised tool schemas) this
   * compaction's estimates included, so a prod row can say how much of
   * `tokensAfter` is tool definitions rather than conversation (SHO-381).
   */
  promptOverheadTokens: number
  /**
   * Tool results variant B dropped from the kept tail (0 = none). Without it a
   * prod row cannot answer whether B1 is actually dropping anything (SHO-381).
   */
  droppedToolResults: number
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
   * folds in the previous one. Returns what the session now holds — the
   * persisted summary (which carries the facts block) and its messages after
   * the compaction — so the memo emits the session rather than a summary of its
   * own making.
   */
  apply: (
    summary: string,
    splitIndex: number,
    opts: { replaceSummary: boolean },
  ) => { summary?: string; kept?: Message[]; droppedToolResults?: number } | void
  /**
   * System prompt + tool schema tokens, counted in the trigger and the event.
   *
   * A function is read on every call, because the advertised tool set changes
   * mid-turn (a `read_guide` activation, a `connect` hot-add) and only the
   * schemas that are actually sent cost anything (SHO-381).
   */
  promptOverheadTokens?: number | (() => number)
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
  /**
   * The tail as the session holds it after the compaction, when it differs from
   * the loop array (variant B rewrote some results). `null` when nothing was
   * rewritten, so the memo slices the live array exactly as before.
   */
  keptTail: Message[] | null
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
    } catch (err: any) {
      // A throwing overhead reader is a bug, not a reason to send a request
      // with no compaction decision: log it loudly and keep the turn running
      // on the memoized (or raw) context. Never fall back to a zero overhead —
      // that silently disables the trigger, which is the failure this class
      // exists to prevent (SHO-381).
      console.warn(`[MidTurnAutocompact] transform failed, keeping current context: ${err?.message}`)
      return { messages: this.memo ? this.withMemo(messages) : messages, event: null }
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
    // Read once per call: the advertised set can change mid-turn, and the same
    // number must be used for `tokensBefore` and `tokensAfter` so the event's
    // `promptOverheadTokens` is exactly what the estimates included.
    const overheadTokens = this.overhead()
    const estimate = this.estimate(wire, overheadTokens)
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
      const applied = this.opts.apply(summary, splitIndex - this.baseIndex, { replaceSummary: continuing })
      // The session's summary carries the deterministic facts block; without it
      // the emitted prefix would differ from `buildHistory` for the same
      // session (the mid-turn wire used to drop the ground truth).
      const effectiveSummary = applied?.summary || summary
      const kept = applied?.kept
      const tail = messages.slice(splitIndex)
      // Only a variant that rewrote the tail needs a snapshot; otherwise the
      // live array stays authoritative (byte-identical to before the feature).
      const keptTail = kept && kept !== tail && kept.some((m, i) => m !== tail[i]) ? kept : null

      const prefix = buildSummaryPrefixMessages(effectiveSummary)
      this.memo = {
        summary: effectiveSummary,
        prefix,
        tailStart: splitIndex,
        tailFirst: messages[splitIndex],
        tailCount: messages.length - splitIndex,
        keptTail,
      }
      this.baseIndex = splitIndex

      const emitted = [...prefix, ...(keptTail ?? messages.slice(splitIndex))]
      const tokensAfter = this.estimate(emitted, overheadTokens)
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
          summaryChars: effectiveSummary.length,
          promptOverheadTokens: overheadTokens,
          droppedToolResults: applied?.droppedToolResults ?? 0,
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
    if (!memo.keptTail) return [...memo.prefix, ...messages.slice(tailStart)]
    // The snapshot holds the first `keptTail.length` messages of the tail as the
    // session has them; anything the loop appended since is still live.
    return [...memo.prefix, ...memo.keptTail, ...messages.slice(tailStart + memo.keptTail.length)]
  }

  private estimate(messages: Message[], overheadTokens: number): number {
    let tokens = 0
    for (const msg of messages) tokens += estimateMessageTokens(msg)
    return tokens + overheadTokens
  }

  /**
   * The prompt overhead for the request about to be sent. Read per call: the
   * advertised tool set can change mid-turn, and a deferred tool's schema is
   * not in the request at all (SHO-381). A throwing reader propagates to
   * `transform`, which logs it — swallowing it here would silently disable the
   * trigger.
   */
  private overhead(): number {
    const overhead = this.opts.promptOverheadTokens
    return typeof overhead === 'function' ? overhead() : (overhead ?? 0)
  }
}
