// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-PROBLEMS-NAV — unit tests for the pure F8 problem-navigation engine.
 *
 * Pure module, no React / Monaco / DOM — runs directly under `bun test`.
 * Pins: flatten ordering across files; the cross-file step (THE fix);
 * workspace wraparound both directions; sitting-on-a-marker advance;
 * cursor-between-markers; active file with no markers; scope:'file'
 * legacy behaviour; severity filtering; collection-shape acceptance
 * (record / Map / array); defensive validation.
 */
import { describe, expect, test } from "bun:test"
import {
  compareDiagnostics,
  countDiagnostics,
  flattenDiagnostics,
  navigateDiagnostics,
  nextDiagnostic,
  type Diagnostic,
  type DiagnosticsCollection,
  type Position,
} from "../problems-navigation"

const d = (
  resource: string,
  startLineNumber: number,
  startColumn = 1,
  severity: Diagnostic["severity"] = "error",
  message = "",
): Diagnostic => ({ resource, startLineNumber, startColumn, severity, message })

// Two-file workspace, intentionally given out of order.
const collection: DiagnosticsCollection = {
  "b.ts": [d("b.ts", 41, 1, "error", "b41"), d("b.ts", 3, 1, "error", "b3")],
  "a.ts": [d("a.ts", 22, 1, "warning", "a22"), d("a.ts", 12, 1, "error", "a12")],
}
// Expected sorted order: a.ts:12, a.ts:22, b.ts:3, b.ts:41
const pos = (resource: string, lineNumber: number, column = 1): Position => ({ resource, lineNumber, column })

describe("flattenDiagnostics ordering", () => {
  test("sorts by resource → line across files, dropping nothing valid", () => {
    const flat = flattenDiagnostics(collection)
    expect(flat.map((x) => x.message)).toEqual(["a12", "a22", "b3", "b41"])
  })
  test("severity breaks ties at identical position (error before warning)", () => {
    const same: Diagnostic[] = [d("x.ts", 5, 2, "warning", "w"), d("x.ts", 5, 2, "error", "e")]
    expect(flattenDiagnostics(same).map((x) => x.message)).toEqual(["e", "w"])
  })
  test("accepts a flat array and a Map, not just a record", () => {
    const arr = [d("z.ts", 1, 1, "error", "z")]
    expect(flattenDiagnostics(arr).map((x) => x.message)).toEqual(["z"])
    const map = new Map<string, Diagnostic[]>([["z.ts", arr]])
    expect(flattenDiagnostics(map).map((x) => x.message)).toEqual(["z"])
  })
  test("drops invalid entries defensively, never throws", () => {
    const dirty = [
      d("a.ts", 1),
      { resource: "", startLineNumber: 1, startColumn: 1, severity: "error" },
      { resource: "b.ts", startLineNumber: NaN, startColumn: 1, severity: "error" },
      { resource: "c.ts", startLineNumber: 1, startColumn: 1, severity: "boom" },
      null,
      undefined,
    ] as unknown as Diagnostic[]
    expect(() => flattenDiagnostics(dirty)).not.toThrow()
    expect(flattenDiagnostics(dirty).length).toBe(1)
  })
  test("null / undefined collection → empty", () => {
    expect(flattenDiagnostics(null)).toEqual([])
    expect(flattenDiagnostics(undefined)).toEqual([])
  })
})

describe("compareDiagnostics is a total order", () => {
  test("antisymmetry on resource", () => {
    expect(compareDiagnostics(d("a.ts", 1), d("b.ts", 1))).toBeLessThan(0)
    expect(compareDiagnostics(d("b.ts", 1), d("a.ts", 1))).toBeGreaterThan(0)
  })
})

