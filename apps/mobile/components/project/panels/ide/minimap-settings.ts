// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-MINIMAP-SCALE — surface the minimap controls in EditorSettings.
 *
 * Shogo's minimap was always-on at a single fixed scale with no user
 * control. VS Code exposes a family of `editor.minimap.*` settings — most
 * importantly `size` (proportional | fit | fill) and `scale` (1 | 2 | 3) —
 * plus enabled / side / renderCharacters / maxColumn. This module is the
 * pure, side-effect-free source of truth those settings read and write,
 * mirroring the extraction pattern of useEditorFont.ts and
 * diff-view-mode.ts: no React, no Monaco import, no DOM, so the settings
 * form and the Monaco editor both stay thin and the logic is unit-testable
 * in isolation.
 *
 * What lives here:
 *
 *   • The value domains + canonical defaults, matching VS Code:
 *       enabled = true, size = 'proportional', scale = 1, side = 'right',
 *       renderCharacters = true, maxColumn = 120.
 *   • The dropdown OPTION lists for the settings form (size, scale, side).
 *   • Defensive coercers (`coerceMinimapScale`, `coerceMinimapSize`, …)
 *     so a corrupt / legacy / hand-edited settings value never throws and
 *     always lands in-domain.
 *   • `parseMinimapSettings` / `serializeMinimapSettings` — round-trip a
 *     partial/dirty settings object to a complete, valid MinimapSettings.
 *   • `minimapSettingsToMonacoOptions` — maps to the exact Monaco
 *     `IEditorMinimapOptions` slice. The ONLY place that knows Monaco's
 *     option names, so a Monaco upgrade touches one file. A disabled
 *     minimap collapses to `{ enabled: false }` (Monaco ignores the rest).
 *   • Presentation helpers (`minimapSizeLabel`, `minimapScaleLabel`) so
 *     the form's human-readable strings are pinned by tests.
 *
 * Deliberately NOT here: any React, any Monaco import, any DOM access.
 */

/** `editor.minimap.size` — how the minimap maps document height to pane. */
export type MinimapSize = "proportional" | "fit" | "fill"

/** `editor.minimap.scale` — pixel multiplier for rendered minimap content. */
export type MinimapScale = 1 | 2 | 3

/** `editor.minimap.side` — which edge the minimap docks to. */
export type MinimapSide = "right" | "left"

/** The full set of minimap settings this surface controls. */
export interface MinimapSettings {
  enabled: boolean
  size: MinimapSize
  scale: MinimapScale
  side: MinimapSide
  renderCharacters: boolean
  maxColumn: number
}

/** VS Code parity defaults. */
export const DEFAULT_MINIMAP_SETTINGS: Readonly<MinimapSettings> = Object.freeze({
  enabled: true,
  size: "proportional",
  scale: 1,
  side: "right",
  renderCharacters: true,
  maxColumn: 120,
})

/** Monaco/VS Code valid range for `maxColumn`. */
export const MINIMAP_MAX_COLUMN_MIN = 1
export const MINIMAP_MAX_COLUMN_MAX = 10_000

export const MINIMAP_SIZE_VALUES: readonly MinimapSize[] = ["proportional", "fit", "fill"]
export const MINIMAP_SCALE_VALUES: readonly MinimapScale[] = [1, 2, 3]
export const MINIMAP_SIDE_VALUES: readonly MinimapSide[] = ["right", "left"]

export interface SelectOption<T> {
  value: T
  label: string
  description?: string
}

/** Dropdown options for the `size` control, with VS Code's descriptions. */
export const MINIMAP_SIZE_OPTIONS: readonly SelectOption<MinimapSize>[] = [
  { value: "proportional", label: "Proportional", description: "Minimap is the same size as the editor content (and can scroll)." },
  { value: "fit", label: "Fit", description: "Minimap shrinks as needed to never be larger than the editor." },
  { value: "fill", label: "Fill", description: "Minimap stretches to always fill the editor height." },
]

/** Dropdown options for the `scale` control. */
export const MINIMAP_SCALE_OPTIONS: readonly SelectOption<MinimapScale>[] = [
  { value: 1, label: "1×", description: "Default density." },
  { value: 2, label: "2×", description: "Larger, easier to read." },
  { value: 3, label: "3×", description: "Largest." },
]

/** Dropdown options for the `side` control. */
export const MINIMAP_SIDE_OPTIONS: readonly SelectOption<MinimapSide>[] = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
]

export function isMinimapSize(v: unknown): v is MinimapSize {
  return v === "proportional" || v === "fit" || v === "fill"
}

export function isMinimapScale(v: unknown): v is MinimapScale {
  return v === 1 || v === 2 || v === 3
}

export function isMinimapSide(v: unknown): v is MinimapSide {
  return v === "right" || v === "left"
}

/**
 * Coerce any input to a valid MinimapSize. Trims + lowercases strings so
 * legacy/hand-edited values survive; anything unknown → fallback.
 */
export function coerceMinimapSize(
  v: unknown,
  fallback: MinimapSize = DEFAULT_MINIMAP_SETTINGS.size,
): MinimapSize {
  if (isMinimapSize(v)) return v
  if (typeof v === "string") {
    const n = v.trim().toLowerCase()
    if (isMinimapSize(n)) return n
  }
  return fallback
}

