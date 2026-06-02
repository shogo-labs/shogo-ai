// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-ZEN — Zen Mode (Cmd+K Z hides all chrome, centers the editor).
 *
 * Shogo had no way to hide all the surrounding chrome and focus on the
 * editor. VS Code's Zen Mode (Cmd/Ctrl+K then Z) hides the activity bar,
 * side bar, status bar, tabs and panel, optionally centers the editor and
 * goes full-screen, and restores everything on exit (double-Escape or the
 * same chord). The fix is a CSS class on the root plus a keybinding — this
 * module is the pure, side-effect-free brain for both halves.
 *
 * Same extraction pattern as the other UX-* modules: no React, no DOM, no
 * document.body access. The React shell reads `zenRootClassNames` /
 * `computeChromeVisibility` to drive the class list, and feeds key events
 * through `advanceZenChord` / `shouldExitOnEscape`.
 *
 * What lives here:
 *   • ZenConfig (mirrors the VS Code `zenMode.*` settings) + defaults +
 *     defensive parsing.
 *   • ZenState + pure transitions (enter / exit / toggle).
 *   • `computeChromeVisibility` — given zen on/off + config, which chrome
 *     surfaces are visible.
 *   • `zenRootClassNames` — the class list to apply to the layout root.
 *   • `advanceZenChord` — the Cmd/Ctrl+K Z two-stroke chord state machine.
 *   • `shouldExitOnEscape` — VS Code's double-Escape-to-exit timing.
 *
 * Deliberately NOT here: React, DOM, document/body, event listeners.
 */

export interface ZenConfig {
  hideActivityBar: boolean
  hideSideBar: boolean
  hideStatusBar: boolean
  hideTabs: boolean
  hidePanel: boolean
  hideLineNumbers: boolean
  centerLayout: boolean
  fullScreen: boolean
  /** Restore the pre-zen layout when exiting. */
  restore: boolean
  silentNotifications: boolean
}

/** VS Code-parity defaults. */
export const DEFAULT_ZEN_CONFIG: Readonly<ZenConfig> = Object.freeze({
  hideActivityBar: true,
  hideSideBar: true,
  hideStatusBar: true,
  hideTabs: true,
  hidePanel: true,
  hideLineNumbers: true,
  centerLayout: true,
  fullScreen: true,
  restore: true,
  silentNotifications: true,
})

export interface ZenState {
  active: boolean
  /** Whether the editor is currently centered (only meaningful when active). */
  centered: boolean
}

export const INITIAL_ZEN_STATE: Readonly<ZenState> = Object.freeze({ active: false, centered: false })

function coerceBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "string") {
    const n = v.trim().toLowerCase()
    if (n === "true") return true
    if (n === "false") return false
  }
  return fallback
}

/** Build a complete, valid ZenConfig from a partial/dirty input. Never throws. */
export function parseZenConfig(raw: unknown, base: ZenConfig = DEFAULT_ZEN_CONFIG): ZenConfig {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const pick = (k: string) => (k in s ? s[k] : s[`zenMode.${k}`])
  return {
    hideActivityBar: coerceBool(pick("hideActivityBar"), base.hideActivityBar),
    hideSideBar: coerceBool(pick("hideSideBar"), base.hideSideBar),
    hideStatusBar: coerceBool(pick("hideStatusBar"), base.hideStatusBar),
    hideTabs: coerceBool(pick("hideTabs"), base.hideTabs),
    hidePanel: coerceBool(pick("hidePanel"), base.hidePanel),
    hideLineNumbers: coerceBool(pick("hideLineNumbers"), base.hideLineNumbers),
    centerLayout: coerceBool(pick("centerLayout"), base.centerLayout),
    fullScreen: coerceBool(pick("fullScreen"), base.fullScreen),
    restore: coerceBool(pick("restore"), base.restore),
    silentNotifications: coerceBool(pick("silentNotifications"), base.silentNotifications),
  }
}

/** Enter zen mode (idempotent). Centered follows the config. */
export function enterZen(_state: ZenState, config: ZenConfig = DEFAULT_ZEN_CONFIG): ZenState {
  return { active: true, centered: config.centerLayout }
}

/** Exit zen mode (idempotent). */
export function exitZen(_state: ZenState): ZenState {
  return { active: false, centered: false }
}

/** Toggle zen mode. */
export function toggleZen(state: ZenState, config: ZenConfig = DEFAULT_ZEN_CONFIG): ZenState {
  return state.active ? exitZen(state) : enterZen(state, config)
}

/** Toggle just the centered-layout sub-state (only when zen is active). */
export function toggleCentered(state: ZenState): ZenState {
  if (!state.active) return state
  return { ...state, centered: !state.centered }
}