describe("navigateDiagnostics — next (the cross-file fix)", () => {
  test("THE BUG: from last marker of active file jumps to FIRST marker of NEXT file", () => {
    const r = navigateDiagnostics(collection, pos("a.ts", 22), { direction: "next" })
    expect(r.target?.message).toBe("b3")
    expect(r.target?.resource).toBe("b.ts")
    expect(r.wrapped).toBe(false)
  })
  test("sitting ON a marker advances to the next one", () => {
    const r = navigateDiagnostics(collection, pos("a.ts", 12), { direction: "next" })
    expect(r.target?.message).toBe("a22")
  })
  test("cursor between markers picks the next strictly after", () => {
    const r = navigateDiagnostics(collection, pos("a.ts", 15), { direction: "next" })
    expect(r.target?.message).toBe("a22")
  })
  test("from very last marker of workspace WRAPS to the first", () => {
    const r = navigateDiagnostics(collection, pos("b.ts", 41), { direction: "next" })
    expect(r.target?.message).toBe("a12")
    expect(r.wrapped).toBe(true)
    expect(r.index).toBe(0)
  })
  test("active file with NO markers jumps to first marker of another file", () => {
    const r = navigateDiagnostics(collection, pos("zzz-empty.ts", 1), { direction: "next" })
    // zzz-empty.ts sorts after b.ts, so 'next' finds nothing after → wraps to a12
    expect(r.target?.message).toBe("a12")
    expect(r.wrapped).toBe(true)
  })
  test("no anchor → first marker", () => {
    expect(navigateDiagnostics(collection, null, { direction: "next" }).target?.message).toBe("a12")
  })
})

describe("navigateDiagnostics — previous", () => {
  test("from first marker of a file goes to last marker of the PREVIOUS file", () => {
    const r = navigateDiagnostics(collection, pos("b.ts", 3), { direction: "previous" })
    expect(r.target?.message).toBe("a22")
    expect(r.wrapped).toBe(false)
  })
  test("from very first marker WRAPS to the last", () => {
    const r = navigateDiagnostics(collection, pos("a.ts", 12), { direction: "previous" })
    expect(r.target?.message).toBe("b41")
    expect(r.wrapped).toBe(true)
    expect(r.index).toBe(3)
  })
  test("sitting on a marker steps to the previous one", () => {
    const r = navigateDiagnostics(collection, pos("b.ts", 41), { direction: "previous" })
    expect(r.target?.message).toBe("b3")
  })
  test("no anchor → last marker", () => {
    expect(navigateDiagnostics(collection, null, { direction: "previous" }).target?.message).toBe("b41")
  })
})

describe("scope: 'file' (legacy single-file behaviour)", () => {
  test("next from last marker in file wraps WITHIN the same file", () => {
    const r = navigateDiagnostics(collection, pos("a.ts", 22), { direction: "next", scope: "file" })
    expect(r.target?.resource).toBe("a.ts")
    expect(r.target?.message).toBe("a12")
    expect(r.wrapped).toBe(true)
  })
  test("scope file with no anchor → empty (cannot determine the file)", () => {
    expect(navigateDiagnostics(collection, null, { scope: "file" }).target).toBeNull()
  })
  test("contrast: workspace scope from the same spot crosses files", () => {
    expect(navigateDiagnostics(collection, pos("a.ts", 22), { direction: "next", scope: "workspace" }).target?.resource).toBe("b.ts")
  })
})

describe("single-marker and empty edge cases", () => {
  test("single marker: next from it wraps back to itself", () => {
    const one = [d("solo.ts", 9, 1, "error", "solo")]
    const r = navigateDiagnostics(one, pos("solo.ts", 9), { direction: "next" })
    expect(r.target?.message).toBe("solo")
    expect(r.wrapped).toBe(true)
    expect(r.total).toBe(1)
  })
  test("empty collection → null target, total 0, index -1", () => {
    const r = navigateDiagnostics({}, pos("a.ts", 1))
    expect(r).toEqual({ target: null, wrapped: false, index: -1, total: 0 })
  })
})

describe("severity filtering", () => {
  test("filter to errors only skips warnings during navigation", () => {
    // a.ts:22 is a warning; next-from-a12 with errors-only skips it to b3
    const r = navigateDiagnostics(collection, pos("a.ts", 12), { direction: "next", severities: ["error"] })
    expect(r.target?.message).toBe("b3")
  })
  test("countDiagnostics respects the severity filter", () => {
    expect(countDiagnostics(collection)).toBe(4)
    expect(countDiagnostics(collection, ["error"])).toBe(3)
    expect(countDiagnostics(collection, ["warning"])).toBe(1)
  })
})

describe("nextDiagnostic convenience wrapper", () => {
  test("returns just the target", () => {
    expect(nextDiagnostic(collection, pos("a.ts", 22))?.message).toBe("b3")
  })
  test("returns null on empty", () => {
    expect(nextDiagnostic([], pos("a.ts", 1))).toBeNull()
  })
})

describe("defensive: invalid anchor position", () => {
  test("anchor with NaN line is treated as no-anchor (enter at start for next)", () => {
    const r = navigateDiagnostics(collection, pos("a.ts", NaN), { direction: "next" })
    expect(r.target?.message).toBe("a12")
  })
})
