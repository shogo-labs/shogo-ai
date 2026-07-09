// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatPanel send/queue wedge — recovery contract.
 *
 * Regression history: the staging incident on session
 * `8af6be85-e4c0-43aa-994a-b9ea7ab45ca0` ended with `useChat().status`
 * pinned at `'submitted'` / `'streaming'` because a turn's body stream
 * never closed. ChatPanel's `handleSendMessage` gate routes every send
 * through the queue while `isStreaming` is true, and the queue-drain
 * effect only fires on a `wasStreaming && !isStreaming` falling edge.
 * Without recovery, the queue grows forever and the user sees a
 * one-way mirror: their messages persist locally, no assistant reply
 * ever arrives.
 *
 * Required behavior:
 *   1. While `status` is `'submitted'` / `'streaming'` and forward
 *      progress is being observed, the queue gate continues to serialize
 *      sends correctly.
 *   2. When `status` stays non-terminal but no progress has been
 *      observed for longer than the watchdog threshold, the panel
 *      treats the turn as stalled, force-stops the chat (which sets
 *      status → `'ready'`), and drains the queue.
 *   3. The `isChatStalled` helper in
 *      `apps/mobile/lib/chat-stall-watchdog.ts` is the single source of
 *      truth for this decision; both the panel and these tests import it.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/chat-panel-wedge.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  isChatStalled,
  resolveProgressAfterVisibilityChange,
  DEFAULT_SUBMITTED_STALL_MS,
  DEFAULT_STREAMING_STALL_MS,
} from '../../../lib/chat-stall-watchdog'

// ---------------------------------------------------------------------------
// Mirror of `ChatPanel.tsx`'s send/queue state. We extract just enough to
// drive the gate without dragging in React, RN, or the navigation tree.
// The watchdog hook below mirrors the new stall-recovery effect that
// ChatPanel installs alongside the existing queue-drain effect.
// ---------------------------------------------------------------------------

type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'

interface QueuedMessage {
  id: string
  content: string
}

interface PanelState {
  status: ChatStatus
  stoppedMessages: unknown | null
  messageQueue: QueuedMessage[]
  isSendingMessage: boolean
  isProcessingQueue: boolean
  prevIsStreaming: boolean
  /** Wall-clock ms of the most recent forward-progress signal. */
  lastProgressAt: number
  /** Wall-clock ms now, advanced manually by tests via {@link advanceTime}. */
  now: number
  /** Whether the watchdog has already fired and force-stopped this turn. */
  watchdogTripped: boolean
  /** counts of side-effects we care about */
  addMessageCalls: Array<{ sessionId: string; content: string }>
  sendMessageCalls: Array<{ chatSessionId: string; text: string }>
  /** user-facing identity the panel is bound to */
  currentSessionId: string
}

function freshState(currentSessionId = 'session-typed'): PanelState {
  return {
    status: 'ready',
    stoppedMessages: null,
    messageQueue: [],
    isSendingMessage: false,
    isProcessingQueue: false,
    prevIsStreaming: false,
    lastProgressAt: 0,
    now: 0,
    watchdogTripped: false,
    addMessageCalls: [],
    sendMessageCalls: [],
    currentSessionId,
  }
}

function computeIsStreaming(s: PanelState): boolean {
  return (s.status === 'streaming' || s.status === 'submitted') && s.stoppedMessages === null
}

/**
 * Advances the simulated wall clock without firing any effects. Tests
 * call {@link tickStatusObserver} after this to let observers react.
 */
function advanceTime(state: PanelState, deltaMs: number): void {
  state.now += deltaMs
}

/**
 * Mirror of `handleSendMessage` in ChatPanel.tsx. The single gate is on
 * `isStreaming || isProcessingQueueRef || isSendingMessageRef`. When the
 * gate is open, sendMessageInternal runs synchronously enough that the
 * test can inspect addMessage / sendMessage call counts immediately.
 */
function handleSendMessage(state: PanelState, content: string): void {
  if (!state.currentSessionId) return
  if (!content.trim()) return

  if (computeIsStreaming(state) || state.isProcessingQueue || state.isSendingMessage) {
    state.messageQueue.push({
      id: `q-${state.messageQueue.length}`,
      content,
    })
    return
  }

  state.isSendingMessage = true
  try {
    state.addMessageCalls.push({ sessionId: state.currentSessionId, content })
    state.sendMessageCalls.push({ chatSessionId: state.currentSessionId, text: content })
    // The real send moves `status` to 'submitted' synchronously when it
    // invokes `chatRef.current.sendMessage`. Mirror that and stamp the
    // progress timestamp so the watchdog doesn't fire immediately.
    state.status = 'submitted'
    state.lastProgressAt = state.now
  } finally {
    state.isSendingMessage = false
  }
}

