// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared design tokens used by both web (CSS vars) and native (JS values).
 *
 * Web: CSS variables in index.css reference these same values.
 * Native: NativeWind reads these via tailwind.config.ts or a theme provider.
 */

export interface ThemeColors {
  background: string
  foreground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  destructive: string
  destructiveForeground: string
  border: string
  input: string
  ring: string
}

export interface ThemeChartColors {
  chart1: string
  chart2: string
  chart3: string
  chart4: string
  chart5: string
}

export interface ThemePhaseColors {
  discovery: string
  analysis: string
  classification: string
  design: string
  spec: string
  testing: string
  implementation: string
  complete: string
}

export interface ThemeStatusColors {
  pending: string
  active: string
  success: string
  error: string
  warning: string
}

export interface ThemeToolColors {
  mcp: string
  file: string
  skill: string
  bash: string
}

export interface ThemeExecColors {
  streaming: string
  success: string
  error: string
}

export interface Theme {
  colors: ThemeColors
  chart: ThemeChartColors
  phase: ThemePhaseColors
  status: ThemeStatusColors
  tool: ThemeToolColors
  exec: ThemeExecColors
}

export const lightTheme: Theme = {
  colors: {
    background: '#ffffff',
    foreground: '#0a0a0a',
    card: '#ffffff',
    cardForeground: '#0a0a0a',
    popover: '#ffffff',
    popoverForeground: '#0a0a0a',
    primary: '#2563eb',
    primaryForeground: '#ffffff',
    secondary: '#f4f4f5',
    secondaryForeground: '#18181b',
    muted: '#f4f4f5',
    mutedForeground: '#71717a',
    accent: '#f4f4f5',
    accentForeground: '#18181b',
    destructive: '#dc2626',
    destructiveForeground: '#ffffff',
    border: '#e4e4e7',
    input: '#e4e4e7',
    ring: '#2563eb',
  },
  chart: {
    chart1: '#e76e50',
    chart2: '#2a9d90',
    chart3: '#274754',
    chart4: '#e9c46a',
    chart5: '#f4a261',
  },
  phase: {
    discovery: '#0ea5e9',
    analysis: '#6366f1',
    classification: '#a855f7',
    design: '#d946ef',
    spec: '#14b8a6',
    testing: '#06b6d4',
    implementation: '#f59e0b',
    complete: '#22c55e',
  },
  status: {
    pending: '#71717a',
    active: '#3b82f6',
    success: '#22c55e',
    error: '#ef4444',
    warning: '#f59e0b',
  },
  tool: {
    mcp: '#8B5CF6',
    file: '#10B981',
    skill: '#F59E0B',
    bash: '#6B7280',
  },
  exec: {
    streaming: '#3B82F6',
    success: '#22C55E',
    error: '#EF4444',
  },
}

export const darkTheme: Theme = {
  colors: {
    background: '#121212',
    foreground: 'rgba(255, 255, 255, 0.87)',
    card: '#1e1e1e',
    cardForeground: 'rgba(255, 255, 255, 0.87)',
    popover: '#1e1e1e',
    popoverForeground: 'rgba(255, 255, 255, 0.87)',
    primary: '#2196f3',
    primaryForeground: '#ffffff',
    secondary: '#333333',
    secondaryForeground: '#ffffff',
    muted: '#2a2a2a',
    mutedForeground: 'rgba(255, 255, 255, 0.6)',
    accent: '#333333',
    accentForeground: '#ffffff',
    destructive: '#dc2626',
    destructiveForeground: '#ffffff',
    border: '#333333',
    input: '#333333',
    ring: '#2196f3',
  },
  chart: {
    chart1: '#2662d9',
    chart2: '#e23670',
    chart3: '#e8a838',
    chart4: '#af57db',
    chart5: '#2eb88a',
  },
  phase: {
    discovery: '#38bdf8',
    analysis: '#818cf8',
    classification: '#c084fc',
    design: '#f0abfc',
    spec: '#2dd4bf',
    testing: '#22d3ee',
    implementation: '#fbbf24',
    complete: '#4ade80',
  },
  status: {
    pending: '#a1a1aa',
    active: '#60a5fa',
    success: '#4ade80',
    error: '#f87171',
    warning: '#fbbf24',
  },
  tool: {
    mcp: '#A78BFA',
    file: '#34D399',
    skill: '#FBBF24',
    bash: '#9CA3AF',
  },
  exec: {
    streaming: '#60A5FA',
    success: '#4ADE80',
    error: '#F87171',
  },
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  '2xl': 48,
} as const

export const borderRadius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  full: 9999,
} as const

export const fontFamilies = {
  display: 'JetBrains Mono',
  body: 'Satoshi',
  micro: 'JetBrains Mono',
} as const
