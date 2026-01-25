/**
 * Theme System
 * 
 * Exports for the theme configuration system.
 * 
 * Usage:
 * ```ts
 * import { THEME_PRESETS, getThemeById, themeToCSS } from '@/lib/themes'
 * import type { ThemeConfig, ThemePreset } from '@/lib/themes'
 * ```
 */

// Types
export type {
  HSLColor,
  ColorPair,
  ThemeColors,
  ThemeTypography,
  ThemeEffects,
  ThemeConfig,
  ThemePreset,
  ProjectThemeState,
  StoredThemeSelection,
} from './types'

// Presets
export {
  THEME_CONFIGS,
  THEME_PRESETS,
  getThemeById,
  getDefaultTheme,
} from './presets'

// Utilities
export {
  hslToCSS,
  themeColorsToCSSVars,
  themeToCSS,
  themeToMinimalCSS,
  themeToPromptContext,
  saveThemeSelection,
  loadThemeSelection,
  getCurrentTheme,
  hexToHSL,
  hslToHex,
  isValidHSL,
} from './utils'
