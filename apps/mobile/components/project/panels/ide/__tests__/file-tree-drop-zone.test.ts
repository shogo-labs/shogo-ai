/**
 * computeDropZone — pure pointer→drop-zone math for the file tree.
 *
 * The canvas BUG-002 prescription was a one-liner ("Add container.scrollTop
 * to drop Y") but the real fix is three properties this suite locks down:
 *
 *   1. contentY = clientY - rect.top + scrollTop (the verbatim canvas fix)
 *   2. zone classification for auto-scroll (top-edge / bottom-edge / inside
 *      / outside) with both-sides exclusive boundaries
 *   3. END-OF-SCROLL guards so the rAF loop quiets when there's nothing
 *      to scroll
 *
 * Every test is named after the property it locks; each test is one assertion
 * (or one small group of related assertions).
 */
import { describe, expect, test } from "bun:test";
import { computeDropZone } from "../file-tree-drop-zone";

const rect = (top: number, height: number) => ({
  top,
  bottom: top + height,
  height,
});

describe("computeDropZone — contentY (the canvas fix)", () => {
  test("equals viewportY when scrollTop=0", () => {
    const r = computeDropZone({
      clientY: 150,
      containerRect: rect(100, 400),
      scrollTop: 0,
      scrollHeight: 400,
    });
    expect(r.viewportY).toBe(50);
    expect(r.contentY).toBe(50);
  });

  test("adds scrollTop so contentY maps to the correct row when scrolled", () => {
    // Pointer mid-viewport (200px into a 400px-high tree).
    // Tree is scrolled 300px down — content row under pointer is at
    // (200 + 300) = 500. Without the BUG-002 fix the caller would see 200
    // and resolve the WRONG row.
    const r = computeDropZone({
      clientY: 300,
      containerRect: rect(100, 400),
      scrollTop: 300,
      scrollHeight: 1200,
    });
    expect(r.viewportY).toBe(200);
    expect(r.contentY).toBe(500);
  });

  test("contentY is consistent across a scroll: dragging the same row index always returns the same contentY", () => {
    // Same conceptual "drop on row 30 of a 16px row list" → contentY=480
    // regardless of how the tree is scrolled when the user dropped.
    const a = computeDropZone({
      clientY: 580,  containerRect: rect(100, 400), scrollTop: 0,   scrollHeight: 1200,
    });
    const b = computeDropZone({
      clientY: 280,  containerRect: rect(100, 400), scrollTop: 300, scrollHeight: 1200,
    });
    expect(a.contentY).toBe(480);
    expect(b.contentY).toBe(480);
  });
});

describe("computeDropZone — zone classification", () => {
  test("inside: pointer comfortably in the middle band", () => {
    const r = computeDropZone({
      clientY: 250, containerRect: rect(100, 400), scrollTop: 100, scrollHeight: 1200,
    });
    expect(r.zone).toBe("inside");
    expect(r.scrollDelta).toBe(0);
  });

  test("top-edge: pointer within edgeSize of the top", () => {
    const r = computeDropZone({
      clientY: 110, containerRect: rect(100, 400), scrollTop: 100, scrollHeight: 1200,
    });
    expect(r.zone).toBe("top-edge");
  });

  test("bottom-edge: pointer within edgeSize of the bottom", () => {
    const r = computeDropZone({
      clientY: 490, containerRect: rect(100, 400), scrollTop: 100, scrollHeight: 1200,
    });
    expect(r.zone).toBe("bottom-edge");
  });

  test("outside (above): pointer above the container", () => {
    const r = computeDropZone({
      clientY: 80, containerRect: rect(100, 400), scrollTop: 0, scrollHeight: 800,
    });
    expect(r.zone).toBe("outside");
    expect(r.scrollDelta).toBe(0);
  });

  test("outside (below): pointer below the container", () => {
    const r = computeDropZone({
      clientY: 520, containerRect: rect(100, 400), scrollTop: 0, scrollHeight: 800,
    });
    expect(r.zone).toBe("outside");
    expect(r.scrollDelta).toBe(0);
  });

  test("exact top edge: viewportY=0 is top-edge", () => {
    const r = computeDropZone({
      clientY: 100, containerRect: rect(100, 400), scrollTop: 50, scrollHeight: 1200,
    });
    expect(r.viewportY).toBe(0);
    expect(r.zone).toBe("top-edge");
  });

  test("exact bottom edge: viewportY=height is bottom-edge", () => {
    const r = computeDropZone({
      clientY: 500, containerRect: rect(100, 400), scrollTop: 50, scrollHeight: 1200,
    });
    expect(r.viewportY).toBe(400);
    expect(r.zone).toBe("bottom-edge");
  });

  test("custom edgeSize narrows the band", () => {
    // With default 28px, viewportY=20 → top-edge. With edgeSize=10 → inside.
    const r = computeDropZone({
      clientY: 120, containerRect: rect(100, 400), scrollTop: 100, scrollHeight: 1200,
      edgeSize: 10,
    });
    expect(r.viewportY).toBe(20);
    expect(r.zone).toBe("inside");
  });
});

