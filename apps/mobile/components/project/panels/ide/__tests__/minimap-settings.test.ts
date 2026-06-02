// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-MINIMAP-SCALE — unit tests for the pure minimap-settings helper.
 *
 * Pure module, no React / Monaco / DOM — runs directly under `bun test`.
 * Pins: VS Code defaults; type guards; defensive coercion (incl. clamp,
 * rounding, legacy strings); partial/nested/flattened parse; Monaco
 * option mapping (incl. disabled collapse); round-trip; presentation.
 */
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MINIMAP_SETTINGS,
  MINIMAP_MAX_COLUMN_MAX,
  MINIMAP_MAX_COLUMN_MIN,
  MINIMAP_SCALE_OPTIONS,
  MINIMAP_SIZE_OPTIONS,
  coerceBool,
  coerceMinimapMaxColumn,
  coerceMinimapScale,
  coerceMinimapSide,
  coerceMinimapSize,
  isMinimapScale,
  isMinimapSide,
  isMinimapSize,
  minimapScaleLabel,
  minimapSettingsToMonacoOptions,
  minimapSizeLabel,
  parseMinimapSettings,
  serializeMinimapSettings,
  type MinimapSettings,
} from "../minimap-settings"

describe("defaults (VS Code parity)", () => {
  test("default object matches VS Code", () => {
    expect(DEFAULT_MINIMAP_SETTINGS).toEqual({
      enabled: true,
      size: "proportional",
      scale: 1,
      side: "right",
      renderCharacters: true,
      maxColumn: 120,
    })
  })
  test("default object is frozen (immutable source of truth)", () => {
    expect(Object.isFrozen(DEFAULT_MINIMAP_SETTINGS)).toBe(true)
  })
  test("option lists cover the full domains", () => {
    expect(MINIMAP_SIZE_OPTIONS.map((o) => o.value)).toEqual(["proportional", "fit", "fill"])
    expect(MINIMAP_SCALE_OPTIONS.map((o) => o.value)).toEqual([1, 2, 3])
  })
})

describe("type guards", () => {
  test("isMinimapSize", () => {
    expect(isMinimapSize("fit")).toBe(true)
    expect(isMinimapSize("FILL")).toBe(false)
    expect(isMinimapSize("")).toBe(false)
    expect(isMinimapSize(1)).toBe(false)
  })
  test("isMinimapScale only 1|2|3", () => {
    expect(isMinimapScale(1)).toBe(true)
    expect(isMinimapScale(2)).toBe(true)
    expect(isMinimapScale(3)).toBe(true)
    expect(isMinimapScale(0)).toBe(false)
    expect(isMinimapScale(4)).toBe(false)
    expect(isMinimapScale("1")).toBe(false)
    expect(isMinimapScale(2.5)).toBe(false)
  })
  test("isMinimapSide", () => {
    expect(isMinimapSide("left")).toBe(true)
    expect(isMinimapSide("top")).toBe(false)
  })
})

describe("coerceMinimapSize", () => {
  test("passes valid", () => {
    expect(coerceMinimapSize("fit")).toBe("fit")
  })
  test("trims + lowercases legacy values", () => {
    expect(coerceMinimapSize("  FILL ")).toBe("fill")
    expect(coerceMinimapSize("Proportional")).toBe("proportional")
  })
  test("junk → default (proportional)", () => {
    expect(coerceMinimapSize("zoom")).toBe("proportional")
    expect(coerceMinimapSize(null)).toBe("proportional")
    expect(coerceMinimapSize(7)).toBe("proportional")
  })
  test("honours explicit fallback", () => {
    expect(coerceMinimapSize("junk", "fill")).toBe("fill")
  })
})

describe("coerceMinimapScale (clamp + round)", () => {
  test("passes valid", () => {
    expect(coerceMinimapScale(1)).toBe(1)
    expect(coerceMinimapScale(2)).toBe(2)
    expect(coerceMinimapScale(3)).toBe(3)
  })
  test("numeric strings parse", () => {
    expect(coerceMinimapScale("2")).toBe(2)
  })
  test("rounds fractional values", () => {
    expect(coerceMinimapScale(2.4)).toBe(2)
    expect(coerceMinimapScale(2.6)).toBe(3)
    expect(coerceMinimapScale(1.5)).toBe(2)
  })
  test("clamps out-of-range to nearest bound", () => {
    expect(coerceMinimapScale(0)).toBe(1)
    expect(coerceMinimapScale(-9)).toBe(1)
    expect(coerceMinimapScale(7)).toBe(3)
  })
  test("junk / empty / NaN → fallback", () => {
    expect(coerceMinimapScale("")).toBe(1)
    expect(coerceMinimapScale("abc")).toBe(1)
    expect(coerceMinimapScale(NaN)).toBe(1)
    expect(coerceMinimapScale(null)).toBe(1)
    expect(coerceMinimapScale(undefined, 2)).toBe(2)
  })
})

