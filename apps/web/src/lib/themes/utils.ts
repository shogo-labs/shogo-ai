/**
 * Theme Utilities
 * 
 * Functions for converting themes to CSS, generating CSS variable strings,
 * and other theme-related utilities.
 */

import type { ThemeConfig, ThemeColors, HSLColor, StoredThemeSelection } from './types'
import { getThemeById, getDefaultTheme } from './presets'

// Storage key for persisted theme selection
const THEME_STORAGE_KEY = 'shogo-project-theme'

/**
 * Convert HSL string to CSS hsl() value
 * Input: "222.2 47.4% 11.2%"
 * Output: "hsl(222.2 47.4% 11.2%)"
 */
export function hslToCSS(hsl: HSLColor): string {
  return `hsl(${hsl})`
}

/**
 * Generate CSS custom properties string from ThemeColors
 * This creates the content for :root or .dark blocks
 */
export function themeColorsToCSSVars(colors: ThemeColors): string {
  const vars: string[] = []
  
  // Simple colors
  vars.push(`--background: ${colors.background};`)
  vars.push(`--foreground: ${colors.foreground};`)
  
  // Color pairs
  vars.push(`--card: ${colors.card.DEFAULT};`)
  vars.push(`--card-foreground: ${colors.card.foreground};`)
  
  vars.push(`--popover: ${colors.popover.DEFAULT};`)
  vars.push(`--popover-foreground: ${colors.popover.foreground};`)
  
  vars.push(`--primary: ${colors.primary.DEFAULT};`)
  vars.push(`--primary-foreground: ${colors.primary.foreground};`)
  
  vars.push(`--secondary: ${colors.secondary.DEFAULT};`)
  vars.push(`--secondary-foreground: ${colors.secondary.foreground};`)
  
  vars.push(`--muted: ${colors.muted.DEFAULT};`)
  vars.push(`--muted-foreground: ${colors.muted.foreground};`)
  
  vars.push(`--accent: ${colors.accent.DEFAULT};`)
  vars.push(`--accent-foreground: ${colors.accent.foreground};`)
  
  vars.push(`--destructive: ${colors.destructive.DEFAULT};`)
  vars.push(`--destructive-foreground: ${colors.destructive.foreground};`)
  
  // Other colors
  vars.push(`--border: ${colors.border};`)
  vars.push(`--input: ${colors.input};`)
  vars.push(`--ring: ${colors.ring};`)
  
  // Chart colors (if present)
  if (colors.chart) {
    vars.push(`--chart-1: ${colors.chart[1]};`)
    vars.push(`--chart-2: ${colors.chart[2]};`)
    vars.push(`--chart-3: ${colors.chart[3]};`)
    vars.push(`--chart-4: ${colors.chart[4]};`)
    vars.push(`--chart-5: ${colors.chart[5]};`)
  }
  
  // Sidebar colors (if present)
  if (colors.sidebar) {
    vars.push(`--sidebar-background: ${colors.sidebar.background};`)
    vars.push(`--sidebar-foreground: ${colors.sidebar.foreground};`)
    vars.push(`--sidebar-primary: ${colors.sidebar.primary};`)
    vars.push(`--sidebar-primary-foreground: ${colors.sidebar.primaryForeground};`)
    vars.push(`--sidebar-accent: ${colors.sidebar.accent};`)
    vars.push(`--sidebar-accent-foreground: ${colors.sidebar.accentForeground};`)
    vars.push(`--sidebar-border: ${colors.sidebar.border};`)
    vars.push(`--sidebar-ring: ${colors.sidebar.ring};`)
  }
  
  return vars.join('\n    ')
}

/**
 * Generate full CSS string for a theme (for index.css)
 */
export function themeToCSS(theme: ThemeConfig): string {
  const lightVars = themeColorsToCSSVars(theme.light)
  const darkVars = themeColorsToCSSVars(theme.dark)
  
  // Add radius from effects
  const radius = theme.effects?.radius ?? '0.5'
  
  return `@tailwind base;
@tailwind components;
@tailwind utilities;

/* 
 * Theme: ${theme.name}
 * ${theme.description || ''}
 * 
 * All colors are in HSL format (without the hsl() wrapper).
 * This allows Tailwind to use opacity modifiers like bg-primary/50.
 */

@layer base {
  :root {
    ${lightVars}
    --radius: ${radius}rem;
  }

  .dark {
    ${darkVars}
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
`
}

