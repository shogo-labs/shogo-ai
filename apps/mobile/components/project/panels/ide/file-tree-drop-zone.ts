/**
 * file-tree-drop-zone.ts — pure pointer→drop-zone math for the file tree.
 *
 * BUG-002 ("File tree DnD drops in wrong slot when scrolled") in canvas
 * shorthand: "Drop Y uses viewport offset, not scrollTop-adjusted. Fix:
 * Add container.scrollTop to drop Y."
 *
 * The canvas reduced the issue to one line, but the underlying scrolled-tree
 * DnD experience needs three things that all share the same math:
 *
 *   1. CONTENT-COORDINATE Y. Anywhere we need to map a pointer back to a
 *      content position (insertion-line index, between-rows reorder, hit-
 *      test on virtualised rows, etc.), we MUST add `scrollTop` to the
 *      viewport-relative `clientY - rect.top`. Browser drag events ship
 *      `clientY` in viewport coordinates — using that raw against the
 *      scrolled content shifts every drop up by however much the user
 *      had scrolled. This helper exposes `contentY` so no caller can
 *      forget the adjustment.
 *
 *   2. EDGE-ZONE DETECTION for auto-scroll. When the pointer is inside
 *      the top or bottom `edgeSize` pixels of the visible viewport, we
 *      need to scroll the container so off-screen folders become drop
 *      targets without the user releasing the drag.
 *
 *   3. END-OF-SCROLL GUARDS. Auto-scrolling past the top (scrollTop < 0)
 *      or past the bottom (scrollTop + height > scrollHeight) is a no-op
 *      in the DOM but flickers the indicator. Returning a clamped
 *      `scrollDelta` keeps the caller's rAF loop quiet.
 *
 * The helper is pure (no DOM access, no state) so the routing rule is
 * deterministically unit-testable and any future refactor of the tree's
 * DnD glue inherits scrollTop-correctness for free.
 */

export interface DropZoneInput {
  /** Pointer Y in viewport coordinates (event.clientY). */
  clientY: number;
  /** Container's bounding rect — only `top`, `bottom`, and `height` are read. */
  containerRect: { top: number; bottom: number; height: number };
  /** Container.scrollTop (px scrolled past the top). */
  scrollTop: number;
  /** Container.scrollHeight (total content height including off-screen). */
  scrollHeight: number;
  /** Edge band size for auto-scroll, in viewport px. Default 28. */
  edgeSize?: number;
  /** Max scroll delta per frame, in px. Default 8. */
  maxScrollDelta?: number;
}

export type DropZone = "top-edge" | "bottom-edge" | "inside" | "outside";

export interface DropZoneResult {
  /**
   * Pointer Y in CONTENT coordinates.
   *
   *   contentY = clientY - containerRect.top + scrollTop
   *
   * This is the exact one-liner BUG-002's fix line prescribes. Use this
   * for any per-row index math (e.g. `Math.floor(contentY / rowHeight)`).
   * When the container is unscrolled (`scrollTop === 0`) this equals the
   * viewport-relative Y.
   */
  contentY: number;
  /** Pointer Y relative to the viewport top of the container (0..height). */
  viewportY: number;
  /** Which auto-scroll band the pointer is currently in. */
  zone: DropZone;
  /**
   * Scroll delta to apply this frame:
   *   - negative when in top-edge AND `scrollTop > 0`
   *   - positive when in bottom-edge AND room remains below
   *   - 0 in `inside` / `outside`, or when already pinned at an end
   *
   * Magnitude scales linearly from 0 at the edge-band's inner boundary
   * to ±maxScrollDelta at the very edge — this gives the user a softer
   * pull-into-scroll feel than a constant velocity.
   */
  scrollDelta: number;
}

export function computeDropZone(input: DropZoneInput): DropZoneResult {
  const {
    clientY,
    containerRect: rect,
    scrollTop,
    scrollHeight,
  } = input;
  const edgeSize = input.edgeSize ?? 28;
  const maxScrollDelta = input.maxScrollDelta ?? 8;

  const viewportY = clientY - rect.top;
  const contentY = viewportY + scrollTop;

  // Outside the container's vertical span entirely (the browser still
  // fires dragOver when the pointer is on a child that hangs off-screen).
  if (viewportY < 0 || viewportY > rect.height) {
    return { contentY, viewportY, zone: "outside", scrollDelta: 0 };
  }

  // Top edge band — closer to the edge → larger negative delta. Clamp to
  // 0 when there's nothing left to scroll up to (avoid flicker / event
  // spam on rAF).
  if (viewportY < edgeSize) {
    if (scrollTop <= 0) {
      return { contentY, viewportY, zone: "top-edge", scrollDelta: 0 };
    }
    const intensity = 1 - viewportY / edgeSize; // 0..1, 1 at the edge
    const raw = -Math.ceil(intensity * maxScrollDelta);
    // Don't overshoot zero (clamp magnitude to scrollTop).
    const delta = Math.max(raw, -scrollTop);
    return { contentY, viewportY, zone: "top-edge", scrollDelta: delta };
  }

  // Bottom edge band.
  if (viewportY > rect.height - edgeSize) {
    const maxScroll = Math.max(0, scrollHeight - rect.height);
    const remaining = maxScroll - scrollTop;
    if (remaining <= 0) {
      return { contentY, viewportY, zone: "bottom-edge", scrollDelta: 0 };
    }
    const intensity = 1 - (rect.height - viewportY) / edgeSize; // 0..1
    const raw = Math.ceil(intensity * maxScrollDelta);
    const delta = Math.min(raw, remaining);
    return { contentY, viewportY, zone: "bottom-edge", scrollDelta: delta };
  }

  return { contentY, viewportY, zone: "inside", scrollDelta: 0 };
}
