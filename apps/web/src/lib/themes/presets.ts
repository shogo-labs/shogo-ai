/**
 * Theme Presets
 * 
 * Pre-defined themes inspired by Lovable.dev's theme system.
 * Each theme provides light and dark mode color configurations
 * using HSL color values for Tailwind CSS integration.
 */

import type { ThemePreset, ThemeConfig, ThemeColors } from './types'

// =============================================================================
// Default Theme (shadcn default)
// =============================================================================

const defaultLight: ThemeColors = {
  background: '0 0% 100%',
  foreground: '222.2 84% 4.9%',
  card: {
    DEFAULT: '0 0% 100%',
    foreground: '222.2 84% 4.9%',
  },
  popover: {
    DEFAULT: '0 0% 100%',
    foreground: '222.2 84% 4.9%',
  },
  primary: {
    DEFAULT: '222.2 47.4% 11.2%',
    foreground: '210 40% 98%',
  },
  secondary: {
    DEFAULT: '210 40% 96.1%',
    foreground: '222.2 47.4% 11.2%',
  },
  muted: {
    DEFAULT: '210 40% 96.1%',
    foreground: '215.4 16.3% 46.9%',
  },
  accent: {
    DEFAULT: '210 40% 96.1%',
    foreground: '222.2 47.4% 11.2%',
  },
  destructive: {
    DEFAULT: '0 84.2% 60.2%',
    foreground: '210 40% 98%',
  },
  border: '214.3 31.8% 91.4%',
  input: '214.3 31.8% 91.4%',
  ring: '222.2 84% 4.9%',
}

const defaultDark: ThemeColors = {
  background: '222.2 84% 4.9%',
  foreground: '210 40% 98%',
  card: {
    DEFAULT: '222.2 84% 4.9%',
    foreground: '210 40% 98%',
  },
  popover: {
    DEFAULT: '222.2 84% 4.9%',
    foreground: '210 40% 98%',
  },
  primary: {
    DEFAULT: '210 40% 98%',
    foreground: '222.2 47.4% 11.2%',
  },
  secondary: {
    DEFAULT: '217.2 32.6% 17.5%',
    foreground: '210 40% 98%',
  },
  muted: {
    DEFAULT: '217.2 32.6% 17.5%',
    foreground: '215 20.2% 65.1%',
  },
  accent: {
    DEFAULT: '217.2 32.6% 17.5%',
    foreground: '210 40% 98%',
  },
  destructive: {
    DEFAULT: '0 62.8% 30.6%',
    foreground: '210 40% 98%',
  },
  border: '217.2 32.6% 17.5%',
  input: '217.2 32.6% 17.5%',
  ring: '212.7 26.8% 83.9%',
}

const defaultTheme: ThemeConfig = {
  id: 'default',
  name: 'Default',
  description: 'Clean and professional default theme',
  light: defaultLight,
  dark: defaultDark,
  effects: {
    radius: '0.5',
  },
}

// =============================================================================
// Glacier Theme (Cool blues)
// =============================================================================

const glacierLight: ThemeColors = {
  background: '210 40% 98%',
  foreground: '222 47% 11%',
  card: {
    DEFAULT: '0 0% 100%',
    foreground: '222 47% 11%',
  },
  popover: {
    DEFAULT: '0 0% 100%',
    foreground: '222 47% 11%',
  },
  primary: {
    DEFAULT: '199 89% 48%',
    foreground: '0 0% 100%',
  },
  secondary: {
    DEFAULT: '210 40% 93%',
    foreground: '222 47% 11%',
  },
  muted: {
    DEFAULT: '210 40% 93%',
    foreground: '215 16% 47%',
  },
  accent: {
    DEFAULT: '199 89% 93%',
    foreground: '199 89% 30%',
  },
  destructive: {
    DEFAULT: '0 84% 60%',
    foreground: '0 0% 100%',
  },
  border: '214 32% 91%',
  input: '214 32% 91%',
  ring: '199 89% 48%',
}

