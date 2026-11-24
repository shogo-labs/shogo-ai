// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the post-load "should I attach to /stream?" probe.
 *
 * Locks down two invariants:
 *   1. The probe is never the cause of a render — every failure mode
 *      (5xx, parse error, network throw, abort) collapses to `unknown`,
 *      which means "history is enough, do not attach".
 *   2. Only `status === 'active'` triggers the live-stream attach.
 *      Completed / failed / aborted turns are already represented in
 *      the loaded history, so re-attaching would race the history
 *      writer (the source of the "I see the same message twice" bug).
 *
 * Run: bun test apps/mobile/components/chat/__tests__/probe-turn-status.test.ts
 */

import { describe, expect, test } from "bun:test"
import {
  isLiveTurnOtherThan,
  normalizeTurnStatus,
  probeChatTurn,
  probeChatTurnBounded,
  probeChatTurnStatus,
  shouldAttachLiveStream,
  type ChatTurnStatus,
} from "../probe-turn-status"

describe("shouldAttachLiveStream", () => {
  test("attaches only when the turn is currently active", () => {
    expect(shouldAttachLiveStream("active")).toBe(true)
  })

  test.each<ChatTurnStatus>(["completed", "failed", "aborted", "unknown"])(
    "does NOT attach for status=%s",
    (status) => {
      expect(shouldAttachLiveStream(status)).toBe(false)
    },
  )
})

describe("normalizeTurnStatus", () => {
  test.each<ChatTurnStatus>(["active", "completed", "failed", "aborted"])(
    "passes known status through: %s",
    (s) => {
      expect(normalizeTurnStatus(s)).toBe(s)
    },
  )

  test("any unknown / malformed value → 'unknown'", () => {
    expect(normalizeTurnStatus(undefined)).toBe("unknown")
    expect(normalizeTurnStatus(null)).toBe("unknown")
    expect(normalizeTurnStatus("")).toBe("unknown")
    expect(normalizeTurnStatus("running")).toBe("unknown")
    expect(normalizeTurnStatus(42)).toBe("unknown")
    expect(normalizeTurnStatus({ status: "active" })).toBe("unknown")
  })
})

/**
 * Build a fake fetch that returns the given response shape, capturing
 * call arguments for assertions.
 */
function makeFetch(opts: {
  status?: number
  body?: unknown
  jsonThrows?: boolean
  fetchThrows?: Error
}) {
  const calls: Array<{ url: string; init: any }> = []
  const fn = (async (url: string, init: any) => {
    calls.push({ url, init })
    if (opts.fetchThrows) throw opts.fetchThrows
    return {
      ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
      status: opts.status ?? 200,
      async json() {
        if (opts.jsonThrows) throw new Error("malformed json")
        return opts.body
      },
    } as any
  }) as unknown as typeof globalThis.fetch
  return Object.assign(fn, { calls })
}

