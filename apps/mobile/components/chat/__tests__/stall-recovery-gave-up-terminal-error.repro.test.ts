// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRODUCTION of Sentry JAVASCRIPT-REACT-5Z — `chat_stall_recovery_gave_up`
 * (warning, tag turnStatus=unknown), new in release 9d6f93f2.
 *
 * Observed breadcrumbs (session 1e8018bd…, all on turnId=526efc2a…):
 *   11:37:01 Stream error: Minified React error #185
 *   11:37:02 stream ended without data-turn-complete (turnId=526efc2a…)   ← gated, no recovery
 *   11:38:49 POST /api/projects/…/chat → 402 (warning)
 *   11:38:54 Stream error: {"error":{"code":"usage_limit_reached",…}}
 *   11:38:54 Agent returned empty response — possible context corruption
 *   11:38:55 stream ended without data-turn-complete (turnId=526efc2a…)   ← SAME, stale turn id
 *   11:38:59…11:39:13 GET /api/projects/…/turn (warning ×4)              ← probes 404
 *   → chat_stall_recovery_gave_up { turnStatus: "unknown" }
 *
 * Chain reproduced here with the REAL helpers:
 *   1. ChatPanel only updates `currentTurnIdRef` / `turnCompletedRef` on a
 *      `data-turn-start` / `data-turn-complete` frame. A send rejected by the
 *      API's usage-limit gate (project-chat.ts: `return c.json({error}, 402)`)
 *      never emits `data-turn-start`, so the refs still describe the PREVIOUS
 *      turn — which itself ended without turn-complete (React #185).
 *   2. The rising edge of `isStreaming` clears `renderDepthErrorTurnIdRef`, and
 *      the #185 turn was never marked recovered, so `shouldAutoRecoverStalledTurn`
 *      now returns true for that stale turn id.
 *   3. The previous turn's runtime buffer was evicted (COMPLETED_GRACE_MS=30s),
 *      so runtime `/agent/chat/:id/turn` → 404 {status:"unknown"}, the API
 *      proxy forwards 404, `probeChatTurnStatus` → "unknown".
 *   4. After MAX_ATTEMPTS=4 unknown probes `getStallRecoveryEffects` → give-up
 *      → ChatPanel captures `chat_stall_recovery_gave_up` with turnStatus
 *      "unknown" and replaces the banner with the stall "tap Retry" message.
 *
 * FIXED: `sendMessageInternal` now forgets the previous turn when a send
 * starts (`currentTurnIdRef = null`, `turnCompletedRef = true`), so a send the
 * API rejects before `data-turn-start` can't be mistaken for a stall. And a
 * persistently-unknown probe now reloads history rather than showing the
 * "tap Retry" banner.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/stall-recovery-gave-up-terminal-error.repro.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test"
import { StreamBufferStore } from "../../../../../packages/core/src/stream-buffer"
import { probeChatTurnStatus, type ChatTurnStatus } from "../probe-turn-status"
import {
  getStallRecoveryEffects,
  shouldAutoRecoverStalledTurn,
} from "../stall-recovery"

const SESSION = "1e8018bd-1bd8-4b70-a4bf-6fb6cd92de96"
const PREV_TURN = "526efc2a-aa2d-478"
const TURN_URL = `https://studio.shogo.ai/api/projects/7adcdb1b/chat/${SESSION}/turn`
const MAX_ATTEMPTS = 4 // ChatPanel attemptStallRecovery

/**
 * Mirrors runtime `GET /agent/chat/:id/turn` (agent-runtime server.ts) as
 * forwarded by the API proxy (project-chat.ts): 404 {status:"unknown"} when the
 * buffer is gone, otherwise the snapshot JSON.
 */
function turnEndpointFetch(store: StreamBufferStore): typeof fetch {
  return (async () => {
    const snap = store.snapshot(SESSION)
    if (!snap) {
      return new Response(JSON.stringify({ status: "unknown" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ chatSessionId: SESSION, ...snap }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

/** Minimal mirror of the ChatPanel refs involved in the falling-edge effect. */
function makePanelRefs() {
  return {
    currentTurnId: null as string | null,
    turnCompleted: false,
    renderDepthErrorTurnId: null as string | null,
    recoveredTurnId: null as string | null,
    userInitiatedStop: false,
  }
}
type Refs = ReturnType<typeof makePanelRefs>

// sendMessageInternal, right before sendMessage()
const onSendStart = (r: Refs) => {
  r.currentTurnId = null
  r.turnCompleted = true
}
// isStreaming rising edge (ChatPanel ~3741)
const onStreamStart = (r: Refs) => {
  r.renderDepthErrorTurnId = null
}
// data-turn-start frame (ChatPanel ~2464)
const onTurnStart = (r: Refs, turnId: string) => {
  if (turnId !== r.currentTurnId) {
    r.currentTurnId = turnId
    r.turnCompleted = false
  }
}
// onError with React #185 (ChatPanel ~2016)
const onRenderDepthError = (r: Refs) => {
  r.renderDepthErrorTurnId = r.currentTurnId
}
// isStreaming falling edge (ChatPanel ~3746); returns true if recovery launches
const onStreamEnd = (r: Refs): boolean => {
  if (!r.currentTurnId || r.turnCompleted) return false
  const stalledTurnId = r.currentTurnId
  if (
    shouldAutoRecoverStalledTurn({
      stalledTurnId,
      recoveredTurnId: r.recoveredTurnId,
      renderDepthErrorTurnId: r.renderDepthErrorTurnId,
      userInitiatedStop: r.userInitiatedStop,
    })
  ) {
    r.recoveredTurnId = stalledTurnId
    return true
  }
  return false
}

/** attemptStallRecovery loop (ChatPanel ~6142), minus backoff sleeps. */
async function runStallRecovery(fetchFn: typeof fetch) {
  const captures: Array<{ message: string; tags: { turnStatus: ChatTurnStatus }; attempt: number }> = []
  let showRetryBanner = false
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const turnStatus = await probeChatTurnStatus({ url: TURN_URL, fetch: fetchFn })
    const effects = getStallRecoveryEffects({ turnStatus, attempt, maxAttempts: MAX_ATTEMPTS })
    if (effects.action === "reconnect") return { outcome: "reconnect" as const, captures, showRetryBanner }
    if (effects.action === "reload-history") {
      if (turnStatus === "unknown") {
        captures.push({ message: "chat_stall_recovery_gave_up", tags: { turnStatus }, attempt })
      }
      showRetryBanner = effects.showRetryBanner
      return { outcome: "reload-history" as const, captures, showRetryBanner }
    }
  }
  return { outcome: "exhausted" as const, captures, showRetryBanner }
}

const realNow = Date.now
afterEach(() => {
  Date.now = realNow
})

describe("REPRODUCTION JAVASCRIPT-REACT-5Z: usage-limit send after a #185 turn reports a false stall give-up", () => {
  test("a rejected send no longer launches recovery for the previous turn's stale id", async () => {
    let now = 1_000_000
    Date.now = () => now
    const store = new StreamBufferStore()
    const refs = makePanelRefs()

    // 11:36:27 — turn 526efc2a starts; server buffers it.
    onStreamStart(refs)
    const writer = store.create(SESSION, { turnId: PREV_TURN })
    onTurnStart(refs, PREV_TURN)
    writer.append(new TextEncoder().encode("data: {}\n\n"))

    // 11:37:01 — client render loop (#185) kills the stream before turn-complete.
    onRenderDepthError(refs)
    expect(onStreamEnd(refs)).toBe(false) // correctly gated: no recovery for #185
    writer.complete()                      // server finishes the turn anyway

    // ~70s later the completed buffer is past its 30s grace and swept.
    now += 70_000
    store.cleanup()
    expect(store.snapshot(SESSION)).toBeNull()

    // 11:38:49 — user sends again; API returns 402 usage_limit_reached JSON.
    // No data-turn-start / data-turn-complete ever arrives.
    onSendStart(refs)
    onStreamStart(refs)
    // (onError fires with the usage_limit_reached body — not #185, so no gate.)
    const launched = onStreamEnd(refs)

    expect(refs.currentTurnId).toBeNull()
    expect(launched).toBe(false) // the 402 banner stays; no false stall recovery

    store.dispose()
  })

  test("a genuinely-unknown stalled turn reloads history instead of showing the stall banner", async () => {
    const store = new StreamBufferStore()
    const result = await runStallRecovery(turnEndpointFetch(store))
    expect(result.outcome).toBe("reload-history")
    expect(result.captures).toEqual([
      { message: "chat_stall_recovery_gave_up", tags: { turnStatus: "unknown" }, attempt: MAX_ATTEMPTS },
    ])
    expect(result.showRetryBanner).toBe(false)
    store.dispose()
  })

  test("probe path alone: the server's 404 for an evicted/never-started turn collapses to 'unknown'", async () => {
    const store = new StreamBufferStore()
    const res = await turnEndpointFetch(store)(TURN_URL)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ status: "unknown" })
    expect(await probeChatTurnStatus({ url: TURN_URL, fetch: turnEndpointFetch(store) })).toBe("unknown")
    store.dispose()
  })

  test("contrast: a completed turn still in grace reloads history without a give-up capture", async () => {
    const store = new StreamBufferStore()
    const w = store.create(SESSION, { turnId: PREV_TURN })
    w.complete()
    const result = await runStallRecovery(turnEndpointFetch(store))
    expect(result.outcome).toBe("reload-history")
    expect(result.captures).toEqual([])
    store.dispose()
  })
})