const glacierDark: ThemeColors = {
  background: '222 47% 6%',
  foreground: '210 40% 98%',
  card: {
    DEFAULT: '222 47% 9%',
    foreground: '210 40% 98%',
  },
  popover: {
    DEFAULT: '222 47% 9%',
    foreground: '210 40% 98%',
  },
  primary: {
    DEFAULT: '199 89% 48%',
    foreground: '222 47% 6%',
  },
  secondary: {
    DEFAULT: '217 33% 17%',
    foreground: '210 40% 98%',
  },
  muted: {
    DEFAULT: '217 33% 17%',
    foreground: '215 20% 65%',
  },
  accent: {
    DEFAULT: '199 89% 20%',
    foreground: '199 89% 90%',
  },
  destructive: {
    DEFAULT: '0 63% 31%',
    foreground: '210 40% 98%',
  },
  border: '217 33% 17%',
  input: '217 33% 17%',
  ring: '199 89% 48%',
}

const glacierTheme: ThemeConfig = {
  id: 'glacier',
  name: 'Glacier',
  description: 'Cool and refreshing blue tones',
  light: glacierLight,
  dark: glacierDark,
  effects: {
    radius: '0.5',
  },
}

// =============================================================================
// Harvest Theme (Warm oranges/browns)
// =============================================================================

const harvestLight: ThemeColors = {
  background: '40 33% 98%',
  foreground: '20 14% 10%',
  card: {
    DEFAULT: '40 33% 100%',
    foreground: '20 14% 10%',
  },
  popover: {
    DEFAULT: '40 33% 100%',
    foreground: '20 14% 10%',
  },
  primary: {
    DEFAULT: '24 95% 53%',
    foreground: '0 0% 100%',
  },
  secondary: {
    DEFAULT: '40 33% 93%',
    foreground: '20 14% 10%',
  },
  muted: {
    DEFAULT: '40 33% 93%',
    foreground: '20 14% 45%',
  },
  accent: {
    DEFAULT: '24 95% 92%',
    foreground: '24 95% 30%',
  },
  destructive: {
    DEFAULT: '0 84% 60%',
    foreground: '0 0% 100%',
  },
  border: '40 20% 88%',
  input: '40 20% 88%',
  ring: '24 95% 53%',
}

const harvestDark: ThemeColors = {
  background: '20 14% 6%',
  foreground: '40 33% 98%',
  card: {
    DEFAULT: '20 14% 9%',
    foreground: '40 33% 98%',
  },
  popover: {
    DEFAULT: '20 14% 9%',
    foreground: '40 33% 98%',
  },
  primary: {
    DEFAULT: '24 95% 53%',
    foreground: '20 14% 6%',
  },
  secondary: {
    DEFAULT: '20 14% 17%',
    foreground: '40 33% 98%',
  },
  muted: {
    DEFAULT: '20 14% 17%',
    foreground: '40 20% 65%',
  },
  accent: {
    DEFAULT: '24 95% 20%',
    foreground: '24 95% 90%',
  },
  destructive: {
    DEFAULT: '0 63% 31%',
    foreground: '40 33% 98%',
  },
  border: '20 14% 17%',
  input: '20 14% 17%',
  ring: '24 95% 53%',
}

const harvestTheme: ThemeConfig = {
  id: 'harvest',
  name: 'Harvest',
  description: 'Warm autumn-inspired orange tones',
  light: harvestLight,
  dark: harvestDark,
  effects: {
    radius: '0.5',
  },
}

// =============================================================================
// Lavender Theme (Soft purples)
// =============================================================================

const lavenderLight: ThemeColors = {
  background: '270 50% 98%',
  foreground: '270 50% 10%',
  card: {
    DEFAULT: '0 0% 100%',
    foreground: '270 50% 10%',
  },
  popover: {
    DEFAULT: '0 0% 100%',
    foreground: '270 50% 10%',
  },
  primary: {
    DEFAULT: '262 83% 58%',
    foreground: '0 0% 100%',
  },
  secondary: {
    DEFAULT: '270 50% 93%',
    foreground: '270 50% 10%',
  },
  muted: {
    DEFAULT: '270 50% 93%',
    foreground: '270 30% 45%',
  },
  accent: {
    DEFAULT: '262 83% 92%',
    foreground: '262 83% 35%',
  },
  destructive: {
    DEFAULT: '0 84% 60%',
    foreground: '0 0% 100%',
  },
  border: '270 30% 88%',
  input: '270 30% 88%',
  ring: '262 83% 58%',
}

