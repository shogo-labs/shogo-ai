// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { Platform } from 'react-native'
import { safeGetItem, safeSetItem } from '../lib/safe-storage'

export interface AppearanceSettings {
  uiFontSize: number  // 11–24 px, default 14
  hue: number         // 0–360
}

const DEFAULTS: AppearanceSettings = {
  uiFontSize: 14,
  hue: 210,
}

const STORAGE_KEY = 'shogo-appearance-v1'

function load(): AppearanceSettings {
  try {
    const raw = safeGetItem(STORAGE_KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {}
  return DEFAULTS
}

function save(s: AppearanceSettings) {
  try { safeSetItem(STORAGE_KEY, JSON.stringify(s)) } catch {}
}

interface AppearanceCtx {
  settings: AppearanceSettings
  update: (partial: Partial<AppearanceSettings>) => void
  reset: () => void
}

const Ctx = createContext<AppearanceCtx>({
  settings: DEFAULTS,
  update: () => {},
  reset: () => {},
})

function applyToDOM(s: AppearanceSettings) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return
  const root = document.documentElement
  // Setting font-size on <html> scales all rem-based Tailwind classes automatically
  root.style.fontSize = `${s.uiFontSize}px`
  root.style.setProperty('--tint-hue', String(s.hue))
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppearanceSettings>(() => {
    if (Platform.OS === 'web') return load()
    return DEFAULTS
  })

  useEffect(() => {
    if (Platform.OS === 'web') {
      const stored = load()
      setSettings(stored)
      applyToDOM(stored)
    }
  }, [])

  useEffect(() => {
    save(settings)
    applyToDOM(settings)
  }, [settings])

  const update = useCallback((partial: Partial<AppearanceSettings>) => {
    setSettings(prev => ({ ...prev, ...partial }))
  }, [])

  const reset = useCallback(() => setSettings(DEFAULTS), [])

  return <Ctx.Provider value={{ settings, update, reset }}>{children}</Ctx.Provider>
}

export function useAppearance() {
  return useContext(Ctx)
}
