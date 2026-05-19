// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Dual Plan preference — when on, plans generated in Plan mode also produce
 * a stakeholder summary alongside the technical body.
 *
 * Implemented as a tiny singleton cache + listener set so every surface
 * that toggles or reads the value stays in sync without prop drilling.
 * Persisted per-device:
 *   - native: SecureStore
 *   - web:    safe-storage (localStorage with in-memory fallback)
 *
 * NOTE on the default: this feature ships ON by default. Users who never
 * toggled it still get a stakeholder summary every time they generate a plan,
 * and can opt out from the chat input, Plans panel header, or user settings.
 */

import { useCallback, useEffect, useState } from "react"
import { Platform } from "react-native"
import * as SecureStore from "expo-secure-store"
import { safeGetItem, safeSetItem } from "./safe-storage"

const DUAL_PLAN_KEY = "dual-plan-preference"
const DEFAULT = true

type Listener = (value: boolean) => void

let cachedValue: boolean = DEFAULT
let hasHydrated = false
const listeners = new Set<Listener>()

async function hydrate(): Promise<void> {
  if (hasHydrated) return
  hasHydrated = true
  try {
    let raw: string | null = null
    if (Platform.OS === "web") {
      raw = safeGetItem(DUAL_PLAN_KEY)
    } else {
      raw = await SecureStore.getItemAsync(DUAL_PLAN_KEY)
    }
    if (raw === "false") cachedValue = false
    else if (raw === "true") cachedValue = true
  } catch {
    // keep default
  }
  for (const l of listeners) l(cachedValue)
}

void hydrate()

export function getDualPlanPreference(): boolean {
  return cachedValue
}

export async function setDualPlanPreference(value: boolean): Promise<void> {
  cachedValue = value
  for (const l of listeners) l(value)
  try {
    if (Platform.OS === "web") {
      safeSetItem(DUAL_PLAN_KEY, value ? "true" : "false")
    } else {
      await SecureStore.setItemAsync(DUAL_PLAN_KEY, value ? "true" : "false")
    }
  } catch {
    // ignore persistence errors
  }
}

/**
 * React hook for components that need to read AND control the preference.
 * All consumers share the same singleton — toggling from one surface
 * (e.g. the settings page) updates the chat input and Plans panel live.
 */
export function useDualPlan(): [boolean, (v: boolean) => Promise<void>] {
  const [value, setValue] = useState<boolean>(cachedValue)
  useEffect(() => {
    let mounted = true
    const listener: Listener = (v) => {
      if (mounted) setValue(v)
    }
    listeners.add(listener)
    void hydrate().then(() => {
      if (mounted) setValue(cachedValue)
    })
    return () => {
      mounted = false
      listeners.delete(listener)
    }
  }, [])
  const update = useCallback(async (v: boolean) => {
    await setDualPlanPreference(v)
  }, [])
  return [value, update]
}

// ---------------------------------------------------------------------------
// Backwards-compatible function exports
// ---------------------------------------------------------------------------

export async function loadDualPlanPreference(): Promise<boolean> {
  await hydrate()
  return cachedValue
}

export async function saveDualPlanPreference(value: boolean): Promise<void> {
  await setDualPlanPreference(value)
}
