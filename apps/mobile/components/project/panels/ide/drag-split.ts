// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-DRAG-SPLIT — drag a tab to a viewport edge to split the editor group.
 *
 * Shogo could only split an editor group via a menu item or keybinding.
 * VS Code lets you DRAG a tab to the edge of an editor group: hovering the
 * outer band on a side shows a half-pane overlay, and dropping there
 * splits the group in that direction and moves the tab into the new group.
 * Dropping in the centre just moves the tab into the existing group.
 *
 * This module is the pure, side-effect-free geometry + planning brain
 * behind that interaction, mirroring the extraction pattern of the other
 * UX-* modules (quick-open-disambiguate / diff-view-mode / minimap-settings
 * / problems-navigation / tab-context-menu / peek-actions / settings-form):
 * no React, no DOM, no drag events. The drop-target React component reads
 * the live pointer rect, calls `resolveDropZone`, renders the overlay from
 * `dropZoneOverlayRect`, and on drop executes `planTabDrop`.
 *
 * What lives here:
 *   • DropZone (center | left | right | top | bottom) and the geometry to
 *     resolve one from a pointer position within a group's rectangle,
 *     with a configurable edge band and correct corner tie-breaking.
 *   • `dropZoneToSplit` — zone → { axis, position } (or null for center).
 *   • `dropZoneOverlayRect` — the highlight rectangle to render.
 *   • `planTabDrop` — the resulting operation: noop / move / split, with
 *     `collapsesSourceGroup` when the source group's last tab leaves it.
 *
 * Deliberately NOT here: React, DOM, DataTransfer, layout mutation.
 */

export type DropZone = "center" | "left" | "right" | "top" | "bottom"

/** Axis along which the two groups sit after a split. */
export type SplitAxis = "horizontal" | "vertical"

/** Where the NEW group lands relative to the existing one. */
export type SplitPosition = "before" | "after"

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface ResolveDropZoneOptions {
  /**
   * Fraction (0–0.5) of each dimension treated as the edge band. Default
   * 0.2 → outer 20% on each side is a split zone, the central 60%×60% is
   * the "move" zone. Clamped to (0, 0.5).
   */
  edgeRatio?: number
}

const DEFAULT_EDGE_RATIO = 0.2

function clampEdgeRatio(r: number | undefined): number {
  if (typeof r !== "number" || !Number.isFinite(r)) return DEFAULT_EDGE_RATIO
  if (r <= 0) return 0.0001
  if (r >= 0.5) return 0.4999
  return r
}

function contains(rect: Rect, p: Point): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
}

/**
 * Resolve which drop zone a pointer is over within a group's rectangle.
 *
 * - Pointer outside the rect, or a degenerate (zero-area) rect → 'center'
 *   (the safe default: a plain move, never an accidental split).
 * - Within an edge band → that edge. In a corner (two bands overlap) the
 *   edge whose normalised distance-from-edge is smaller wins; ties favour
 *   the horizontal (left/right) split, matching VS Code.
 * - Otherwise → 'center'.
 */
export function resolveDropZone(
  point: Point,
  rect: Rect,
  options: ResolveDropZoneOptions = {},
): DropZone {
  if (!rect || rect.width <= 0 || rect.height <= 0) return "center"
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return "center"
  if (!contains(rect, point)) return "center"

  const ratio = clampEdgeRatio(options.edgeRatio)
  // Normalised position within the rect, 0..1.
  const nx = (point.x - rect.x) / rect.width
  const ny = (point.y - rect.y) / rect.height

  const nearLeft = nx <= ratio
  const nearRight = nx >= 1 - ratio
  const nearTop = ny <= ratio
  const nearBottom = ny >= 1 - ratio

  // Distance INTO the band (how deep past the threshold), normalised so
  // horizontal and vertical bands compare fairly.
  const horizCandidate = nearLeft ? { zone: "left" as DropZone, depth: ratio - nx } : nearRight ? { zone: "right" as DropZone, depth: nx - (1 - ratio) } : null
  const vertCandidate = nearTop ? { zone: "top" as DropZone, depth: ratio - ny } : nearBottom ? { zone: "bottom" as DropZone, depth: ny - (1 - ratio) } : null

  if (horizCandidate && vertCandidate) {
    // Corner: deeper-into-band wins; tie → horizontal (left/right).
    return vertCandidate.depth > horizCandidate.depth ? vertCandidate.zone : horizCandidate.zone
  }
  if (horizCandidate) return horizCandidate.zone
  if (vertCandidate) return vertCandidate.zone
  return "center"
}

