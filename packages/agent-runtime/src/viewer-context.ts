// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Viewer form-factor from the Studio client (iPhone vs desktop).
 *
 * Chat POST bodies may include `viewer: { formFactor, platform, width }`.
 * The gateway is a process singleton, so each request must replace or
 * clear the last value. The injected prompt is a hint for layout
 * priority — canvases stay responsive either way.
 */

export type CanvasViewerFormFactor = 'phone' | 'desktop'

export interface CanvasViewer {
  formFactor: CanvasViewerFormFactor
  platform: string
  width: number
}

/** Typical iPhone CSS width when the client omits `width`. */
export const PHONE_HINT_WIDTH = 390
/** Typical desktop CSS width when the client omits `width`. */
export const DESKTOP_HINT_WIDTH = 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseFormFactor(raw: unknown): CanvasViewerFormFactor | null {
  return raw === 'phone' || raw === 'desktop' ? raw : null
}

function parseWidth(raw: unknown, formFactor: CanvasViewerFormFactor): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(1, Math.round(raw))
  }
  return formFactor === 'phone' ? PHONE_HINT_WIDTH : DESKTOP_HINT_WIDTH
}

function parsePlatform(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown'
  const platform = raw.trim()
  return platform || 'unknown'
}

export function parseCanvasViewer(raw: unknown): CanvasViewer | null {
  if (!isRecord(raw)) return null
  const formFactor = parseFormFactor(raw.formFactor)
  if (!formFactor) return null
  return {
    formFactor,
    platform: parsePlatform(raw.platform),
    width: parseWidth(raw.width, formFactor),
  }
}

export function buildViewerContextPrompt(viewer: CanvasViewer): string {
  if (viewer.formFactor === 'phone') {
    return [
      '## Viewer',
      `Live preview is a **phone** (${viewer.platform}, ~${viewer.width}px) — the device toolbar for this turn.`,
      'Apply the canvas preview contract on this write. Do not wait for the user to mention mobile or responsive.',
      'Stacked panes, no pinned left sidebar, thumb-reachable actions. Grow to desktop with `sm:` / `md:` / `lg:`.',
      '',
    ].join('\n')
  }
  return [
    '## Viewer',
    `Live preview is **desktop** (${viewer.platform}, ~${viewer.width}px).`,
    'Still write mobile-first Tailwind so the same canvas works on iPhone (~390px). Do not wait to be asked.',
    '',
  ].join('\n')
}
