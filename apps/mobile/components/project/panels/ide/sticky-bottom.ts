/**
 * sticky-bottom.ts — pure helpers + hook for tail-follow with user
 * scroll detection (BUG-009).
 *
 * Canvas evidence: "Output panel auto-scroll fights user when spammy.
 * No 'user scrolled up' detection. Fix: Sticky-bottom only if within
 * 24px of max."
 *
 * Background:
 *   Three panels (OutputTab, RunDebugPanel, DebugView) all had the
 *   same anti-pattern:
 *
 *       useEffect(() => {
 *         el.scrollTop = el.scrollHeight     // ← unconditional jump
 *       }, [rows.length])
 *
 *   If the user manually scrolls UP to read an earlier line while logs
 *   keep streaming, EVERY new row yanks them back to the bottom. On a
 *   spammy build (vite HMR, jest watch, eslint --fix) the panel becomes
 *   unusable — you literally can't read scrollback.
 *
 *   Even with an explicit "Auto-scroll" toggle, "auto" should mean
 *   "follow the tail while at bottom" — never "fight the user". This
 *   is the universal terminal / DevTools / iTerm pattern.
 *
 * Fix design:
 *   1. isNearBottom(el, threshold) is a pure predicate — caller decides
 *      whether to honour stickiness. Default 24px threshold (canvas
 *      prescription); matches macOS / iOS bounce slack.
 *   2. useStickyBottom(ref) returns a scrollToBottom() callback that
 *      ONLY scrolls if the user is currently near the bottom. Wraps
 *      the scroll-event listener for cleanup. No state — just a ref
 *      check on every call (cheap, deterministic, no re-renders).
 *
 * Why "no state":
 *   A separate `isSticky` state variable would require re-rendering the
 *   panel on every scroll event (or debouncing scroll events, which
 *   introduces lag). Reading el.scrollTop / el.scrollHeight at the
 *   moment we want to scroll is faster AND avoids the "is sticky state
 *   stale because we batched 5 scroll events into one render" hazard.
 */
import { useCallback, useRef } from "react";

/**
 * True iff the element's viewport is within `threshold` pixels of the
 * bottom of its scrollable content. Returns true for a non-scrollable
 * element (scrollHeight <= clientHeight) — the user can't be "scrolled
 * up" if there's no scrollbar.
 *
 * Pure. Caller passes a live HTMLElement; we read three properties.
 */
export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 24,
): boolean {
  // Element has no overflow → vacuously "at bottom".
  const maxScroll = el.scrollHeight - el.clientHeight;
  if (maxScroll <= 0) return true;
  return el.scrollTop >= maxScroll - threshold;
}

/**
 * Hook: returns a `scrollToBottom()` callback that honours sticky-bottom
 * semantics — it scrolls to the bottom ONLY if the element is currently
 * within `threshold` pixels of the bottom (i.e. the user hasn't scrolled
 * up). If the user has scrolled up, calling scrollToBottom() is a no-op
 * — the new content arrives in the scrollback silently.
 *
 * Usage:
 *
 *     const ref = useRef<HTMLDivElement>(null)
 *     const { scrollToBottom } = useStickyBottom(ref)
 *     useEffect(() => { scrollToBottom() }, [rows.length])
 *     return <div ref={ref}>…</div>
 *
 * Optionally: pass `enabled=false` to disable scrolling entirely (mirrors
 * an explicit Auto-scroll toggle off — the user opted out, we honour it).
 */
export function useStickyBottom(
  ref: { current: HTMLElement | null },
  opts: { threshold?: number; enabled?: boolean } = {},
): { scrollToBottom: () => void; isAtBottom: () => boolean } {
  const { threshold = 24 } = opts;
  // We deliberately read `enabled` through a ref so the returned callback
  // is stable across renders (parents can put it in a useEffect deps array
  // without re-running on every render).
  const enabledRef = useRef(opts.enabled ?? true);
  enabledRef.current = opts.enabled ?? true;

  const isAtBottom = useCallback((): boolean => {
    const el = ref.current;
    if (!el) return false;
    return isNearBottom(el, threshold);
  }, [ref, threshold]);

  const scrollToBottom = useCallback((): void => {
    if (!enabledRef.current) return;
    const el = ref.current;
    if (!el) return;
    // Re-check inside the callback — the user may have scrolled in the
    // tick between the new row landing and React firing this effect.
    if (!isNearBottom(el, threshold)) return;
    el.scrollTop = el.scrollHeight;
  }, [ref, threshold]);

  return { scrollToBottom, isAtBottom };
}
