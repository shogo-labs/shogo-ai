/**
 * sticky-bottom — BUG-009 contract lockdown.
 *
 * The hook IS the rule. Every property each of the three consumer panels
 * (OutputTab, RunDebugPanel, DebugView) relies on is pinned here so a
 * future refactor that drops one property breaks one named test, not the
 * UX silently.
 *
 * Two surfaces:
 *   - isNearBottom — pure predicate (10 unit tests).
 *   - useStickyBottom — React hook over a scrollable ref (9 RTL tests).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act, cleanup, renderHook } from "@testing-library/react"
import { isNearBottom, useStickyBottom } from "../sticky-bottom"

const el = (scrollTop: number, scrollHeight: number, clientHeight: number) =>
  ({ scrollTop, scrollHeight, clientHeight })

describe("isNearBottom — pure predicate", () => {
  test("at exact bottom (scrollTop === maxScroll) is true", () => {
    // content 1000, viewport 200 → maxScroll 800. At 800 → true.
    expect(isNearBottom(el(800, 1000, 200))).toBe(true)
  })

  test("1 px above bottom: true (within 24px threshold)", () => {
    expect(isNearBottom(el(799, 1000, 200))).toBe(true)
  })

  test("exactly at the 24px threshold: true (inclusive boundary)", () => {
    // maxScroll = 800, threshold = 24 → boundary at scrollTop = 776.
    expect(isNearBottom(el(776, 1000, 200))).toBe(true)
  })

  test("1 px past the threshold: false (user has scrolled up)", () => {
    expect(isNearBottom(el(775, 1000, 200))).toBe(false)
  })

  test("scrolled to the top: false", () => {
    expect(isNearBottom(el(0, 1000, 200))).toBe(false)
  })

  test("scroll position > maxScroll (over-scroll on mobile bounce): true", () => {
    // iOS bounce can produce scrollTop momentarily > scrollHeight - clientHeight.
    expect(isNearBottom(el(900, 1000, 200))).toBe(true)
  })

  test("non-scrollable container (content fits): vacuously true", () => {
    // scrollHeight === clientHeight → no overflow → user can't be "up".
    expect(isNearBottom(el(0, 100, 200))).toBe(true)
  })

  test("custom threshold: 0px means only exact-bottom counts", () => {
    expect(isNearBottom(el(800, 1000, 200), 0)).toBe(true)
    expect(isNearBottom(el(799, 1000, 200), 0)).toBe(false)
  })

  test("custom threshold: 100px is very forgiving", () => {
    expect(isNearBottom(el(700, 1000, 200), 100)).toBe(true)
    expect(isNearBottom(el(699, 1000, 200), 100)).toBe(false)
  })

  test("default threshold is 24px (the canvas prescription)", () => {
    // 800 - 24 = 776 → exactly the canvas boundary.
    expect(isNearBottom(el(776, 1000, 200))).toBe(true)
    expect(isNearBottom(el(775, 1000, 200))).toBe(false)
  })
})

// ─── Hook tests with a writable scrollEl-like ref ────────────────────────
type ScrollEl = HTMLElement & { _setScrollTop: (n: number) => void }

function makeScrollEl(scrollTop: number, scrollHeight: number, clientHeight: number): ScrollEl {
  let st = scrollTop
  // Minimal HTMLElement shape — only the props the hook reads.
  return {
    get scrollTop() { return st },
    set scrollTop(v: number) { st = v },
    get scrollHeight() { return scrollHeight },
    get clientHeight() { return clientHeight },
    _setScrollTop(v: number) { st = v },
  } as ScrollEl
}

afterEach(cleanup)

describe("useStickyBottom — sticky semantics", () => {
  test("scrollToBottom is a no-op when ref is null (e.g. element not yet mounted)", () => {
    const ref = { current: null as HTMLElement | null }
    const { result } = renderHook(() => useStickyBottom(ref))
    expect(() => result.current.scrollToBottom()).not.toThrow()
  })

  test("at bottom → scrollToBottom() scrolls to the very bottom", () => {
    const node = makeScrollEl(800, 1000, 200)
    const ref = { current: node }
    const { result } = renderHook(() => useStickyBottom(ref))
    // Simulate new content arriving: scrollHeight grows by 200.
    // Without sticky we'd scroll; with sticky we still scroll because
    // the user is at 800 which IS within 24 of the (currently 800) max.
    act(() => result.current.scrollToBottom())
    expect(node.scrollTop).toBe(1000) // scrolled to scrollHeight
  })

  test("user scrolled up far → scrollToBottom() is a NO-OP", () => {
    const node = makeScrollEl(0, 1000, 200) // way up
    const ref = { current: node }
    const { result } = renderHook(() => useStickyBottom(ref))
    act(() => result.current.scrollToBottom())
    expect(node.scrollTop).toBe(0) // UNCHANGED — user's scroll position respected
  })

  test("user scrolled up 50 px (past 24px threshold) → NO-OP", () => {
    const node = makeScrollEl(750, 1000, 200) // maxScroll=800, 50px up
    const ref = { current: node }
    const { result } = renderHook(() => useStickyBottom(ref))
    act(() => result.current.scrollToBottom())
    expect(node.scrollTop).toBe(750) // unchanged
  })

  test("user scrolled up 10 px (within 24 threshold) → still scrolls", () => {
    const node = makeScrollEl(790, 1000, 200) // 10px up — still sticky
    const ref = { current: node }
    const { result } = renderHook(() => useStickyBottom(ref))
    act(() => result.current.scrollToBottom())
    expect(node.scrollTop).toBe(1000)
  })

  test("enabled=false → scrollToBottom is a no-op even at bottom (user toggle off)", () => {
    const node = makeScrollEl(800, 1000, 200)
    const ref = { current: node }
    const { result } = renderHook(() => useStickyBottom(ref, { enabled: false }))
    act(() => result.current.scrollToBottom())
    expect(node.scrollTop).toBe(800) // unchanged
  })

  test("custom threshold flows through", () => {
    const node = makeScrollEl(700, 1000, 200) // 100px up
    const ref = { current: node }
    const { result } = renderHook(() => useStickyBottom(ref, { threshold: 200 }))
    act(() => result.current.scrollToBottom())
    expect(node.scrollTop).toBe(1000) // 100px up but 200 threshold → stuck
  })

  test("isAtBottom() returns the live status from the ref", () => {
    const node = makeScrollEl(800, 1000, 200)
    const ref = { current: node }
    const { result } = renderHook(() => useStickyBottom(ref))
    expect(result.current.isAtBottom()).toBe(true)
    node._setScrollTop(0)
    expect(result.current.isAtBottom()).toBe(false)
  })

  test("scrollToBottom re-checks stickiness AT CALL TIME (not at hook render)", () => {
    // This is the critical invariant for "user scrolled up in the same
    // tick a new row landed". If we cached the sticky bool at render
    // time we'd yank the user back. The hook reads from the ref live.
    const node = makeScrollEl(800, 1000, 200) // sticky at hook render
    const ref = { current: node }
    const { result } = renderHook(() => useStickyBottom(ref))

    // Between render and the effect call: user scrolls way up.
    node._setScrollTop(0)
    act(() => result.current.scrollToBottom())
    expect(node.scrollTop).toBe(0) // unchanged — re-check at call time
  })
})

describe("BUG-009 canonical scenarios", () => {
  test("spammy log — user scrolls up to read line 100, new lines stream in: NO yank", () => {
    // Simulate the bug's scenario directly.
    const node = makeScrollEl(800, 1000, 200) // tail follow
    const ref = { current: node }
    const { result } = renderHook(() => useStickyBottom(ref))

    // Tail follow works while at bottom.
    act(() => result.current.scrollToBottom())
    expect(node.scrollTop).toBe(1000)

    // User scrolls up to inspect an earlier line.
    node._setScrollTop(200)

    // Five new lines arrive — each triggers scrollToBottom().
    for (let i = 0; i < 5; i++) {
      act(() => result.current.scrollToBottom())
    }

    // User's scroll position MUST be preserved across all 5 attempts.
    expect(node.scrollTop).toBe(200)
  })

  test("user scrolls back to bottom → tail follow auto-engages", () => {
    const node = makeScrollEl(0, 1000, 200) // way up
    const ref = { current: node }
    const { result } = renderHook(() => useStickyBottom(ref))

    // Confirm we're not sticky.
    act(() => result.current.scrollToBottom())
    expect(node.scrollTop).toBe(0)

    // User scrolls to the bottom themselves.
    node._setScrollTop(800)

    // Next new row engages sticky again.
    act(() => result.current.scrollToBottom())
    expect(node.scrollTop).toBe(1000)
  })
})
