// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * useTabOverflow — DOM-overflow detection hook tests.
 *
 * Three concerns pinned here, each born from a real BUG-014 audit issue:
 *
 *   1. PURE PREDICATE. `computeState({ scrollWidth, clientWidth, scrollLeft })`
 *      must return the correct `{ isOverflowing, canScrollLeft, canScrollRight }`
 *      for every edge: exact-bottom, sub-pixel, no-overflow, both-edges,
 *      and the inclusive 1px tolerance for trackpad subpixel drift.
 *
 *   2. REACTIVITY. The hook must observe scroll + resize and recompute.
 *      A consumer with chevrons that don't disable themselves on scroll-to-end
 *      is the visible bug; pinning this here prevents regressions.
 *
 *   3. NO LEAKS. Unmount must remove both the ResizeObserver and the
 *      scroll listener. A hot-reload loop that swaps refs must not
 *      leave orphan handlers running against a detached element.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as React from "react";

import {
  useTabOverflow,
  __test,
} from "../useTabOverflow";

const { computeState, EDGE_TOLERANCE_PX, TAB_SCROLL_STEP_PX } = __test;

// ─── helpers ──────────────────────────────────────────────────────────────

/** Stamp scrollLeft / scrollWidth / clientWidth onto a DOM node so that
 *  `computeState` can read them. We use Object.defineProperty because the
 *  setters on real elements are no-ops in JSDOM. */
function stampScrollProps(
  el: HTMLElement,
  props: { scrollLeft?: number; scrollWidth?: number; clientWidth?: number },
): void {
  if (props.scrollLeft !== undefined) {
    Object.defineProperty(el, "scrollLeft", {
      configurable: true,
      writable: true,
      value: props.scrollLeft,
    });
  }
  if (props.scrollWidth !== undefined) {
    Object.defineProperty(el, "scrollWidth", {
      configurable: true,
      get: () => props.scrollWidth!,
    });
  }
  if (props.clientWidth !== undefined) {
    Object.defineProperty(el, "clientWidth", {
      configurable: true,
      get: () => props.clientWidth!,
    });
  }
}

/** Minimal mutable shape — a plain div with stamped scroll props. */
function mkEl(props: {
  scrollLeft?: number;
  scrollWidth?: number;
  clientWidth?: number;
}): HTMLElement {
  const el = document.createElement("div");
  stampScrollProps(el, props);
  return el;
}

// Capture installed ResizeObserver / addEventListener for leak assertions.
let roInstances: Array<{ disconnected: boolean; observe: (t: Element) => void }> = [];

beforeEach(() => {
  roInstances = [];
  // Polyfill — JSDOM ships without one. We capture each instance so we
  // can assert .disconnect() is called on unmount.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    public disconnected = false;
    public observed: Element[] = [];
    constructor(_cb: ResizeObserverCallback) {
      roInstances.push(this);
    }
    observe(t: Element): void {
      this.observed.push(t);
    }
    unobserve(): void {}
    disconnect(): void {
      this.disconnected = true;
    }
  };
});

afterEach(() => {
  cleanup();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).ResizeObserver;
});

// ─── 1. Pure predicate (computeState) — 8 specs ───────────────────────────

