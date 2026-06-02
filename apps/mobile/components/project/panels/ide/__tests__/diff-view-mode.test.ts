// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-DIFF-INLINE — unit tests for the pure diff view-mode helper.
 *
 * Pure module, no React / Monaco / DOM — runs directly under `bun test`.
 * Pins: the default, the type guard, toggle/next inverses, defensive
 * persistence parse (incl. legacy boolean + casing + separators), Monaco
 * option mapping, the responsive inline-fallback boundary, and the
 * button presentation (label / icon / aria-pressed) contract.
 */
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_DIFF_VIEW_MODE,
  DEFAULT_INLINE_BREAKPOINT,
  DIFF_VIEW_MODE_STORAGE_KEY,
  diffViewModeAriaPressed,
  diffViewModeIcon,
  diffViewModeLabel,
  diffViewModeToMonacoOptions,
  effectiveDiffViewMode,
  isDiffViewMode,
  nextDiffViewMode,
  parseStoredDiffViewMode,
  serializeDiffViewMode,
  toggleDiffViewMode,
  type DiffViewMode,
} from "../diff-view-mode"

describe("constants", () => {
  test("default is side-by-side (VS Code parity)", () => {
    expect(DEFAULT_DIFF_VIEW_MODE).toBe("sideBySide")
  })
  test("storage key is namespaced under shogo.ide", () => {
    expect(DIFF_VIEW_MODE_STORAGE_KEY).toBe("shogo.ide.diff.viewMode")
  })
  test("default inline breakpoint matches VS Code (900px)", () => {
    expect(DEFAULT_INLINE_BREAKPOINT).toBe(900)
  })
})

describe("isDiffViewMode", () => {
  test("accepts the two canonical values", () => {
    expect(isDiffViewMode("inline")).toBe(true)
    expect(isDiffViewMode("sideBySide")).toBe(true)
  })
  test("rejects everything else", () => {
    for (const bad of ["INLINE", "side-by-side", "", "true", 1, null, undefined, {}, []]) {
      expect(isDiffViewMode(bad)).toBe(false)
    }
  })
})

describe("nextDiffViewMode / toggleDiffViewMode", () => {
  test("flips both directions", () => {
    expect(nextDiffViewMode("sideBySide")).toBe("inline")
    expect(nextDiffViewMode("inline")).toBe("sideBySide")
  })
  test("toggle is its own inverse (round-trips)", () => {
    const modes: DiffViewMode[] = ["inline", "sideBySide"]
    for (const m of modes) {
      expect(toggleDiffViewMode(toggleDiffViewMode(m))).toBe(m)
    }
  })
  test("toggle defends against a bad input by resolving from default first", () => {
    // default is sideBySide → toggling a garbage value yields inline
    expect(toggleDiffViewMode("garbage" as unknown as DiffViewMode)).toBe("inline")
  })
})

describe("parseStoredDiffViewMode", () => {
  test("passes through canonical values", () => {
    expect(parseStoredDiffViewMode("inline")).toBe("inline")
    expect(parseStoredDiffViewMode("sideBySide")).toBe("sideBySide")
  })
  test("is case-insensitive and trims", () => {
    expect(parseStoredDiffViewMode("  INLINE ")).toBe("inline")
    expect(parseStoredDiffViewMode("SideBySide")).toBe("sideBySide")
  })
  test("accepts separator variants", () => {
    expect(parseStoredDiffViewMode("side-by-side")).toBe("sideBySide")
    expect(parseStoredDiffViewMode("side_by_side")).toBe("sideBySide")
  })
  test("migrates legacy boolean encodings", () => {
    expect(parseStoredDiffViewMode("true")).toBe("sideBySide")
    expect(parseStoredDiffViewMode("false")).toBe("inline")
  })
  test("falls back to default on junk / null / non-string", () => {
    expect(parseStoredDiffViewMode("nonsense")).toBe("sideBySide")
    expect(parseStoredDiffViewMode(null)).toBe("sideBySide")
    expect(parseStoredDiffViewMode(undefined)).toBe("sideBySide")
    expect(parseStoredDiffViewMode(42)).toBe("sideBySide")
  })
  test("honours an explicit fallback", () => {
    expect(parseStoredDiffViewMode("junk", "inline")).toBe("inline")
  })
  test("never throws", () => {
    expect(() => parseStoredDiffViewMode(Symbol("x") as unknown as string)).not.toThrow()
  })
})

describe("serializeDiffViewMode round-trip", () => {
  test("serialize → parse is identity for both modes", () => {
    for (const m of ["inline", "sideBySide"] as DiffViewMode[]) {
      expect(parseStoredDiffViewMode(serializeDiffViewMode(m))).toBe(m)
    }
  })
  test("serialize sanitises a bad value to default", () => {
    expect(serializeDiffViewMode("oops" as unknown as DiffViewMode)).toBe("sideBySide")
  })
})

