import { useEffect, useRef } from "react";

/**
 * BUG-011 — Drag controller cancel hook.
 *
 * The HTML5 drag-drop spec says hitting `Escape` mid-drag fires the
 * `dragend` event, which is where consumers normally clear their React
 * drag state. In practice `dragend` is unreliable in several real-world
 * conditions:
 *
 *   1. Pointer leaves the renderer (Electron / iframe) → dragend may
 *      fire on the OS, never on our window.
 *   2. The page loses focus mid-drag (alt-tab, OS dialog) → the drag
 *      is cancelled but no `dragend` arrives.
 *   3. The tab visibility flips to hidden (background tab) → same.
 *   4. Mobile Safari + WebKit: dragend can be dropped if the drag is
 *      cancelled by a system gesture.
 *
 * In every one of those, our React state stays set, which leaves
 * artefacts on screen (e.g. the blue drop indicator on a tab strip
 * showing where the user *would have* dropped, even though the drag
 * is long over). The canvas evidence for BUG-011 calls this out
 * exactly: "Esc cancels drag but div not removed".
 *
 * This hook is the universal belt-and-braces: while a drag is active,
 * we listen for the three signals that mean "drag is done, regardless
 * of what dragend did" and invoke a single `cancel()` callback that
 * the consumer uses to clear its drag state.
 *
 * Design notes
 * ─────────────────────────────────────────────────────────────────
 * • Listener attaches ONLY while `active === true`. No work in the
 *   common no-drag case (no perf cost on idle tabstrips).
 * • Keydown is registered in the capture phase so a stacked modal
 *   listening for Esc on the same frame can't swallow our cancel
 *   first. (Drag-in-progress is a transient state; precedence here
 *   is correct — Esc should cancel the drag before anything else.)
 * • We do NOT call `preventDefault()` on the Esc keydown. The browser
 *   ALSO needs to fire its native drag-cancel path so that any
 *   pending OS drag image / cursor restores correctly. Our handler
 *   is purely additive — it cleans up React state; the native
 *   dragend (if it fires) will be a no-op because state is already
 *   null.
 * • `cancel` is stored in a ref so the effect doesn't tear down and
 *   re-attach on every parent render — only the `active` flag flips
 *   the subscription on/off. Without this, a parent that re-creates
 *   `cancel` on every render would churn listeners 60×/sec during a
 *   drag.
 * • `visibilitychange` only triggers when document goes hidden
 *   (not when it becomes visible again) — flipping back into view
 *   mid-drag should not cancel.
 * • Idempotent: calling cancel() when nothing is active is fine
 *   (consumer's setDragId(null) etc. is a no-op). The hook makes
 *   no assumption about consumer state shape.
 *
 * @param active  Whether a drag is currently in progress.
 * @param cancel  Called when the drag should be cancelled. Should
 *                clear all drag-related state in the consumer.
 */
export function useDragCancel(active: boolean, cancel: () => void): void {
  // Ref-pin the callback so the effect's dep array stays stable across
  // re-renders. Parents almost always pass an inline `() => { ... }`
  // which would otherwise tear the listener down 60×/sec.
  const cancelRef = useRef(cancel);
  useEffect(() => {
    cancelRef.current = cancel;
  }, [cancel]);

  useEffect(() => {
    if (!active) return;

    const invoke = () => cancelRef.current();

    const onKeyDown = (e: KeyboardEvent) => {
      // Plain Esc cancels (Shift+Esc / Cmd+Esc also fire `key === "Escape"`
      // — and a user who really wants to cancel a drag is unlikely to
      // be holding a modifier; matching native browser drag-cancel UX
      // is fine here).
      if (e.key === "Escape") invoke();
    };

    const onBlur = () => invoke();

    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        invoke();
      }
    };

    // Capture phase for keydown so an open modal / palette listening
    // on bubble can't swallow our cancel.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [active]);
}