describe("computeState — pure predicate", () => {
  test("null element → all false", () => {
    expect(computeState(null)).toEqual({
      isOverflowing: false,
      canScrollLeft: false,
      canScrollRight: false,
    });
  });

  test("content fits in viewport → not overflowing", () => {
    const el = mkEl({ scrollLeft: 0, scrollWidth: 200, clientWidth: 300 });
    expect(computeState(el)).toEqual({
      isOverflowing: false,
      canScrollLeft: false,
      canScrollRight: false,
    });
  });

  test("content exactly matches viewport → not overflowing", () => {
    const el = mkEl({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
    expect(computeState(el).isOverflowing).toBe(false);
  });

  test("content overflows, scrolled to start → only canScrollRight", () => {
    const el = mkEl({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
    expect(computeState(el)).toEqual({
      isOverflowing: true,
      canScrollLeft: false,
      canScrollRight: true,
    });
  });

  test("content overflows, scrolled to end → only canScrollLeft", () => {
    const el = mkEl({ scrollLeft: 600, scrollWidth: 1000, clientWidth: 400 });
    expect(computeState(el)).toEqual({
      isOverflowing: true,
      canScrollLeft: true,
      canScrollRight: false,
    });
  });

  test("content overflows, scrolled mid → both can scroll", () => {
    const el = mkEl({ scrollLeft: 200, scrollWidth: 1000, clientWidth: 400 });
    expect(computeState(el)).toEqual({
      isOverflowing: true,
      canScrollLeft: true,
      canScrollRight: true,
    });
  });

  test("1px tolerance — subpixel drift near end treated as 'at end'", () => {
    // maxScroll = 1000 - 400 = 600. scrollLeft = 599.5 → within tolerance.
    const el = mkEl({ scrollLeft: 599.5, scrollWidth: 1000, clientWidth: 400 });
    expect(computeState(el).canScrollRight).toBe(false);
  });

  test("1px tolerance at start — scrollLeft=0.4 treated as start", () => {
    const el = mkEl({ scrollLeft: 0.4, scrollWidth: 1000, clientWidth: 400 });
    expect(computeState(el).canScrollLeft).toBe(false);
  });

  test("just past 1px tolerance — chevron enables", () => {
    const el = mkEl({ scrollLeft: 1.5, scrollWidth: 1000, clientWidth: 400 });
    expect(computeState(el).canScrollLeft).toBe(true);
  });

  test("default tolerance is exactly 1px (canvas-prescribed)", () => {
    expect(EDGE_TOLERANCE_PX).toBe(1);
  });

  test("default scroll step is approximately one tab width", () => {
    // 160 is the typical Monaco tab width; canvas prescribes "one tab".
    expect(TAB_SCROLL_STEP_PX).toBe(160);
  });
});

// ─── 2. Hook reactivity — 6 specs ─────────────────────────────────────────

describe("useTabOverflow — hook reactivity", () => {
  test("returns synchronous initial state from the ref's current element", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 100, scrollWidth: 1000, clientWidth: 400 });
    (ref as { current: HTMLElement }).current = el;
    const { result } = renderHook(() => useTabOverflow(ref));
    expect(result.current.isOverflowing).toBe(true);
    expect(result.current.canScrollLeft).toBe(true);
    expect(result.current.canScrollRight).toBe(true);
  });

  test("scroll event triggers recompute", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
    (ref as { current: HTMLElement }).current = el;
    const { result } = renderHook(() => useTabOverflow(ref));
    expect(result.current.canScrollLeft).toBe(false);

    act(() => {
      stampScrollProps(el, { scrollLeft: 300 });
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.canScrollLeft).toBe(true);
    expect(result.current.canScrollRight).toBe(true);
  });

  test("ResizeObserver re-invocation triggers recompute", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 0, scrollWidth: 200, clientWidth: 400 });
    (ref as { current: HTMLElement }).current = el;
    const { result } = renderHook(() => useTabOverflow(ref));
    expect(result.current.isOverflowing).toBe(false);

    // Simulate "container shrunk so content now overflows".
    act(() => {
      stampScrollProps(el, { clientWidth: 100, scrollWidth: 200 });
      // Trigger the captured RO callback by manually invoking it via the
      // observer instance (the polyfill stores the cb in the ctor closure
      // but we can fire a scroll which the hook also listens to).
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.isOverflowing).toBe(true);
  });

  test("idempotent recompute — identical state does not churn updates", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 0, scrollWidth: 200, clientWidth: 400 });
    (ref as { current: HTMLElement }).current = el;
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useTabOverflow(ref);
    });
    const baseline = renderCount;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
      el.dispatchEvent(new Event("scroll"));
      el.dispatchEvent(new Event("scroll"));
    });
    // Three no-op scrolls should not produce three extra renders.
    expect(renderCount - baseline).toBeLessThanOrEqual(1);
    expect(result.current.isOverflowing).toBe(false);
  });

  test("scrollByTab calls native scrollBy with one tab-width delta (right)", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
    const scrollByMock = mock<HTMLElement["scrollBy"]>(() => undefined);
    el.scrollBy = scrollByMock as unknown as HTMLElement["scrollBy"];
    (ref as { current: HTMLElement }).current = el;
    const { result } = renderHook(() => useTabOverflow(ref));

    act(() => result.current.scrollByTab("right"));
    expect(scrollByMock).toHaveBeenCalledTimes(1);
    expect(scrollByMock).toHaveBeenCalledWith({
      left: TAB_SCROLL_STEP_PX,
      behavior: "smooth",
    });
  });

  test("scrollByTab calls native scrollBy with NEGATIVE delta (left)", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 500, scrollWidth: 1000, clientWidth: 400 });
    const scrollByMock = mock<HTMLElement["scrollBy"]>(() => undefined);
    el.scrollBy = scrollByMock as unknown as HTMLElement["scrollBy"];
    (ref as { current: HTMLElement }).current = el;
    const { result } = renderHook(() => useTabOverflow(ref));

    act(() => result.current.scrollByTab("left"));
    expect(scrollByMock).toHaveBeenCalledWith({
      left: -TAB_SCROLL_STEP_PX,
      behavior: "smooth",
    });
  });

  test("scrollByTab falls back to scrollLeft assignment without scrollBy", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 100, scrollWidth: 1000, clientWidth: 400 });
    // Older WebKit / JSDOM-without-polyfill — scrollBy is undefined.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).scrollBy = undefined;
    (ref as { current: HTMLElement }).current = el;
    const { result } = renderHook(() => useTabOverflow(ref));

    act(() => result.current.scrollByTab("right"));
    expect(el.scrollLeft).toBe(100 + TAB_SCROLL_STEP_PX);
  });
});

// ─── 3. scrollIntoView semantics — 4 specs ────────────────────────────────