describe("probeChatTurnStatus", () => {
  test("returns 'active' for a real active-turn snapshot", async () => {
    const fetch = makeFetch({ status: 200, body: { status: "active", lastSeq: 42 } })
    const status = await probeChatTurnStatus({ url: "http://x/turn", fetch })
    expect(status).toBe("active")
  })

  test("returns 'completed' for a finished turn", async () => {
    const fetch = makeFetch({ status: 200, body: { status: "completed", lastSeq: 99 } })
    const status = await probeChatTurnStatus({ url: "http://x/turn", fetch })
    expect(status).toBe("completed")
  })

  test("404 (no buffer for this session) → 'unknown'", async () => {
    const fetch = makeFetch({ status: 404, body: { status: "unknown" } })
    const status = await probeChatTurnStatus({ url: "http://x/turn", fetch })
    expect(status).toBe("unknown")
  })

  test("204 (no body) → 'unknown'", async () => {
    const fetch = makeFetch({ status: 204 })
    const status = await probeChatTurnStatus({ url: "http://x/turn", fetch })
    expect(status).toBe("unknown")
  })

  test("5xx upstream → 'unknown' (probe failure must never block the UI)", async () => {
    const fetch = makeFetch({ status: 502 })
    const status = await probeChatTurnStatus({ url: "http://x/turn", fetch })
    expect(status).toBe("unknown")
  })

  test("network error → 'unknown' (no rethrow, never crashes the caller)", async () => {
    const fetch = makeFetch({ fetchThrows: new Error("ECONNREFUSED") })
    const status = await probeChatTurnStatus({ url: "http://x/turn", fetch })
    expect(status).toBe("unknown")
  })

  test("malformed JSON body → 'unknown'", async () => {
    const fetch = makeFetch({ status: 200, jsonThrows: true })
    const status = await probeChatTurnStatus({ url: "http://x/turn", fetch })
    expect(status).toBe("unknown")
  })

  test("unrecognised status string → 'unknown'", async () => {
    const fetch = makeFetch({ status: 200, body: { status: "running" } })
    const status = await probeChatTurnStatus({ url: "http://x/turn", fetch })
    expect(status).toBe("unknown")
  })

  test("forwards method=GET, headers, and credentials to the underlying fetch", async () => {
    const fetch = makeFetch({ status: 200, body: { status: "active" } })
    await probeChatTurnStatus({
      url: "http://x/turn",
      fetch,
      headers: { Cookie: "session=abc" },
      credentials: "include",
    })
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0].url).toBe("http://x/turn")
    expect(fetch.calls[0].init.method).toBe("GET")
    expect(fetch.calls[0].init.headers).toEqual({ Cookie: "session=abc" })
    expect(fetch.calls[0].init.credentials).toBe("include")
  })
})

describe("probeChatTurn", () => {
  test("surfaces the turn id beside the status", async () => {
    const fetch = makeFetch({
      status: 200,
      body: { status: "active", turnId: "turn-7", lastSeq: 3 },
    })
    expect(await probeChatTurn({ url: "http://x/turn", fetch })).toEqual({
      status: "active",
      turnId: "turn-7",
      answered: true,
    })
  })

  test("404 (no buffer for this session) → unknown with no turn id, answered", async () => {
    const fetch = makeFetch({ status: 404, body: { status: "unknown" } })
    expect(await probeChatTurn({ url: "http://x/turn", fetch })).toEqual({
      status: "unknown",
      turnId: null,
      answered: true,
    })
  })

  test("204 (no body) → unknown with no turn id, answered", async () => {
    const fetch = makeFetch({ status: 204 })
    expect(await probeChatTurn({ url: "http://x/turn", fetch })).toEqual({
      status: "unknown",
      turnId: null,
      answered: true,
    })
  })

  test("a snapshot without a turn id still reports its status", async () => {
    const fetch = makeFetch({ status: 200, body: { status: "completed" } })
    expect(await probeChatTurn({ url: "http://x/turn", fetch })).toEqual({
      status: "completed",
      turnId: null,
      answered: true,
    })
  })

  // `answered` is the difference between "the runtime says it has no turn"
  // and "I could not ask". Recovery gives up on the first and keeps trying on
  // the second — 4 blind probes is how REACT-5Z declared live turns dead.
  test("a 5xx is not an answer", async () => {
    const fetch = makeFetch({ status: 503, body: {} })
    expect(await probeChatTurn({ url: "http://x/turn", fetch })).toEqual({
      status: "unknown",
      turnId: null,
      answered: false,
    })
  })

  test("a thrown fetch is not an answer", async () => {
    const fetch = (async () => {
      throw new TypeError("network error")
    }) as unknown as typeof globalThis.fetch
    expect(await probeChatTurn({ url: "http://x/turn", fetch })).toEqual({
      status: "unknown",
      turnId: null,
      answered: false,
    })
  })

  test("a 200 with an unparseable body is not an answer", async () => {
    const fetch = (async () =>
      ({ ok: true, status: 200, async json() { throw new Error("bad json") } }) as any
    ) as unknown as typeof globalThis.fetch
    expect(await probeChatTurn({ url: "http://x/turn", fetch })).toEqual({
      status: "unknown",
      turnId: null,
      answered: false,
    })
  })
})

