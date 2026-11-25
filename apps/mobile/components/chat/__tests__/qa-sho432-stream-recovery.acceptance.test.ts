// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-432 acceptance — a silent chat stream must not cost the person their turn.
 *
 * The card's four acceptance criteria, tested through the real modules the panel
 * calls (no mirrored copy of the logic):
 *
 *  AC1  Silence alone never ends a turn. The stall watchdog used to call
 *       `stop()` the moment client-side time crossed its threshold; every
 *       recorded trip sat at threshold + one 15 s tick (~133 s) against the
 *       120 s `submitted` threshold. The panel now asks the runtime's `/turn`
 *       probe first. `probeChatTurn` + `decideStallTrip` are driven here with a
 *       real Response so the composition — the part that shipped wrong — is
 *       what is asserted.
 *
 *  AC2  Recovery reattaches while the turn is still running server-side, and
 *       only gives up when the runtime says the turn is over (or never answers).
 *       The old budget was 4 probes (~9 s); an active answer at the last probe
 *       must still reconnect, and an active answer must never raise the
 *       "Runtime unreachable" banner.
 *
 *  AC3  A failed send carries a real message. `createAutoResumingFetch` wraps the
 *       chat POST; a non-2xx with an empty body (a bare 401/502 from the auth
 *       middleware, an evicted pod or the gateway) reached the AI SDK as
 *       `new Error('')`, which the panel rendered as a blank banner — Sentry
 *       SHOGO-ANDROID-5, 447 events across 108 users.
 *
 *  AC4  (the rate drop) is post-release telemetry; what can be pinned now is
 *       that each old failure path no longer exists in `ChatPanel`.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/qa-sho432-stream-recovery.acceptance.test.ts
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import {
  chatErrorMessage,
  createAutoResumingFetch,
  formatErrorMessage,
} from "@shogo/shared-app/chat"
import { probeChatTurn, probeChatTurnBounded } from "../probe-turn-status"
import {
  decideStallRecovery,
  decideStallTrip,
  DEFAULT_STALL_KEEP_ALIVES,
  getStallRecoveryEffects,
} from "../stall-recovery"

const TURN_URL = "https://api.example.com/api/projects/p1/chats/s1/turn"
const CHAT_POST_URL = "https://api.example.com/api/projects/p1/chats/s1/stream"
const SILENT_LOGGER = { warn: () => {}, log: () => {} }

const jsonFetch = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch

