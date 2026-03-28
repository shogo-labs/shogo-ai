// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasThemeContext
 *
 * Manages canvas-local theming state (color scheme + per-surface color theme).
 * Each canvas surface gets its own color theme preset, randomly assigned on
 * first encounter. The color scheme (light/dark/system) is shared globally.
 *
 * Provides a themed container that wraps canvas content with scoped
 * CSS variable overrides so the canvas can be themed independently
 * from the rest of the app.
 */

import { createContext, useContext, useState, useMemo, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { View, Platform } from 'react-native'
import { useColorScheme, vars as nwVars } from 'nativewind'
import { useTheme } from '../../contexts/theme'
import { CANVAS_THEMES, type CanvasColorScheme, type CanvasThemePreset } from './canvas-themes'

interface CanvasThemeSettings {
  canvasColorScheme?: CanvasColorScheme
  canvasThemeId?: string
  canvasSurfaceThemes?: Record<string, string>
}


interface CanvasThemeState {
  colorScheme: CanvasColorScheme
  themeId: string
  setColorScheme: (scheme: CanvasColorScheme) => void
  setThemeId: (id: string) => void
  resolvedIsDark: boolean
  activePreset: CanvasThemePreset
  surfaceThemes: Record<string, string>
  getSwatchForSurface: (surfaceId: string) => string
}

const CanvasThemeCtx = createContext<CanvasThemeState | null>(null)

export function useCanvasTheme() {
  const ctx = useContext(CanvasThemeCtx)
  if (!ctx) throw new Error('useCanvasTheme must be used within CanvasThemeProvider')
  return ctx
}

export function useCanvasThemeOptional() {
  return useContext(CanvasThemeCtx)
}

function pickRandomTheme(usedThemeIds: string[]): string {
  const available = CANVAS_THEMES.filter((t) => !usedThemeIds.includes(t.id))
  if (available.length === 0) {
    return CANVAS_THEMES[Math.floor(Math.random() * CANVAS_THEMES.length)].id
  }
  return available[Math.floor(Math.random() * available.length)].id
}

interface CanvasThemeProviderProps {
  children: ReactNode
  projectSettings?: Record<string, unknown> | null
  onUpdateSettings?: (settings: Record<string, unknown>) => void
  defaultThemeId?: string
  defaultColorScheme?: CanvasColorScheme
  activeSurfaceId?: string | null
  surfaceIds?: string[]
}

export function CanvasThemeProvider({
  children,
  projectSettings,
  onUpdateSettings,
  defaultThemeId = 'default',
  defaultColorScheme = 'system',
  activeSurfaceId,
  surfaceIds,
}: CanvasThemeProviderProps) {
  const [colorScheme, setColorSchemeRaw] = useState<CanvasColorScheme>(defaultColorScheme)
  const [surfaceThemes, setSurfaceThemesRaw] = useState<Record<string, string>>({})
  const hydratedRef = useRef(false)

  // Hydrate from project settings once
  useEffect(() => {
    if (hydratedRef.current) return
    const s = projectSettings as CanvasThemeSettings | null | undefined
    if (!s) return
    hydratedRef.current = true
    if (s.canvasColorScheme) setColorSchemeRaw(s.canvasColorScheme)
    if (s.canvasSurfaceThemes && typeof s.canvasSurfaceThemes === 'object') {
      setSurfaceThemesRaw(s.canvasSurfaceThemes)
    } else if (s.canvasThemeId) {
      // Backward compat: migrate global themeId — no surfaces to assign yet,
      // but keep the old themeId as a fallback that gets assigned to the first surface.
      setSurfaceThemesRaw({ __legacyDefault: s.canvasThemeId })
    }
  }, [projectSettings])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<{ cs: CanvasColorScheme; themes: Record<string, string> } | null>(null)
  const flushingRef = useRef(false)
  const latestRef = useRef({ colorScheme, surfaceThemes })
  latestRef.current = { colorScheme, surfaceThemes }

  const flushPersist = useCallback(async () => {
    if (!onUpdateSettings || flushingRef.current) return
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    flushingRef.current = true
    try {
      await onUpdateSettings({ canvasColorScheme: pending.cs, canvasSurfaceThemes: pending.themes })
    } catch {
      // Silently ignore concurrent-update errors from domain stores
    } finally {
      flushingRef.current = false
      if (pendingRef.current) flushPersist()
    }
  }, [onUpdateSettings])

  const persistToDb = useCallback((cs: CanvasColorScheme, themes: Record<string, string>) => {
    if (!onUpdateSettings) return
    pendingRef.current = { cs, themes }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(flushPersist, 500)
  }, [onUpdateSettings, flushPersist])

  const setColorScheme = useCallback((scheme: CanvasColorScheme) => {
    setColorSchemeRaw(scheme)
    persistToDb(scheme, latestRef.current.surfaceThemes)
  }, [persistToDb])

  // Auto-assign random themes to surfaces that don't have one yet
  useEffect(() => {
    if (!surfaceIds || surfaceIds.length === 0) return
    setSurfaceThemesRaw((prev) => {
      const usedIds = Object.values(prev).filter((v) => v !== '__legacyDefault')
      let changed = false
      const next = { ...prev }

      // Consume legacy default: assign it to the first surface that needs a theme
      const legacyDefault = next.__legacyDefault
      if (legacyDefault) {
        delete next.__legacyDefault
        changed = true
      }

      let legacyUsed = false
      for (const sid of surfaceIds) {
        if (!next[sid]) {
          if (legacyDefault && !legacyUsed) {
            next[sid] = legacyDefault
            legacyUsed = true
          } else {
            const allUsed = [...usedIds, ...Object.values(next)]
            next[sid] = pickRandomTheme(allUsed)
          }
          changed = true
        }
      }
      if (!changed) return prev
      // Persist the new assignments
      persistToDb(latestRef.current.colorScheme, next)
      return next
    })
  }, [surfaceIds, persistToDb])

  // Set theme for the currently active surface (or global fallback for code-mode)
  const setThemeId = useCallback((id: string) => {
    const key = activeSurfaceId || '__global'
    setSurfaceThemesRaw((prev) => {
      const next = { ...prev, [key]: id }
      persistToDb(latestRef.current.colorScheme, next)
      return next
    })
  }, [activeSurfaceId, persistToDb])

  // Derive themeId for the active surface (with global fallback for code-mode)
  const themeId = (activeSurfaceId && surfaceThemes[activeSurfaceId])
    || surfaceThemes.__global
    || defaultThemeId

  const { colorScheme: systemScheme } = useColorScheme()
  const { theme: appTheme } = useTheme()

  const resolvedIsDark = useMemo(() => {
    if (colorScheme === 'system') {
      return appTheme === 'system'
        ? systemScheme === 'dark'
        : appTheme === 'dark'
    }
    return colorScheme === 'dark'
  }, [colorScheme, appTheme, systemScheme])

  const activePreset = useMemo(
    () => CANVAS_THEMES.find((t) => t.id === themeId) ?? CANVAS_THEMES[0],
    [themeId],
  )

  const getSwatchForSurface = useCallback((surfaceId: string): string => {
    const tid = surfaceThemes[surfaceId]
    const preset = tid ? CANVAS_THEMES.find((t) => t.id === tid) : undefined
    return preset?.swatch ?? CANVAS_THEMES[0].swatch
  }, [surfaceThemes])

  const value = useMemo<CanvasThemeState>(
    () => ({
      colorScheme,
      themeId,
      setColorScheme,
      setThemeId,
      resolvedIsDark,
      activePreset,
      surfaceThemes,
      getSwatchForSurface,
    }),
    [colorScheme, themeId, resolvedIsDark, activePreset, surfaceThemes, getSwatchForSurface],
  )

  return (
    <CanvasThemeCtx.Provider value={value}>
      {children}
    </CanvasThemeCtx.Provider>
  )
}

/**
 * Gluestack uses NativeWind's vars() to set RGB-triplet CSS custom properties
 * (e.g. --color-typography-700: "82 82 82") for its color scales. These are
 * separate from the semantic --color-foreground variables. When the canvas
 * color scheme differs from the app's, we need to override both sets.
 *
 * Values sourced from apps/mobile/components/ui/gluestack-ui-provider/config.ts
 */
const GLUESTACK_LIGHT: Record<string, string> = {
  '--color-typography-0': '254 254 255',
  '--color-typography-50': '245 245 245',
  '--color-typography-100': '229 229 229',
  '--color-typography-200': '219 219 220',
  '--color-typography-300': '212 212 212',
  '--color-typography-400': '163 163 163',
  '--color-typography-500': '140 140 140',
  '--color-typography-600': '115 115 115',
  '--color-typography-700': '82 82 82',
  '--color-typography-800': '64 64 64',
  '--color-typography-900': '38 38 39',
  '--color-typography-950': '23 23 23',
  '--color-outline-0': '253 254 254',
  '--color-outline-50': '243 243 243',
  '--color-outline-100': '230 230 230',
  '--color-outline-200': '221 220 219',
  '--color-outline-300': '211 211 211',
  '--color-outline-400': '165 163 163',
  '--color-outline-500': '140 141 141',
  '--color-outline-600': '115 116 116',
  '--color-outline-700': '83 82 82',
  '--color-outline-800': '65 65 65',
  '--color-outline-900': '39 38 36',
  '--color-outline-950': '26 23 23',
  '--color-background-0': '255 255 255',
  '--color-background-50': '246 246 246',
  '--color-background-100': '242 241 241',
  '--color-background-200': '220 219 219',
  '--color-background-300': '213 212 212',
  '--color-background-400': '162 163 163',
  '--color-background-500': '142 142 142',
  '--color-background-600': '116 116 116',
  '--color-background-700': '83 82 82',
  '--color-background-800': '65 64 64',
  '--color-background-900': '39 38 37',
  '--color-background-950': '18 18 18',
  '--color-background-error': '254 241 241',
  '--color-background-warning': '255 243 234',
  '--color-background-success': '237 252 242',
  '--color-background-muted': '247 248 247',
  '--color-background-info': '235 248 254',
}

const GLUESTACK_DARK: Record<string, string> = {
  '--color-typography-0': '23 23 23',
  '--color-typography-50': '38 38 39',
  '--color-typography-100': '64 64 64',
  '--color-typography-200': '82 82 82',
  '--color-typography-300': '115 115 115',
  '--color-typography-400': '140 140 140',
  '--color-typography-500': '163 163 163',
  '--color-typography-600': '212 212 212',
  '--color-typography-700': '219 219 220',
  '--color-typography-800': '229 229 229',
  '--color-typography-900': '245 245 245',
  '--color-typography-950': '254 254 255',
  '--color-outline-0': '26 23 23',
  '--color-outline-50': '39 38 36',
  '--color-outline-100': '65 65 65',
  '--color-outline-200': '83 82 82',
  '--color-outline-300': '115 116 116',
  '--color-outline-400': '140 141 141',
  '--color-outline-500': '165 163 163',
  '--color-outline-600': '211 211 211',
  '--color-outline-700': '221 220 219',
  '--color-outline-800': '230 230 230',
  '--color-outline-900': '243 243 243',
  '--color-outline-950': '253 254 254',
  '--color-background-0': '18 18 18',
  '--color-background-50': '39 38 37',
  '--color-background-100': '65 64 64',
  '--color-background-200': '83 82 82',
  '--color-background-300': '116 116 116',
  '--color-background-400': '142 142 142',
  '--color-background-500': '162 163 163',
  '--color-background-600': '213 212 212',
  '--color-background-700': '229 228 228',
  '--color-background-800': '242 241 241',
  '--color-background-900': '246 246 246',
  '--color-background-950': '255 255 255',
  '--color-background-error': '66 43 43',
  '--color-background-warning': '65 47 35',
  '--color-background-success': '28 43 33',
  '--color-background-muted': '51 51 51',
  '--color-background-info': '26 40 46',
}

/**
 * Themed container that applies scoped CSS variables to its children.
 * Wraps canvas content in a rounded-corner container with theme overrides.
 *
 * On web, uses a raw <div> element so CSS custom properties are applied
 * directly via the style attribute (React Native Web's View strips
 * unknown properties like --color-*).
 */
export function CanvasThemedContainer({ children, noBorder }: { children: ReactNode; noBorder?: boolean }) {
  const { resolvedIsDark, activePreset } = useCanvasTheme()
  const themeVars = resolvedIsDark ? activePreset.dark : activePreset.light

  const allVars = useMemo(() => {
    const gluestackVars = resolvedIsDark ? GLUESTACK_DARK : GLUESTACK_LIGHT
    return { ...gluestackVars, ...themeVars } as Record<string, string>
  }, [resolvedIsDark, themeVars])

  if (Platform.OS === 'web') {
    return (
      <div
        style={{
          ...allVars,
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          overflow: 'hidden',
          ...(noBorder ? {} : {
            borderRadius: 16,
            border: '1px solid rgb(var(--color-border, 228 228 231))',
          }),
          backgroundColor: `rgb(${themeVars['--color-background']})`,
          color: `rgb(${themeVars['--color-foreground']})`,
        }}
      >
        {children}
      </div>
    )
  }

  // Native: scope canvas theme CSS variables to this container subtree
  // via NativeWind's vars(), mirroring the web <div style={cssVars}> approach.
  const nativeStyle = useMemo(() => {
    const scopedVars = nwVars(allVars)
    const [r, g, b] = themeVars['--color-background'].split(' ').map(Number)
    return [scopedVars, { backgroundColor: `rgb(${r}, ${g}, ${b})` }]
  }, [allVars, themeVars])

  return (
    <View
      className={noBorder ? 'flex-1 overflow-hidden' : 'flex-1 overflow-hidden rounded-2xl border border-border'}
      style={nativeStyle as any}
    >
      {children}
    </View>
  )
}