/**
 * Generate a minimal CSS snippet for updating just the colors
 * (useful for AI to understand what to change)
 */
export function themeToMinimalCSS(theme: ThemeConfig, mode: 'light' | 'dark' = 'light'): string {
  const colors = mode === 'light' ? theme.light : theme.dark
  return themeColorsToCSSVars(colors)
}

/**
 * Generate a summary of theme colors for AI prompt context
 */
export function themeToPromptContext(theme: ThemeConfig): string {
  const { light, dark } = theme
  
  return `## Current Theme: ${theme.name}

### Light Mode Colors
- Background: ${light.background}
- Foreground (text): ${light.foreground}
- Primary: ${light.primary.DEFAULT}
- Primary Text: ${light.primary.foreground}
- Secondary: ${light.secondary.DEFAULT}
- Accent: ${light.accent.DEFAULT}
- Muted: ${light.muted.DEFAULT}
- Border: ${light.border}
- Radius: ${theme.effects?.radius ?? '0.5'}rem

### Dark Mode Colors
- Background: ${dark.background}
- Foreground (text): ${dark.foreground}
- Primary: ${dark.primary.DEFAULT}
- Primary Text: ${dark.primary.foreground}
- Secondary: ${dark.secondary.DEFAULT}
- Accent: ${dark.accent.DEFAULT}
- Muted: ${dark.muted.DEFAULT}
- Border: ${dark.border}

### How to Update Theme
To change the theme, modify the CSS variables in \`src/index.css\`.
All color values must be in HSL format without the hsl() wrapper.
Example: "--primary: 222.2 47.4% 11.2%;"

The Tailwind classes like \`bg-primary\`, \`text-foreground\`, etc. 
automatically use these CSS variables.`
}

/**
 * Save theme selection to localStorage
 */
export function saveThemeSelection(selection: StoredThemeSelection): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(selection))
  } catch (e) {
    console.warn('Failed to save theme selection:', e)
  }
}

/**
 * Load theme selection from localStorage
 */
export function loadThemeSelection(): StoredThemeSelection | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored) {
      return JSON.parse(stored) as StoredThemeSelection
    }
  } catch (e) {
    console.warn('Failed to load theme selection:', e)
  }
  return null
}

/**
 * Get the current theme config (from storage or default)
 */
export function getCurrentTheme(): ThemeConfig {
  const selection = loadThemeSelection()
  
  if (selection) {
    if (selection.customConfig) {
      return selection.customConfig
    }
    const preset = getThemeById(selection.themeId)
    if (preset) {
      return preset
    }
  }
  
  return getDefaultTheme()
}

/**
 * Convert a hex color to HSL string
 * Input: "#3b82f6" or "3b82f6"
 * Output: "217 91% 60%"
 */
export function hexToHSL(hex: string): HSLColor {
  // Remove # if present
  hex = hex.replace(/^#/, '')
  
  // Parse RGB values
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2
  
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      case b:
        h = ((r - g) / d + 4) / 6
        break
    }
  }
  
  // Convert to degrees and percentages
  const hDeg = Math.round(h * 360 * 10) / 10
  const sPercent = Math.round(s * 100 * 10) / 10
  const lPercent = Math.round(l * 100 * 10) / 10
  
  return `${hDeg} ${sPercent}% ${lPercent}%`
}

/**
 * Convert HSL string to hex color
 * Input: "217 91% 60%"
 * Output: "#3b82f6"
 */
export function hslToHex(hsl: HSLColor): string {
  const parts = hsl.match(/[\d.]+/g)
  if (!parts || parts.length < 3) return '#000000'
  
  const h = parseFloat(parts[0]) / 360
  const s = parseFloat(parts[1]) / 100
  const l = parseFloat(parts[2]) / 100
  
  let r: number, g: number, b: number
  
  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1/6) return p + (q - p) * 6 * t
      if (t < 1/2) return q
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
      return p
    }
    
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1/3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1/3)
  }
  
  const toHex = (x: number) => {
    const hex = Math.round(x * 255).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }
  
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Validate that a string is a valid HSL color format
 */
export function isValidHSL(value: string): boolean {
  // Match patterns like "222.2 47.4% 11.2%" or "0 0% 100%"
  const hslPattern = /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/
  return hslPattern.test(value.trim())
}
