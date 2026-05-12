// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Shared accent palette used for listing icons, hero gradients, and tile
 * backgrounds. We pick a deterministic color from the title so the same
 * agent always renders with the same accent across the app.
 *
 * The palette is intentionally jewel-toned and works well on both the
 * light and dark themes defined in `apps/mobile/global.css`.
 */
export const ACCENT_COLORS = [
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#f97316', // orange-500
  '#22c55e', // green-500
  '#06b6d4', // cyan-500
  '#7c3aed', // violet-600
  '#d946ef', // fuchsia-500
  '#14b8a6', // teal-500
] as const

export function getAccentColor(seed: string | null | undefined): string {
  if (!seed) return ACCENT_COLORS[0]
  const idx =
    seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % ACCENT_COLORS.length
  return ACCENT_COLORS[idx]
}

export function getInitial(title: string | null | undefined): string {
  if (!title) return '?'
  return title.trim().charAt(0).toUpperCase() || '?'
}
