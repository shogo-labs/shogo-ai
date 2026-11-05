// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Shared "SSE first, poll only while it is down" policy.
 *
 * Two studio IDE hooks used to carry their own copies of a fallback: one
 * flipped to a 3 s poll forever the first time the stream errored, the other
 * re-read the active file every 2 s whether or not SSE was healthy. Between
 * them that is ~72k proxied calls a day from one open tab (PERF-10).
 *
 * The policy here is deliberately one-directional:
 *
 *   • SSE always, and it is always retried. A failed stream schedules a retry
 *     at 2 → 4 → 8 → 16 → 30 s (capped); a successful open resets the ladder.
 *     Nothing ever settles into "poll forever".
 *   • Polling is a bridge, not a mode. It starts only after the first quick
 *     retry also fails (so a single proxy cut never costs a request), runs at
 *     15 s, slows to 30 s once the retry ladder is at its cap, and stops the
 *     moment a stream opens.
 *   • A hidden tab does nothing: no polls, no retries. Coming back to a
 *     visible tab while SSE is down retries immediately with the ladder reset.
 *
 * The caller owns the transport plumbing (`connect` / `poll`) so the same
 * policy drives an `EventSource` and an SDK subscription alike.
 */

export type StreamTransport = 'idle' | 'sse' | 'poll'

/** Retry ladder for a broken SSE stream; the last entry is the cap. */
export const SSE_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000]

/** Fallback poll cadence while the stream is down. */
export const POLL_INTERVAL_MS = 15_000
/** Fallback poll cadence once the retry ladder is capped. */
export const POLL_INTERVAL_CAPPED_MS = 30_000

/**
 * Polling starts on the Nth consecutive stream failure. With the default 2,
 * the first failure costs one retry and nothing else — a single dropped
 * connection never turns into request traffic.
 */
export const POLL_AFTER_FAILURES = 2

export interface StreamConnectHooks {
  /** The transport is connected and delivering. */
  onOpen(): void
  /** The transport broke (or failed to start). */
  onError(error?: unknown): void
}

export interface StreamFallbackOptions {
  /**
   * Open the stream. Return a disposer that closes it; the fallback calls the
   * disposer before every retry and on `stop()`.
   */
  connect(hooks: StreamConnectHooks): () => void
  /** One fallback poll. Called only while the stream is down and the tab is visible. */
  poll(): void | Promise<void>
  /** Default: always visible. Wire `document` / `AppState` here. */
  isVisible?(): boolean
  /** Subscribe to visibility changes so a hidden tab parks and a visible one resumes. */
  subscribeVisibility?(onChange: () => void): () => void
  /** Observable transport, for `transport` in a hook's return value and for tests. */
  onTransportChange?(transport: StreamTransport): void
  /** Test seams. */
  retryDelaysMs?: readonly number[]
  pollIntervalMs?: number
  pollIntervalCappedMs?: number
}

export interface StreamFallback {
  /** Connect now (unless the tab is hidden). Idempotent. */
  start(): void
  /** Tear everything down: stream, timers, visibility listener. */
  stop(): void
  transport(): StreamTransport
}

