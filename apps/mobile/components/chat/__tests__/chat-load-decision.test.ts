// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the pure decision logic behind ChatPanel's Effect 1
 * (the /chat-messages stale-while-revalidate loader).
 *
 * Headline regression locked down here (FIXED — must not come back):
 *
 *   On a fresh page refresh of a chat with history, the server logs show
 *
 *     [AgentChat] Stream reconnect: session=... fromSeq=0 snapshot=none
 *
 *   but the frontend never calls GET /api/chat-messages?sessionId=...,
 *   so the panel renders empty.
 *
 *   Root cause: Effect 1 used to read the per-session freshness stamp via
 *
 *     const refreshedAt = cacheRefreshedAtRef.current.get(sessionId) ?? 0
 *     if (performance.now() - refreshedAt < 5000) return // bailout
 *
 *   The `?? 0` collapses "never stamped for this session" into the same
 *   value the freshness bailout uses, so for the first 5 seconds after
 *   navigation `performance.now() < 5000` and the bailout fires —
 *   skipping the fetch but still flipping `isInitialLoadComplete=true`,
 *   which fires `useChat`'s resumeStream and explains the orphaned
 *   `Stream reconnect` line in the logs.
 *
 *   The fix is to leave `cacheRefreshedAt` as `undefined` until a real
 *   load completes, and only enter the bailout when there *is* a stamp
 *   AND it's < 5s old. The decision function in `chat-load-decision.ts`
 *   models this; these tests pin it. ChatPanel.tsx Effect 1 was patched
 *   to use the same explicit `!== undefined` guard inline.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/chat-load-decision.test.ts
 */

import { describe, expect, test } from "bun:test"
import {
  decideChatMessageLoadAction,
  type ChatLoadDecisionInput,
} from "../chat-load-decision"

function input(overrides: Partial<ChatLoadDecisionInput> = {}): ChatLoadDecisionInput {
  return {
    isActive: true,
    currentSessionId: "session-abc",
    isStreaming: false,
    isSendingMessage: false,
    isLoadingMessages: false,
    hasCachedMessages: false,
    cacheRefreshedAt: undefined,
    now: 10_000,
    ...overrides,
  }
}

describe("decideChatMessageLoadAction — regression: page-refresh false bailout", () => {
  test("BUG REPRO: fresh page refresh with chat history → must fetch (currently bails)", () => {
    // Mimic a hard browser refresh on a chat with persisted history:
    //   - the active panel mounts ~500ms into the page lifecycle, so
    //     `performance.now()` is small (< the 5s freshness window)
    //   - no successful load has stamped the per-session freshness map
    //     yet, so `cacheRefreshedAt` is `undefined`
    //   - the in-memory module cache (`sessionMessageCache`) was wiped
    //     by the refresh, so `hasCachedMessages` is false
    //
    // The fetch MUST run. If we instead emit `skip-fresh-cache` here,
    // Effect 1 will flip `isInitialLoadComplete=true` and the AI SDK
    // `useChat({ resume: true })` effect will fire its resumeStream
    // (the `[AgentChat] Stream reconnect ... snapshot=none` log line)
    // — but the panel will never call /chat-messages, so the chat
    // renders blank.
    const action = decideChatMessageLoadAction(
      input({
        cacheRefreshedAt: undefined,
        hasCachedMessages: false,
        now: 500, // ~half a second since navigation
      }),
    )
    expect(action.kind).toBe("fetch")
  })

  test("freshness bailout DOES fire when a stamp exists and is < 5s old", () => {
    // After a real load completes, the .finally() stamps performance.now()
    // into the per-session map. A subsequent Effect 1 re-run inside the
    // 5s window correctly bails out so we don't refetch on every
    // setIsLoadingMessages(false) → effect re-run cycle.
    const action = decideChatMessageLoadAction(
      input({
        cacheRefreshedAt: 8_000,
        now: 10_000, // 2s since the last stamp
      }),
    )
    expect(action.kind).toBe("skip-fresh-cache")
  })

  test("freshness bailout expires after 5s and the next mount refetches", () => {
    const action = decideChatMessageLoadAction(
      input({
        cacheRefreshedAt: 1_000,
        now: 10_000, // 9s since the last stamp
      }),
    )
    expect(action.kind).toBe("fetch")
  })

  test("freshness window edge: exactly 5000ms is stale (refetches)", () => {
    const action = decideChatMessageLoadAction(
      input({
        cacheRefreshedAt: 5_000,
        now: 10_000, // exactly 5s ago
      }),
    )
    expect(action.kind).toBe("fetch")
  })

  test("a stamp from t=0 (epoch-ish) inside the window still bails out (real stamp, not the absent-sentinel collision)", () => {
    // Locks in that the fix doesn't accidentally treat 0 as "no stamp" —
    // a real stamp value of 0 is uncommon in practice but we shouldn't
    // misinterpret it. The `undefined` sentinel is what means "absent".
    const action = decideChatMessageLoadAction(
      input({
        cacheRefreshedAt: 0,
        now: 1_000, // 1s after stamp
      }),
    )
    expect(action.kind).toBe("skip-fresh-cache")
  })
})

