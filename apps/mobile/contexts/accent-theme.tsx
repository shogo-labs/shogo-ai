// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { safeGetItem, safeSetItem, safeRemoveItem } from '../lib/safe-storage'
import { useResolvedTheme } from './theme'
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentTripletToRgb,
  type AccentThemeName,
} from '../lib/accent-themes'

interface AccentThemeContextValue {
  accent: AccentThemeName
  setAccent: (name: AccentThemeName) => void
}

const STORAGE_KEY = 'accent-theme'

const AccentThemeContext = createContext<AccentThemeContextValue>({
  accent: DEFAULT_ACCENT,
  setAccent: () => {},
})

function isValidAccent(v: string | null | undefined): v is AccentThemeName {
  return typeof v === 'string' && v in ACCENT_PRESETS
}

async function loadAccent(): Promise<AccentThemeName> {
  try {
    if (Platform.OS === 'web') {
      const stored = safeGetItem(STORAGE_KEY)
      return isValidAccent(stored) ? stored : DEFAULT_ACCENT
    }
    const stored = await SecureStore.getItemAsync(STORAGE_KEY)
    return isValidAccent(stored) ? stored : DEFAULT_ACCENT
  } catch {
    return DEFAULT_ACCENT
  }
}

async function saveAccent(value: AccentThemeName): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (value === DEFAULT_ACCENT) {
        safeRemoveItem(STORAGE_KEY)
      } else {
        safeSetItem(STORAGE_KEY, value)
      }
      return
    }
    await SecureStore.setItemAsync(STORAGE_KEY, value)
  } catch {
    // persist failure is non-critical
  }
}

function applyAccentToWeb(name: AccentThemeName) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return
  const preset = ACCENT_PRESETS[name]
  const root = document.documentElement

  root.style.setProperty('--color-primary', preset.light.primary)
  root.style.setProperty('--color-primary-foreground', preset.light.primaryForeground)
  root.style.setProperty('--color-ring', preset.light.ring)

  let darkSheet = document.getElementById('accent-dark-overrides') as HTMLStyleElement | null
  if (!darkSheet) {
    darkSheet = document.createElement('style')
    darkSheet.id = 'accent-dark-overrides'
    document.head.appendChild(darkSheet)
  }
  darkSheet.textContent = `.dark {
  --color-primary: ${preset.dark.primary};
  --color-primary-foreground: ${preset.dark.primaryForeground};
  --color-ring: ${preset.dark.ring};
}`
}

export function AccentThemeProvider({ children }: { children: ReactNode }) {
  const [accent, setAccentState] = useState<AccentThemeName>(DEFAULT_ACCENT)

  useEffect(() => {
    loadAccent().then((stored) => {
      setAccentState(stored)
      applyAccentToWeb(stored)
    })
  }, [])

  const setAccent = useCallback((name: AccentThemeName) => {
    setAccentState(name)
    saveAccent(name)
    applyAccentToWeb(name)
  }, [])

  return (
    <AccentThemeContext.Provider value={{ accent, setAccent }}>
      {children}
    </AccentThemeContext.Provider>
  )
}

export function useAccentTheme() {
  return useContext(AccentThemeContext)
}

/**
 * Returns NativeWind-compatible `vars()` overrides for the current accent.
 * Used by GluestackUIProvider to keep native in sync.
 */
export function getAccentVars(name: AccentThemeName, mode: 'light' | 'dark') {
  const preset = ACCENT_PRESETS[name]
  const values = mode === 'dark' ? preset.dark : preset.light
  return {
    '--color-primary': values.primary,
    '--color-primary-foreground': values.primaryForeground,
    '--color-ring': values.ring,
  }
}

/**
 * The live accent as concrete `rgb()` strings, for props and RN styles that
 * cannot take a `className` (WebView chrome, `selectionColor`, canvas bars).
 * Anything that can take a class should use `bg-primary` / `text-primary`
 * instead — those follow the CSS vars without a re-render.
 */
export function useAccentColors(): {
  primary: string
  primaryForeground: string
  ring: string
} {
  const { accent } = useAccentTheme()
  const mode = useResolvedTheme()
  const values = mode === 'dark' ? ACCENT_PRESETS[accent].dark : ACCENT_PRESETS[accent].light
  return {
    primary: accentTripletToRgb(values.primary),
    primaryForeground: accentTripletToRgb(values.primaryForeground),
    ring: accentTripletToRgb(values.ring),
  }
}
