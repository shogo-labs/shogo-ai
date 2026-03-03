/**
 * CanvasThemeContext
 *
 * Manages canvas-local theming state (color scheme + color theme preset).
 * Provides a themed container that wraps canvas content with scoped
 * CSS variable overrides so the canvas can be themed independently
 * from the rest of the app.
 */

import { createContext, useContext, useState, useMemo, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { View, Platform } from 'react-native'
import { useColorScheme } from 'nativewind'
import { useTheme } from '../../contexts/theme'
import { CANVAS_THEMES, type CanvasColorScheme, type CanvasThemePreset } from './canvas-themes'

interface CanvasThemeSettings {
  canvasColorScheme?: CanvasColorScheme
  canvasThemeId?: string
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
  const [themeId, setThemeIdRaw] = useState(defaultThemeId)
  const hydratedRef = useRef(false)

  useEffect(() => {
    if (hydratedRef.current) return
    const s = projectSettings as CanvasThemeSettings | null | undefined
    if (!s) return
    hydratedRef.current = true
    if (s.canvasColorScheme) setColorSchemeRaw(s.canvasColorScheme)
    if (s.canvasThemeId) setThemeIdRaw(s.canvasThemeId)
  }, [projectSettings])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef({ colorScheme, themeId })
  latestRef.current = { colorScheme, themeId }

  const persistToDb = useCallback((cs: CanvasColorScheme, tid: string) => {
    if (!onUpdateSettings) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      onUpdateSettings({ canvasColorScheme: cs, canvasThemeId: tid })
    }, 500)
  }, [onUpdateSettings])

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
    [colorScheme, themeId, resolvedIsDark, activePreset],
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
export function CanvasThemedContainer({ children }: { children: ReactNode }) {
  const { resolvedIsDark, activePreset } = useCanvasTheme()
  const vars = resolvedIsDark ? activePreset.dark : activePreset.light

  const allVars = useMemo(() => {
    if (Platform.OS !== 'web') return {}
    const gluestackVars = resolvedIsDark ? GLUESTACK_DARK : GLUESTACK_LIGHT
    return { ...gluestackVars, ...vars } as Record<string, string>
  }, [resolvedIsDark, vars])

  if (Platform.OS === 'web') {
    return (
      <div
        style={{
          ...allVars,
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 16,
          border: '1px solid rgb(var(--color-border, 228 228 231))',
          backgroundColor: `rgb(${vars['--color-background']})`,
        }}
      >
        {children}
      </div>
    )
  }

  return (
    <View className="flex-1 overflow-hidden rounded-2xl border border-border">
      {children}
    </View>
  )
}
