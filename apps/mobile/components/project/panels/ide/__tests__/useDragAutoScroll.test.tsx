/**
 * useDragAutoScroll — rAF-driven auto-scroll loop tests.
 *
 * The hook owns three guarantees the file-tree DnD path depends on:
 *
 *   1. ZERO IDLE WORK. When delta=0 the rAF loop must not be running —
 *      otherwise we'd burn 60 callbacks/s while the user holds a drag
 *      stationary in the middle of the tree.
 *
 *   2. LATEST-DELTA SEMANTICS. A second updateDelta call mid-frame must
 *      be picked up on the next frame (the loop reads a ref, never a
 *      closure capture).
 *
 *   3. CLEAN TEAR-DOWN. stop() / unmount must cancel the pending frame;
 *      no orphan rAF after the user releases the drag or hot-reloads.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as React from "react";
import { useDragAutoScroll } from "../useDragAutoScroll";

// ─── rAF fake: queue callbacks, drain them manually ───────────────────────
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextRafId = 1;
let cancelCount = 0;
const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;

beforeEach(() => {
  rafQueue = [];
  nextRafId = 1;
  cancelCount = 0;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafQueue.push({ id, cb });
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    cancelCount++;
    rafQueue = rafQueue.filter((r) => r.id !== id);
  }) as typeof cancelAnimationFrame;
});

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
});

function flushOneFrame() {
  // Drain exactly the frames queued at this moment — tick() may re-queue
  // a new one which must wait for the NEXT flush.
  const due = rafQueue;
  rafQueue = [];
  for (const r of due) r.cb(0);
}

function makeScrollEl(initial = 0) {
  const el = { scrollTop: initial } as HTMLElement;
  return { current: el };
}

// ──────────────────────────────────────────────────────────────────────────

describe("useDragAutoScroll — idle behaviour", () => {
  test("does NOT schedule a frame on mount", () => {
    const ref = makeScrollEl();
    renderHook(() => useDragAutoScroll(ref));
    expect(rafQueue.length).toBe(0);
  });

  test("does NOT schedule a frame for delta=0", () => {
    const ref = makeScrollEl();
    const { result } = renderHook(() => useDragAutoScroll(ref));
    act(() => result.current.updateDelta(0));
    expect(rafQueue.length).toBe(0);
  });
});

describe("useDragAutoScroll — scrolling behaviour", () => {
  test("scrolls the element by the latest delta each frame", () => {
    const ref = makeScrollEl(100);
    const { result } = renderHook(() => useDragAutoScroll(ref));

    act(() => result.current.updateDelta(8));
    expect(rafQueue.length).toBe(1);

    flushOneFrame();
    expect(ref.current!.scrollTop).toBe(108);
    expect(rafQueue.length).toBe(1); // re-queued for next frame

    flushOneFrame();
    expect(ref.current!.scrollTop).toBe(116);
  });

  test("picks up the LATEST delta on the next frame (ref, not closure)", () => {
    const ref = makeScrollEl(100);
    const { result } = renderHook(() => useDragAutoScroll(ref));

    act(() => result.current.updateDelta(8));
    flushOneFrame();
    expect(ref.current!.scrollTop).toBe(108);

    // Pointer moved into a steeper part of the edge: bump delta.
    act(() => result.current.updateDelta(16));
    flushOneFrame();
    expect(ref.current!.scrollTop).toBe(124);
  });

  test("setting delta=0 mid-loop stops scrolling on the next frame", () => {
    const ref = makeScrollEl(100);
    const { result } = renderHook(() => useDragAutoScroll(ref));

    act(() => result.current.updateDelta(8));
    flushOneFrame();
    expect(ref.current!.scrollTop).toBe(108);

    act(() => result.current.updateDelta(0));
    flushOneFrame();
    expect(ref.current!.scrollTop).toBe(108); // no further movement
    expect(rafQueue.length).toBe(0); // loop torn down
  });

  test("scrolls in the negative direction (top-edge)", () => {
    const ref = makeScrollEl(100);
    const { result } = renderHook(() => useDragAutoScroll(ref));

    act(() => result.current.updateDelta(-8));
    flushOneFrame();
    expect(ref.current!.scrollTop).toBe(92);
  });
});

describe("useDragAutoScroll — tear-down", () => {
  test("stop() cancels the pending frame and clears delta", () => {
    const ref = makeScrollEl(100);
    const { result } = renderHook(() => useDragAutoScroll(ref));

    act(() => result.current.updateDelta(8));
    expect(rafQueue.length).toBe(1);

    act(() => result.current.stop());
    expect(rafQueue.length).toBe(0);
    expect(cancelCount).toBeGreaterThan(0);
  });

  test("stop() is idempotent (safe to call when no frame is queued)", () => {
    const ref = makeScrollEl(100);
    const { result } = renderHook(() => useDragAutoScroll(ref));

    expect(() => act(() => result.current.stop())).not.toThrow();
    expect(() => act(() => result.current.stop())).not.toThrow();
  });

  test("unmount cancels any in-flight frame (no orphan rAF)", () => {
    const ref = makeScrollEl(100);
    const { result, unmount } = renderHook(() => useDragAutoScroll(ref));

    act(() => result.current.updateDelta(8));
    expect(rafQueue.length).toBe(1);

    unmount();
    expect(rafQueue.length).toBe(0);
  });

  test("does NOT scroll a detached element (ref.current=null)", () => {
    const ref: { current: HTMLElement | null } = makeScrollEl(100);
    const { result } = renderHook(() => useDragAutoScroll(ref));

    act(() => result.current.updateDelta(8));
    ref.current = null; // simulate element removed mid-drag
    expect(() => flushOneFrame()).not.toThrow();
    // No re-queue because tick() bailed on null el.
    expect(rafQueue.length).toBe(0);
  });
});