describe("diffViewModeToMonacoOptions", () => {
  test("inline → renderSideBySide false, no responsive collapse", () => {
    const o = diffViewModeToMonacoOptions("inline")
    expect(o.renderSideBySide).toBe(false)
    expect(o.useInlineViewWhenSpaceIsLimited).toBe(false)
    expect(o.renderSideBySideInlineBreakpoint).toBe(DEFAULT_INLINE_BREAKPOINT)
  })
  test("sideBySide → renderSideBySide true with responsive collapse on", () => {
    const o = diffViewModeToMonacoOptions("sideBySide")
    expect(o.renderSideBySide).toBe(true)
    expect(o.useInlineViewWhenSpaceIsLimited).toBe(true)
  })
  test("responsive:false keeps side-by-side sticky at any width", () => {
    const o = diffViewModeToMonacoOptions("sideBySide", { responsive: false })
    expect(o.renderSideBySide).toBe(true)
    expect(o.useInlineViewWhenSpaceIsLimited).toBe(false)
  })
  test("custom breakpoint is floored and applied", () => {
    expect(diffViewModeToMonacoOptions("sideBySide", { inlineBreakpoint: 640.9 }).renderSideBySideInlineBreakpoint).toBe(640)
  })
  test("invalid breakpoint falls back to default", () => {
    expect(diffViewModeToMonacoOptions("sideBySide", { inlineBreakpoint: -5 }).renderSideBySideInlineBreakpoint).toBe(900)
    expect(diffViewModeToMonacoOptions("sideBySide", { inlineBreakpoint: NaN }).renderSideBySideInlineBreakpoint).toBe(900)
  })
  test("bad mode resolves to the default mapping", () => {
    expect(diffViewModeToMonacoOptions("???" as unknown as DiffViewMode).renderSideBySide).toBe(true)
  })
})

describe("effectiveDiffViewMode (responsive fallback)", () => {
  test("inline stays inline regardless of width", () => {
    expect(effectiveDiffViewMode("inline", 2000)).toBe("inline")
    expect(effectiveDiffViewMode("inline", 100)).toBe("inline")
  })
  test("side-by-side collapses to inline below the breakpoint", () => {
    expect(effectiveDiffViewMode("sideBySide", 800)).toBe("inline")
  })
  test("side-by-side stays at and above the breakpoint", () => {
    expect(effectiveDiffViewMode("sideBySide", 900)).toBe("sideBySide")
    expect(effectiveDiffViewMode("sideBySide", 1200)).toBe("sideBySide")
  })
  test("unknown / unmeasured width keeps the requested side-by-side", () => {
    expect(effectiveDiffViewMode("sideBySide")).toBe("sideBySide")
    expect(effectiveDiffViewMode("sideBySide", 0)).toBe("sideBySide")
    expect(effectiveDiffViewMode("sideBySide", -10)).toBe("sideBySide")
    expect(effectiveDiffViewMode("sideBySide", NaN)).toBe("sideBySide")
  })
  test("responsive:false never collapses", () => {
    expect(effectiveDiffViewMode("sideBySide", 200, { responsive: false })).toBe("sideBySide")
  })
  test("custom breakpoint shifts the boundary", () => {
    expect(effectiveDiffViewMode("sideBySide", 700, { inlineBreakpoint: 640 })).toBe("sideBySide")
    expect(effectiveDiffViewMode("sideBySide", 600, { inlineBreakpoint: 640 })).toBe("inline")
  })
  test("bad requested mode resolves to default before evaluating width", () => {
    expect(effectiveDiffViewMode("junk" as unknown as DiffViewMode, 1200)).toBe("sideBySide")
    expect(effectiveDiffViewMode("junk" as unknown as DiffViewMode, 300)).toBe("inline")
  })
})

describe("presentation contract", () => {
  test("label phrases the action (switch to the OTHER view)", () => {
    expect(diffViewModeLabel("sideBySide")).toBe("Switch to inline view")
    expect(diffViewModeLabel("inline")).toBe("Switch to side-by-side view")
  })
  test("icon reflects the CURRENT mode", () => {
    expect(diffViewModeIcon("sideBySide")).toBe("Columns2")
    expect(diffViewModeIcon("inline")).toBe("Rows2")
  })
  test("aria-pressed is true only when side-by-side is active", () => {
    expect(diffViewModeAriaPressed("sideBySide")).toBe(true)
    expect(diffViewModeAriaPressed("inline")).toBe(false)
  })
  test("presentation helpers defend against bad input (default = sideBySide)", () => {
    const bad = "x" as unknown as DiffViewMode
    expect(diffViewModeLabel(bad)).toBe("Switch to inline view")
    expect(diffViewModeIcon(bad)).toBe("Columns2")
    expect(diffViewModeAriaPressed(bad)).toBe(true)
  })
})
