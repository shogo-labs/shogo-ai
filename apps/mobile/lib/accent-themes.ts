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
    swatch: '#C2410C',
    light: { primary: '194 65 12', primaryForeground: '255 255 255', ring: '194 65 12' },
    dark: { primary: '240 144 80', primaryForeground: '24 24 27', ring: '240 144 80' },
  },
  blue: {
    label: 'Blue',
    swatch: '#2563EB',
    light: { primary: '37 99 235', primaryForeground: '255 255 255', ring: '37 99 235' },
    dark: { primary: '33 150 243', primaryForeground: '24 24 27', ring: '33 150 243' },
  },
  purple: {
    label: 'Purple',
    swatch: '#7C3AED',
    light: { primary: '124 58 237', primaryForeground: '255 255 255', ring: '124 58 237' },
    dark: { primary: '167 139 250', primaryForeground: '24 24 27', ring: '167 139 250' },
  },
  teal: {
    label: 'Teal',
    swatch: '#0F766E',
    light: { primary: '15 118 110', primaryForeground: '255 255 255', ring: '15 118 110' },
    dark: { primary: '45 212 191', primaryForeground: '24 24 27', ring: '45 212 191' },
  },
  rose: {
    label: 'Rose',
    swatch: '#E11D48',
    light: { primary: '225 29 72', primaryForeground: '255 255 255', ring: '225 29 72' },
    dark: { primary: '251 113 133', primaryForeground: '24 24 27', ring: '251 113 133' },
  },
} as const satisfies Record<string, AccentPreset>

export type AccentThemeName = keyof typeof ACCENT_PRESETS
export const DEFAULT_ACCENT: AccentThemeName = 'shogo-orange'
export const ACCENT_NAMES = Object.keys(ACCENT_PRESETS) as AccentThemeName[]
