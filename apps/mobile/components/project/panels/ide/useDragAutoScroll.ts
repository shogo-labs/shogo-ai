/**
 * useDragAutoScroll — rAF-driven auto-scroll for the file tree during DnD.
 *
 * Part of the BUG-002 fix. The pure math lives in `file-tree-drop-zone.ts`;
 * this hook is the side-effect layer that:
 *
 *   - keeps a single requestAnimationFrame loop alive only while a delta
 *     is non-zero (no idle CPU when the pointer sits in the inside zone),
 *   - reads the LATEST delta on each frame from a ref (so a fast pointer
 *     move out of the edge band stops scrolling on the next frame, not
 *     "after the queued frame finishes"),
 *   - tears down cleanly on drop / drag-end / unmount / leave — the
 *     dragend event the browser fires on every drop (including outside
 *     our container) is the canonical stop signal.
 *
 * Returned API:
 *   updateDelta(delta) — call from onDragOver with the latest scrollDelta;
 *                        pass 0 to pause the loop without tearing it down.
 *   stop()             — call from onDrop / onDragLeave (container) /
 *                        onDragEnd / cleanup. Idempotent.
 */
import { useCallback, useEffect, useRef } from "react";

export function useDragAutoScroll(
  scrollEl: { current: HTMLElement | null },
): {
  updateDelta: (delta: number) => void;
  stop: () => void;
} {
  const deltaRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const tick = useCallback(() => {
    const el = scrollEl.current;
    const delta = deltaRef.current;
    if (!el || delta === 0) {
      rafRef.current = null;
      return;
    }
    // Apply once per frame. The pure helper already clamped delta against
    // top/bottom — but DOM mutations between frames may shift bounds, so
    // the element will silently clamp again if we overshoot.
    el.scrollTop = el.scrollTop + delta;
    rafRef.current = requestAnimationFrame(tick);
  }, [scrollEl]);

  const updateDelta = useCallback(
    (delta: number) => {
      deltaRef.current = delta;
      if (delta !== 0 && rafRef.current === null) {
        rafRef.current = requestAnimationFrame(tick);
      }
    },
    [tick],
  );

  const stop = useCallback(() => {
    deltaRef.current = 0;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Always cancel on unmount. Without this a hot-reload mid-drag would
  // leave an orphan rAF loop holding the stale scrollEl ref.
  useEffect(() => stop, [stop]);

  return { updateDelta, stop };
}
