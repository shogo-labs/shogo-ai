// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which colour an agent's screen glows in. White and grey agents would make a
 * dull haze, so anything with little colour glows a deep blue instead.
 */

export const FALLBACK_GLOW = '#3B5BDB'

/** A `#rrggbb` (or `rrggbb`) colour as 0-255 channels, or null when it isn't one. */
export function parseHex(hex: string | null | undefined): { r: number; g: number; b: number } | null {
  const digits = (hex ?? '').trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) return null
  const value = parseInt(digits, 16)
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
}

export function glowHex(hex: string | null | undefined): string {
  const rgb = parseHex(hex)
  if (!rgb) return FALLBACK_GLOW
  const high = Math.max(rgb.r, rgb.g, rgb.b) / 255
  const low = Math.min(rgb.r, rgb.g, rgb.b) / 255
  const saturation = high === 0 ? 0 : (high - low) / high
  return saturation < 0.25 ? FALLBACK_GLOW : `#${(hex ?? '').trim().replace(/^#/, '').toLowerCase()}`
}