describe("coerceBool", () => {
  test("passthrough boolean", () => {
    expect(coerceBool(true, false)).toBe(true)
    expect(coerceBool(false, true)).toBe(false)
  })
  test("string true/false", () => {
    expect(coerceBool("true", false)).toBe(true)
    expect(coerceBool(" FALSE ", true)).toBe(false)
  })
  test("junk → fallback", () => {
    expect(coerceBool("yes", true)).toBe(true)
    expect(coerceBool(1, false)).toBe(false)
  })
})

describe("coerceMinimapMaxColumn (clamp + round)", () => {
  test("rounds and clamps", () => {
    expect(coerceMinimapMaxColumn(120.4)).toBe(120)
    expect(coerceMinimapMaxColumn(0)).toBe(MINIMAP_MAX_COLUMN_MIN)
    expect(coerceMinimapMaxColumn(99999)).toBe(MINIMAP_MAX_COLUMN_MAX)
  })
  test("numeric string", () => {
    expect(coerceMinimapMaxColumn("80")).toBe(80)
  })
  test("junk → fallback 120", () => {
    expect(coerceMinimapMaxColumn("nope")).toBe(120)
    expect(coerceMinimapMaxColumn(NaN)).toBe(120)
  })
})

describe("coerceMinimapSide", () => {
  test("valid + legacy", () => {
    expect(coerceMinimapSide("left")).toBe("left")
    expect(coerceMinimapSide(" RIGHT ")).toBe("right")
  })
  test("junk → default right", () => {
    expect(coerceMinimapSide("middle")).toBe("right")
  })
})

describe("parseMinimapSettings", () => {
  test("empty / null → full defaults (cloned, not the frozen ref)", () => {
    const out = parseMinimapSettings(null)
    expect(out).toEqual({ ...DEFAULT_MINIMAP_SETTINGS })
    expect(Object.isFrozen(out)).toBe(false)
  })
  test("partial object fills missing with defaults", () => {
    const out = parseMinimapSettings({ scale: 3, size: "fit" })
    expect(out.scale).toBe(3)
    expect(out.size).toBe("fit")
    expect(out.enabled).toBe(true)
    expect(out.maxColumn).toBe(120)
  })
  test("nested { minimap: {...} } wrapper is unwrapped", () => {
    const out = parseMinimapSettings({ minimap: { scale: 2, enabled: false } })
    expect(out.scale).toBe(2)
    expect(out.enabled).toBe(false)
  })
  test("flattened editor.minimap.* keys are read", () => {
    const out = parseMinimapSettings({ "editor.minimap.size": "fill", "minimap.scale": "3" })
    expect(out.size).toBe("fill")
    expect(out.scale).toBe(3)
  })
  test("dirty values are coerced, never throw", () => {
    const out = parseMinimapSettings({ scale: 99, size: "BIG", maxColumn: -4, enabled: "false" })
    expect(out.scale).toBe(3)
    expect(out.size).toBe("proportional")
    expect(out.maxColumn).toBe(MINIMAP_MAX_COLUMN_MIN)
    expect(out.enabled).toBe(false)
  })
  test("honours a custom base", () => {
    const base: MinimapSettings = { ...DEFAULT_MINIMAP_SETTINGS, scale: 2, side: "left" }
    const out = parseMinimapSettings({ size: "fit" }, base)
    expect(out.scale).toBe(2)
    expect(out.side).toBe("left")
    expect(out.size).toBe("fit")
  })
})

describe("serializeMinimapSettings round-trip", () => {
  test("valid settings round-trip unchanged", () => {
    const s: MinimapSettings = { enabled: true, size: "fill", scale: 2, side: "left", renderCharacters: false, maxColumn: 80 }
    expect(parseMinimapSettings(serializeMinimapSettings(s))).toEqual(s)
  })
})

describe("minimapSettingsToMonacoOptions", () => {
  test("disabled collapses to just { enabled:false }", () => {
    expect(minimapSettingsToMonacoOptions({ ...DEFAULT_MINIMAP_SETTINGS, enabled: false })).toEqual({ enabled: false })
  })
  test("enabled returns the full validated slice", () => {
    const out = minimapSettingsToMonacoOptions({ enabled: true, size: "fit", scale: 3, side: "left", renderCharacters: false, maxColumn: 90 })
    expect(out).toEqual({ enabled: true, size: "fit", scale: 3, side: "left", renderCharacters: false, maxColumn: 90 })
  })
  test("accepts and sanitises a dirty input object", () => {
    const out = minimapSettingsToMonacoOptions({ enabled: "true", scale: 5, size: "fill" } as unknown)
    expect(out.enabled).toBe(true)
    expect(out.scale).toBe(3)
    expect(out.size).toBe("fill")
  })
})

describe("presentation", () => {
  test("size labels", () => {
    expect(minimapSizeLabel("proportional")).toBe("Proportional")
    expect(minimapSizeLabel("fit")).toBe("Fit")
    expect(minimapSizeLabel("fill")).toBe("Fill")
  })
  test("scale labels", () => {
    expect(minimapScaleLabel(1)).toBe("1×")
    expect(minimapScaleLabel(2)).toBe("2×")
    expect(minimapScaleLabel(3)).toBe("3×")
  })
})
