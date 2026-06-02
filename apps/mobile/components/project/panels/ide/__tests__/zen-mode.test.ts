// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-ZEN — unit tests for the pure Zen Mode brain.
 *
 * Pure module, no React / DOM — runs under `bun test`.
 * Pins: config parse/coercion; state transitions (enter/exit/toggle/
 * center); chrome visibility per config; root class list; the Cmd/Ctrl+K Z
 * chord state machine (incl. platform + re-arm + reset); and double-Escape
 * exit timing.
 */
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ZEN_CONFIG,
  INITIAL_ZEN_STATE,
  advanceZenChord,
  computeChromeVisibility,
  enterZen,
  exitZen,
  parseZenConfig,
  shouldExitOnEscape,
  toggleCentered,
  toggleZen,
  zenRootClassNames,
  type KeyStroke,
  type ZenConfig,
  type ZenState,
} from "../zen-mode"

const cfg = (over: Partial<ZenConfig> = {}): ZenConfig => ({ ...DEFAULT_ZEN_CONFIG, ...over })
const active: ZenState = { active: true, centered: true }

describe("defaults", () => {
  test("VS Code-parity defaults, frozen", () => {
    expect(DEFAULT_ZEN_CONFIG.hideActivityBar).toBe(true)
    expect(DEFAULT_ZEN_CONFIG.centerLayout).toBe(true)
    expect(DEFAULT_ZEN_CONFIG.restore).toBe(true)
    expect(Object.isFrozen(DEFAULT_ZEN_CONFIG)).toBe(true)
    expect(Object.isFrozen(INITIAL_ZEN_STATE)).toBe(true)
  })
})

describe("parseZenConfig", () => {
  test("empty → defaults (cloned, not frozen)", () => {
    const out = parseZenConfig(null)
    expect(out).toEqual({ ...DEFAULT_ZEN_CONFIG })
    expect(Object.isFrozen(out)).toBe(false)
  })
  test("partial overrides, rest from defaults", () => {
    expect(parseZenConfig({ hideStatusBar: false }).hideStatusBar).toBe(false)
    expect(parseZenConfig({ hideStatusBar: false }).hideActivityBar).toBe(true)
  })
  test("reads flattened zenMode.* keys", () => {
    expect(parseZenConfig({ "zenMode.fullScreen": false }).fullScreen).toBe(false)
  })
  test("coerces string booleans, junk → default", () => {
    expect(parseZenConfig({ centerLayout: "false" }).centerLayout).toBe(false)
    expect(parseZenConfig({ centerLayout: "true" }).centerLayout).toBe(true)
    expect(parseZenConfig({ centerLayout: "maybe" }).centerLayout).toBe(true)
  })
  test("honours a custom base", () => {
    expect(parseZenConfig({ hideTabs: false }, cfg({ fullScreen: false })).fullScreen).toBe(false)
  })
})

describe("state transitions", () => {
  test("enter activates + centers per config", () => {
    expect(enterZen(INITIAL_ZEN_STATE)).toEqual({ active: true, centered: true })
    expect(enterZen(INITIAL_ZEN_STATE, cfg({ centerLayout: false }))).toEqual({ active: true, centered: false })
  })
  test("exit deactivates", () => {
    expect(exitZen(active)).toEqual({ active: false, centered: false })
  })
  test("toggle flips both ways", () => {
    expect(toggleZen(INITIAL_ZEN_STATE).active).toBe(true)
    expect(toggleZen(active).active).toBe(false)
  })
  test("enter/exit are idempotent", () => {
    expect(enterZen(enterZen(INITIAL_ZEN_STATE))).toEqual({ active: true, centered: true })
    expect(exitZen(exitZen(active))).toEqual({ active: false, centered: false })
  })
  test("toggleCentered only works while active", () => {
    expect(toggleCentered(active)).toEqual({ active: true, centered: false })
    expect(toggleCentered(INITIAL_ZEN_STATE)).toEqual(INITIAL_ZEN_STATE)
  })
})

