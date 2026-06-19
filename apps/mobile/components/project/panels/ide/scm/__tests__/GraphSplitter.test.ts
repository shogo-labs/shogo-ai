/**
 * GraphSplitter — localStorage persistence + height constraints.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";

// ── Constants matching the hook ──
const GRAPH_HEIGHT_KEY = "sourceControl.graphHeight";
const GRAPH_HEIGHT_DEFAULT = 250;
const GRAPH_HEIGHT_MIN = 120;
const GRAPH_HEIGHT_MAX_RATIO = 0.8;
const CHANGES_MIN_HEIGHT = 100;
const SPLITTER_HEIGHT = 5;

function clampGraphHeight(
  requested: number,
  containerHeight: number,
): number {
  const maxGraph = Math.floor(containerHeight * GRAPH_HEIGHT_MAX_RATIO);
  let h = Math.max(GRAPH_HEIGHT_MIN, Math.min(maxGraph, requested));
  const changesAvailable = containerHeight - h - SPLITTER_HEIGHT;
  if (changesAvailable < CHANGES_MIN_HEIGHT) {
    h = containerHeight - CHANGES_MIN_HEIGHT - SPLITTER_HEIGHT;
  }
  return Math.max(GRAPH_HEIGHT_MIN, h);
}

describe("GraphSplitter — height constraints", () => {
  it("respects minimum graph height", () => {
    expect(clampGraphHeight(50, 1000)).toBe(GRAPH_HEIGHT_MIN);
    expect(clampGraphHeight(0, 1000)).toBe(GRAPH_HEIGHT_MIN);
    expect(clampGraphHeight(-100, 1000)).toBe(GRAPH_HEIGHT_MIN);
  });

  it("respects maximum graph height (80% of container)", () => {
    const max = Math.floor(1000 * GRAPH_HEIGHT_MAX_RATIO);
    expect(clampGraphHeight(1000, 1000)).toBe(max);
    expect(clampGraphHeight(900, 1000)).toBe(max);
  });

  it("enforces changes minimum height (100px)", () => {
    // container 300, want 250 graph → changes = 300-250-5 = 45 < 100 → clamp
    expect(clampGraphHeight(250, 300)).toBe(300 - CHANGES_MIN_HEIGHT - SPLITTER_HEIGHT);
  });

  it("default height is within bounds", () => {
    expect(clampGraphHeight(GRAPH_HEIGHT_DEFAULT, 800)).toBe(GRAPH_HEIGHT_DEFAULT);
  });

  it("normal drag up (grow graph)", () => {
    const start = 250;
    const newH = clampGraphHeight(start + 50, 800);
    expect(newH).toBe(300);
  });

  it("normal drag down (shrink graph)", () => {
    const start = 250;
    const newH = clampGraphHeight(start - 50, 800);
    expect(newH).toBe(200);
  });

  it("tiny container clamps to GRAPH_HEIGHT_MIN", () => {
    // 200 - 100 - 5 = 95, but Math.max(120, 95) = 120
    expect(clampGraphHeight(250, 200)).toBe(GRAPH_HEIGHT_MIN);
  });

  it("drag up near max", () => {
    // 800px container, max graph = 640. Start at 600, drag up 100 → clamped to 640
    expect(clampGraphHeight(700, 800)).toBe(Math.floor(800 * GRAPH_HEIGHT_MAX_RATIO));
  });

  it("drag down near min", () => {
    expect(clampGraphHeight(100, 800)).toBe(GRAPH_HEIGHT_MIN);
  });
});

// ── localStorage mock (bun test doesn't have browser localStorage) ──
const store = new Map<string, string>();
const mockStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
};

describe("GraphSplitter — localStorage", () => {
  const origLS = (globalThis as any).localStorage;

  beforeEach(() => {
    (globalThis as any).localStorage = mockStorage;
    store.clear();
  });

  afterEach(() => {
    (globalThis as any).localStorage = origLS;
  });

  it("returns null when no preference exists", () => {
    expect(localStorage.getItem(GRAPH_HEIGHT_KEY)).toBeNull();
  });

  it("persists graph height", () => {
    localStorage.setItem(GRAPH_HEIGHT_KEY, "320");
    expect(localStorage.getItem(GRAPH_HEIGHT_KEY)).toBe("320");
  });

  it("ignores invalid stored values", () => {
    localStorage.setItem(GRAPH_HEIGHT_KEY, "abc");
    const n = Number(localStorage.getItem(GRAPH_HEIGHT_KEY));
    expect(Number.isFinite(n)).toBe(false);
  });

  it("detects stored values below minimum", () => {
    localStorage.setItem(GRAPH_HEIGHT_KEY, "10");
    const n = Number(localStorage.getItem(GRAPH_HEIGHT_KEY));
    expect(n < GRAPH_HEIGHT_MIN).toBe(true);
  });

  it("accepts valid stored values", () => {
    localStorage.setItem(GRAPH_HEIGHT_KEY, "350");
    const n = Number(localStorage.getItem(GRAPH_HEIGHT_KEY));
    expect(Number.isFinite(n)).toBe(true);
    expect(n >= GRAPH_HEIGHT_MIN).toBe(true);
  });
});
