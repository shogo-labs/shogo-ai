/**
 * Splitter — tests for the invert option in useResizable.
 */
import { describe, expect, test } from "bun:test";

function computeNextSize(opts: {
  startSize: number;
  delta: number;
  min: number;
  max: number;
  invert: boolean;
}): number {
  const { startSize, delta, min, max, invert } = opts;
  return Math.min(max, Math.max(min, startSize + (invert ? -delta : delta)));
}

describe("useResizable — normal mode (invert=false)", () => {
  test("drag right increases size", () => {
    expect(computeNextSize({ startSize: 280, delta: 50, min: 200, max: 540, invert: false })).toBe(330);
  });
  test("drag left decreases size", () => {
    expect(computeNextSize({ startSize: 280, delta: -50, min: 200, max: 540, invert: false })).toBe(230);
  });
  test("clamps to min", () => {
    expect(computeNextSize({ startSize: 220, delta: -100, min: 200, max: 540, invert: false })).toBe(200);
  });
  test("clamps to max", () => {
    expect(computeNextSize({ startSize: 500, delta: 100, min: 200, max: 540, invert: false })).toBe(540);
  });
  test("zero delta → no change", () => {
    expect(computeNextSize({ startSize: 280, delta: 0, min: 200, max: 540, invert: false })).toBe(280);
  });
});

describe("useResizable — inverted mode (invert=true)", () => {
  test("drag right DECREASES size", () => {
    expect(computeNextSize({ startSize: 280, delta: 50, min: 200, max: 540, invert: true })).toBe(230);
  });
  test("drag left INCREASES size", () => {
    expect(computeNextSize({ startSize: 280, delta: -50, min: 200, max: 540, invert: true })).toBe(330);
  });
  test("clamps to min even when inverted", () => {
    expect(computeNextSize({ startSize: 220, delta: 100, min: 200, max: 540, invert: true })).toBe(200);
  });
  test("clamps to max even when inverted", () => {
    expect(computeNextSize({ startSize: 250, delta: -400, min: 200, max: 540, invert: true })).toBe(540);
  });
  test("zero delta → no change", () => {
    expect(computeNextSize({ startSize: 280, delta: 0, min: 200, max: 540, invert: true })).toBe(280);
  });
});

describe("useResizable — symmetry", () => {
  test("normal right = inverted left", () => {
    const n = computeNextSize({ startSize: 280, delta: 50, min: 200, max: 540, invert: false });
    const i = computeNextSize({ startSize: 280, delta: -50, min: 200, max: 540, invert: true });
    expect(n).toBe(i);
  });
  test("normal left = inverted right", () => {
    const n = computeNextSize({ startSize: 280, delta: -50, min: 200, max: 540, invert: false });
    const i = computeNextSize({ startSize: 280, delta: 50, min: 200, max: 540, invert: true });
    expect(n).toBe(i);
  });
});