const lavenderDark: ThemeColors = {
  background: '270 50% 5%',
  foreground: '270 50% 98%',
  card: {
    DEFAULT: '270 50% 8%',
    foreground: '270 50% 98%',
  },
  popover: {
    DEFAULT: '270 50% 8%',
    foreground: '270 50% 98%',
  },
  primary: {
    DEFAULT: '262 83% 58%',
    foreground: '270 50% 5%',
  },
  secondary: {
    DEFAULT: '270 30% 17%',
    foreground: '270 50% 98%',
  },
  muted: {
    DEFAULT: '270 30% 17%',
    foreground: '270 30% 65%',
  },
  accent: {
    DEFAULT: '262 83% 20%',
    foreground: '262 83% 90%',
  },
  destructive: {
    DEFAULT: '0 63% 31%',
    foreground: '270 50% 98%',
  },
  border: '270 30% 17%',
  input: '270 30% 17%',
  ring: '262 83% 58%',
}

const lavenderTheme: ThemeConfig = {
  id: 'lavender',
  name: 'Lavender',
  description: 'Soft and calming purple tones',
  light: lavenderLight,
  dark: lavenderDark,
  effects: {
    radius: '0.625',
  },
}

// =============================================================================
// Brutalist Theme (High contrast, bold)
// =============================================================================

const brutalistLight: ThemeColors = {
  background: '0 0% 100%',
  foreground: '0 0% 0%',
  card: {
    DEFAULT: '0 0% 100%',
    foreground: '0 0% 0%',
  },
  popover: {
    DEFAULT: '0 0% 100%',
    foreground: '0 0% 0%',
  },
  primary: {
    DEFAULT: '0 0% 0%',
    foreground: '0 0% 100%',
  },
  secondary: {
    DEFAULT: '0 0% 95%',
    foreground: '0 0% 0%',
  },
  muted: {
    DEFAULT: '0 0% 95%',
    foreground: '0 0% 40%',
  },
  accent: {
    DEFAULT: '351 100% 50%',
    foreground: '0 0% 100%',
  },
  destructive: {
    DEFAULT: '351 100% 50%',
    foreground: '0 0% 100%',
  },
  border: '0 0% 0%',
  input: '0 0% 85%',
  ring: '0 0% 0%',
}

const brutalistDark: ThemeColors = {
  background: '0 0% 0%',
  foreground: '0 0% 100%',
  card: {
    DEFAULT: '0 0% 5%',
    foreground: '0 0% 100%',
  },
  popover: {
    DEFAULT: '0 0% 5%',
    foreground: '0 0% 100%',
  },
  primary: {
    DEFAULT: '0 0% 100%',
    foreground: '0 0% 0%',
  },
  secondary: {
    DEFAULT: '0 0% 15%',
    foreground: '0 0% 100%',
  },
  muted: {
    DEFAULT: '0 0% 15%',
    foreground: '0 0% 60%',
  },
  accent: {
    DEFAULT: '351 100% 50%',
    foreground: '0 0% 100%',
  },
  destructive: {
    DEFAULT: '351 100% 50%',
    foreground: '0 0% 100%',
  },
  border: '0 0% 100%',
  input: '0 0% 20%',
  ring: '0 0% 100%',
}

const brutalistTheme: ThemeConfig = {
  id: 'brutalist',
  name: 'Brutalist',
  description: 'Bold, high-contrast monochrome with red accents',
  light: brutalistLight,
  dark: brutalistDark,
  effects: {
    radius: '0',
  },
}

// =============================================================================
// Obsidian Theme (Dark elegant)
// =============================================================================

const obsidianLight: ThemeColors = {
  background: '240 10% 96%',
  foreground: '240 10% 10%',
  card: {
    DEFAULT: '0 0% 100%',
    foreground: '240 10% 10%',
  },
  popover: {
    DEFAULT: '0 0% 100%',
    foreground: '240 10% 10%',
  },
  primary: {
    DEFAULT: '240 6% 25%',
    foreground: '0 0% 100%',
  },
  secondary: {
    DEFAULT: '240 10% 91%',
    foreground: '240 10% 10%',
  },
  muted: {
    DEFAULT: '240 10% 91%',
    foreground: '240 6% 45%',
  },
  accent: {
    DEFAULT: '240 6% 85%',
    foreground: '240 6% 20%',
  },
  destructive: {
    DEFAULT: '0 84% 60%',
    foreground: '0 0% 100%',
  },
  border: '240 6% 85%',
  input: '240 6% 85%',
  ring: '240 6% 25%',
}

