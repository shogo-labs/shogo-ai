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
  normalizeTurnStatus,
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