const failingFetch = (status: number, body: BodyInit | null = null) =>
  (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch

/** What the AI SDK does with a non-2xx chat response. */
async function aiSdkSendError(
  status: number,
  body: BodyInit | null,
): Promise<Error> {
  const fetcher = createAutoResumingFetch(failingFetch(status, body), {
    logger: SILENT_LOGGER,
  })
  const response = await fetcher(CHAT_POST_URL, { method: "POST" })
  // postToApi: `const text = await response.text(); throw new Error(text)`.
  return new Error(await response.text())
}

describe("AC1 — a silent stream asks the runtime before it kills the turn", () => {
  test("a runtime that reports the turn active keeps the panel attached", async () => {
    const snapshot = await probeChatTurn({
      url: TURN_URL,
      fetch: jsonFetch({ status: "active", turnId: "turn-1" }),
    })

    expect(snapshot).toEqual({ status: "active", turnId: "turn-1", answered: true })
    // The old watchdog called stop() here, aborting a live turn.
    expect(
      decideStallTrip({ turnStatus: snapshot.status, answered: snapshot.answered }),
    ).toBe("stay-attached")
  })

  test("a second full window of silence drops the dead body and reattaches — it does not give up", async () => {
    const snapshot = await probeChatTurn({
      url: TURN_URL,
      fetch: jsonFetch({ status: "active", turnId: "turn-2" }),
    })

    const decision = decideStallTrip({
      turnStatus: snapshot.status,
      answered: snapshot.answered,
      keptAlive: DEFAULT_STALL_KEEP_ALIVES,
    })
    // "stop" is the give-up path (banner + Retry that re-runs the work).
    expect(decision).toBe("stop-and-reattach")
  })

  test("a turn the runtime says is over reloads saved history instead of claiming it is unreachable", async () => {
    for (const status of ["completed", "failed", "aborted"] as const) {
      const snapshot = await probeChatTurn({
        url: TURN_URL,
        fetch: jsonFetch({ status, turnId: "turn-3" }),
      })
      expect(snapshot.answered).toBe(true)
      expect(
        decideStallTrip({ turnStatus: snapshot.status, answered: snapshot.answered }),
      ).toBe("stop-and-reload")
    }
  })

  test("a probe that could not reach the runtime is not evidence the turn ended", async () => {
    for (const status of [503, 500, 429]) {
      const snapshot = await probeChatTurn({
        url: TURN_URL,
        fetch: failingFetch(status),
      })
      expect(snapshot).toEqual({ status: "unknown", turnId: null, answered: false })
      // Nothing confirmed a live turn: break the wedge rather than hang on it.
      expect(
        decideStallTrip({ turnStatus: snapshot.status, answered: snapshot.answered }),
      ).toBe("stop")
    }

    const thrown = await probeChatTurn({
      url: TURN_URL,
      fetch: (async () => {
        throw new TypeError("network error")
      }) as unknown as typeof globalThis.fetch,
    })
    expect(thrown.answered).toBe(false)
  })

  test("the probe every stall path uses can never outlive its timeout", async () => {
    // Round 1 sent this back: both stall probes were unbounded, so a half-open
    // socket never settled the fetch — the watchdog's in-flight latch stayed
    // taken and the recovery loop sat in "recovering" forever, which is the
    // same "nothing comes back" the probe exists to prevent.
    let sawSignal = false
    const hung = ((_input: unknown, init?: RequestInit) => {
      sawSignal = Boolean(init?.signal)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        )
      })
    }) as unknown as typeof globalThis.fetch

    const startedAt = Date.now()
    const snapshot = await probeChatTurnBounded({ url: TURN_URL, fetch: hung }, 80)
    expect(sawSignal).toBe(true)
    // An abort means "the runtime told us nothing", which every caller handles.
    expect(snapshot.answered).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  test("a caller's own signal still owns the probe's lifetime", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | null | undefined
    const fetchFn = ((_input: unknown, init?: RequestInit) => {
      seen = init?.signal
      return Promise.resolve(
        new Response(JSON.stringify({ status: "unknown" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof globalThis.fetch

    await probeChatTurnBounded({ url: TURN_URL, fetch: fetchFn, signal: controller.signal }, 80)
    expect(seen).toBe(controller.signal)
  })
})

describe("AC2 — recovery reattaches while the turn runs, and only gives up when it is over", () => {
  test("an active answer on the very last probe still reconnects", () => {
    // The budget that shipped was 4 probes (~9 s); the runtime was still running
    // the turn at attempt 4 (Sentry REACT-5Z / SHOGO-ANDROID-V).
    const input = { turnStatus: "active" as const, attempt: 12, maxAttempts: 12 }
    expect(decideStallRecovery(input)).toBe("reconnect")

    const effects = getStallRecoveryEffects(input)
    expect(effects.showRetryBanner).toBe(false)
    expect(effects.interruptStuckTools).toBe(false)
  })

  test("only an exhausted, unanswered poll gives up and shows the banner", () => {
    const input = { turnStatus: "unknown" as const, attempt: 12, maxAttempts: 12 }
    expect(decideStallRecovery(input)).toBe("give-up")
    expect(getStallRecoveryEffects(input).showRetryBanner).toBe(true)
    // Still time left: keep probing rather than telling the person it failed.
    expect(
      decideStallRecovery({ turnStatus: "unknown", attempt: 11, maxAttempts: 12 }),
    ).toBe("retry-later")
  })

  test("ChatPanel wires the new decisions: probe first, reattach from the buffer, no re-send", () => {
    const panel = readFileSync(
      join(import.meta.dir, "..", "ChatPanel.tsx"),
      "utf8",
    )

    // The watchdog effect: from the probe comment to the end of the interval.
    const watchdogStart = panel.indexOf("Client-side time alone does not say the turn is dead")
    expect(watchdogStart).toBeGreaterThan(-1)
    const watchdog = panel.slice(watchdogStart, panel.indexOf("}, intervalMs)", watchdogStart))

    // The stall probe must be bounded: an unbounded one leaves the in-flight
    // latch taken forever when a socket dies without settling the fetch.
    const probeAt = watchdog.indexOf("await probeChatTurnBounded({")
    const decideAt = watchdog.indexOf("decideStallTrip({")
    const stopAt = watchdog.indexOf("void stop()")
    expect(probeAt).toBeGreaterThan(-1)
    expect(decideAt).toBeGreaterThan(probeAt)
    // No stop() before the probe's answer has been turned into a decision.
    expect(stopAt).toBeGreaterThan(decideAt)

    // Keeping a live turn gives it a fresh window.
    const keepAliveAt = watchdog.indexOf('decision === "stay-attached"')
    expect(keepAliveAt).toBeGreaterThan(-1)
    expect(
      watchdog.slice(keepAliveAt, watchdog.indexOf('decision === "stop-and-reattach"')).includes(
        "lastChatProgressAtRef.current = Date.now()",
      ),
    ).toBe(true)

    // Reattaching must not restart the work behind the person's back.
    const reattach = watchdog.slice(
      watchdog.indexOf('decision === "stop-and-reattach"'),
      watchdog.indexOf('decision === "stop-and-reload"'),
    )
    expect(reattach).toContain("void stop()")
    expect(reattach).not.toContain("sendMessage")
    expect(reattach).not.toContain("truncate")

    // Recovery budget: 12 probes, not 4.
    const recovery = panel.slice(panel.indexOf("const MAX_ATTEMPTS ="), panel.indexOf("setStreamAutoRecovering(true)"))
    expect(recovery).toMatch(/const MAX_ATTEMPTS = 12\b/)

    // A terminal answer paints saved history and never raises the stall banner.
    const recoveryBody = panel.slice(
      panel.indexOf("const outcome = decideStallGiveUp({"),
    )
    expect(recoveryBody.length).toBeGreaterThan(1)
    expect(recoveryBody.indexOf("catchUpAfterTurnEndedRef.current?.()")).toBeGreaterThan(-1)
    expect(recoveryBody).toContain("effects.showRetryBanner && !ended")
  })
})

describe("AC3 — a failed send always says why (SHOGO-ANDROID-5)", () => {
  test("a 401 with no body reaches the user as a message naming the status", async () => {
    const err = await aiSdkSendError(401, null)

    expect(chatErrorMessage(err)).toMatch(/401/)
    expect(chatErrorMessage(err).trim().length).toBeGreaterThan(0)
    expect(formatErrorMessage(err.message)).toMatch(/401/)
    // Never the blank banner / "No error message".
    expect(formatErrorMessage(err.message).trim().length).toBeGreaterThan(0)
  })

  test("a bare 502 from an evicted pod is readable too", async () => {
    const err = await aiSdkSendError(502, new Response(null).body)
    expect(formatErrorMessage(err.message)).toMatch(/502/)
  })

  test("the server's own error body is passed through untouched", async () => {
    const body = JSON.stringify({ error: { code: "rate_limited", message: "Slow down a moment." } })
    const err = await aiSdkSendError(429, body)
    expect(chatErrorMessage(err)).toContain("rate_limited")
    expect(formatErrorMessage(err.message)).toBe("Slow down a moment.")
  })

  test("a successful chat response is not wrapped in an error envelope", async () => {
    const fetcher = createAutoResumingFetch(
      (async () =>
        new Response("data: hello\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as unknown as typeof globalThis.fetch,
      { logger: SILENT_LOGGER },
    )
    const response = await fetcher(CHAT_POST_URL, { method: "POST" })
    expect(response.ok).toBe(true)
    expect(await response.text()).toContain("hello")
  })

  test("telemetry never records an empty message", async () => {
    const err = new Error("")
    expect(chatErrorMessage(err).trim().length).toBeGreaterThan(0)
  })
})
