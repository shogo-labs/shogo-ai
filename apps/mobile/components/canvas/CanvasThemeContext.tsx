// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasThemeContext
 *
 * Manages canvas-local theming state: the color scheme (light/dark/system)
 * and the active theme preset (a named palette of CSS custom properties).
 *
 * Provides a themed container that wraps canvas content with scoped CSS
 * variable overrides so the canvas can be themed independently from the
 * rest of the app.
 */

import { createContext, useContext, useState, useMemo, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { View, Platform } from 'react-native'
import { useColorScheme, vars as nwVars } from 'nativewind'
import { useTheme } from '../../contexts/theme'
import { CANVAS_THEMES, type CanvasColorScheme, type CanvasThemePreset } from './canvas-themes'

interface CanvasThemeSettings {
  canvasColorScheme?: CanvasColorScheme
  canvasThemeId?: string
  // Legacy v1 shape: { [surfaceId]: themeId } map. v2 has a single canvas
  // surface so we collapse this on read.
  canvasSurfaceThemes?: Record<string, string>
}


interface CanvasThemeState {
  colorScheme: CanvasColorScheme
  themeId: string
  setColorScheme: (scheme: CanvasColorScheme) => void
  setThemeId: (id: string) => void
  resolvedIsDark: boolean
  activePreset: CanvasThemePreset
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

interface CanvasThemeProviderProps {
  children: ReactNode
  projectSettings?: Record<string, unknown> | null
  onUpdateSettings?: (settings: Record<string, unknown>) => void
  defaultThemeId?: string
  defaultColorScheme?: CanvasColorScheme
}

export function CanvasThemeProvider({
  children,
  projectSettings,
  onUpdateSettings,
  defaultThemeId = 'default',
  defaultColorScheme = 'system',
}: CanvasThemeProviderProps) {
  const [colorScheme, setColorSchemeRaw] = useState<CanvasColorScheme>(defaultColorScheme)
  const [themeId, setThemeIdRaw] = useState<string>(defaultThemeId)
  const hydratedRef = useRef(false)

  // Hydrate from project settings once
  useEffect(() => {
    if (hydratedRef.current) return
    const s = projectSettings as CanvasThemeSettings | null | undefined
    if (!s) return
    hydratedRef.current = true
    if (s.canvasColorScheme) setColorSchemeRaw(s.canvasColorScheme)
    if (s.canvasThemeId) {
      setThemeIdRaw(s.canvasThemeId)
    } else if (s.canvasSurfaceThemes && typeof s.canvasSurfaceThemes === 'object') {
      // Legacy v1 settings carried a per-surface map. Collapse to the first
      // non-empty value so existing projects keep their chosen theme on
      // first read; the next setThemeId/setColorScheme write persists the
      // new flat shape.
      const firstValue = Object.values(s.canvasSurfaceThemes).find((v) => typeof v === 'string' && v.length > 0)
      if (firstValue) setThemeIdRaw(firstValue)
    }
  }, [projectSettings])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<{ cs: CanvasColorScheme; themeId: string } | null>(null)
  const flushingRef = useRef(false)
  const latestRef = useRef({ colorScheme, themeId })
  latestRef.current = { colorScheme, themeId }

  const flushPersist = useCallback(async () => {
    if (!onUpdateSettings || flushingRef.current) return
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    flushingRef.current = true
    try {
      await onUpdateSettings({ canvasColorScheme: pending.cs, canvasThemeId: pending.themeId })
    } catch {
      // Silently ignore concurrent-update errors from domain stores
    } finally {
      flushingRef.current = false
      if (pendingRef.current) flushPersist()
    }
  }, [onUpdateSettings])

  const persistToDb = useCallback((cs: CanvasColorScheme, tid: string) => {
    if (!onUpdateSettings) return
    pendingRef.current = { cs, themeId: tid }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(flushPersist, 500)
  }, [onUpdateSettings, flushPersist])

  const setColorScheme = useCallback((scheme: CanvasColorScheme) => {
    setColorSchemeRaw(scheme)
    persistToDb(scheme, latestRef.current.themeId)
  }, [persistToDb])

  const setThemeId = useCallback((id: string) => {
    setThemeIdRaw(id)
    persistToDb(latestRef.current.colorScheme, id)
  }, [persistToDb])

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

  const value = useMemo<CanvasThemeState>(
    () => ({
      colorScheme,
      themeId,
      setColorScheme,
      setThemeId,
      resolvedIsDark,
      activePreset,
    }),
    [colorScheme, themeId, setColorScheme, setThemeId, resolvedIsDark, activePreset],
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