/** Map a zone to the split it represents. Center → null (no split). */
export function dropZoneToSplit(zone: DropZone): { axis: SplitAxis; position: SplitPosition } | null {
  switch (zone) {
    case "left":
      return { axis: "horizontal", position: "before" }
    case "right":
      return { axis: "horizontal", position: "after" }
    case "top":
      return { axis: "vertical", position: "before" }
    case "bottom":
      return { axis: "vertical", position: "after" }
    case "center":
    default:
      return null
  }
}

/**
 * The overlay rectangle to highlight for a given zone — half the group on
 * the relevant side for an edge, the full group for center. Pure geometry;
 * a degenerate rect yields a zero-area overlay at its origin.
 */
export function dropZoneOverlayRect(zone: DropZone, rect: Rect): Rect {
  const w = Math.max(0, rect?.width ?? 0)
  const h = Math.max(0, rect?.height ?? 0)
  const x = rect?.x ?? 0
  const y = rect?.y ?? 0
  switch (zone) {
    case "left":
      return { x, y, width: w / 2, height: h }
    case "right":
      return { x: x + w / 2, y, width: w / 2, height: h }
    case "top":
      return { x, y, width: w, height: h / 2 }
    case "bottom":
      return { x, y: y + h / 2, width: w, height: h / 2 }
    case "center":
    default:
      return { x, y, width: w, height: h }
  }
}

export type TabDropKind = "noop" | "move" | "split"

export interface TabDropInput {
  zone: DropZone
  sourceGroupId: string
  targetGroupId: string
  /** Number of tabs currently in the SOURCE group (incl. the dragged one). */
  sourceTabCount: number
  /** Is the dragged tab already the active/only tab being dropped onto itself? */
  draggedTabId?: string
  /** The currently active tab id in the target group (for same-spot noop). */
  targetActiveTabId?: string
}

export interface TabDropPlan {
  kind: TabDropKind
  axis?: SplitAxis
  position?: SplitPosition
  /** True when the source group becomes empty and should be removed. */
  collapsesSourceGroup: boolean
}

/**
 * Plan the operation a drop should perform.
 *
 * - Center drop onto the SAME group, of a tab already there, with nothing
 *   to reorder → 'noop'.
 * - Center drop → 'move' the tab into the target group.
 * - Edge drop → 'split' the target group along the zone's axis/position
 *   and move the tab into the new group.
 * - `collapsesSourceGroup` is true when the source group had exactly one
 *   tab (the dragged one) and it leaves — i.e. a split/move that empties
 *   the source. A center drop onto the same group never collapses it.
 * - Splitting the ONLY tab of a group onto that SAME group's edge is a
 *   noop (it would just recreate an identical single-tab group).
 */
export function planTabDrop(input: TabDropInput): TabDropPlan {
  const { zone, sourceGroupId, targetGroupId, sourceTabCount } = input
  const sameGroup = sourceGroupId === targetGroupId
  const split = dropZoneToSplit(zone)
  const sourceHasOneTab = (typeof sourceTabCount === "number" ? sourceTabCount : 0) <= 1

  if (!split) {
    // Center: move (or noop if dropping into the group it's already in).
    if (sameGroup) {
      return { kind: "noop", collapsesSourceGroup: false }
    }
    return { kind: "move", collapsesSourceGroup: sourceHasOneTab }
  }

  // Edge split.
  if (sameGroup && sourceHasOneTab) {
    // Splitting a group's only tab off onto its own edge = identical layout.
    return { kind: "noop", collapsesSourceGroup: false }
  }

  return {
    kind: "split",
    axis: split.axis,
    position: split.position,
    collapsesSourceGroup: !sameGroup && sourceHasOneTab,
  }
}
