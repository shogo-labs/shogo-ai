// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-DRAG-SPLIT — unit tests for the pure drag-to-split geometry/planner.
 *
 * Pure module, no React / DOM / drag events — runs under `bun test`.
 * Pins: drop-zone resolution (centre, each edge, corner tie-break, edge
 * band ratio, outside/degenerate guards); zone→split mapping; overlay
 * rect geometry; and the drop plan (noop/move/split + source collapse).
 */
import { describe, expect, test } from "bun:test"
import {
  dropZoneOverlayRect,
  dropZoneToSplit,
  planTabDrop,
  resolveDropZone,
  type Rect,
} from "../drag-split"

const rect: Rect = { x: 0, y: 0, width: 1000, height: 800 }
const at = (x: number, y: number) => ({ x, y })

describe("resolveDropZone", () => {
  test("dead centre → center", () => {
    expect(resolveDropZone(at(500, 400), rect)).toBe("center")
  })
  test("each edge band resolves to its zone (default 0.2 ratio)", () => {
    expect(resolveDropZone(at(50, 400), rect)).toBe("left") // nx .05
    expect(resolveDropZone(at(950, 400), rect)).toBe("right") // nx .95
    expect(resolveDropZone(at(500, 40), rect)).toBe("top") // ny .05
    expect(resolveDropZone(at(500, 760), rect)).toBe("bottom") // ny .95
  })
  test("just inside the central region → center", () => {
    // ratio 0.2 → left band ends at x=200; x=210 is central
    expect(resolveDropZone(at(210, 400), rect)).toBe("center")
    // ny = 170/800 = 0.2125 > 0.2 → past the top band → center
    expect(resolveDropZone(at(500, 170), rect)).toBe("center")
    // ny = 150/800 = 0.1875 <= 0.2 → inside the top band
    expect(resolveDropZone(at(500, 150), rect)).toBe("top")
  })
  test("boundary x exactly on the band edge counts as the edge (<=)", () => {
    expect(resolveDropZone(at(200, 400), rect)).toBe("left") // nx .2 == ratio
  })
  test("corner: deeper band wins; exact tie favours horizontal", () => {
    // top-left corner, equally deep → tie → left (horizontal)
    expect(resolveDropZone(at(0, 0), rect)).toBe("left")
    // very top but only mildly left → top wins (vertical deeper)
    expect(resolveDropZone(at(180, 5), rect)).toBe("top")
    // very left but only mildly top → left wins
    expect(resolveDropZone(at(5, 150), rect)).toBe("left")
  })
  test("custom edgeRatio widens/narrows the bands", () => {
    expect(resolveDropZone(at(300, 400), rect, { edgeRatio: 0.35 })).toBe("left") // nx .3 <= .35
    expect(resolveDropZone(at(300, 400), rect, { edgeRatio: 0.2 })).toBe("center")
  })
  test("clamps an out-of-range edgeRatio", () => {
    expect(() => resolveDropZone(at(500, 400), rect, { edgeRatio: 5 })).not.toThrow()
    expect(() => resolveDropZone(at(500, 400), rect, { edgeRatio: -1 })).not.toThrow()
  })
  test("pointer outside rect → center", () => {
    expect(resolveDropZone(at(-10, 400), rect)).toBe("center")
    expect(resolveDropZone(at(2000, 400), rect)).toBe("center")
  })
  test("degenerate rect → center", () => {
    expect(resolveDropZone(at(0, 0), { x: 0, y: 0, width: 0, height: 0 })).toBe("center")
  })
  test("non-finite point → center", () => {
    expect(resolveDropZone(at(NaN, 400), rect)).toBe("center")
  })
  test("respects a non-zero rect origin", () => {
    const off: Rect = { x: 100, y: 100, width: 200, height: 200 }
    expect(resolveDropZone(at(110, 200), off)).toBe("left") // nx (10/200)=.05
    expect(resolveDropZone(at(200, 200), off)).toBe("center")
  })
})