describe("computeDropZone — scroll delta + end guards", () => {
  test("top-edge scrolls up (negative delta) when scrollTop > 0", () => {
    const r = computeDropZone({
      clientY: 110, containerRect: rect(100, 400), scrollTop: 100, scrollHeight: 1200,
    });
    expect(r.scrollDelta).toBeLessThan(0);
  });

  test("top-edge clamps to 0 when already at the top (no over-scroll)", () => {
    const r = computeDropZone({
      clientY: 105, containerRect: rect(100, 400), scrollTop: 0, scrollHeight: 1200,
    });
    expect(r.zone).toBe("top-edge");
    expect(r.scrollDelta).toBe(0);
  });

  test("top-edge clamps magnitude to remaining scrollTop (don't overshoot 0)", () => {
    // scrollTop=3, max delta=8 — full-intensity scroll would overshoot.
    const r = computeDropZone({
      clientY: 100, containerRect: rect(100, 400), scrollTop: 3, scrollHeight: 1200,
    });
    expect(r.scrollDelta).toBe(-3);
  });

  test("bottom-edge scrolls down (positive delta) when room remains", () => {
    const r = computeDropZone({
      clientY: 490, containerRect: rect(100, 400), scrollTop: 100, scrollHeight: 1200,
    });
    expect(r.scrollDelta).toBeGreaterThan(0);
  });

  test("bottom-edge clamps to 0 when already pinned at the bottom", () => {
    // scrollTop + height === scrollHeight → no room.
    const r = computeDropZone({
      clientY: 495, containerRect: rect(100, 400), scrollTop: 800, scrollHeight: 1200,
    });
    expect(r.zone).toBe("bottom-edge");
    expect(r.scrollDelta).toBe(0);
  });

  test("bottom-edge clamps magnitude to remaining scroll room", () => {
    // 4 px of room remaining, full-intensity would be +8 → clamp to +4.
    const r = computeDropZone({
      clientY: 500, containerRect: rect(100, 400), scrollTop: 796, scrollHeight: 1200,
    });
    expect(r.scrollDelta).toBe(4);
  });

  test("scrollDelta scales with intensity: deeper into the edge → bigger pull", () => {
    const shallow = computeDropZone({
      clientY: 122, containerRect: rect(100, 400), scrollTop: 100, scrollHeight: 1200,
    });
    const deep = computeDropZone({
      clientY: 102, containerRect: rect(100, 400), scrollTop: 100, scrollHeight: 1200,
    });
    expect(Math.abs(deep.scrollDelta)).toBeGreaterThan(Math.abs(shallow.scrollDelta));
  });

  test("custom maxScrollDelta caps the per-frame movement", () => {
    const r = computeDropZone({
      clientY: 100, containerRect: rect(100, 400), scrollTop: 1000, scrollHeight: 5000,
      maxScrollDelta: 2,
    });
    expect(r.scrollDelta).toBe(-2);
  });

  test("scrollHeight smaller than viewport (no scrollbar): bottom-edge yields 0", () => {
    const r = computeDropZone({
      clientY: 495, containerRect: rect(100, 400), scrollTop: 0, scrollHeight: 200,
    });
    expect(r.zone).toBe("bottom-edge");
    expect(r.scrollDelta).toBe(0);
  });
});