export interface ChromeVisibility {
  activityBar: boolean
  sideBar: boolean
  statusBar: boolean
  tabs: boolean
  panel: boolean
  lineNumbers: boolean
  notifications: boolean
  centered: boolean
}

const ALL_VISIBLE: Readonly<ChromeVisibility> = Object.freeze({
  activityBar: true,
  sideBar: true,
  statusBar: true,
  tabs: true,
  panel: true,
  lineNumbers: true,
  notifications: true,
  centered: false,
})

/**
 * Which chrome surfaces are visible. When zen is inactive everything is
 * visible and centered is false. When active, each surface is hidden per
 * its `hide*` config flag (a `hide*: false` keeps it visible even in zen).
 */
export function computeChromeVisibility(
  state: ZenState,
  config: ZenConfig = DEFAULT_ZEN_CONFIG,
): ChromeVisibility {
  if (!state.active) return { ...ALL_VISIBLE }
  return {
    activityBar: !config.hideActivityBar,
    sideBar: !config.hideSideBar,
    statusBar: !config.hideStatusBar,
    tabs: !config.hideTabs,
    panel: !config.hidePanel,
    lineNumbers: !config.hideLineNumbers,
    notifications: !config.silentNotifications,
    centered: state.centered,
  }
}

/** The class list for the layout root (CSS does the hiding + transition). */
export function zenRootClassNames(
  state: ZenState,
  config: ZenConfig = DEFAULT_ZEN_CONFIG,
): string[] {
  if (!state.active) return []
  const classes = ["zen-mode"]
  if (state.centered) classes.push("zen-centered")
  if (config.fullScreen) classes.push("zen-fullscreen")
  if (config.silentNotifications) classes.push("zen-silent")
  return classes
}

// ── Cmd/Ctrl+K Z chord ──────────────────────────────────────────────────

export type Platform = "mac" | "windows" | "linux"

export interface KeyStroke {
  /** Single character key, case-insensitive (e.g. "k", "z", "Escape"). */
  key: string
  meta?: boolean // Cmd
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export type ChordStatus = "none" | "prefix" | "complete"

export interface ChordResult {
  status: ChordStatus
  /** True while a prefix (Cmd/Ctrl+K) is pending the next stroke. */
  pending: boolean
}

/** The primary modifier for chords: Cmd on mac, Ctrl elsewhere. */
function hasPrimaryModifier(stroke: KeyStroke, platform: Platform): boolean {
  return platform === "mac" ? !!stroke.meta : !!stroke.ctrl
}

function keyEquals(stroke: KeyStroke, ch: string): boolean {
  return typeof stroke.key === "string" && stroke.key.toLowerCase() === ch
}

/**
 * Two-stroke chord state machine for Cmd/Ctrl+K Z.
 *
 * @param pending  whether a Cmd/Ctrl+K prefix is currently held
 * @param stroke   the new key stroke
 * @param platform key platform (default mac)
 * @returns the new status; 'complete' means fire the toggle.
 *
 * - No prefix yet: Cmd/Ctrl+K → 'prefix'; anything else → 'none'.
 * - Prefix pending: a bare "z" (no primary modifier required) → 'complete';
 *   a repeat of Cmd/Ctrl+K → stays 'prefix'; anything else → 'none' (reset).
 */
export function advanceZenChord(
  pending: boolean,
  stroke: KeyStroke,
  platform: Platform = "mac",
): ChordResult {
  if (!stroke || typeof stroke.key !== "string") return { status: "none", pending: false }

  if (!pending) {
    if (hasPrimaryModifier(stroke, platform) && keyEquals(stroke, "k")) {
      return { status: "prefix", pending: true }
    }
    return { status: "none", pending: false }
  }

  // A prefix is pending.
  if (keyEquals(stroke, "z")) {
    return { status: "complete", pending: false }
  }
  // Allow re-arming with another Cmd/Ctrl+K.
  if (hasPrimaryModifier(stroke, platform) && keyEquals(stroke, "k")) {
    return { status: "prefix", pending: true }
  }
  return { status: "none", pending: false }
}

/**
 * VS Code exits Zen Mode on a DOUBLE Escape within a short window. Given
 * the timestamp of the previous Escape and now, decide whether this second
 * Escape should exit. Returns false when zen is inactive, when there was no
 * recent prior Escape, or when the gap exceeds `windowMs` (default 500ms).
 */
export function shouldExitOnEscape(
  state: ZenState,
  lastEscapeAt: number | null | undefined,
  now: number,
  windowMs = 500,
): boolean {
  if (!state.active) return false
  if (typeof lastEscapeAt !== "number" || !Number.isFinite(lastEscapeAt)) return false
  if (typeof now !== "number" || !Number.isFinite(now)) return false
  const gap = now - lastEscapeAt
  return gap >= 0 && gap <= windowMs
}
