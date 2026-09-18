// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatGPT iOS canvas tokens. Native handsets apply these; web applies them
 * only on a phone-sized viewport so tablets, desktop studio, and Electron stay
 * on their existing theme surfaces.
 */
import { vars } from 'nativewind'
import { SURFACE_RGB } from './surface-tokens'

export const CHATGPT_PHONE_SURFACES = {
  light: {
    '--color-background': SURFACE_RGB.light.surface,
    '--color-foreground': SURFACE_RGB.light.onSurface,
    '--color-card': SURFACE_RGB.light.container,
    '--color-card-foreground': SURFACE_RGB.light.onSurface,
    '--color-popover': SURFACE_RGB.light.containerHigh,
    '--color-popover-foreground': SURFACE_RGB.light.onSurface,
    '--color-muted': '244 244 244',
    '--color-muted-foreground': '142 142 142',
    '--color-border': '229 229 229',
    '--color-secondary': '244 244 244',
    '--color-secondary-foreground': '13 13 13',
    '--color-accent': '244 244 244',
    '--color-accent-foreground': '13 13 13',
    '--color-input': '229 229 229',
    '--color-surface-0': SURFACE_RGB.light.containerLowest,
    '--color-surface-1': SURFACE_RGB.light.containerLow,
    '--color-surface-2': SURFACE_RGB.light.container,
    '--color-surface-3': SURFACE_RGB.light.containerHigh,
    '--color-surface-4': SURFACE_RGB.light.containerHighest,
  },
  dark: {
    '--color-background': SURFACE_RGB.dark.surface,
    '--color-foreground': SURFACE_RGB.dark.onSurface,
    '--color-card': SURFACE_RGB.dark.container,
    '--color-card-foreground': SURFACE_RGB.dark.onSurface,
    '--color-popover': SURFACE_RGB.dark.containerHigh,
    '--color-popover-foreground': SURFACE_RGB.dark.onSurface,
    '--color-muted': '47 47 47',
    '--color-muted-foreground': '142 142 142',
    '--color-border': '62 62 62',
    '--color-secondary': '47 47 47',
    '--color-secondary-foreground': '236 236 236',
    '--color-accent': '47 47 47',
    '--color-accent-foreground': '236 236 236',
    '--color-input': '62 62 62',
    '--color-surface-0': SURFACE_RGB.dark.containerLowest,
    '--color-surface-1': SURFACE_RGB.dark.containerLow,
    '--color-surface-2': SURFACE_RGB.dark.container,
    '--color-surface-3': SURFACE_RGB.dark.containerHigh,
    '--color-surface-4': SURFACE_RGB.dark.containerHighest,
  },
} as const

export const CHATGPT_PHONE_SURFACE_VARS = {
  light: vars(CHATGPT_PHONE_SURFACES.light),
  dark: vars(CHATGPT_PHONE_SURFACES.dark),
} as const