const obsidianDark: ThemeColors = {
  background: '240 6% 6%',
  foreground: '240 10% 96%',
  card: {
    DEFAULT: '240 6% 10%',
    foreground: '240 10% 96%',
  },
  popover: {
    DEFAULT: '240 6% 10%',
    foreground: '240 10% 96%',
  },
  primary: {
    DEFAULT: '240 10% 90%',
    foreground: '240 6% 6%',
  },
  secondary: {
    DEFAULT: '240 6% 15%',
    foreground: '240 10% 96%',
  },
  muted: {
    DEFAULT: '240 6% 15%',
    foreground: '240 6% 55%',
  },
  accent: {
    DEFAULT: '240 6% 20%',
    foreground: '240 10% 90%',
  },
  destructive: {
    DEFAULT: '0 63% 31%',
    foreground: '240 10% 96%',
  },
  border: '240 6% 15%',
  input: '240 6% 15%',
  ring: '240 10% 90%',
}

const obsidianTheme: ThemeConfig = {
  id: 'obsidian',
  name: 'Obsidian',
  description: 'Elegant dark slate tones',
  light: obsidianLight,
  dark: obsidianDark,
  effects: {
    radius: '0.375',
  },
}

// =============================================================================
// Orchid Theme (Vibrant pinks)
// =============================================================================

const orchidLight: ThemeColors = {
  background: '330 50% 98%',
  foreground: '330 50% 10%',
  card: {
    DEFAULT: '0 0% 100%',
    foreground: '330 50% 10%',
  },
  popover: {
    DEFAULT: '0 0% 100%',
    foreground: '330 50% 10%',
  },
  primary: {
    DEFAULT: '330 81% 60%',
    foreground: '0 0% 100%',
  },
  secondary: {
    DEFAULT: '330 50% 93%',
    foreground: '330 50% 10%',
  },
  muted: {
    DEFAULT: '330 50% 93%',
    foreground: '330 30% 45%',
  },
  accent: {
    DEFAULT: '330 81% 92%',
    foreground: '330 81% 35%',
  },
  destructive: {
    DEFAULT: '0 84% 60%',
    foreground: '0 0% 100%',
  },
  border: '330 30% 88%',
  input: '330 30% 88%',
  ring: '330 81% 60%',
}

const orchidDark: ThemeColors = {
  background: '330 50% 5%',
  foreground: '330 50% 98%',
  card: {
    DEFAULT: '330 50% 8%',
    foreground: '330 50% 98%',
  },
  popover: {
    DEFAULT: '330 50% 8%',
    foreground: '330 50% 98%',
  },
  primary: {
    DEFAULT: '330 81% 60%',
    foreground: '330 50% 5%',
  },
  secondary: {
    DEFAULT: '330 30% 17%',
    foreground: '330 50% 98%',
  },
  muted: {
    DEFAULT: '330 30% 17%',
    foreground: '330 30% 65%',
  },
  accent: {
    DEFAULT: '330 81% 25%',
    foreground: '330 81% 90%',
  },
  destructive: {
    DEFAULT: '0 63% 31%',
    foreground: '330 50% 98%',
  },
  border: '330 30% 17%',
  input: '330 30% 17%',
  ring: '330 81% 60%',
}

const orchidTheme: ThemeConfig = {
  id: 'orchid',
  name: 'Orchid',
  description: 'Vibrant pink and magenta tones',
  light: orchidLight,
  dark: orchidDark,
  effects: {
    radius: '0.5',
  },
}

// =============================================================================
// Solar Theme (Sunny yellows)
// =============================================================================

const solarLight: ThemeColors = {
  background: '48 100% 98%',
  foreground: '20 14% 10%',
  card: {
    DEFAULT: '0 0% 100%',
    foreground: '20 14% 10%',
  },
  popover: {
    DEFAULT: '0 0% 100%',
    foreground: '20 14% 10%',
  },
  primary: {
    DEFAULT: '45 93% 47%',
    foreground: '20 14% 10%',
  },
  secondary: {
    DEFAULT: '48 100% 93%',
    foreground: '20 14% 10%',
  },
  muted: {
    DEFAULT: '48 100% 93%',
    foreground: '20 14% 45%',
  },
  accent: {
    DEFAULT: '45 93% 88%',
    foreground: '45 93% 25%',
  },
  destructive: {
    DEFAULT: '0 84% 60%',
    foreground: '0 0% 100%',
  },
  border: '48 50% 85%',
  input: '48 50% 85%',
  ring: '45 93% 47%',
}

