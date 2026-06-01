/**
 * useProblemsBadgeCount — BUG-004 contract lockdown.
 *
 * The canvas evidence ("setTimeout id captured before projectId change. Fix:
 * clearTimeout + reset lastRunAt — applied in useProblemsBadgeCount") names
 * a surface fix that's already in the hook. What's missing is COVERAGE
 * pinning the contract so any future refactor that drops a piece of it
 * (the alive flag, the lastRunAt reset, the in-flight discard, the timer
 * cleanup) is caught at PR time, not in production silence.
 *
 * The bug class — a poller that retains a stale `setTimeout` id across
 * an identity change and never cancels it — is uniquely nasty because:
 *   - There's no error / crash. The leaked timer fires, calls fetch with
 *     the OLD projectId, and the result silently overwrites state for the
 *     new project (count goes wrong but no exception);
 *   - State refs (`lastRunAtRef`) leaked across identity boundaries cause
 *     a "since=<old>" delta query against the new project, which the server
 *     answers with `{ unchanged: true }` (because it never saw lastRunAt
 *     for THIS project), freezing the badge on the wrong-project count;
 *   - Tab/route-rapid-switch reproductions are timing-dependent and rarely
 *     caught in manual QA.
 *
 * Each test below pins one specific invariant and is named after the
 * invariant. If any future change breaks one, the failure name tells you
 * EXACTLY which guarantee regressed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act, cleanup, renderHook } from "@testing-library/react"

// ─── Inject the fetch impl via the hook's `fetchImpl` option ──────────────
// Bypasses bun-test's order-sensitive cross-file mock-module cache.
import { DiagnosticsApiError } from "../../../../../../lib/diagnostics-api"
import { useProblemsBadgeCount as useHook } from "../useProblemsBadgeCount"

let fetchImpl: (
  projectId: string,
  opts?: { since?: string },
) => Promise<any> = async () => ({ unchanged: true, lastRunAt: "t0" })
const fetchCalls: Array<{ projectId: string; since: string | undefined }> = []

const trackedFetch = (projectId: string, opts?: { since?: string }) => {
  fetchCalls.push({ projectId, since: opts?.since })
  return fetchImpl(projectId, opts)
}

// ─── Manual setTimeout/clearTimeout fake (bun:test has no fake timers) ───
type Pending = { id: number; cb: () => void; ms: number }
let timers: Pending[] = []
let nextTimerId = 1
let clearCount = 0
const origSetTimeout = globalThis.setTimeout
const origClearTimeout = globalThis.clearTimeout

beforeEach(() => {
  fetchCalls.length = 0
  fetchImpl = async () => ({ unchanged: true, lastRunAt: "t0" })
  timers = []
  nextTimerId = 1
  clearCount = 0
  globalThis.setTimeout = ((cb: () => void, ms: number) => {
    const id = nextTimerId++
    timers.push({ id, cb, ms })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: any) => {
    clearCount++
    timers = timers.filter((t) => t.id !== id)
  }) as typeof clearTimeout
})

afterEach(() => {
  cleanup()
  globalThis.setTimeout = origSetTimeout
  globalThis.clearTimeout = origClearTimeout
})

function flushPromises() {
  // Drain the microtask queue so awaited fetches resolve.
  return new Promise((r) => origSetTimeout(r as any, 0))
}

function fireOneTimer() {
  // Pop the head timer and run it. (The hook only ever has 1 pending.)
  const due = timers.shift()
  if (due) due.cb()
}

// Thin wrapper: always inject our trackedFetch + DiagnosticsApiError.
const useProblemsBadgeCount = (opts: {
  projectId: string | null | undefined
  enabled: boolean
  intervalMs?: number
}) => useHook({ ...opts, fetchImpl: trackedFetch as any })

// ──────────────────────────────────────────────────────────────────────────

describe("useProblemsBadgeCount — disabled gates", () => {
  test("enabled=false: NEVER calls fetchDiagnostics and returns 0/null", async () => {
    const { result } = renderHook(() =>
      useProblemsBadgeCount({ projectId: "proj-1", enabled: false }),
    )
    await flushPromises()
    expect(fetchCalls.length).toBe(0)
    expect(result.current).toEqual({ count: 0, severity: null })
  })

  test("projectId=null: NEVER calls fetchDiagnostics and returns 0/null", async () => {
    const { result } = renderHook(() =>
      useProblemsBadgeCount({ projectId: null, enabled: true }),
    )
    await flushPromises()
    expect(fetchCalls.length).toBe(0)
    expect(result.current).toEqual({ count: 0, severity: null })
  })

  test("projectId=undefined: NEVER calls fetchDiagnostics", async () => {
    renderHook(() =>
      useProblemsBadgeCount({ projectId: undefined, enabled: true }),
    )
    await flushPromises()
    expect(fetchCalls.length).toBe(0)
  })

  test("empty-string projectId: NEVER calls fetchDiagnostics", async () => {
    renderHook(() => useProblemsBadgeCount({ projectId: "", enabled: true }))
    await flushPromises()
    expect(fetchCalls.length).toBe(0)
  })

  test("disabling clears the pending timer (no leak)", async () => {
    fetchImpl = async () => ({ diagnostics: [], lastRunAt: "t0", sources: [], fromCache: false })
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useProblemsBadgeCount({ projectId: "proj-1", enabled }),
      { initialProps: { enabled: true } },
    )
    await flushPromises()
    expect(timers.length).toBe(1) // initial tick scheduled the next
    const before = clearCount
    act(() => rerender({ enabled: false }))
    // Cleanup MUST have called clearTimeout for the pending tick.
    expect(clearCount).toBeGreaterThan(before)
    expect(timers.length).toBe(0)
  })
})

describe("useProblemsBadgeCount — initial fetch + polling", () => {
  test("mounts: tick runs immediately (no wait for the first interval)", async () => {
    fetchImpl = async () => ({ diagnostics: [], lastRunAt: "t0", sources: [], fromCache: false })
    renderHook(() => useProblemsBadgeCount({ projectId: "proj-1", enabled: true }))
    await flushPromises()
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]!.projectId).toBe("proj-1")
    expect(fetchCalls[0]!.since).toBeUndefined()
  })

  test("state reflects the diagnostics result via problemsBadge formatter", async () => {
    fetchImpl = async () => ({
      diagnostics: [
        { id: "1", source: "ts", severity: "error", file: "a", line: 1, column: 1, message: "x" },
        { id: "2", source: "ts", severity: "warning", file: "b", line: 1, column: 1, message: "y" },
      ],
      lastRunAt: "t0", sources: ["ts"], fromCache: false,
    })
    const { result } = renderHook(() =>
      useProblemsBadgeCount({ projectId: "proj-1", enabled: true }),
    )
    await flushPromises()
    expect(result.current.count).toBe(1)  // errors only (VS-Code parity, warnings ignored when errors present)
    expect(result.current.severity).toBe("error")
  })

  test("schedules a next-tick timeout after the first fetch", async () => {
    fetchImpl = async () => ({ diagnostics: [], lastRunAt: "t0", sources: [], fromCache: false })
    renderHook(() =>
      useProblemsBadgeCount({ projectId: "proj-1", enabled: true, intervalMs: 1000 }),
    )
    await flushPromises()
    expect(timers.length).toBe(1)
    expect(timers[0]!.ms).toBe(1000)
  })

  test("subsequent ticks send lastRunAt as `since`", async () => {
    fetchImpl = async () => ({ diagnostics: [], lastRunAt: "T-AFTER-FIRST", sources: [], fromCache: false })
    renderHook(() =>
      useProblemsBadgeCount({ projectId: "proj-1", enabled: true, intervalMs: 1 }),
    )
    await flushPromises()
    // Fire the next-tick timer the previous fetch scheduled.
    act(() => fireOneTimer())
    await flushPromises()
    expect(fetchCalls.length).toBe(2)
    expect(fetchCalls[1]!.since).toBe("T-AFTER-FIRST")
  })

  test('"unchanged" response keeps prior state but updates lastRunAt', async () => {
    let call = 0
    fetchImpl = async () => {
      call++
      if (call === 1) {
        return {
          diagnostics: [
            { id: "1", source: "ts", severity: "warning", file: "a", line: 1, column: 1, message: "x" },
          ],
          lastRunAt: "T1", sources: ["ts"], fromCache: false,
        }
      }
      return { unchanged: true, lastRunAt: "T2" }
    }
    const { result } = renderHook(() =>
      useProblemsBadgeCount({ projectId: "proj-1", enabled: true, intervalMs: 1 }),
    )
    await flushPromises()
    expect(result.current).toEqual({ count: 1, severity: "warn" })
    act(() => fireOneTimer())
    await flushPromises()
    // State unchanged after "unchanged" response.
    expect(result.current).toEqual({ count: 1, severity: "warn" })
    // But lastRunAt advanced — the next tick will use T2.
    act(() => fireOneTimer())
    await flushPromises()
    expect(fetchCalls[2]!.since).toBe("T2")
  })
})

describe("useProblemsBadgeCount — projectId change (the BUG-004 fix)", () => {
  test("cancels the pending timer for the previous project", async () => {
    fetchImpl = async () => ({ diagnostics: [], lastRunAt: "t0", sources: [], fromCache: false })
    const { rerender } = renderHook(
      ({ pid }: { pid: string }) =>
        useProblemsBadgeCount({ projectId: pid, enabled: true }),
      { initialProps: { pid: "proj-1" } },
    )
    await flushPromises()
    expect(timers.length).toBe(1) // proj-1's next tick
    const beforeClear = clearCount
    act(() => rerender({ pid: "proj-2" }))
    expect(clearCount).toBeGreaterThan(beforeClear) // proj-1 timer was cleared
  })

  test("resets lastRunAt so the new project fetches with since=undefined", async () => {
    fetchImpl = async () => ({ diagnostics: [], lastRunAt: "T-PROJ-1", sources: [], fromCache: false })
    const { rerender } = renderHook(
      ({ pid }: { pid: string }) =>
        useProblemsBadgeCount({ projectId: pid, enabled: true }),
      { initialProps: { pid: "proj-1" } },
    )
    await flushPromises()
    expect(fetchCalls[0]!.since).toBeUndefined()

    act(() => rerender({ pid: "proj-2" }))
    await flushPromises()
    // The first fetch for proj-2 MUST be a full query (since=undefined),
    // NOT a delta query using proj-1's lastRunAt. The latter would risk a
    // misleading "unchanged" response that freezes the badge on the wrong
    // project's count.
    const proj2First = fetchCalls.find((c) => c.projectId === "proj-2")
    expect(proj2First).toBeDefined()
    expect(proj2First!.since).toBeUndefined()
  })

  test("stale in-flight response from previous project does NOT update state", async () => {
    let resolvePrev: ((v: any) => void) | null = null
    fetchImpl = async (pid) => {
      if (pid === "proj-1") {
        return new Promise((r) => { resolvePrev = r })
      }
      return { diagnostics: [], lastRunAt: "T-PROJ-2", sources: [], fromCache: false }
    }
    const { result, rerender } = renderHook(
      ({ pid }: { pid: string }) =>
        useProblemsBadgeCount({ projectId: pid, enabled: true }),
      { initialProps: { pid: "proj-1" } },
    )
    await flushPromises()
    // proj-1 fetch in flight — swap to proj-2 BEFORE it resolves.
    act(() => rerender({ pid: "proj-2" }))
    await flushPromises()
    // Now resolve the stale proj-1 fetch with a LOUD result.
    act(() => resolvePrev!({
      diagnostics: [
        { id: "STALE", source: "ts", severity: "error", file: "a", line: 1, column: 1, message: "z" },
      ],
      lastRunAt: "T-STALE", sources: ["ts"], fromCache: false,
    }))
    await flushPromises()
    // State must reflect proj-2's (empty), NOT proj-1's stale result.
    expect(result.current).toEqual({ count: 0, severity: null })
  })

  test("after projectId change, fetch is called with NEW projectId", async () => {
    fetchImpl = async () => ({ diagnostics: [], lastRunAt: "t0", sources: [], fromCache: false })
    const { rerender } = renderHook(
      ({ pid }: { pid: string }) =>
        useProblemsBadgeCount({ projectId: pid, enabled: true }),
      { initialProps: { pid: "proj-1" } },
    )
    await flushPromises()
    act(() => rerender({ pid: "proj-2" }))
    await flushPromises()
    expect(fetchCalls.map((c) => c.projectId)).toEqual(["proj-1", "proj-2"])
  })
})

describe("useProblemsBadgeCount — unmount", () => {
  test("clears the pending timer (no orphan setTimeout)", async () => {
    fetchImpl = async () => ({ diagnostics: [], lastRunAt: "t0", sources: [], fromCache: false })
    const { unmount } = renderHook(() =>
      useProblemsBadgeCount({ projectId: "proj-1", enabled: true }),
    )
    await flushPromises()
    expect(timers.length).toBe(1)
    const before = clearCount
    unmount()
    expect(clearCount).toBeGreaterThan(before)
    expect(timers.length).toBe(0)
  })

  test("in-flight fetch resolving AFTER unmount does NOT schedule a new timer", async () => {
    let resolveIt: ((v: any) => void) | null = null
    fetchImpl = () => new Promise((r) => { resolveIt = r })
    const { unmount } = renderHook(() =>
      useProblemsBadgeCount({ projectId: "proj-1", enabled: true }),
    )
    await flushPromises()
    // No timers yet — the first tick's fetch is still in flight.
    expect(timers.length).toBe(0)
    unmount()
    // Resolve it AFTER unmount — must NOT schedule a follow-up tick.
    act(() => resolveIt!({ diagnostics: [], lastRunAt: "t", sources: [], fromCache: false }))
    await flushPromises()
    expect(timers.length).toBe(0)
  })
})

describe("useProblemsBadgeCount — error handling", () => {
  test("DiagnosticsApiError 'service_starting' keeps prior state and reschedules", async () => {
    let call = 0
    fetchImpl = async () => {
      call++
      if (call === 1) {
        return {
          diagnostics: [
            { id: "1", source: "ts", severity: "warning", file: "a", line: 1, column: 1, message: "x" },
          ],
          lastRunAt: "T1", sources: ["ts"], fromCache: false,
        }
      }
      throw new DiagnosticsApiError("warming up", "service_starting", 503, true)
    }
    const { result } = renderHook(() =>
      useProblemsBadgeCount({ projectId: "proj-1", enabled: true, intervalMs: 1 }),
    )
    await flushPromises()
    expect(result.current.count).toBe(1)
    act(() => fireOneTimer())
    await flushPromises()
    // State preserved despite the error.
    expect(result.current.count).toBe(1)
    // And a new timer is queued for the retry.
    expect(timers.length).toBe(1)
  })

  test("generic error keeps prior state and still reschedules", async () => {
    let call = 0
    fetchImpl = async () => {
      call++
      if (call === 1) {
        return {
          diagnostics: [
            { id: "1", source: "ts", severity: "error", file: "a", line: 1, column: 1, message: "x" },
          ],
          lastRunAt: "T1", sources: ["ts"], fromCache: false,
        }
      }
      throw new Error("network down")
    }
    // Suppress the console.warn the hook emits on generic errors.
    const origWarn = console.warn
    console.warn = () => {}
    try {
      const { result } = renderHook(() =>
        useProblemsBadgeCount({ projectId: "proj-1", enabled: true, intervalMs: 1 }),
      )
      await flushPromises()
      expect(result.current.count).toBe(1)
      act(() => fireOneTimer())
      await flushPromises()
      expect(result.current.count).toBe(1)
      expect(timers.length).toBe(1)
    } finally {
      console.warn = origWarn
    }
  })

  test("cleanup mid-error does NOT schedule a follow-up timer", async () => {
    let rejectIt: ((e: unknown) => void) | null = null
    fetchImpl = () => new Promise((_r, reject) => { rejectIt = reject })
    const { unmount } = renderHook(() =>
      useProblemsBadgeCount({ projectId: "proj-1", enabled: true }),
    )
    await flushPromises()
    unmount()
    act(() => rejectIt!(new Error("boom")))
    await flushPromises()
    expect(timers.length).toBe(0)
  })
})