describe("computeChromeVisibility", () => {
  test("inactive → everything visible, not centered", () => {
    const v = computeChromeVisibility(INITIAL_ZEN_STATE)
    expect(v).toEqual({
      activityBar: true, sideBar: true, statusBar: true, tabs: true,
      panel: true, lineNumbers: true, notifications: true, centered: false,
    })
  })
  test("active with defaults → all chrome hidden, centered", () => {
    const v = computeChromeVisibility(active)
    expect(v.activityBar).toBe(false)
    expect(v.sideBar).toBe(false)
    expect(v.statusBar).toBe(false)
    expect(v.tabs).toBe(false)
    expect(v.panel).toBe(false)
    expect(v.lineNumbers).toBe(false)
    expect(v.notifications).toBe(false)
    expect(v.centered).toBe(true)
  })
  test("hide*:false keeps a surface visible even in zen", () => {
    const v = computeChromeVisibility(active, cfg({ hideStatusBar: false, hideTabs: false }))
    expect(v.statusBar).toBe(true)
    expect(v.tabs).toBe(true)
    expect(v.activityBar).toBe(false)
  })
  test("centered reflects state, not just config", () => {
    expect(computeChromeVisibility({ active: true, centered: false }).centered).toBe(false)
  })
})

describe("zenRootClassNames", () => {
  test("inactive → no classes", () => {
    expect(zenRootClassNames(INITIAL_ZEN_STATE)).toEqual([])
  })
  test("active default → zen-mode + centered + fullscreen + silent", () => {
    expect(zenRootClassNames(active)).toEqual(["zen-mode", "zen-centered", "zen-fullscreen", "zen-silent"])
  })
  test("no center / no fullscreen / no silent → just zen-mode", () => {
    const c = cfg({ fullScreen: false, silentNotifications: false })
    expect(zenRootClassNames({ active: true, centered: false }, c)).toEqual(["zen-mode"])
  })
})

describe("advanceZenChord (Cmd/Ctrl+K Z)", () => {
  const k = (key: string, mods: Partial<KeyStroke> = {}): KeyStroke => ({ key, ...mods })

  test("mac: Cmd+K then Z completes", () => {
    const a = advanceZenChord(false, k("k", { meta: true }), "mac")
    expect(a).toEqual({ status: "prefix", pending: true })
    const b = advanceZenChord(a.pending, k("z"), "mac")
    expect(b.status).toBe("complete")
  })
  test("windows/linux: Ctrl+K then Z completes", () => {
    const a = advanceZenChord(false, k("k", { ctrl: true }), "windows")
    expect(a.status).toBe("prefix")
    expect(advanceZenChord(a.pending, k("z"), "windows").status).toBe("complete")
  })
  test("uppercase keys and Z are accepted (case-insensitive)", () => {
    const a = advanceZenChord(false, k("K", { meta: true }), "mac")
    expect(advanceZenChord(a.pending, k("Z"), "mac").status).toBe("complete")
  })
  test("Cmd+K without modifier on the wrong platform does not prefix", () => {
    // meta on windows is not the primary modifier
    expect(advanceZenChord(false, k("k", { meta: true }), "windows").status).toBe("none")
  })
  test("bare K (no modifier) does not start the chord", () => {
    expect(advanceZenChord(false, k("k"), "mac").status).toBe("none")
  })
  test("prefix + wrong second key resets to none", () => {
    expect(advanceZenChord(true, k("x"), "mac")).toEqual({ status: "none", pending: false })
  })
  test("prefix can be re-armed by another Cmd+K", () => {
    expect(advanceZenChord(true, k("k", { meta: true }), "mac")).toEqual({ status: "prefix", pending: true })
  })
  test("defensive: malformed stroke → none", () => {
    expect(advanceZenChord(true, undefined as unknown as KeyStroke, "mac").status).toBe("none")
    expect(advanceZenChord(false, { key: 123 as unknown as string }, "mac").status).toBe("none")
  })
})

describe("shouldExitOnEscape (double-Escape)", () => {
  test("two Escapes within the window → exit", () => {
    expect(shouldExitOnEscape(active, 1000, 1200)).toBe(true)
  })
  test("gap beyond the window → no exit", () => {
    expect(shouldExitOnEscape(active, 1000, 1600)).toBe(false)
  })
  test("custom window respected", () => {
    expect(shouldExitOnEscape(active, 1000, 1800, 1000)).toBe(true)
  })
  test("no prior Escape → no exit", () => {
    expect(shouldExitOnEscape(active, null, 1200)).toBe(false)
  })
  test("inactive zen → never exits via Escape", () => {
    expect(shouldExitOnEscape(INITIAL_ZEN_STATE, 1000, 1100)).toBe(false)
  })
  test("non-finite timestamps → no exit (no throw)", () => {
    expect(shouldExitOnEscape(active, NaN, 1200)).toBe(false)
    expect(shouldExitOnEscape(active, 1000, NaN)).toBe(false)
  })
  test("negative gap (clock skew) → no exit", () => {
    expect(shouldExitOnEscape(active, 2000, 1000)).toBe(false)
  })
})
