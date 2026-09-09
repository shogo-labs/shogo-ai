// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { Platform, useColorScheme } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { safeGetItem, safeSetItem, safeRemoveItem } from '../lib/safe-storage'
import { resolveThemeMode, type ThemePreference } from '../lib/resolve-theme-mode'

export type { ThemePreference }
export { resolveThemeMode }

interface ThemeContextValue {
  theme: ThemePreference
  setTheme: (t: ThemePreference) => void
  isLoaded: boolean
}

const STORAGE_KEY = 'theme-preference'

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  setTheme: () => {},
  isLoaded: false,
})

async function loadTheme(): Promise<ThemePreference> {
  try {
    if (Platform.OS === 'web') {
      const stored = safeGetItem(STORAGE_KEY)
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
      return 'system'
    }
    const stored = await SecureStore.getItemAsync(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
    return 'system'
  } catch {
    return 'system'
  }
}

async function saveTheme(value: ThemePreference): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (value === 'system') {
        safeRemoveItem(STORAGE_KEY)
      } else {
        safeSetItem(STORAGE_KEY, value)
      }
      return
    }
    await SecureStore.setItemAsync(STORAGE_KEY, value)
  } catch {
    // Silently fail - theme will just not persist
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>('system')
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    loadTheme().then((stored) => {
      setThemeState(stored)
      setIsLoaded(true)
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const resolved = stored === 'system'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : stored
        document.documentElement.classList.toggle('dark', resolved === 'dark')
      }
    })
  }, [])

  const setTheme = useCallback((t: ThemePreference) => {
    setThemeState(t)
    saveTheme(t)

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      if (t === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
        document.documentElement.classList.toggle('dark', prefersDark)
      } else {
        document.documentElement.classList.toggle('dark', t === 'dark')
      }
    }
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, setTheme, isLoaded }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}

/**
 * Returns the currently resolved theme (`'light'` or `'dark'`).
 * On web this mirrors the `dark` class on <html>, which is the same source
 * of truth Tailwind's `dark:` variants read. On native it follows the app
 * theme preference (including `system` → OS scheme). Prefer this over
 * nativewind's `useColorScheme()` when the user has pinned light or dark.
 */
export function useResolvedTheme(): 'light' | 'dark' {
  const { theme } = useTheme()
  const systemColorScheme = useColorScheme()

  const getWebResolved = (): 'light' | 'dark' => {
    if (typeof document === 'undefined') return 'light'
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  }

  const [webResolved, setWebResolved] = useState<'light' | 'dark'>(getWebResolved)

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return
    const update = () => setWebResolved(getWebResolved())
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', update)
    }
  }, [])

  if (Platform.OS === 'web') return webResolved
  return resolveThemeMode(theme, systemColorScheme)
}