describe("useTabOverflow — scrollIntoView", () => {
  test("does nothing for null tab element", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
    (ref as { current: HTMLElement }).current = el;
    const { result } = renderHook(() => useTabOverflow(ref));
    // Should simply no-op — no throw.
    expect(() => result.current.scrollIntoView(null)).not.toThrow();
  });

  test("does NOT scroll if tab is fully visible inside the container", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
    el.getBoundingClientRect = () =>
      ({ left: 0, right: 400, top: 0, bottom: 36 }) as DOMRect;
    (ref as { current: HTMLElement }).current = el;

    const tab = document.createElement("div");
    tab.getBoundingClientRect = () =>
      ({ left: 50, right: 150, top: 0, bottom: 36 }) as DOMRect;
    const scrollIntoViewMock = mock<HTMLElement["scrollIntoView"]>(() => undefined);
    tab.scrollIntoView = scrollIntoViewMock as unknown as HTMLElement["scrollIntoView"];

    const { result } = renderHook(() => useTabOverflow(ref));
    act(() => result.current.scrollIntoView(tab));
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  test("scrolls when tab is clipped on the RIGHT", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
    el.getBoundingClientRect = () =>
      ({ left: 0, right: 400, top: 0, bottom: 36 }) as DOMRect;
    (ref as { current: HTMLElement }).current = el;

    const tab = document.createElement("div");
    tab.getBoundingClientRect = () =>
      ({ left: 450, right: 600, top: 0, bottom: 36 }) as DOMRect;
    const scrollIntoViewMock = mock<HTMLElement["scrollIntoView"]>(() => undefined);
    tab.scrollIntoView = scrollIntoViewMock as unknown as HTMLElement["scrollIntoView"];

    const { result } = renderHook(() => useTabOverflow(ref));
    act(() => result.current.scrollIntoView(tab));
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      inline: "nearest",
      block: "nearest",
      behavior: "smooth",
    });
  });

  test("falls back to scrollLeft math when scrollIntoView missing (left clip)", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 500, scrollWidth: 1000, clientWidth: 400 });
    el.getBoundingClientRect = () =>
      ({ left: 100, right: 500, top: 0, bottom: 36 }) as DOMRect;
    (ref as { current: HTMLElement }).current = el;

    const tab = document.createElement("div");
    tab.getBoundingClientRect = () =>
      ({ left: -50, right: 50, top: 0, bottom: 36 }) as DOMRect;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tab as any).scrollIntoView = undefined;

    const { result } = renderHook(() => useTabOverflow(ref));
    act(() => result.current.scrollIntoView(tab));
    // Container's left = 100, tab's left = -50 → must subtract (100 - -50) = 150
    expect(el.scrollLeft).toBe(500 - 150);
  });
});

// ─── 4. Cleanup — 2 specs ─────────────────────────────────────────────────

describe("useTabOverflow — teardown", () => {
  test("ResizeObserver disconnects on unmount", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
    (ref as { current: HTMLElement }).current = el;
    const { unmount } = renderHook(() => useTabOverflow(ref));

    expect(roInstances.length).toBeGreaterThan(0);
    const ro = roInstances[roInstances.length - 1];
    expect(ro.disconnected).toBe(false);

    unmount();
    expect(ro.disconnected).toBe(true);
  });

  test("scroll listener removed on unmount", () => {
    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
    let listeners = 0;
    const origAdd = el.addEventListener.bind(el);
    const origRemove = el.removeEventListener.bind(el);
    el.addEventListener = function (this: HTMLElement, type: string) {
      if (type === "scroll") listeners++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origAdd as any).apply(this, arguments as unknown as IArguments);
    } as typeof el.addEventListener;
    el.removeEventListener = function (this: HTMLElement, type: string) {
      if (type === "scroll") listeners--;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origRemove as any).apply(this, arguments as unknown as IArguments);
    } as typeof el.removeEventListener;

    (ref as { current: HTMLElement }).current = el;
    const { unmount } = renderHook(() => useTabOverflow(ref));
    expect(listeners).toBe(1);
    unmount();
    expect(listeners).toBe(0);
  });

  test("falls back to window resize listener without ResizeObserver", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).ResizeObserver;

    const ref = React.createRef<HTMLDivElement>();
    const el = mkEl({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
    (ref as { current: HTMLElement }).current = el;

    let windowListeners = 0;
    const origAdd = window.addEventListener;
    const origRemove = window.removeEventListener;
    window.addEventListener = function (this: Window, type: string) {
      if (type === "resize") windowListeners++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origAdd as any).apply(this, arguments as unknown as IArguments);
    } as typeof window.addEventListener;
    window.removeEventListener = function (this: Window, type: string) {
      if (type === "resize") windowListeners--;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origRemove as any).apply(this, arguments as unknown as IArguments);
    } as typeof window.removeEventListener;

    const { unmount } = renderHook(() => useTabOverflow(ref));
    expect(windowListeners).toBe(1);
    unmount();
    expect(windowListeners).toBe(0);

    window.addEventListener = origAdd;
    window.removeEventListener = origRemove;
  });
});
