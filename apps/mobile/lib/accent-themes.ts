// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface AccentPreset {
  label: string
  /** Hex color shown in the picker swatch (light-mode representative) */
  swatch: string
  light: { primary: string; primaryForeground: string; ring: string }
  dark: { primary: string; primaryForeground: string; ring: string }
}

export const ACCENT_PRESETS = {
  'shogo-orange': {
    label: 'Shogo Orange',
    swatch: '#E27927',
    light: { primary: '226 121 39', primaryForeground: '255 255 255', ring: '226 121 39' },
    dark: { primary: '240 144 80', primaryForeground: '255 255 255', ring: '240 144 80' },
  },
  blue: {
    label: 'Blue',
    swatch: '#2563EB',
    light: { primary: '37 99 235', primaryForeground: '255 255 255', ring: '37 99 235' },
    dark: { primary: '33 150 243', primaryForeground: '255 255 255', ring: '33 150 243' },
  },
  purple: {
    label: 'Purple',
    swatch: '#7C3AED',
    light: { primary: '124 58 237', primaryForeground: '255 255 255', ring: '124 58 237' },
    dark: { primary: '167 139 250', primaryForeground: '255 255 255', ring: '167 139 250' },
  },
  teal: {
    label: 'Teal',
    swatch: '#0D9488',
    light: { primary: '13 148 136', primaryForeground: '255 255 255', ring: '13 148 136' },
    dark: { primary: '45 212 191', primaryForeground: '0 0 0', ring: '45 212 191' },
  },
  rose: {
    label: 'Rose',
    swatch: '#E11D48',
    light: { primary: '225 29 72', primaryForeground: '255 255 255', ring: '225 29 72' },
    dark: { primary: '251 113 133', primaryForeground: '255 255 255', ring: '251 113 133' },
  },
} as const satisfies Record<string, AccentPreset>

export type AccentThemeName = keyof typeof ACCENT_PRESETS
export const DEFAULT_ACCENT: AccentThemeName = 'shogo-orange'
export const ACCENT_NAMES = Object.keys(ACCENT_PRESETS) as AccentThemeName[]

/** `226 121 39` → `rgb(226, 121, 39)`, the form React Native props accept. */
export function accentTripletToRgb(triplet: string): string {
  return `rgb(${triplet.trim().split(/\s+/).join(', ')})`
}

/**
 * The live accent for code that cannot use a hook — the root error boundary
 * renders when the providers it would read from may not be mounted. On web it
 * reads the same stored preference and `dark` class the accent provider writes;
 * elsewhere it falls back to the default preset.
 */
export function resolveAccentWithoutContext(): { primary: string; primaryForeground: string } {
  let name: AccentThemeName = DEFAULT_ACCENT
  let dark = false
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem('accent-theme')
      if (stored && stored in ACCENT_PRESETS) name = stored as AccentThemeName
    } catch {
      // storage unavailable — default accent is fine for a fallback screen
    }
    dark = document.documentElement.classList.contains('dark')
  }
  const values = dark ? ACCENT_PRESETS[name].dark : ACCENT_PRESETS[name].light
  return {
    primary: accentTripletToRgb(values.primary),
    primaryForeground: accentTripletToRgb(values.primaryForeground),
  }
}
