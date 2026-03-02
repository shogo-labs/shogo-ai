import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'

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
      const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
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
      if (typeof localStorage !== 'undefined') {
        if (value === 'system') {
          localStorage.removeItem(STORAGE_KEY)
        } else {
          localStorage.setItem(STORAGE_KEY, value)
        }
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