/**
 * Mirror of the queue-drain effect in ChatPanel.tsx.
 * Drains the queue exactly on the falling edge of `isStreaming`.
 */
function tickStatusObserver(state: PanelState): void {
  // --- Stall-recovery effect (new): if the watchdog fires, force-stop
  // the chat so the queue can drain. Mirrors `chat.stop()` →
  // `setStatus('ready')` in the AI SDK.
  if (
    !state.watchdogTripped &&
    isChatStalled({
      status: state.status,
      lastProgressAt: state.lastProgressAt,
      now: state.now,
    })
  ) {
    state.status = 'ready'
    state.watchdogTripped = true
  }

  const isStreaming = computeIsStreaming(state)
  const wasStreaming = state.prevIsStreaming
  state.prevIsStreaming = isStreaming

  if (wasStreaming && !isStreaming) {
    state.isProcessingQueue = false
    while (state.messageQueue.length > 0 && state.currentSessionId) {
      const next = state.messageQueue.shift()!
      state.isProcessingQueue = true
      try {
        state.addMessageCalls.push({ sessionId: state.currentSessionId, content: next.content })
        state.sendMessageCalls.push({ chatSessionId: state.currentSessionId, text: next.content })
        state.status = 'submitted'
        state.lastProgressAt = state.now
        state.watchdogTripped = false
        // Resetting prevIsStreaming so the next drain edge can fire.
        state.prevIsStreaming = true
      } finally {
        state.isProcessingQueue = false
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSendMessage / queue gate (ChatPanel.tsx mirror)', () => {
  let state: PanelState

  beforeEach(() => {
    state = freshState()
  })

  test('control: status=ready → message goes straight through to addMessage + sendMessage', () => {
    handleSendMessage(state, 'first message')

    expect(state.messageQueue).toHaveLength(0)
    expect(state.addMessageCalls).toEqual([
      { sessionId: 'session-typed', content: 'first message' },
    ])
    expect(state.sendMessageCalls).toEqual([
      { chatSessionId: 'session-typed', text: 'first message' },
    ])
    expect(state.status).toBe('submitted')
  })

  test('serialization: while a turn is genuinely in flight, follow-ups go to the queue', () => {
    handleSendMessage(state, 'first message')
    expect(state.status).toBe('submitted')

    // Advance the clock a little so the watchdog doesn't fire — we
    // want to assert the queue's serialization contract, not the
    // recovery branch.
    advanceTime(state, 500)
    for (let i = 1; i <= 5; i++) {
      handleSendMessage(state, `follow-up #${i}`)
    }

    expect(state.addMessageCalls).toHaveLength(1)
    expect(state.sendMessageCalls).toHaveLength(1)
    expect(state.messageQueue.map((m) => m.content)).toEqual([
      'follow-up #1',
      'follow-up #2',
      'follow-up #3',
      'follow-up #4',
      'follow-up #5',
    ])
  })

  test('normal completion: data-turn-complete arrives and the queue drains', () => {
    handleSendMessage(state, 'first message')
    tickStatusObserver(state)
    advanceTime(state, 500)
    for (let i = 1; i <= 3; i++) handleSendMessage(state, `follow-up #${i}`)

    state.status = 'ready'
    tickStatusObserver(state)

    expect(state.messageQueue).toHaveLength(0)
    expect(state.addMessageCalls).toHaveLength(4)
    expect(state.sendMessageCalls).toHaveLength(4)
  })

  test('recovery: a stalled "submitted" turn is force-stopped by the watchdog and the queue drains', () => {
    handleSendMessage(state, 'first message')
    tickStatusObserver(state)

    // User keeps typing while the turn appears to be in flight.
    advanceTime(state, 500)
    for (let i = 1; i <= 5; i++) handleSendMessage(state, `follow-up #${i}`)
    expect(state.messageQueue).toHaveLength(5)
    expect(state.sendMessageCalls).toHaveLength(1)

    // The status stays pinned at 'submitted' (stream never closes).
    // After the watchdog threshold elapses with no progress, the next
    // observer tick should force-stop the chat AND drain the queue in
    // the same pass. We don't assert `watchdogTripped` here because
    // the drain loop resets it after dispatching each queued message
    // so a future stall on the new turn can also be recovered.
    advanceTime(state, DEFAULT_SUBMITTED_STALL_MS + 1000)
    tickStatusObserver(state)

    expect(state.messageQueue).toHaveLength(0)
    expect(state.sendMessageCalls).toHaveLength(6)
    expect(state.addMessageCalls).toHaveLength(6)
  })

  test('recovery: no spurious force-stop while the stream is making forward progress', () => {
    handleSendMessage(state, 'first message')
    tickStatusObserver(state)

    // Simulate 10 progress signals (e.g. text-delta callbacks) spaced
    // well inside the watchdog threshold. The watchdog must NOT fire.
    for (let i = 0; i < 10; i++) {
      advanceTime(state, Math.floor(DEFAULT_SUBMITTED_STALL_MS / 2))
      state.lastProgressAt = state.now
      state.status = 'streaming'
      tickStatusObserver(state)
    }

    expect(state.watchdogTripped).toBe(false)
    expect(state.status).toBe('streaming')
  })

  test('recovery: a stalled "streaming" turn is force-stopped after the streaming threshold', () => {
    handleSendMessage(state, 'first message')
    state.status = 'streaming'
    state.lastProgressAt = state.now
    tickStatusObserver(state)
    advanceTime(state, 500)
    handleSendMessage(state, 'follow-up while streaming')
    expect(state.messageQueue).toHaveLength(1)

    // Below the streaming threshold → no recovery yet.
    advanceTime(state, DEFAULT_SUBMITTED_STALL_MS + 1000)
    tickStatusObserver(state)
    expect(state.watchdogTripped).toBe(false)
    expect(state.messageQueue).toHaveLength(1)

    // Past the streaming threshold → watchdog fires, queue drains.
    // We don't assert `watchdogTripped` here because the drain loop
    // legitimately resets it after dispatching the queued message so a
    // future stall on the new turn can also be recovered.
    advanceTime(state, DEFAULT_STREAMING_STALL_MS)
    tickStatusObserver(state)
    expect(state.messageQueue).toHaveLength(0)
    expect(state.sendMessageCalls).toHaveLength(2)
  })
})

describe('isChatStalled — predicate semantics', () => {
  test("'ready' and 'error' are never stalled", () => {
    expect(isChatStalled({ status: 'ready', lastProgressAt: 0, now: 60_000_000 })).toBe(false)
    expect(isChatStalled({ status: 'error', lastProgressAt: 0, now: 60_000_000 })).toBe(false)
  })

  test("'submitted' becomes stalled at the submitted threshold", () => {
    const base = { status: 'submitted' as const, lastProgressAt: 0 }
    expect(isChatStalled({ ...base, now: DEFAULT_SUBMITTED_STALL_MS - 1 })).toBe(false)
    expect(isChatStalled({ ...base, now: DEFAULT_SUBMITTED_STALL_MS })).toBe(true)
  })

  test("'streaming' becomes stalled at the streaming threshold, not the submitted one", () => {
    const base = { status: 'streaming' as const, lastProgressAt: 0 }
    expect(isChatStalled({ ...base, now: DEFAULT_SUBMITTED_STALL_MS + 1 })).toBe(false)
    expect(isChatStalled({ ...base, now: DEFAULT_STREAMING_STALL_MS })).toBe(true)
  })

  test('callers can override thresholds for testing / mobile-background cases', () => {
    expect(
      isChatStalled({
        status: 'submitted',
        lastProgressAt: 0,
        now: 1_000,
        submittedThresholdMs: 500,
      }),
    ).toBe(true)
    expect(
      isChatStalled({
        status: 'streaming',
        lastProgressAt: 0,
        now: 1_000,
        streamingThresholdMs: 5_000,
      }),
    ).toBe(false)
  })

  test('negative elapsed (clock skew) never stalls', () => {
    expect(
      isChatStalled({ status: 'submitted', lastProgressAt: 10_000_000, now: 0 }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Sentry REACT-38 regression: backgrounded-tab false positives.
//
// ~half of `chat_stall_watchdog_tripped` events had `elapsedMs` far beyond the
// threshold (up to ~2h) — the signature of a hidden tab whose throttled/
// suspended `setInterval` + jumped `Date.now()` make the turn *look* stalled on
// refocus, even though it was alive (or already completed) server-side. Tripping
// there force-stopped healthy turns AND emitted false telemetry.
// ---------------------------------------------------------------------------
describe('isChatStalled — backgrounded tab must not trip (REACT-38)', () => {
  test('a huge elapsed does NOT stall while the document is hidden', () => {
    // 2 hours of "elapsed" — but purely from the tab being backgrounded.
    const twoHours = 2 * 60 * 60_000
    expect(
      isChatStalled({
        status: 'streaming',
        lastProgressAt: 0,
        now: twoHours,
        documentHidden: true,
      }),
    ).toBe(false)
    expect(
      isChatStalled({
        status: 'submitted',
        lastProgressAt: 0,
        now: twoHours,
        documentHidden: true,
      }),
    ).toBe(false)
  })

  test('the same elapsed DOES stall once foreground (documentHidden falsey)', () => {
    const twoHours = 2 * 60 * 60_000
    expect(
      isChatStalled({ status: 'streaming', lastProgressAt: 0, now: twoHours }),
    ).toBe(true)
  })
})

describe('resolveProgressAfterVisibilityChange — restart the window on refocus', () => {
  test('returning to foreground restarts the stall window at now', () => {
    expect(
      resolveProgressAfterVisibilityChange({ isVisibleNow: true, now: 5_000_000, lastProgressAt: 0 }),
    ).toBe(5_000_000)
  })

  test('staying hidden keeps the existing progress mark', () => {
    expect(
      resolveProgressAfterVisibilityChange({ isVisibleNow: false, now: 5_000_000, lastProgressAt: 42 }),
    ).toBe(42)
  })

  test('end-to-end: a long background stint does not trip on the first foreground tick', () => {
    // Turn started at t=0, tab hidden the whole time, user returns at t=2h.
    const now = 2 * 60 * 60_000
    // While hidden the watchdog would have been suppressed by documentHidden.
    expect(isChatStalled({ status: 'streaming', lastProgressAt: 0, now, documentHidden: true })).toBe(false)
    // On refocus we restart the window, so the very next foreground tick is NOT
    // an instant stall — the turn gets a fresh threshold to show progress /
    // auto-resume reattach.
    const restarted = resolveProgressAfterVisibilityChange({ isVisibleNow: true, now, lastProgressAt: 0 })
    expect(isChatStalled({ status: 'streaming', lastProgressAt: restarted, now })).toBe(false)
    // ...and it still trips if it stays dead past the threshold after refocus.
    expect(
      isChatStalled({
        status: 'streaming',
        lastProgressAt: restarted,
        now: now + DEFAULT_STREAMING_STALL_MS,
      }),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Real AI SDK `Chat` class — invariant the watchdog exists to compensate for.
//
// `AbstractChat.makeRequest` blocks on `reader.read()` until the body
// stream closes; there is no internal timeout. This test pins that
// invariant so it stays visible: if the SDK ever grows its own stall
// detection, we can revisit the panel watchdog. Until then, the panel
// is the only layer that can break the wedge.
// ---------------------------------------------------------------------------

describe('AbstractChat with a non-terminating stream — SDK has no internal stall timer', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Chat } = require('@ai-sdk/react')

  // TODO(SHOG-???): this test exercises AbstractChat against a custom
  // transport returning a `ReadableStream<UIMessageChunk>`. On Bun the
  // SDK's internal `stream.pipeThrough(new TransformStream(...))` rejects
  // our Bun-constructed ReadableStream with
  //   `TypeError: readable should be ReadableStream`
  // — a Bun/ai-sdk web-streams interop issue, NOT a regression in the
  // panel watchdog or the SDK's stall behavior. The test was added in
  // de26e770c and has never passed in CI (it landed via a directly-merged
  // branch on a red main; see the `push: branches: [main]` trigger added
  // in this same fix). Re-enable once the interop is sorted — likely by
  // constructing the test stream via `Readable.toWeb(Readable.from(...))`
  // or by importing `ReadableStream` from `stream/web` explicitly.
  test.skip('a transport whose stream never closes pins status at submitted/streaming until stop() is called', async () => {
    const stuckTransport = {
      sendMessages: async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        return new ReadableStream({
          start(controller) {
            const onAbort = () => {
              try {
                controller.error(new DOMException('aborted', 'AbortError'))
              } catch {
                /* already errored */
              }
            }
            if (abortSignal) {
              if (abortSignal.aborted) onAbort()
              else abortSignal.addEventListener('abort', onAbort, { once: true })
            }
          },
        })
      },
      reconnectToStream: async () => null,
    }

    const chat = new Chat({
      id: 'wedge-A',
      messages: [],
      transport: stuckTransport,
    })

    expect(chat.status).toBe('ready')
    void chat.sendMessage({ text: 'hello' })
    await new Promise((r) => setTimeout(r, 25))
    expect(['submitted', 'streaming']).toContain(chat.status)

    await new Promise((r) => setTimeout(r, 100))
    expect(['submitted', 'streaming']).toContain(chat.status)
    expect(chat.status).not.toBe('ready')
    expect(chat.status).not.toBe('error')

    await chat.stop()
    await new Promise((r) => setTimeout(r, 50))
    expect(chat.status).toBe('ready')
  })
})