const solarDark: ThemeColors = {
  background: '20 14% 6%',
  foreground: '48 100% 98%',
  card: {
    DEFAULT: '20 14% 9%',
    foreground: '48 100% 98%',
  },
  popover: {
    DEFAULT: '20 14% 9%',
    foreground: '48 100% 98%',
  },
  primary: {
    DEFAULT: '45 93% 47%',
    foreground: '20 14% 6%',
  },
  secondary: {
    DEFAULT: '20 14% 17%',
    foreground: '48 100% 98%',
  },
  muted: {
    DEFAULT: '20 14% 17%',
    foreground: '48 50% 65%',
  },
  accent: {
    DEFAULT: '45 93% 20%',
    foreground: '45 93% 90%',
  },
  destructive: {
    DEFAULT: '0 63% 31%',
    foreground: '48 100% 98%',
  },
  border: '20 14% 17%',
  input: '20 14% 17%',
  ring: '45 93% 47%',
}

const solarTheme: ThemeConfig = {
  id: 'solar',
  name: 'Solar',
  description: 'Bright and energetic yellow tones',
  light: solarLight,
  dark: solarDark,
  effects: {
    radius: '0.5',
  },
}

// =============================================================================
// Tide Theme (Ocean teals)
// =============================================================================

const tideLight: ThemeColors = {
  background: '180 30% 98%',
  foreground: '180 30% 10%',
  card: {
    DEFAULT: '0 0% 100%',
    foreground: '180 30% 10%',
  },
  popover: {
    DEFAULT: '0 0% 100%',
    foreground: '180 30% 10%',
  },
  primary: {
    DEFAULT: '173 80% 40%',
    foreground: '0 0% 100%',
  },
  secondary: {
    DEFAULT: '180 30% 93%',
    foreground: '180 30% 10%',
  },
  muted: {
    DEFAULT: '180 30% 93%',
    foreground: '180 20% 45%',
  },
  accent: {
    DEFAULT: '173 80% 90%',
    foreground: '173 80% 25%',
  },
  destructive: {
    DEFAULT: '0 84% 60%',
    foreground: '0 0% 100%',
  },
  border: '180 20% 88%',
  input: '180 20% 88%',
  ring: '173 80% 40%',
}

const tideDark: ThemeColors = {
  background: '180 30% 5%',
  foreground: '180 30% 98%',
  card: {
    DEFAULT: '180 30% 8%',
    foreground: '180 30% 98%',
  },
  popover: {
    DEFAULT: '180 30% 8%',
    foreground: '180 30% 98%',
  },
  primary: {
    DEFAULT: '173 80% 40%',
    foreground: '180 30% 5%',
  },
  secondary: {
    DEFAULT: '180 20% 17%',
    foreground: '180 30% 98%',
  },
  muted: {
    DEFAULT: '180 20% 17%',
    foreground: '180 20% 65%',
  },
  accent: {
    DEFAULT: '173 80% 20%',
    foreground: '173 80% 90%',
  },
  destructive: {
    DEFAULT: '0 63% 31%',
    foreground: '180 30% 98%',
  },
  border: '180 20% 17%',
  input: '180 20% 17%',
  ring: '173 80% 40%',
}

const tideTheme: ThemeConfig = {
  id: 'tide',
  name: 'Tide',
  description: 'Refreshing ocean-inspired teal tones',
  light: tideLight,
  dark: tideDark,
  effects: {
    radius: '0.5',
  },
}

// =============================================================================
// Verdant Theme (Natural greens)
// =============================================================================

const verdantLight: ThemeColors = {
  background: '120 30% 98%',
  foreground: '120 30% 10%',
  card: {
    DEFAULT: '0 0% 100%',
    foreground: '120 30% 10%',
  },
  popover: {
    DEFAULT: '0 0% 100%',
    foreground: '120 30% 10%',
  },
  primary: {
    DEFAULT: '142 71% 45%',
    foreground: '0 0% 100%',
  },
  secondary: {
    DEFAULT: '120 30% 93%',
    foreground: '120 30% 10%',
  },
  muted: {
    DEFAULT: '120 30% 93%',
    foreground: '120 20% 45%',
  },
  accent: {
    DEFAULT: '142 71% 90%',
    foreground: '142 71% 25%',
  },
  destructive: {
    DEFAULT: '0 84% 60%',
    foreground: '0 0% 100%',
  },
  border: '120 20% 88%',
  input: '120 20% 88%',
  ring: '142 71% 45%',
}