describe("isLiveTurnOtherThan", () => {
  test("the turn Stop cancelled is not a turn to wait for", () => {
    expect(
      isLiveTurnOtherThan(
        { status: "active", turnId: "turn-1", answered: true },
        "turn-1",
      ),
    ).toBe(false)
  })

  test("another live turn still holds a send back", () => {
    expect(
      isLiveTurnOtherThan(
        { status: "active", turnId: "turn-2", answered: true },
        "turn-1",
      ),
    ).toBe(true)
  })

  test("a finished turn never holds a send back", () => {
    for (const status of ["completed", "failed", "aborted", "unknown"] as const) {
      expect(
        isLiveTurnOtherThan({ status, turnId: "turn-2", answered: true }, "turn-1"),
      ).toBe(false)
    }
  })

  test("falls back to the status when either id is missing", () => {
    expect(
      isLiveTurnOtherThan(
        { status: "active", turnId: null, answered: true },
        "turn-1",
      ),
    ).toBe(true)
    expect(
      isLiveTurnOtherThan(
        { status: "active", turnId: "turn-2", answered: true },
        null,
      ),
    ).toBe(true)
  })
})

describe("probeChatTurnStatus retries", () => {
  /** Fails `failures` times (5xx or a throw), then answers with `status`. */
  function flakyFetch(failures: number, how: "5xx" | "throw", status: number, body?: unknown) {
    let calls = 0
    const fn = (async () => {
      calls++
      if (calls <= failures) {
        if (how === "throw") throw new Error("ECONNRESET")
        return { ok: false, status: 503, async json() { return null } } as any
      }
      return { ok: status >= 200 && status < 300, status, async json() { return body } } as any
    }) as unknown as typeof globalThis.fetch
    return Object.assign(fn, { calls: () => calls })
  }

  test("a failed probe is retried and finds the live turn", async () => {
    const fetch = flakyFetch(1, "5xx", 200, { status: "active" })
    expect(await probeChatTurnStatus({ url: "http://x/turn", fetch, retryDelaysMs: [1] })).toBe("active")
    expect(fetch.calls()).toBe(2)
  })

  test("a thrown fetch is retried too", async () => {
    const fetch = flakyFetch(2, "throw", 200, { status: "active" })
    expect(await probeChatTurnStatus({ url: "http://x/turn", fetch, retryDelaysMs: [1, 1] })).toBe("active")
  })

  test("404 is an answer, not retried", async () => {
    const fetch = flakyFetch(0, "5xx", 404, { status: "unknown" })
    expect(await probeChatTurnStatus({ url: "http://x/turn", fetch, retryDelaysMs: [1, 1] })).toBe("unknown")
    expect(fetch.calls()).toBe(1)
  })

  test("gives up as 'unknown' once retries run out", async () => {
    const fetch = flakyFetch(5, "5xx", 200, { status: "active" })
    expect(await probeChatTurnStatus({ url: "http://x/turn", fetch, retryDelaysMs: [1, 1] })).toBe("unknown")
    expect(fetch.calls()).toBe(3)
  })

  test("an aborted probe is not retried", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = flakyFetch(5, "throw", 200, { status: "active" })
    expect(await probeChatTurnStatus({ url: "http://x/turn", fetch, signal: controller.signal, retryDelaysMs: [1, 1] })).toBe("unknown")
    expect(fetch.calls()).toBe(1)
  })
})

