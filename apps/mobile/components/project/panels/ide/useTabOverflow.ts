// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * useTabOverflow — DOM-overflow detector for the editor tab strip.
 *
 * Why a hook (and not inline logic):
 *
 *   1. Layout-derived UI state is the single most race-prone surface in
 *      a React tree. `scrollWidth`, `clientWidth` and `scrollLeft` are
 *      mutable DOM properties that change between paint cycles — reading
 *      them in render is unsafe, and forgetting to read them after a
 *      ResizeObserver / scroll event leaves chevrons stuck on "off".
 *      Containing the whole reactive dance in one hook lets the
 *      consumer say `useTabOverflow(ref)` and trust the booleans.
 *
 *   2. Three independent signals — child mutation (a tab opens/closes),
 *      container resize (window shrinks, sidebar opens), and user scroll
 *      (chevron click, wheel, trackpad swipe) — all need to recompute
 *      the same `{ isOverflowing, canScrollLeft, canScrollRight }` shape.
 *      Doing this in three useEffects in the consumer is where the
 *      "chevron disabled when it shouldn't be" class of bug lives.
 *
 *   3. Testability. A pure helper hook is unit-testable with
 *      Object.defineProperty mocks; the rendered consumer is then free
 *      to focus its RTL tests on user-visible behaviour
 *      (clicking ▶ scrolls, dropdown opens, etc.).
 *
 * Contract (locked by useTabOverflow.test.ts):
 *
 *   • Initial state derives from a synchronous read of the ref's DOM
 *     props — no flash of "no overflow" on first paint.
 *   • Scroll within a 1px tolerance counts as "at the edge". Float
 *     subpixel scrollLeft values (Safari trackpad) shouldn't keep the
 *     chevron permanently enabled when the user is visually at the end.
 *   • A ResizeObserver-less environment (older browsers, JSDOM without
 *     the polyfill) still gets one initial read; the hook degrades
 *     silently to "static" rather than crashing.
 *   • Cleanup detaches both the observer and the scroll listener.
 *     A hot-reload that swaps the ref must not leak handlers.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface TabOverflowState {
  /** True when content width exceeds visible width (i.e. some tabs are clipped). */
  isOverflowing: boolean;
  /** True when there is scrollable content to the LEFT of the viewport. */
  canScrollLeft: boolean;
  /** True when there is scrollable content to the RIGHT of the viewport. */
  canScrollRight: boolean;
}

export interface TabOverflowControls extends TabOverflowState {
  /** Smooth-scroll by approximately one tab width in the given direction. */
  scrollByTab: (direction: "left" | "right") => void;
  /** Scroll the supplied tab element into view if it's clipped. */
  scrollIntoView: (tabEl: HTMLElement | null) => void;
}

/** Tolerance for "at the edge" — subpixel scroll values on Safari/Firefox
 *  trackpads can leave scrollLeft at 0.49 even when the user is visually
 *  at the very start. 1px is generous without being misleading. */
const EDGE_TOLERANCE_PX = 1;

/** Single-tab scroll amount when chevrons are clicked. The strip will
 *  often have variable-width tabs; this approximates "one tab" without
 *  having to query each child. */
const TAB_SCROLL_STEP_PX = 160;

function computeState(el: HTMLElement | null): TabOverflowState {
  if (!el) return { isOverflowing: false, canScrollLeft: false, canScrollRight: false };
  const { scrollLeft, scrollWidth, clientWidth } = el;
  const maxScroll = scrollWidth - clientWidth;
  const isOverflowing = maxScroll > EDGE_TOLERANCE_PX;
  if (!isOverflowing) {
    return { isOverflowing: false, canScrollLeft: false, canScrollRight: false };
  }
  return {
    isOverflowing: true,
    canScrollLeft: scrollLeft > EDGE_TOLERANCE_PX,
    canScrollRight: scrollLeft < maxScroll - EDGE_TOLERANCE_PX,
  };
}

