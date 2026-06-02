// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-DIFF-INLINE — inline vs. side-by-side toggle for the diff editor.
 *
 * Shogo's diff editor was hard-wired to side-by-side. VS Code lets the
 * user flip between the two-column "side-by-side" view and the single-
 * column "inline" (unified) view from a control in the diff tab header.
 * This module is the pure, side-effect-free brain behind that toggle so
 * the React tab-header button and the Monaco DiffEditor stay thin and
 * fully testable.
 *
 * What lives here (and why it's pure):
 *
 *   • The two-valued mode + canonical default.
 *   • Persistence helpers (parse / serialize) keyed off the SAME
 *     `shogo.ide.settings`-adjacent storage key family as the rest of
 *     the IDE, with defensive parsing so a corrupt/legacy value never
 *     throws — it falls back to the default.
 *   • `toggleDiffViewMode` / `nextDiffViewMode` — the action a tab-header
 *     button performs.
 *   • `diffViewModeToMonacoOptions` — maps a mode to the exact subset of
 *     Monaco `IDiffEditorOptions` we set (`renderSideBySide` plus the
 *     responsive `useInlineViewWhenSpaceIsLimited` /
 *     `renderSideBySideInlineBreakpoint` pair). This is the ONLY place
 *     that knows Monaco's option names, so a Monaco upgrade touches one
 *     file.
 *   • `effectiveDiffViewMode` — resolves what the user ACTUALLY sees
 *     after Monaco's responsive fallback: VS Code silently collapses a
 *     side-by-side diff to inline when the editor is narrower than
 *     `renderSideBySideInlineBreakpoint` (default 900px). The tab-header
 *     button reflects the *requested* mode (so the user's choice isn't
 *     lost on a transient resize) while the icon/tooltip can reflect the
 *     *effective* mode. Keeping both concepts explicit avoids the bug
 *     where a narrow split silently inverts the toggle state.
 *   • Presentation helpers (`diffViewModeLabel`, `diffViewModeIcon`,
 *     `diffViewModeAriaPressed`) so the button's a11y contract is pinned
 *     by tests, not by ad-hoc JSX.
 *
 * Deliberately NOT here: any React, any Monaco import, any DOM access.
 */

/** The two diff layouts, matching VS Code's `diffEditor.renderSideBySide`. */
export type DiffViewMode = "inline" | "sideBySide"

/** VS Code parity: the diff editor opens side-by-side by default. */
export const DEFAULT_DIFF_VIEW_MODE: DiffViewMode = "sideBySide"

/**
 * Persistence key. Namespaced under the IDE's `shogo.ide.*` family so it
 * sits alongside the other editor prefs without colliding.
 */
export const DIFF_VIEW_MODE_STORAGE_KEY = "shogo.ide.diff.viewMode"

/**
 * VS Code's default width (px) below which a side-by-side diff is shown
 * inline instead. Exposed so callers can override per-pane and so the
 * test suite can pin the boundary behaviour.
 */
export const DEFAULT_INLINE_BREAKPOINT = 900

/** Type guard — true only for the two canonical string values. */
export function isDiffViewMode(value: unknown): value is DiffViewMode {
  return value === "inline" || value === "sideBySide"
}

/**
 * The mode a toggle would switch TO. Pure inverse — handy for both the
 * toggle action and for labelling the button ("Switch to <next>").
 */
export function nextDiffViewMode(mode: DiffViewMode): DiffViewMode {
  return mode === "sideBySide" ? "inline" : "sideBySide"
}

/**
 * Toggle action. Alias of `nextDiffViewMode` with intent-revealing name
 * for the button's onClick. Defensive: a non-mode input resolves from
 * the default first, so a bad caller can't produce a third state.
 */
export function toggleDiffViewMode(mode: DiffViewMode): DiffViewMode {
  return nextDiffViewMode(isDiffViewMode(mode) ? mode : DEFAULT_DIFF_VIEW_MODE)
}

/**
 * Defensive parse of a persisted value (localStorage string, settings
 * JSON field, query param …). Trims and is case-insensitive so legacy
 * or hand-edited values like `"INLINE"` or `" sideBySide "` survive.
 * Anything unrecognised → the default. Never throws.
 */
export function parseStoredDiffViewMode(
  raw: unknown,
  fallback: DiffViewMode = DEFAULT_DIFF_VIEW_MODE,
): DiffViewMode {
  if (isDiffViewMode(raw)) return raw
  if (typeof raw !== "string") return fallback
  const norm = raw.trim().toLowerCase()
  if (norm === "inline") return "inline"
  if (norm === "sidebyside" || norm === "side-by-side" || norm === "side_by_side") {
    return "sideBySide"
  }
  // Legacy boolean-ish encodings: some early builds stored the raw
  // Monaco `renderSideBySide` boolean instead of the mode string.
  if (norm === "true") return "sideBySide"
  if (norm === "false") return "inline"
  return fallback
}

/** Canonical string for persistence. Round-trips with the parser. */
export function serializeDiffViewMode(mode: DiffViewMode): string {
  return isDiffViewMode(mode) ? mode : DEFAULT_DIFF_VIEW_MODE
}

/** The exact slice of Monaco diff options this toggle controls. */
export interface DiffMonacoOptions {
  /** Two columns when true (side-by-side), one column when false (inline). */
  renderSideBySide: boolean
  /** Let Monaco collapse to inline when the pane is narrower than the breakpoint. */
  useInlineViewWhenSpaceIsLimited: boolean
  /** Width (px) under which side-by-side collapses to inline. */
  renderSideBySideInlineBreakpoint: number
}

export interface DiffMonacoOptionsConfig {
  /** Override the responsive collapse breakpoint (px). */
  inlineBreakpoint?: number
  /**
   * Disable the responsive collapse entirely. When false, a side-by-side
   * request stays side-by-side at any width. Default true (VS Code-like).
   */
  responsive?: boolean
}

/**
 * Map a requested mode to Monaco diff options.
 *
 * - inline → `renderSideBySide:false`; the responsive fallback is moot
 *   (we're already inline) so it's disabled to avoid a confusing option.
 * - sideBySide → `renderSideBySide:true` plus the responsive pair so a
 *   narrow split degrades gracefully, exactly like VS Code.
 */
export function diffViewModeToMonacoOptions(
  mode: DiffViewMode,
  config: DiffMonacoOptionsConfig = {},
): DiffMonacoOptions {
  const resolved = isDiffViewMode(mode) ? mode : DEFAULT_DIFF_VIEW_MODE
  const breakpoint = normalizeBreakpoint(config.inlineBreakpoint)
  const responsive = config.responsive !== false
  if (resolved === "inline") {
    return {
      renderSideBySide: false,
      useInlineViewWhenSpaceIsLimited: false,
      renderSideBySideInlineBreakpoint: breakpoint,
    }
  }
  return {
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: responsive,
    renderSideBySideInlineBreakpoint: breakpoint,
  }
}

/**
 * Resolve what the user ACTUALLY sees given the requested mode and the
 * current pane width. A side-by-side request renders inline when the
 * pane is narrower than the breakpoint (and the responsive fallback is
 * on). An unknown width (undefined / <= 0) keeps the requested mode —
 * we never force a fallback on a not-yet-measured pane.
 */
export function effectiveDiffViewMode(
  requested: DiffViewMode,
  containerWidth?: number,
  config: DiffMonacoOptionsConfig = {},
): DiffViewMode {
  const resolved = isDiffViewMode(requested) ? requested : DEFAULT_DIFF_VIEW_MODE
  if (resolved === "inline") return "inline"
  if (config.responsive === false) return "sideBySide"
  if (typeof containerWidth !== "number" || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return "sideBySide"
  }
  const breakpoint = normalizeBreakpoint(config.inlineBreakpoint)
  return containerWidth < breakpoint ? "inline" : "sideBySide"
}

/**
 * Tooltip / aria-label for the tab-header toggle button. Phrased as the
 * action it performs ("Switch to …"), matching VS Code's command title.
 */
export function diffViewModeLabel(mode: DiffViewMode): string {
  const resolved = isDiffViewMode(mode) ? mode : DEFAULT_DIFF_VIEW_MODE
  return resolved === "sideBySide"
    ? "Switch to inline view"
    : "Switch to side-by-side view"
}

/**
 * lucide-react icon name representing the CURRENT mode (what the button
 * shows). Side-by-side ⇒ two columns, inline ⇒ stacked rows. Returned as
 * a string so this module stays icon-library-agnostic and importable in
 * a non-React test.
 */
export function diffViewModeIcon(mode: DiffViewMode): "Columns2" | "Rows2" {
  const resolved = isDiffViewMode(mode) ? mode : DEFAULT_DIFF_VIEW_MODE
  return resolved === "sideBySide" ? "Columns2" : "Rows2"
}

/**
 * `aria-pressed` value for a toggle button whose "pressed" state means
 * "side-by-side is active". Keeps the a11y semantics in one tested place.
 */
export function diffViewModeAriaPressed(mode: DiffViewMode): boolean {
  return (isDiffViewMode(mode) ? mode : DEFAULT_DIFF_VIEW_MODE) === "sideBySide"
}

/** Clamp / sanitise a breakpoint to a sane positive integer. */
function normalizeBreakpoint(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_INLINE_BREAKPOINT
  }
  return Math.floor(value)
}
