// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { safeGetItem, safeSetItem, safeRemoveItem } from '../lib/safe-storage'

export type ThemePreference = 'light' | 'dark' | 'system'

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
 * Returns the currently resolved theme (`'light'` or `'dark'`) as applied
 * to the DOM. On web this mirrors the `dark` class on <html>, which is the
 * same source of truth Tailwind's `dark:` variants read. Kept in sync with
 * MutationObserver + media-query listener so callers re-render when the
 * user toggles the theme or the OS preference flips under `system` mode.
 *
 * Prefer this over nativewind's `useColorScheme()` when you need to pick
 * assets (e.g. Shiki theme) that must match the actual rendered theme —
 * `useColorScheme()` returns the OS preference, which can disagree with
 * the app's chosen theme.
 */
export function useResolvedTheme(): 'light' | 'dark' {
  const getResolved = (): 'light' | 'dark' => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      // Native: fall back to OS preference via matchMedia-equivalent (not
      // reliable off-web). Callers on native typically don't need Shiki.
      return 'light'
    }
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  }

  const [resolved, setResolved] = useState<'light' | 'dark'>(getResolved)

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return
    const update = () => setResolved(getResolved())
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

  return resolved
}