describe("dropZoneToSplit", () => {
  test("edges map to axis + position", () => {
    expect(dropZoneToSplit("left")).toEqual({ axis: "horizontal", position: "before" })
    expect(dropZoneToSplit("right")).toEqual({ axis: "horizontal", position: "after" })
    expect(dropZoneToSplit("top")).toEqual({ axis: "vertical", position: "before" })
    expect(dropZoneToSplit("bottom")).toEqual({ axis: "vertical", position: "after" })
  })
  test("center → null", () => {
    expect(dropZoneToSplit("center")).toBeNull()
  })
})

describe("dropZoneOverlayRect", () => {
  test("left/right are half-width", () => {
    expect(dropZoneOverlayRect("left", rect)).toEqual({ x: 0, y: 0, width: 500, height: 800 })
    expect(dropZoneOverlayRect("right", rect)).toEqual({ x: 500, y: 0, width: 500, height: 800 })
  })
  test("top/bottom are half-height", () => {
    expect(dropZoneOverlayRect("top", rect)).toEqual({ x: 0, y: 0, width: 1000, height: 400 })
    expect(dropZoneOverlayRect("bottom", rect)).toEqual({ x: 0, y: 400, width: 1000, height: 400 })
  })
  test("center fills the group", () => {
    expect(dropZoneOverlayRect("center", rect)).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
  })
  test("respects origin + degenerate rect", () => {
    const off: Rect = { x: 100, y: 50, width: 200, height: 100 }
    expect(dropZoneOverlayRect("right", off)).toEqual({ x: 200, y: 50, width: 100, height: 100 })
    expect(dropZoneOverlayRect("left", { x: 0, y: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe("planTabDrop", () => {
  test("center onto the SAME group → noop, no collapse", () => {
    expect(planTabDrop({ zone: "center", sourceGroupId: "g1", targetGroupId: "g1", sourceTabCount: 3 }))
      .toEqual({ kind: "noop", collapsesSourceGroup: false })
  })
  test("center onto a DIFFERENT group → move", () => {
    expect(planTabDrop({ zone: "center", sourceGroupId: "g1", targetGroupId: "g2", sourceTabCount: 3 }))
      .toEqual({ kind: "move", collapsesSourceGroup: false })
  })
  test("center move of the source's LAST tab collapses the source", () => {
    expect(planTabDrop({ zone: "center", sourceGroupId: "g1", targetGroupId: "g2", sourceTabCount: 1 }))
      .toEqual({ kind: "move", collapsesSourceGroup: true })
  })
  test("edge drop → split with axis/position", () => {
    expect(planTabDrop({ zone: "right", sourceGroupId: "g1", targetGroupId: "g2", sourceTabCount: 3 }))
      .toEqual({ kind: "split", axis: "horizontal", position: "after", collapsesSourceGroup: false })
    expect(planTabDrop({ zone: "top", sourceGroupId: "g1", targetGroupId: "g2", sourceTabCount: 3 }))
      .toEqual({ kind: "split", axis: "vertical", position: "before", collapsesSourceGroup: false })
  })
  test("edge split of the source's last tab into ANOTHER group collapses source", () => {
    expect(planTabDrop({ zone: "left", sourceGroupId: "g1", targetGroupId: "g2", sourceTabCount: 1 }))
      .toEqual({ kind: "split", axis: "horizontal", position: "before", collapsesSourceGroup: true })
  })
  test("splitting the ONLY tab onto its OWN group's edge is a noop", () => {
    expect(planTabDrop({ zone: "left", sourceGroupId: "g1", targetGroupId: "g1", sourceTabCount: 1 }))
      .toEqual({ kind: "noop", collapsesSourceGroup: false })
  })
  test("splitting one of MANY tabs onto its own group's edge is a real split (no collapse)", () => {
    expect(planTabDrop({ zone: "bottom", sourceGroupId: "g1", targetGroupId: "g1", sourceTabCount: 4 }))
      .toEqual({ kind: "split", axis: "vertical", position: "after", collapsesSourceGroup: false })
  })
  test("defensive: missing sourceTabCount treated as 0 (collapses on cross-group move)", () => {
    expect(planTabDrop({ zone: "center", sourceGroupId: "g1", targetGroupId: "g2", sourceTabCount: undefined as unknown as number }))
      .toEqual({ kind: "move", collapsesSourceGroup: true })
  })
})
