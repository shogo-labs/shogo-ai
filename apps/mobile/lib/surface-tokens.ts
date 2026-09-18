// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Shared surface palette from the Shogo Figma color tokens. */
export const SURFACE_COLORS = {
  light: {
    surface: '#F5FBF5',
    containerLowest: '#FFFFFF',
    containerLow: '#F7F3F2',
    container: '#F1EDEC',
    containerHigh: '#EBE7E6',
    containerHighest: '#E5E2E1',
    onSurface: '#1C1B1B',
  },
  dark: {
    surface: '#141313',
    containerLowest: '#0E0E0E',
    containerLow: '#1C1B1B',
    container: '#201F1F',
    containerHigh: '#2A2A29',
    containerHighest: '#353434',
    onSurface: '#FFFFFF',
  },
} as const

function hexToRgbString(hex: string): string {
  const value = hex.replace('#', '')
  return `${parseInt(value.slice(0, 2), 16)} ${parseInt(value.slice(2, 4), 16)} ${parseInt(value.slice(4, 6), 16)}`
}

export const SURFACE_RGB = {
  light: {
    surface: hexToRgbString(SURFACE_COLORS.light.surface),
    containerLowest: hexToRgbString(SURFACE_COLORS.light.containerLowest),
    containerLow: hexToRgbString(SURFACE_COLORS.light.containerLow),
    container: hexToRgbString(SURFACE_COLORS.light.container),
    containerHigh: hexToRgbString(SURFACE_COLORS.light.containerHigh),
    containerHighest: hexToRgbString(SURFACE_COLORS.light.containerHighest),
    onSurface: hexToRgbString(SURFACE_COLORS.light.onSurface),
  },
  dark: {
    surface: hexToRgbString(SURFACE_COLORS.dark.surface),
    containerLowest: hexToRgbString(SURFACE_COLORS.dark.containerLowest),
    containerLow: hexToRgbString(SURFACE_COLORS.dark.containerLow),
    container: hexToRgbString(SURFACE_COLORS.dark.container),
    containerHigh: hexToRgbString(SURFACE_COLORS.dark.containerHigh),
    containerHighest: hexToRgbString(SURFACE_COLORS.dark.containerHighest),
    onSurface: hexToRgbString(SURFACE_COLORS.dark.onSurface),
  },
} as const