export function createStreamFallback(options: StreamFallbackOptions): StreamFallback {
  const delays = options.retryDelaysMs?.length
    ? options.retryDelaysMs
    : SSE_RETRY_DELAYS_MS
  const pollDelay = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const pollDelayCapped = options.pollIntervalCappedMs ?? POLL_INTERVAL_CAPPED_MS
  const isVisible = options.isVisible ?? (() => true)
  const capDelay = delays[delays.length - 1] ?? 0

  let started = false
  let transport: StreamTransport = 'idle'
  /** Consecutive stream failures; reset by an open. */
  let failures = 0
  /** Identifies the live connection so a late callback from a dead one is ignored. */
  let generation = 0
  let dispose: (() => void) | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribeVisibility: (() => void) | null = null

  const setTransport = (next: StreamTransport): void => {
    if (transport === next) return
    transport = next
    options.onTransportChange?.(next)
  }

  const clearRetry = (): void => {
    if (retryTimer === null) return
    clearTimeout(retryTimer)
    retryTimer = null
  }

  const clearPoll = (): void => {
    if (pollTimer === null) return
    clearTimeout(pollTimer)
    pollTimer = null
  }

  const closeStream = (): void => {
    generation += 1
    const d = dispose
    dispose = null
    if (!d) return
    try {
      d()
    } catch {
      /* best effort — a broken disposer must not wedge the loop */
    }
  }

  const retryDelay = (): number =>
    delays[Math.min(Math.max(0, failures - 1), delays.length - 1)] ?? capDelay

  // Read through a call so a narrowing from an earlier guard can't leak into a
  // timer callback that runs after `transport` has changed.
  const streamIsUp = (): boolean => transport === 'sse'

  const startPolling = (): void => {
    if (pollTimer !== null || !started) return
    if (streamIsUp() || !isVisible()) return
    const delay = retryDelay() >= capDelay ? pollDelayCapped : pollDelay
    pollTimer = setTimeout(() => {
      pollTimer = null
      if (!started || streamIsUp() || !isVisible()) return
      void (async () => {
        try {
          await options.poll()
        } catch {
          /* transient — the next tick retries */
        }
        // Re-arm after the poll resolves so a slow request can't stack up.
        if (started && !streamIsUp() && isVisible()) startPolling()
      })()
    }, delay)
  }

  const handleOpen = (): void => {
    if (!started) return
    failures = 0
    clearRetry()
    clearPoll()
    setTransport('sse')
  }

  const handleError = (): void => {
    if (!started) return
    closeStream()
    failures += 1
    // 'poll' means "the stream is down and the fallback owns the data" — the
    // first poll may still be a retry away.
    setTransport('poll')
    if (!isVisible()) return // a hidden tab schedules nothing
    retryTimer = setTimeout(() => {
      retryTimer = null
      connectNow()
    }, retryDelay())
    if (failures >= POLL_AFTER_FAILURES) startPolling()
  }

  const connectNow = (): void => {
    if (!started || !isVisible()) return
    clearRetry()
    closeStream()
    const token = generation
    const d = options.connect({
      onOpen: () => {
        if (token === generation) handleOpen()
      },
      onError: () => {
        if (token === generation) handleError()
      },
    })
    if (token !== generation) {
      // The connection failed before we even got its disposer.
      try {
        d()
      } catch {
        /* ignore */
      }
      return
    }
    dispose = d
  }

  const handleVisibility = (): void => {
    if (!started) return
    if (!isVisible()) {
      // Hidden: stop both loops. The stream itself is left alone; the browser
      // suspends it anyway and an open one keeps working.
      clearRetry()
      clearPoll()
      return
    }
    if (transport === 'sse') return
    // Back to a visible tab with the stream down: retry now, ladder reset.
    failures = 0
    clearPoll()
    connectNow()
  }

  return {
    start(): void {
      if (started) return
      started = true
      unsubscribeVisibility = options.subscribeVisibility?.(handleVisibility) ?? null
      if (!isVisible()) return
      connectNow()
    },
    stop(): void {
      started = false
      clearRetry()
      clearPoll()
      closeStream()
      if (unsubscribeVisibility) {
        try {
          unsubscribeVisibility()
        } catch {
          /* ignore */
        }
        unsubscribeVisibility = null
      }
      setTransport('idle')
    },
    transport(): StreamTransport {
      return transport
    },
  }
}

/**
 * `document.visibilityState` on web, `AppState` on native. Returns an
 * "always visible" stub where neither exists (SSR, headless tests).
 *
 * Kept here rather than in the helper's callers so both hooks see the same
 * notion of "the user is not looking at this tab".
 */
export function appVisibility(): {
  isVisible(): boolean
  subscribe(onChange: () => void): () => void
} {
  const globalDocument =
    typeof document !== 'undefined' ? (document as Document) : null
  if (globalDocument) {
    return {
      isVisible: () => globalDocument.visibilityState !== 'hidden',
      subscribe(onChange: () => void) {
        globalDocument.addEventListener('visibilitychange', onChange)
        return () => globalDocument.removeEventListener('visibilitychange', onChange)
      },
    }
  }
  const appState = loadAppState()
  if (!appState) {
    return { isVisible: () => true, subscribe: () => () => {} }
  }
  return {
    isVisible: () => appState.currentState === 'active',
    subscribe(onChange: () => void) {
      const sub = appState.addEventListener('change', onChange)
      return () => sub?.remove?.()
    },
  }
}

type AppStateLike = {
  currentState: string
  addEventListener(type: 'change', listener: () => void): { remove?: () => void } | undefined
}

/**
 * `react-native` is only present in the app bundle. Require it lazily so this
 * module stays importable from plain-Node tests and web builds.
 */
function loadAppState(): AppStateLike | null {
  try {
    if (typeof require !== 'function') return null
    const mod = require('react-native') as { AppState?: AppStateLike }
    return mod.AppState ?? null
  } catch {
    return null
  }
}
