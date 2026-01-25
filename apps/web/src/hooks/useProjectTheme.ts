/**
 * useProjectTheme Hook
 * 
 * Manages theme selection state for projects.
 * Provides methods to get, set, and persist theme selections.
 * 
 * Usage:
 * - On homepage (before project creation): stores selection in localStorage
 * - In project context: would store in project metadata (future enhancement)
 */

import { useState, useCallback, useEffect } from 'react'
import type { ThemeConfig, ThemePreset, StoredThemeSelection } from '@/lib/themes/types'
import { THEME_PRESETS, getThemeById, getDefaultTheme } from '@/lib/themes/presets'
import { 
  saveThemeSelection, 
  loadThemeSelection,
  themeToCSS,
  themeToPromptContext,
} from '@/lib/themes/utils'

interface UseProjectThemeOptions {
  /** Project ID (optional - if not provided, uses localStorage) */
  projectId?: string | null
  /** Initial theme ID to use if nothing is stored */
  initialThemeId?: string
}

interface UseProjectThemeReturn {
  /** Currently selected theme configuration */
  currentTheme: ThemeConfig
  /** Currently selected theme ID */
  currentThemeId: string
  /** Whether using a custom (non-preset) theme */
  isCustomTheme: boolean
  /** All available theme presets */
  presets: ThemePreset[]
  /** Select a preset theme by ID */
  selectTheme: (themeId: string) => void
  /** Set a custom theme configuration */
  setCustomTheme: (config: ThemeConfig) => void
  /** Reset to default theme */
  resetToDefault: () => void
  /** Generate CSS for current theme (for index.css) */
  generateCSS: () => string
  /** Generate context string for AI prompt */
  generatePromptContext: () => string
}

/**
 * Hook for managing project theme selection
 */
export function useProjectTheme(options: UseProjectThemeOptions = {}): UseProjectThemeReturn {
  const { projectId, initialThemeId = 'default' } = options
  
  // State for current theme
  const [currentThemeId, setCurrentThemeId] = useState<string>(() => {
    // Try to load from storage
    const stored = loadThemeSelection()
    if (stored) {
      return stored.themeId
    }
    return initialThemeId
  })
  
  const [customTheme, setCustomThemeState] = useState<ThemeConfig | null>(() => {
    const stored = loadThemeSelection()
    return stored?.customConfig ?? null
  })
  
  // Derive current theme from state
  const isCustomTheme = currentThemeId === 'custom' && customTheme !== null
  
  const currentTheme: ThemeConfig = isCustomTheme
    ? customTheme!
    : (getThemeById(currentThemeId) ?? getDefaultTheme())
  
  // Persist selection when it changes
  useEffect(() => {
    const selection: StoredThemeSelection = {
      themeId: currentThemeId,
      customConfig: isCustomTheme ? customTheme! : undefined,
      updatedAt: new Date().toISOString(),
    }
    saveThemeSelection(selection)
  }, [currentThemeId, customTheme, isCustomTheme])
  
  // Select a preset theme
  const selectTheme = useCallback((themeId: string) => {
    const theme = getThemeById(themeId)
    if (theme) {
      setCurrentThemeId(themeId)
      setCustomThemeState(null)
    } else {
      console.warn(`Theme not found: ${themeId}`)
    }
  }, [])
  
  // Set a custom theme
  const setCustomTheme = useCallback((config: ThemeConfig) => {
    setCurrentThemeId('custom')
    setCustomThemeState(config)
  }, [])
  
  // Reset to default
  const resetToDefault = useCallback(() => {
    setCurrentThemeId('default')
    setCustomThemeState(null)
  }, [])
  
  // Generate CSS for the theme
  const generateCSS = useCallback(() => {
    return themeToCSS(currentTheme)
  }, [currentTheme])
  
  // Generate prompt context for AI
  const generatePromptContext = useCallback(() => {
    return themeToPromptContext(currentTheme)
  }, [currentTheme])
  
  return {
    currentTheme,
    currentThemeId,
    isCustomTheme,
    presets: THEME_PRESETS,
    selectTheme,
    setCustomTheme,
    resetToDefault,
    generateCSS,
    generatePromptContext,
  }
}

/**
 * Get theme prompt context without using the hook
 * (useful for server-side or non-React contexts)
 */
export function getThemePromptContext(themeId?: string): string {
  const theme = themeId ? getThemeById(themeId) : null
  return themeToPromptContext(theme ?? getDefaultTheme())
}

/**
 * Get theme CSS without using the hook
 */
export function getThemeCSS(themeId?: string): string {
  const theme = themeId ? getThemeById(themeId) : null
  return themeToCSS(theme ?? getDefaultTheme())
}