describe("ChatPanel.tsx Effect 1 production logic — pre-fix bug, post-fix correctness", () => {
  /**
   * Mirrors the OLD (buggy) freshness-bailout snippet that used to live in
   * `apps/mobile/components/chat/ChatPanel.tsx` (Effect 1, ~line 2480).
   *
   * Old code (BUGGY):
   *   const refreshedAt = cacheRefreshedAtRef.current.get(sessionId) ?? 0
   *   if (performance.now() - refreshedAt < 5000) return // bailout
   *
   * New code (FIXED):
   *   const refreshedAt = cacheRefreshedAtRef.current.get(sessionId)
   *   if (refreshedAt !== undefined && performance.now() - refreshedAt < 5000) return
   *
   * Both helpers below take the exact same inputs so we can show, in code,
   * how the same "fresh page refresh" snapshot used to skip the fetch and
   * now correctly proceeds to it.
   */
  function oldBuggyBailoutWouldFire(args: {
    cacheRefreshedAtMap: Map<string, number>
    sessionId: string
    nowMs: number
  }): boolean {
    const refreshedAt = args.cacheRefreshedAtMap.get(args.sessionId) ?? 0
    return args.nowMs - refreshedAt < 5000
  }

  function fixedBailoutWouldFire(args: {
    cacheRefreshedAtMap: Map<string, number>
    sessionId: string
    nowMs: number
  }): boolean {
    const refreshedAt = args.cacheRefreshedAtMap.get(args.sessionId)
    return refreshedAt !== undefined && args.nowMs - refreshedAt < 5000
  }

  const FRESH_REFRESH = {
    cacheRefreshedAtMap: new Map<string, number>(),
    sessionId: "507d84ae-f77e-460e-bb36-9cbdf9738ffb",
    nowMs: 500, // ~500ms after navigation start
  }

  test("OLD code: page just loaded, no prior stamp → bailout incorrectly fires (the original bug)", () => {
    // The empty Map represents `cacheRefreshedAtRef.current` after a hard
    // refresh — the per-session entry has never been stamped because no
    // load has completed yet. Under the old `?? 0` logic the bailout fires
    // → loadPage is NEVER called → /chat-messages request is never made
    // → panel stays empty even though useChat({ resume: true }) goes on
    // to fire its resumeStream (the orphan `Stream reconnect ...
    // snapshot=none` line in the server logs).
    expect(oldBuggyBailoutWouldFire(FRESH_REFRESH)).toBe(true)
  })

  test("FIXED code: same inputs correctly proceed to the /chat-messages fetch", () => {
    expect(fixedBailoutWouldFire(FRESH_REFRESH)).toBe(false)
  })

  test("FIXED code routed through the pure decision returns 'fetch' for the same inputs", () => {
    const action = decideChatMessageLoadAction(
      input({
        currentSessionId: FRESH_REFRESH.sessionId,
        cacheRefreshedAt: undefined,
        hasCachedMessages: false,
        now: FRESH_REFRESH.nowMs,
      }),
    )
    expect(action.kind).toBe("fetch")
  })
})

describe("decideChatMessageLoadAction — gate ordering", () => {
  test("inactive tab short-circuits before anything else", () => {
    const action = decideChatMessageLoadAction(
      input({
        isActive: false,
        currentSessionId: "session-abc",
        cacheRefreshedAt: undefined,
        now: 500,
      }),
    )
    expect(action).toEqual({ kind: "noop", reason: "tab-inactive" })
  })

  test("no session → mark complete (clears the loading UI)", () => {
    const action = decideChatMessageLoadAction(
      input({ currentSessionId: null }),
    )
    expect(action.kind).toBe("mark-complete-no-session")
  })

  test("streaming-active wins over the freshness check (no fetch mid-turn)", () => {
    // The streaming SSE response IS the source of truth mid-turn; firing a
    // GET /chat-messages now would queue behind the SSE and wedge the
    // loading flag forever (the original "stuck on skip: already loading"
    // wedge). Hydrate from cache instead.
    const action = decideChatMessageLoadAction(
      input({
        isStreaming: true,
        cacheRefreshedAt: undefined,
        now: 60_000,
      }),
    )
    expect(action.kind).toBe("hydrate-while-streaming")
  })

  test("sendMessage-in-flight is treated like streaming (no fetch)", () => {
    const action = decideChatMessageLoadAction(
      input({ isSendingMessage: true }),
    )
    expect(action.kind).toBe("hydrate-while-streaming")
  })

  test("in-flight load dedupes (the second concurrent caller is a noop)", () => {
    const action = decideChatMessageLoadAction(
      input({ isLoadingMessages: true }),
    )
    expect(action).toEqual({ kind: "noop", reason: "load-in-flight" })
  })

  test("having a cache does NOT skip the network fetch on its own", () => {
    // Stale-while-revalidate: cache hit hydrates immediately, but we
    // still kick the network so the panel reconciles to the server's
    // view. The freshness stamp is what gates the network call, not
    // the cache presence.
    const action = decideChatMessageLoadAction(
      input({
        hasCachedMessages: true,
        cacheRefreshedAt: undefined,
        now: 60_000,
      }),
    )
    expect(action.kind).toBe("fetch")
  })
})