/**
 * Coerce any input to a valid MinimapScale (1|2|3). Accepts numbers and
 * numeric strings; rounds, then CLAMPS to the [1,3] range rather than
 * rejecting — a settings slider that reports 2.4 or 7 still lands sanely.
 */
export function coerceMinimapScale(
  v: unknown,
  fallback: MinimapScale = DEFAULT_MINIMAP_SETTINGS.scale,
): MinimapScale {
  let n: number
  if (typeof v === "number") n = v
  else if (typeof v === "string" && v.trim() !== "") n = Number(v)
  else return fallback
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  if (rounded <= 1) return 1
  if (rounded >= 3) return 3
  return 2
}

export function coerceMinimapSide(
  v: unknown,
  fallback: MinimapSide = DEFAULT_MINIMAP_SETTINGS.side,
): MinimapSide {
  if (isMinimapSide(v)) return v
  if (typeof v === "string") {
    const n = v.trim().toLowerCase()
    if (isMinimapSide(n)) return n
  }
  return fallback
}

/** Coerce to boolean, accepting the JSON-ish strings "true"/"false". */
export function coerceBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "string") {
    const n = v.trim().toLowerCase()
    if (n === "true") return true
    if (n === "false") return false
  }
  return fallback
}

/** Coerce + clamp maxColumn into Monaco's accepted range. */
export function coerceMinimapMaxColumn(
  v: unknown,
  fallback: number = DEFAULT_MINIMAP_SETTINGS.maxColumn,
): number {
  let n: number
  if (typeof v === "number") n = v
  else if (typeof v === "string" && v.trim() !== "") n = Number(v)
  else return fallback
  if (!Number.isFinite(n)) return fallback
  const i = Math.round(n)
  if (i < MINIMAP_MAX_COLUMN_MIN) return MINIMAP_MAX_COLUMN_MIN
  if (i > MINIMAP_MAX_COLUMN_MAX) return MINIMAP_MAX_COLUMN_MAX
  return i
}

/**
 * Build a complete, valid MinimapSettings from a partial / dirty object
 * (settings JSON, a flattened `editor.minimap.*` map, or a nested
 * `{ minimap: {...} }`). Missing/invalid fields fall back to the defaults.
 * Never throws.
 */
export function parseMinimapSettings(
  raw: unknown,
  base: MinimapSettings = DEFAULT_MINIMAP_SETTINGS,
): MinimapSettings {
  const src = unwrap(raw)
  if (!src) return { ...base }
  return {
    enabled: coerceBool(pick(src, "enabled"), base.enabled),
    size: coerceMinimapSize(pick(src, "size"), base.size),
    scale: coerceMinimapScale(pick(src, "scale"), base.scale),
    side: coerceMinimapSide(pick(src, "side"), base.side),
    renderCharacters: coerceBool(pick(src, "renderCharacters"), base.renderCharacters),
    maxColumn: coerceMinimapMaxColumn(pick(src, "maxColumn"), base.maxColumn),
  }
}

/** Normalise to a canonical, fully-valid settings object for persistence. */
export function serializeMinimapSettings(s: MinimapSettings): MinimapSettings {
  return parseMinimapSettings(s)
}

/** The exact slice of Monaco `IEditorMinimapOptions` this surface sets. */
export interface MonacoMinimapOptions {
  enabled: boolean
  size?: MinimapSize
  scale?: MinimapScale
  side?: MinimapSide
  renderCharacters?: boolean
  maxColumn?: number
}

/**
 * Map settings to Monaco options. A disabled minimap returns just
 * `{ enabled: false }` — Monaco ignores the rest, and emitting them would
 * be noise. Enabled returns the full validated slice.
 */
export function minimapSettingsToMonacoOptions(
  input: MinimapSettings | unknown,
): MonacoMinimapOptions {
  const s = parseMinimapSettings(input)
  if (!s.enabled) return { enabled: false }
  return {
    enabled: true,
    size: s.size,
    scale: s.scale,
    side: s.side,
    renderCharacters: s.renderCharacters,
    maxColumn: s.maxColumn,
  }
}

export function minimapSizeLabel(size: MinimapSize): string {
  return MINIMAP_SIZE_OPTIONS.find((o) => o.value === size)?.label
    ?? MINIMAP_SIZE_OPTIONS[0].label
}

export function minimapScaleLabel(scale: MinimapScale): string {
  return MINIMAP_SCALE_OPTIONS.find((o) => o.value === scale)?.label
    ?? MINIMAP_SCALE_OPTIONS[0].label
}

/** Accept either a nested `{ minimap: {...} }` wrapper or a flat object. */
function unwrap(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const nested = obj.minimap
  if (nested && typeof nested === "object") return nested as Record<string, unknown>
  return obj
}

/** Read a key directly or via a flattened `minimap.<key>` / `editor.minimap.<key>`. */
function pick(src: Record<string, unknown>, key: string): unknown {
  if (key in src) return src[key]
  if (`minimap.${key}` in src) return src[`minimap.${key}`]
  if (`editor.minimap.${key}` in src) return src[`editor.minimap.${key}`]
  return undefined
}
