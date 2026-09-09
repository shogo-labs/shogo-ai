// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatGPT iOS canvas tokens. Native handsets apply these; web applies them
 * only on a phone-sized viewport so tablets, desktop studio, and Electron stay
 * on their existing theme surfaces.
 */
import { vars } from 'nativewind'

export const CHATGPT_PHONE_SURFACES = {
  light: {
    '--color-background': '255 255 255',
    '--color-foreground': '13 13 13',
    '--color-card': '255 255 255',
    '--color-card-foreground': '13 13 13',
    '--color-popover': '255 255 255',
    '--color-popover-foreground': '13 13 13',
    '--color-muted': '244 244 244',
    '--color-muted-foreground': '142 142 142',
    '--color-border': '229 229 229',
    '--color-secondary': '244 244 244',
    '--color-secondary-foreground': '13 13 13',
    '--color-accent': '244 244 244',
    '--color-accent-foreground': '13 13 13',
    '--color-input': '229 229 229',
  },
  dark: {
    '--color-background': '0 0 0',
    '--color-foreground': '244 244 244',
    '--color-card': '33 33 33',
    '--color-card-foreground': '236 236 236',
    '--color-popover': '33 33 33',
    '--color-popover-foreground': '236 236 236',
    '--color-muted': '47 47 47',
    '--color-muted-foreground': '142 142 142',
    '--color-border': '62 62 62',
    '--color-secondary': '47 47 47',
    '--color-secondary-foreground': '236 236 236',
    '--color-accent': '47 47 47',
    '--color-accent-foreground': '236 236 236',
    '--color-input': '62 62 62',
  },
} as const

export const CHATGPT_PHONE_SURFACE_VARS = {
  light: vars(CHATGPT_PHONE_SURFACES.light),
  dark: vars(CHATGPT_PHONE_SURFACES.dark),
} as const
