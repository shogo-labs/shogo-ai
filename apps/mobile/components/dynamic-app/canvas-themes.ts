/**
 * Canvas Color Theme Presets
 *
 * Defines scoped CSS variable overrides for the canvas container.
 * Each theme provides light + dark variants that override the
 * app's --color-* variables within the canvas boundary.
 *
 * Themes match those from packages/project-runtime/src/tools/template.copy.ts
 * (converted from HSL to hex for the mobile app's format).
 */

export interface CanvasThemeVariant {
  '--color-background': string
  '--color-foreground': string
  '--color-card': string
  '--color-card-foreground': string
  '--color-popover': string
  '--color-popover-foreground': string
  '--color-primary': string
  '--color-primary-foreground': string
  '--color-secondary': string
  '--color-secondary-foreground': string
  '--color-muted': string
  '--color-muted-foreground': string
  '--color-accent': string
  '--color-accent-foreground': string
  '--color-destructive': string
  '--color-destructive-foreground': string
  '--color-border': string
  '--color-input': string
  '--color-ring': string
  '--color-surface-0': string
  '--color-surface-1': string
  '--color-surface-2': string
  '--color-surface-3': string
}

export interface CanvasThemePreset {
  id: string
  label: string
  swatch: string
  light: CanvasThemeVariant
  dark: CanvasThemeVariant
}

function surfaceProgression(base: string, light: boolean): Pick<CanvasThemeVariant, '--color-surface-0' | '--color-surface-1' | '--color-surface-2' | '--color-surface-3'> {
  if (light) {
    return {
      '--color-surface-0': base,
      '--color-surface-1': adjustBrightness(base, -0.02),
      '--color-surface-2': adjustBrightness(base, -0.04),
      '--color-surface-3': adjustBrightness(base, -0.06),
    }
  }
  return {
    '--color-surface-0': base,
    '--color-surface-1': adjustBrightness(base, 0.03),
    '--color-surface-2': adjustBrightness(base, 0.06),
    '--color-surface-3': adjustBrightness(base, 0.09),
  }
}

function hexToRgb(hex: string): string {
  return `${parseInt(hex.slice(1, 3), 16)} ${parseInt(hex.slice(3, 5), 16)} ${parseInt(hex.slice(5, 7), 16)}`
}

function adjustBrightness(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v + amount * 255)))
  return `${clamp(r)} ${clamp(g)} ${clamp(b)}`
}

function toRgbTheme(theme: Record<string, string>): CanvasThemeVariant {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(theme)) {
    if (value.startsWith('#')) {
      result[key] = hexToRgb(value)
    } else if (value.startsWith('rgba(')) {
      const m = value.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)
      if (m) {
        const alpha = parseFloat(m[4])
        result[key] = `${Math.round(parseInt(m[1]) * alpha)} ${Math.round(parseInt(m[2]) * alpha)} ${Math.round(parseInt(m[3]) * alpha)}`
      } else {
        result[key] = value
      }
    } else {
      result[key] = value
    }
  }
  return result as unknown as CanvasThemeVariant
}

