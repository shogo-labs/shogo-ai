// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stall watchdog for the AI-SDK `useChat` lifecycle.
 *
 * Motivation: the AI SDK's `AbstractChat.makeRequest` consumer blocks
 * on `reader.read()` until the body stream closes. When the upstream
 * proxy cuts mid-turn AND `auto-resuming-fetch` exhausts its resume
 * budget while still inside an open `data:` frame, the durable body
 * can sit pinned without enqueuing or closing — the SDK never reaches
 * `setStatus('ready')` and `useChat()` stays in `'submitted'` /
 * `'streaming'` indefinitely.
 *
 * ChatPanel guards its `handleSendMessage` on
 * `isStreaming || isProcessingQueueRef || isSendingMessageRef`, so a
 * stuck status routes every subsequent user send to the queue, and the
 * drain effect — which only fires on a `wasStreaming && !isStreaming`
 * falling edge — never has a reason to run. Symptom in prod: the user
 * keeps typing for hours, every user row lands in the DB, no assistant
 * row ever lands, and the project's warm-pool pod is eventually
 * evicted for inactivity because no chat POST ever fires.
 *
 * This module exposes a single pure predicate so both the panel and
 * its tests reason about "is this turn stalled?" with the same logic.
 */

/**
 * The non-terminal AI-SDK statuses the watchdog is allowed to break.
 * `'ready'` and `'error'` are already exit states — the queue drain
 * effect handles `'ready'`, and `'error'` surfaces the failure via
 * `useChat().error`. We only force-stop when the SDK is wedged in a
 * transitional state.
 */
export type StalledChatStatus = 'submitted' | 'streaming'

/**
 * Default thresholds, chosen to be comfortably longer than any normal
 * turn boundary. `'submitted'` should flip to `'streaming'` within a
 * few seconds (the runtime emits `data-turn-start` as its first SSE
 * frame); a long pause there means the upstream POST never started.
 * `'streaming'` can take a while for a real long turn, so the bar is
 * deliberately high — we only act when the stream is unambiguously
 * dead.
 *
 * History: the submitted threshold was 30_000 until 2026-05-23, when a
 * production incident showed the watchdog tripping on legitimate
 * cold-start turns. The AI SDK only flips `useChat().status` →
 * `'streaming'` on the first `text-delta`, not on `data-turn-start` —
 * so when a project pod has a cold Composio session init (~300ms) +
 * a large system-prompt build (~18k tokens / 60+ tools) + Anthropic
 * TTFB on a ≥170k-token request, the gap between POST and first
 * text-delta routinely exceeds 30s. Raising to 120s gives p99
 * comfortable headroom; we also (a) reset the progress timestamp on
 * any wire byte (auto-resuming-fetch `onChunk`) and (b) reset on
 * every `data-*` callback (`useChat({ onData })`) so the watchdog
 * tracks actual liveness rather than AI-SDK status flips.
 */
export const DEFAULT_SUBMITTED_STALL_MS = 120_000
export const DEFAULT_STREAMING_STALL_MS = 180_000

export interface StallWatchdogState {
  /** Current AI-SDK status, as returned by `useChat()`. */
  status: 'ready' | 'submitted' | 'streaming' | 'error'
  /**
   * Wall-clock ms at which the most recent forward-progress signal was
   * observed. Forward progress = a status transition AWAY from `'ready'`
   * (start of a new turn), OR a message-delta callback firing while
   * streaming. The ChatPanel resets this on every `onData` /
   * `setMessages` write.
   */
  lastProgressAt: number
  /** Wall-clock ms now. Injected for deterministic tests. */
  now: number
  /** Override for `'submitted'` threshold (ms). Defaults to {@link DEFAULT_SUBMITTED_STALL_MS}. */
  submittedThresholdMs?: number
  /** Override for `'streaming'` threshold (ms). Defaults to {@link DEFAULT_STREAMING_STALL_MS}. */
  streamingThresholdMs?: number
  /**
   * Whether the tab/document is currently backgrounded (`document.visibilityState
   * === 'hidden'`). Browsers throttle `setInterval` to ≥1/min in hidden tabs and
   * the OS may suspend the page entirely, so `now - lastProgressAt` balloons far
   * past the threshold purely from time spent hidden — NOT from a dead turn. The
   * turn is very likely still streaming (or already completed) server-side, and
   * `auto-resuming-fetch` reattaches on refocus. Tripping here would force-stop a
   * healthy turn AND emit a false `chat_stall_watchdog_tripped` (Sentry REACT-38:
   * ~half of trips had elapsed ≫ threshold, up to ~2h). When hidden we never
   * stall; the caller restarts the window on the foreground transition via
   * {@link resolveProgressAfterVisibilityChange}.
   */
  documentHidden?: boolean
}

/**
 * Returns `true` when the chat is wedged long enough that the panel
 * should call `chat.stop()` to unblock the queue drain effect. The
 * caller is expected to react by invoking the SDK's `stop()` (which
 * transitions status → `'ready'` synchronously) and, optionally,
 * surfacing an error banner so the user knows the turn was lost.
 *
 * Returns `false` for `'ready'` and `'error'` — those are exit states
 * the panel already handles correctly.
 */
export function isChatStalled(state: StallWatchdogState): boolean {
  const { status, lastProgressAt, now } = state
  if (status === 'ready' || status === 'error') return false
  // Never trip while backgrounded — throttled/suspended timers make `elapsed`
  // meaningless and the turn is almost certainly alive server-side. See
  // `documentHidden` docs above (Sentry REACT-38).
  if (state.documentHidden) return false

  const elapsed = now - lastProgressAt
  if (elapsed < 0) return false // clock skew / future timestamp — never stall

  const threshold =
    status === 'submitted'
      ? state.submittedThresholdMs ?? DEFAULT_SUBMITTED_STALL_MS
      : state.streamingThresholdMs ?? DEFAULT_STREAMING_STALL_MS

  return elapsed >= threshold
}

/**
 * The wall-clock timestamp the watchdog should treat as the latest forward
 * progress after a visibility transition.
 *
 * Returning to the foreground restarts the stall window (returns `now`) so time
 * that accrued while the tab was hidden — when `setInterval` is throttled and
 * the turn may have completed server-side — never counts toward a stall. Any
 * other transition keeps the existing mark unchanged.
 *
 * Pairs with {@link StallWatchdogState.documentHidden}: `documentHidden` stops
 * the watchdog from tripping *while* hidden; this restarts the clock the moment
 * the user comes back so a long background stint doesn't instantly trip on the
 * first foreground tick.
 */
export function resolveProgressAfterVisibilityChange(opts: {
  /** True when the document just became visible (foreground). */
  isVisibleNow: boolean
  /** Wall-clock ms now. */
  now: number
  /** The current `lastProgressAt` mark. */
  lastProgressAt: number
}): number {
  return opts.isVisibleNow ? opts.now : opts.lastProgressAt
}
