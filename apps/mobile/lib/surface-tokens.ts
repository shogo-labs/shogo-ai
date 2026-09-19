// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Shared surface palette matching the web semantic color tokens. */
export const SURFACE_COLORS = {
  light: {
    surface: '#FFFFFF',
    containerLowest: '#FFFFFF',
    containerLow: '#F4F4F5',
    container: '#FFFFFF',
    containerHigh: '#F4F4F5',
    containerHighest: '#E4E4E7',
    onSurface: '#0A0A0A',
  },
  dark: {
    surface: '#121212',
    containerLowest: '#121212',
    containerLow: '#2A2A2A',
    container: '#1E1E1E',
    containerHigh: '#2A2A2A',
    containerHighest: '#333333',
    onSurface: '#DEDEDE',
  },
} as const
