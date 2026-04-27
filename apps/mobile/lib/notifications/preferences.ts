// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Lightweight, AsyncStorage-backed store for client-only notification prefs.
 * Kept intentionally tiny — if we grow more preferences we can promote this
 * to a proper MobX store.
 */

import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = 'shogo:notify-on-turn-complete'
const DEFAULT = true

type Listener = (value: boolean) => void

let cachedValue: boolean = DEFAULT
let hasHydrated = false
const listeners = new Set<Listener>()

async function hydrate() {
  if (hasHydrated) return
  hasHydrated = true
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (raw === 'false') cachedValue = false
    else if (raw === 'true') cachedValue = true
  } catch {
    // keep default
  }
  for (const l of listeners) l(cachedValue)
}

void hydrate()

export function getNotifyOnTurnComplete(): boolean {
  return cachedValue
}

export async function setNotifyOnTurnComplete(value: boolean): Promise<void> {
  cachedValue = value
  for (const l of listeners) l(value)
  try {
    await AsyncStorage.setItem(STORAGE_KEY, value ? 'true' : 'false')
  } catch {
    // ignore persistence errors
  }
}

export function useNotifyOnTurnComplete(): [boolean, (v: boolean) => Promise<void>] {
  const [value, setValue] = useState<boolean>(cachedValue)
  useEffect(() => {
    let mounted = true
    const listener: Listener = (v) => {
      if (mounted) setValue(v)
    }
    listeners.add(listener)
    // Trigger an initial read in case hydration completed before this mount.
    void hydrate().then(() => {
      if (mounted) setValue(cachedValue)
    })
    return () => {
      mounted = false
      listeners.delete(listener)
    }
  }, [])
  const update = useCallback(async (v: boolean) => {
    await setNotifyOnTurnComplete(v)
  }, [])
  return [value, update]
}