export const CANVAS_THEMES: CanvasThemePreset[] = [
  {
    id: 'default',
    label: 'Default',
    swatch: '#2563eb',
    light: toRgbTheme({
      '--color-background': '#ffffff',
      '--color-foreground': '#0a0a0a',
      '--color-card': '#ffffff',
      '--color-card-foreground': '#0a0a0a',
      '--color-popover': '#ffffff',
      '--color-popover-foreground': '#0a0a0a',
      '--color-primary': '#2563eb',
      '--color-primary-foreground': '#ffffff',
      '--color-secondary': '#f4f4f5',
      '--color-secondary-foreground': '#18181b',
      '--color-muted': '#f4f4f5',
      '--color-muted-foreground': '#71717a',
      '--color-accent': '#f4f4f5',
      '--color-accent-foreground': '#18181b',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#ffffff',
      '--color-border': '#e4e4e7',
      '--color-input': '#e4e4e7',
      '--color-ring': '#2563eb',
      ...surfaceProgression('#ffffff', true),
    }),
    dark: toRgbTheme({
      '--color-background': '#121212',
      '--color-foreground': 'rgba(255, 255, 255, 0.87)',
      '--color-card': '#1e1e1e',
      '--color-card-foreground': 'rgba(255, 255, 255, 0.87)',
      '--color-popover': '#1e1e1e',
      '--color-popover-foreground': 'rgba(255, 255, 255, 0.87)',
      '--color-primary': '#2196f3',
      '--color-primary-foreground': '#ffffff',
      '--color-secondary': '#333333',
      '--color-secondary-foreground': '#ffffff',
      '--color-muted': '#2a2a2a',
      '--color-muted-foreground': 'rgba(255, 255, 255, 0.6)',
      '--color-accent': '#333333',
      '--color-accent-foreground': '#ffffff',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#ffffff',
      '--color-border': '#333333',
      '--color-input': '#333333',
      '--color-ring': '#2196f3',
      ...surfaceProgression('#1e1e1e', false),
    }),
  },
  {
    id: 'lavender',
    label: 'Lavender',
    swatch: '#7c3aed',
    light: toRgbTheme({
      '--color-background': '#f9f5ff',
      '--color-foreground': '#1a0d2e',
      '--color-card': '#ffffff',
      '--color-card-foreground': '#1a0d2e',
      '--color-popover': '#ffffff',
      '--color-popover-foreground': '#1a0d2e',
      '--color-primary': '#7c3aed',
      '--color-primary-foreground': '#ffffff',
      '--color-secondary': '#ede9fe',
      '--color-secondary-foreground': '#1a0d2e',
      '--color-muted': '#ede9fe',
      '--color-muted-foreground': '#6b5b8a',
      '--color-accent': '#ddd6fe',
      '--color-accent-foreground': '#4c1d95',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#ffffff',
      '--color-border': '#ddd6fe',
      '--color-input': '#ddd6fe',
      '--color-ring': '#7c3aed',
      ...surfaceProgression('#ffffff', true),
    }),
    dark: toRgbTheme({
      '--color-background': '#0f0720',
      '--color-foreground': '#f5f3ff',
      '--color-card': '#1a0f2e',
      '--color-card-foreground': '#f5f3ff',
      '--color-popover': '#1a0f2e',
      '--color-popover-foreground': '#f5f3ff',
      '--color-primary': '#8b5cf6',
      '--color-primary-foreground': '#0f0720',
      '--color-secondary': '#2e1a4a',
      '--color-secondary-foreground': '#f5f3ff',
      '--color-muted': '#2e1a4a',
      '--color-muted-foreground': '#a78bfa',
      '--color-accent': '#3b1f6e',
      '--color-accent-foreground': '#ddd6fe',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#f5f3ff',
      '--color-border': '#2e1a4a',
      '--color-input': '#2e1a4a',
      '--color-ring': '#8b5cf6',
      ...surfaceProgression('#1a0f2e', false),
    }),
  },
  {
    id: 'glacier',
    label: 'Glacier',
    swatch: '#06b6d4',
    light: toRgbTheme({
      '--color-background': '#f0f9ff',
      '--color-foreground': '#0c1929',
      '--color-card': '#ffffff',
      '--color-card-foreground': '#0c1929',
      '--color-popover': '#ffffff',
      '--color-popover-foreground': '#0c1929',
      '--color-primary': '#06b6d4',
      '--color-primary-foreground': '#ffffff',
      '--color-secondary': '#e0f2fe',
      '--color-secondary-foreground': '#0c1929',
      '--color-muted': '#e0f2fe',
      '--color-muted-foreground': '#64748b',
      '--color-accent': '#cffafe',
      '--color-accent-foreground': '#155e75',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#ffffff',
      '--color-border': '#bae6fd',
      '--color-input': '#bae6fd',
      '--color-ring': '#06b6d4',
      ...surfaceProgression('#ffffff', true),
    }),
    dark: toRgbTheme({
      '--color-background': '#0a1628',
      '--color-foreground': '#f0f9ff',
      '--color-card': '#0f2137',
      '--color-card-foreground': '#f0f9ff',
      '--color-popover': '#0f2137',
      '--color-popover-foreground': '#f0f9ff',
      '--color-primary': '#06b6d4',
      '--color-primary-foreground': '#0a1628',
      '--color-secondary': '#1e3a5f',
      '--color-secondary-foreground': '#f0f9ff',
      '--color-muted': '#1e3a5f',
      '--color-muted-foreground': '#7dd3fc',
      '--color-accent': '#164e63',
      '--color-accent-foreground': '#cffafe',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#f0f9ff',
      '--color-border': '#1e3a5f',
      '--color-input': '#1e3a5f',
      '--color-ring': '#06b6d4',
      ...surfaceProgression('#0f2137', false),
    }),
  },
  {
    id: 'harvest',
    label: 'Harvest',
    swatch: '#f97316',
    light: toRgbTheme({
      '--color-background': '#fffbf5',
      '--color-foreground': '#1c1210',
      '--color-card': '#ffffff',
      '--color-card-foreground': '#1c1210',
      '--color-popover': '#ffffff',
      '--color-popover-foreground': '#1c1210',
      '--color-primary': '#f97316',
      '--color-primary-foreground': '#ffffff',
      '--color-secondary': '#fff7ed',
      '--color-secondary-foreground': '#1c1210',
      '--color-muted': '#fff7ed',
      '--color-muted-foreground': '#78716c',
      '--color-accent': '#fed7aa',
      '--color-accent-foreground': '#7c2d12',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#ffffff',
      '--color-border': '#fed7aa',
      '--color-input': '#fed7aa',
      '--color-ring': '#f97316',
      ...surfaceProgression('#ffffff', true),
    }),
    dark: toRgbTheme({
      '--color-background': '#120e0a',
      '--color-foreground': '#fffbf5',
      '--color-card': '#1c1612',
      '--color-card-foreground': '#fffbf5',
      '--color-popover': '#1c1612',
      '--color-popover-foreground': '#fffbf5',
      '--color-primary': '#f97316',
      '--color-primary-foreground': '#120e0a',
      '--color-secondary': '#2e2118',
      '--color-secondary-foreground': '#fffbf5',
      '--color-muted': '#2e2118',
      '--color-muted-foreground': '#fdba74',
      '--color-accent': '#431407',
      '--color-accent-foreground': '#fed7aa',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#fffbf5',
      '--color-border': '#2e2118',
      '--color-input': '#2e2118',
      '--color-ring': '#f97316',
      ...surfaceProgression('#1c1612', false),
    }),
  },
  {
    id: 'orchid',
    label: 'Orchid',
    swatch: '#ec4899',
    light: toRgbTheme({
      '--color-background': '#fdf2f8',
      '--color-foreground': '#1a0b14',
      '--color-card': '#ffffff',
      '--color-card-foreground': '#1a0b14',
      '--color-popover': '#ffffff',
      '--color-popover-foreground': '#1a0b14',
      '--color-primary': '#ec4899',
      '--color-primary-foreground': '#ffffff',
      '--color-secondary': '#fce7f3',
      '--color-secondary-foreground': '#1a0b14',
      '--color-muted': '#fce7f3',
      '--color-muted-foreground': '#7a5568',
      '--color-accent': '#fbcfe8',
      '--color-accent-foreground': '#831843',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#ffffff',
      '--color-border': '#fbcfe8',
      '--color-input': '#fbcfe8',
      '--color-ring': '#ec4899',
      ...surfaceProgression('#ffffff', true),
    }),
    dark: toRgbTheme({
      '--color-background': '#110613',
      '--color-foreground': '#fdf2f8',
      '--color-card': '#1f0c1e',
      '--color-card-foreground': '#fdf2f8',
      '--color-popover': '#1f0c1e',
      '--color-popover-foreground': '#fdf2f8',
      '--color-primary': '#ec4899',
      '--color-primary-foreground': '#110613',
      '--color-secondary': '#3b1532',
      '--color-secondary-foreground': '#fdf2f8',
      '--color-muted': '#3b1532',
      '--color-muted-foreground': '#f9a8d4',
      '--color-accent': '#500724',
      '--color-accent-foreground': '#fbcfe8',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#fdf2f8',
      '--color-border': '#3b1532',
      '--color-input': '#3b1532',
      '--color-ring': '#ec4899',
      ...surfaceProgression('#1f0c1e', false),
    }),
  },
  {
    id: 'solar',
    label: 'Solar',
    swatch: '#eab308',
    light: toRgbTheme({
      '--color-background': '#fefce8',
      '--color-foreground': '#1c1210',
      '--color-card': '#ffffff',
      '--color-card-foreground': '#1c1210',
      '--color-popover': '#ffffff',
      '--color-popover-foreground': '#1c1210',
      '--color-primary': '#eab308',
      '--color-primary-foreground': '#1c1210',
      '--color-secondary': '#fef9c3',
      '--color-secondary-foreground': '#1c1210',
      '--color-muted': '#fef9c3',
      '--color-muted-foreground': '#78716c',
      '--color-accent': '#fde68a',
      '--color-accent-foreground': '#713f12',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#ffffff',
      '--color-border': '#fde68a',
      '--color-input': '#fde68a',
      '--color-ring': '#eab308',
      ...surfaceProgression('#ffffff', true),
    }),
    dark: toRgbTheme({
      '--color-background': '#120e0a',
      '--color-foreground': '#fefce8',
      '--color-card': '#1c1612',
      '--color-card-foreground': '#fefce8',
      '--color-popover': '#1c1612',
      '--color-popover-foreground': '#fefce8',
      '--color-primary': '#eab308',
      '--color-primary-foreground': '#120e0a',
      '--color-secondary': '#2e2518',
      '--color-secondary-foreground': '#fefce8',
      '--color-muted': '#2e2518',
      '--color-muted-foreground': '#fde68a',
      '--color-accent': '#422006',
      '--color-accent-foreground': '#fef9c3',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#fefce8',
      '--color-border': '#2e2518',
      '--color-input': '#2e2518',
      '--color-ring': '#eab308',
      ...surfaceProgression('#1c1612', false),
    }),
  },
  {
    id: 'tide',
    label: 'Tide',
    swatch: '#14b8a6',
    light: toRgbTheme({
      '--color-background': '#f0fdfa',
      '--color-foreground': '#0a1a18',
      '--color-card': '#ffffff',
      '--color-card-foreground': '#0a1a18',
      '--color-popover': '#ffffff',
      '--color-popover-foreground': '#0a1a18',
      '--color-primary': '#14b8a6',
      '--color-primary-foreground': '#ffffff',
      '--color-secondary': '#ccfbf1',
      '--color-secondary-foreground': '#0a1a18',
      '--color-muted': '#ccfbf1',
      '--color-muted-foreground': '#5a7a74',
      '--color-accent': '#99f6e4',
      '--color-accent-foreground': '#115e59',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#ffffff',
      '--color-border': '#99f6e4',
      '--color-input': '#99f6e4',
      '--color-ring': '#14b8a6',
      ...surfaceProgression('#ffffff', true),
    }),
    dark: toRgbTheme({
      '--color-background': '#071210',
      '--color-foreground': '#f0fdfa',
      '--color-card': '#0d1f1c',
      '--color-card-foreground': '#f0fdfa',
      '--color-popover': '#0d1f1c',
      '--color-popover-foreground': '#f0fdfa',
      '--color-primary': '#14b8a6',
      '--color-primary-foreground': '#071210',
      '--color-secondary': '#1a3833',
      '--color-secondary-foreground': '#f0fdfa',
      '--color-muted': '#1a3833',
      '--color-muted-foreground': '#5eead4',
      '--color-accent': '#134e4a',
      '--color-accent-foreground': '#99f6e4',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#f0fdfa',
      '--color-border': '#1a3833',
      '--color-input': '#1a3833',
      '--color-ring': '#14b8a6',
      ...surfaceProgression('#0d1f1c', false),
    }),
  },
  {
    id: 'verdant',
    label: 'Verdant',
    swatch: '#22c55e',
    light: toRgbTheme({
      '--color-background': '#f0fdf4',
      '--color-foreground': '#0a1a10',
      '--color-card': '#ffffff',
      '--color-card-foreground': '#0a1a10',
      '--color-popover': '#ffffff',
      '--color-popover-foreground': '#0a1a10',
      '--color-primary': '#22c55e',
      '--color-primary-foreground': '#ffffff',
      '--color-secondary': '#dcfce7',
      '--color-secondary-foreground': '#0a1a10',
      '--color-muted': '#dcfce7',
      '--color-muted-foreground': '#5a7a64',
      '--color-accent': '#bbf7d0',
      '--color-accent-foreground': '#14532d',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#ffffff',
      '--color-border': '#bbf7d0',
      '--color-input': '#bbf7d0',
      '--color-ring': '#22c55e',
      ...surfaceProgression('#ffffff', true),
    }),
    dark: toRgbTheme({
      '--color-background': '#071208',
      '--color-foreground': '#f0fdf4',
      '--color-card': '#0d1f12',
      '--color-card-foreground': '#f0fdf4',
      '--color-popover': '#0d1f12',
      '--color-popover-foreground': '#f0fdf4',
      '--color-primary': '#22c55e',
      '--color-primary-foreground': '#071208',
      '--color-secondary': '#1a3822',
      '--color-secondary-foreground': '#f0fdf4',
      '--color-muted': '#1a3822',
      '--color-muted-foreground': '#86efac',
      '--color-accent': '#14532d',
      '--color-accent-foreground': '#bbf7d0',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#f0fdf4',
      '--color-border': '#1a3822',
      '--color-input': '#1a3822',
      '--color-ring': '#22c55e',
      ...surfaceProgression('#0d1f12', false),
    }),
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    swatch: '#64748b',
    light: toRgbTheme({
      '--color-background': '#f1f5f9',
      '--color-foreground': '#0f172a',
      '--color-card': '#ffffff',
      '--color-card-foreground': '#0f172a',
      '--color-popover': '#ffffff',
      '--color-popover-foreground': '#0f172a',
      '--color-primary': '#475569',
      '--color-primary-foreground': '#ffffff',
      '--color-secondary': '#e2e8f0',
      '--color-secondary-foreground': '#0f172a',
      '--color-muted': '#e2e8f0',
      '--color-muted-foreground': '#64748b',
      '--color-accent': '#cbd5e1',
      '--color-accent-foreground': '#1e293b',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#ffffff',
      '--color-border': '#cbd5e1',
      '--color-input': '#cbd5e1',
      '--color-ring': '#475569',
      ...surfaceProgression('#ffffff', true),
    }),
    dark: toRgbTheme({
      '--color-background': '#0a0a0f',
      '--color-foreground': '#f1f5f9',
      '--color-card': '#141420',
      '--color-card-foreground': '#f1f5f9',
      '--color-popover': '#141420',
      '--color-popover-foreground': '#f1f5f9',
      '--color-primary': '#94a3b8',
      '--color-primary-foreground': '#0a0a0f',
      '--color-secondary': '#1e1e2e',
      '--color-secondary-foreground': '#f1f5f9',
      '--color-muted': '#1e1e2e',
      '--color-muted-foreground': '#94a3b8',
      '--color-accent': '#2d2d44',
      '--color-accent-foreground': '#e2e8f0',
      '--color-destructive': '#dc2626',
      '--color-destructive-foreground': '#f1f5f9',
      '--color-border': '#1e1e2e',
      '--color-input': '#1e1e2e',
      '--color-ring': '#94a3b8',
      ...surfaceProgression('#141420', false),
    }),
  },
]

export type CanvasColorScheme = 'light' | 'dark' | 'system'