const verdantDark: ThemeColors = {
  background: '120 30% 5%',
  foreground: '120 30% 98%',
  card: {
    DEFAULT: '120 30% 8%',
    foreground: '120 30% 98%',
  },
  popover: {
    DEFAULT: '120 30% 8%',
    foreground: '120 30% 98%',
  },
  primary: {
    DEFAULT: '142 71% 45%',
    foreground: '120 30% 5%',
  },
  secondary: {
    DEFAULT: '120 20% 17%',
    foreground: '120 30% 98%',
  },
  muted: {
    DEFAULT: '120 20% 17%',
    foreground: '120 20% 65%',
  },
  accent: {
    DEFAULT: '142 71% 20%',
    foreground: '142 71% 90%',
  },
  destructive: {
    DEFAULT: '0 63% 31%',
    foreground: '120 30% 98%',
  },
  border: '120 20% 17%',
  input: '120 20% 17%',
  ring: '142 71% 45%',
}

const verdantTheme: ThemeConfig = {
  id: 'verdant',
  name: 'Verdant',
  description: 'Fresh and natural green tones',
  light: verdantLight,
  dark: verdantDark,
  effects: {
    radius: '0.5',
  },
}

// =============================================================================
// Exports
// =============================================================================

/**
 * All available theme configurations
 */
export const THEME_CONFIGS: Record<string, ThemeConfig> = {
  default: defaultTheme,
  glacier: glacierTheme,
  harvest: harvestTheme,
  lavender: lavenderTheme,
  brutalist: brutalistTheme,
  obsidian: obsidianTheme,
  orchid: orchidTheme,
  solar: solarTheme,
  tide: tideTheme,
  verdant: verdantTheme,
}

/**
 * Theme presets with preview colors for the selector UI
 */
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'default',
    name: 'Default',
    preview: {
      primary: '222.2 47.4% 11.2%',
      secondary: '210 40% 96.1%',
      accent: '210 40% 96.1%',
      background: '0 0% 100%',
    },
    config: defaultTheme,
  },
  {
    id: 'glacier',
    name: 'Glacier',
    preview: {
      primary: '199 89% 48%',
      secondary: '210 40% 93%',
      accent: '199 89% 93%',
      background: '210 40% 98%',
    },
    config: glacierTheme,
  },
  {
    id: 'harvest',
    name: 'Harvest',
    preview: {
      primary: '24 95% 53%',
      secondary: '40 33% 93%',
      accent: '24 95% 92%',
      background: '40 33% 98%',
    },
    config: harvestTheme,
  },
  {
    id: 'lavender',
    name: 'Lavender',
    preview: {
      primary: '262 83% 58%',
      secondary: '270 50% 93%',
      accent: '262 83% 92%',
      background: '270 50% 98%',
    },
    config: lavenderTheme,
  },
  {
    id: 'brutalist',
    name: 'Brutalist',
    preview: {
      primary: '0 0% 0%',
      secondary: '0 0% 95%',
      accent: '351 100% 50%',
      background: '0 0% 100%',
    },
    config: brutalistTheme,
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    preview: {
      primary: '240 6% 25%',
      secondary: '240 10% 91%',
      accent: '240 6% 85%',
      background: '240 10% 96%',
    },
    config: obsidianTheme,
  },
  {
    id: 'orchid',
    name: 'Orchid',
    preview: {
      primary: '330 81% 60%',
      secondary: '330 50% 93%',
      accent: '330 81% 92%',
      background: '330 50% 98%',
    },
    config: orchidTheme,
  },
  {
    id: 'solar',
    name: 'Solar',
    preview: {
      primary: '45 93% 47%',
      secondary: '48 100% 93%',
      accent: '45 93% 88%',
      background: '48 100% 98%',
    },
    config: solarTheme,
  },
  {
    id: 'tide',
    name: 'Tide',
    preview: {
      primary: '173 80% 40%',
      secondary: '180 30% 93%',
      accent: '173 80% 90%',
      background: '180 30% 98%',
    },
    config: tideTheme,
  },
  {
    id: 'verdant',
    name: 'Verdant',
    preview: {
      primary: '142 71% 45%',
      secondary: '120 30% 93%',
      accent: '142 71% 90%',
      background: '120 30% 98%',
    },
    config: verdantTheme,
  },
]

/**
 * Get a theme configuration by ID
 */
export function getThemeById(id: string): ThemeConfig | undefined {
  return THEME_CONFIGS[id]
}

/**
 * Get the default theme
 */
export function getDefaultTheme(): ThemeConfig {
  return defaultTheme
}
