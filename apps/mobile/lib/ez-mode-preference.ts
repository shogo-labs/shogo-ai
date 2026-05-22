// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * EZ Mode preferences — persisted per-device so a page refresh
 * preserves the user's last view:
 *
 *   - `ezModeActive`     — was the EZ Mode overlay on?
 *   - `ezModeInputMode`  — was the overlay in 'voice' or 'text' mode?
 *
 * Implemented as tiny singleton caches + listener sets so every
 * surface that reads or toggles the values stays in sync without
 * prop drilling, mirroring `dual-plan-preference.ts`.
 *
 * Persistence:
 *   - native: SecureStore
 *   - web:    safe-storage (localStorage with in-memory fallback)
 *
 * Defaults: overlay off, voice mode. The provider/component layer
 * can supply a one-shot URL-driven seed (e.g. `?startEzMode=1`)
 * that wins on the very first mount when nothing is persisted yet;
 * once the user has interacted, the persisted value takes over.
 */

import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { safeGetItem, safeSetItem } from './safe-storage'

export type EzModeInputMode = 'voice' | 'text'

const ACTIVE_KEY = 'ez-mode-active'
const INPUT_KEY = 'ez-mode-input-mode'

const DEFAULT_ACTIVE = false
const DEFAULT_INPUT: EzModeInputMode = 'voice'

type ActiveListener = (value: boolean) => void
type InputListener = (value: EzModeInputMode) => void

let cachedActive: boolean = DEFAULT_ACTIVE
let cachedInput: EzModeInputMode = DEFAULT_INPUT
let hasHydratedActive = false
let hasHydratedInput = false
let activeIsStored = false

const activeListeners = new Set<ActiveListener>()
const inputListeners = new Set<InputListener>()

async function hydrateActive(): Promise<void> {
  if (hasHydratedActive) return
  hasHydratedActive = true
  try {
    let raw: string | null = null
    if (Platform.OS === 'web') {
      raw = safeGetItem(ACTIVE_KEY)
    } else {
      raw = await SecureStore.getItemAsync(ACTIVE_KEY)
    }
    if (raw === 'false') {
      cachedActive = false
      activeIsStored = true
    } else if (raw === 'true') {
      cachedActive = true
      activeIsStored = true
    }
  } catch {
    // keep default
  }
  for (const l of activeListeners) l(cachedActive)
}

async function hydrateInput(): Promise<void> {
  if (hasHydratedInput) return
  hasHydratedInput = true
  try {
    let raw: string | null = null
    if (Platform.OS === 'web') {
      raw = safeGetItem(INPUT_KEY)
    } else {
      raw = await SecureStore.getItemAsync(INPUT_KEY)
    }
    if (raw === 'voice' || raw === 'text') cachedInput = raw
  } catch {
    // keep default
  }
  for (const l of inputListeners) l(cachedInput)
}

void hydrateActive()
void hydrateInput()

export function getEzModeActive(): boolean {
  return cachedActive
}

export function isEzModeActiveStored(): boolean {
  return activeIsStored
}

export async function setEzModeActivePreference(value: boolean): Promise<void> {
  cachedActive = value
  activeIsStored = true
  for (const l of activeListeners) l(value)
  try {
    if (Platform.OS === 'web') {
      safeSetItem(ACTIVE_KEY, value ? 'true' : 'false')
    } else {
      await SecureStore.setItemAsync(ACTIVE_KEY, value ? 'true' : 'false')
    }
  } catch {
    // ignore persistence errors
  }
}

export function getEzModeInputMode(): EzModeInputMode {
  return cachedInput
}

export async function setEzModeInputModePreference(
  value: EzModeInputMode,
): Promise<void> {
  cachedInput = value
  for (const l of inputListeners) l(value)
  try {
    if (Platform.OS === 'web') {
      safeSetItem(INPUT_KEY, value)
    } else {
      await SecureStore.setItemAsync(INPUT_KEY, value)
    }
  } catch {
    // ignore persistence errors
  }
}

/**
 * React hook for the persisted EZ Mode active flag.
 *
 * `seedIfUnset` lets callers (e.g. `ChatBridgeProvider`) supply a
 * one-shot URL-driven default that only takes effect when nothing is
 * stored yet — used by the homepage → project navigation when the
 * user clicks the mic to start voice project creation, so the first
 * render shows the overlay even before hydration finishes.
 */
export function useEzModeActivePreference(
  seedIfUnset: boolean = false,
): [boolean, (v: boolean) => Promise<void>] {
  const initial = activeIsStored ? cachedActive : seedIfUnset || cachedActive
  const [value, setValue] = useState<boolean>(initial)
  useEffect(() => {
    let mounted = true
    const listener: ActiveListener = (v) => {
      if (mounted) setValue(v)
    }
    activeListeners.add(listener)
    void hydrateActive().then(() => {
      if (!mounted) return
      if (activeIsStored) {
        setValue(cachedActive)
      } else if (seedIfUnset && !cachedActive) {
        // Persist the URL-driven seed so subsequent refreshes
        // remember without needing the URL flag again.
        void setEzModeActivePreference(true)
      }
    })
    return () => {
      mounted = false
      activeListeners.delete(listener)
    }
  }, [seedIfUnset])
  const update = useCallback(async (v: boolean) => {
    await setEzModeActivePreference(v)
  }, [])
  return [value, update]
}

/**
 * React hook for the persisted EZ Mode input modality (voice/text).
 */
export function useEzModeInputModePreference(): [
  EzModeInputMode,
  (v: EzModeInputMode) => Promise<void>,
] {
  const [value, setValue] = useState<EzModeInputMode>(cachedInput)
  useEffect(() => {
    let mounted = true
    const listener: InputListener = (v) => {
      if (mounted) setValue(v)
    }
    inputListeners.add(listener)
    void hydrateInput().then(() => {
      if (mounted) setValue(cachedInput)
    })
    return () => {
      mounted = false
      inputListeners.delete(listener)
    }
  }, [])
  const update = useCallback(async (v: EzModeInputMode) => {
    await setEzModeInputModePreference(v)
  }, [])
  return [value, update]
}