describe("probeChatTurn on a refused credential (SHO-564)", () => {
  /** 401 for any cookie but the refreshed one; `fresh` answers the live turn. */
  function guardedFetch(body: unknown = { status: "active", turnId: "turn-live" }) {
    const calls: Array<{ headers: any; credentials?: RequestCredentials }> = []
    const fn = (async (_url: string, init: any) => {
      calls.push({ headers: init?.headers, credentials: init?.credentials })
      if (init?.headers?.Cookie === "fresh-cookie") {
        return {
          ok: true,
          status: 200,
          async json() {
            return body
          },
        } as any
      }
      return { ok: false, status: 401, async json() { return null } } as any
    }) as unknown as typeof globalThis.fetch
    return Object.assign(fn, { calls })
  }

  test("401 triggers one reauth and the retry returns the live snapshot", async () => {
    const fetch = guardedFetch()
    let headers = { Cookie: "dead-cookie" }
    let refreshes = 0

    const snapshot = await probeChatTurn({
      url: "http://x/turn",
      fetch,
      headers: () => headers,
      onRefused: async () => {
        refreshes += 1
        headers = { Cookie: "fresh-cookie" }
        return true
      },
    })

    expect(refreshes).toBe(1)
    expect(fetch.calls).toHaveLength(2)
    // The retry carries the refreshed cookie, not the dead one.
    expect(fetch.calls[1].headers).toEqual({ Cookie: "fresh-cookie" })
    expect(snapshot).toEqual({ status: "active", turnId: "turn-live", answered: true })
  })

  test("a refresh that fails reports the refused session, not a silent unknown", async () => {
    const fetch = guardedFetch()
    const snapshot = await probeChatTurn({
      url: "http://x/turn",
      fetch,
      headers: { Cookie: "dead-cookie" },
      onRefused: async () => false,
    })

    expect(fetch.calls).toHaveLength(1)
    expect(snapshot.refused).toBe(true)
    expect(snapshot.answered).toBe(false)
    expect(snapshot.status).toBe("unknown")
  })

  test("re-establishes the session at most once per probe", async () => {
    const fetch = guardedFetch()
    let refreshes = 0
    const snapshot = await probeChatTurn({
      url: "http://x/turn",
      fetch,
      headers: { Cookie: "dead-cookie" },
      onRefused: async () => {
        refreshes += 1
        return true
      },
      retryDelaysMs: [1, 1],
    })

    expect(refreshes).toBe(1)
    expect(fetch.calls).toHaveLength(2)
    expect(snapshot.refused).toBe(true)
  })

  test("a refusal with no refresh hook is still reported as refused", async () => {
    const fetch = guardedFetch()
    expect(await probeChatTurn({ url: "http://x/turn", fetch })).toMatchObject({
      refused: true,
      answered: false,
    })
  })

  test("403 is a refusal too", async () => {
    const fetch = (async () =>
      ({ ok: false, status: 403, async json() { return null } }) as any
    ) as unknown as typeof globalThis.fetch
    expect(await probeChatTurn({ url: "http://x/turn", fetch })).toMatchObject({ refused: true })
  })
})

describe("probeChatTurnBounded", () => {
  /**
   * A socket that is half-open: the request never settles on its own. This is
   * what left the stall watchdog's in-flight latch taken forever and parked the
   * recovery loop inside "recovering" (Sentry REACT-5Z / ANDROID-V).
   */
  function hungFetch() {
    const fn = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        const fail = () => reject(new Error("The operation was aborted"))
        // Real fetch rejects at once for a signal that is already aborted;
        // waiting for the event would hang the test, not the probe.
        if (signal?.aborted) fail()
        else signal?.addEventListener("abort", fail)
      })) as unknown as typeof globalThis.fetch
    return fn
  }

  test("a fetch that never settles resolves as unanswered within the bound", async () => {
    const started = Date.now()
    const snapshot = await probeChatTurnBounded({ url: "http://x/turn", fetch: hungFetch() }, 20)
    expect(snapshot).toEqual({ status: "unknown", turnId: null, answered: false })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("a probe the caller bounds itself is left alone", async () => {
    const controller = new AbortController()
    controller.abort()
    const snapshot = await probeChatTurnBounded(
      { url: "http://x/turn", fetch: hungFetch(), signal: controller.signal },
      60_000,
    )
    expect(snapshot.answered).toBe(false)
  })

  test("a normal answer passes through unchanged", async () => {
    const fetch = (async () =>
      ({ ok: true, status: 200, async json() { return { status: "active", turnId: "turn-1" } } }) as any
    ) as unknown as typeof globalThis.fetch
    expect(await probeChatTurnBounded({ url: "http://x/turn", fetch }, 20)).toEqual({
      status: "active",
      turnId: "turn-1",
      answered: true,
    })
  })
})