export function useTabOverflow(
  ref: RefObject<HTMLElement | null>,
): TabOverflowControls {
  const [state, setState] = useState<TabOverflowState>(() => computeState(ref.current));

  // Keep a stable updater that always re-reads the *current* ref — important
  // because the consumer might swap refs (e.g. via React 19 ref-as-prop) and
  // we don't want to recompute against a stale element.
  const recompute = useCallback(() => {
    setState((prev) => {
      const next = computeState(ref.current);
      if (
        prev.isOverflowing === next.isOverflowing &&
        prev.canScrollLeft === next.canScrollLeft &&
        prev.canScrollRight === next.canScrollRight
      ) {
        // Bail out — React 18+ will skip the re-render anyway, but this saves
        // the strict-mode double-invoke from being noisy.
        return prev;
      }
      return next;
    });
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // First read — guarantees we're not stuck on the stale initial state if
    // the ref was attached AFTER our useState initializer ran (the common case
    // when the parent renders the strip lazily).
    recompute();

    const onScroll = () => recompute();
    el.addEventListener("scroll", onScroll, { passive: true });

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => recompute());
      observer.observe(el);
      // Also observe the parent — if the IDE sidebar collapses, the strip's
      // own size may not change yet but the children's required space might,
      // and the parent reflow tells us first.
      if (el.parentElement) observer.observe(el.parentElement);
    } else if (typeof window !== "undefined") {
      // Fallback for environments without ResizeObserver: window resize is
      // strictly weaker (won't catch sidebar collapses) but keeps the
      // chevrons honest on browser zoom / orientation change.
      window.addEventListener("resize", recompute);
    }

    return () => {
      el.removeEventListener("scroll", onScroll);
      if (observer) observer.disconnect();
      else if (typeof window !== "undefined") {
        window.removeEventListener("resize", recompute);
      }
    };
  }, [ref, recompute]);

  const scrollByTab = useCallback(
    (direction: "left" | "right") => {
      const el = ref.current;
      if (!el) return;
      const delta = direction === "left" ? -TAB_SCROLL_STEP_PX : TAB_SCROLL_STEP_PX;
      // Prefer native smooth scroll where available — falls back to instant
      // assignment otherwise (JSDOM, older WebKit).
      if (typeof el.scrollBy === "function") {
        el.scrollBy({ left: delta, behavior: "smooth" });
      } else {
        el.scrollLeft = el.scrollLeft + delta;
      }
      // The scroll listener will recompute, but smooth scrolling is async;
      // schedule an explicit recompute for the JSDOM path (which doesn't fire
      // scroll events for synchronous scrollLeft writes in every config).
      recompute();
    },
    [ref, recompute],
  );

  const scrollIntoView = useCallback(
    (tabEl: HTMLElement | null) => {
      const el = ref.current;
      if (!el || !tabEl) return;
      const containerRect = el.getBoundingClientRect();
      const tabRect = tabEl.getBoundingClientRect();
      // If the tab is fully visible, don't scroll — avoids the "every click
      // re-centers the strip" jitter that VS Code studiously avoids.
      if (
        tabRect.left >= containerRect.left &&
        tabRect.right <= containerRect.right
      ) {
        return;
      }
      if (typeof tabEl.scrollIntoView === "function") {
        tabEl.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
      } else {
        // Fallback: compute the minimum scroll needed.
        if (tabRect.left < containerRect.left) {
          el.scrollLeft -= containerRect.left - tabRect.left;
        } else {
          el.scrollLeft += tabRect.right - containerRect.right;
        }
      }
      recompute();
    },
    [ref, recompute],
  );

  return { ...state, scrollByTab, scrollIntoView };
}

// Test-only export — exposed so unit tests can assert the pure predicate
// behaviour against synthetic element shapes without spinning up React.
export const __test = { computeState, EDGE_TOLERANCE_PX, TAB_SCROLL_STEP_PX };
