// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Announce huddle calls" (iPhone): whether this iPhone takes incoming huddles
 * on the call screen. Off, the phone stops sending its VoIP token, so the
 * server falls back to the ordinary alert. It is a device setting, like the
 * dock bounce on desktop, so it lives on this device only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = 'shogo:announce-huddle-calls'

type Listener = (enabled: boolean) => void

let cached = true
let hydrated = false
const listeners = new Set<Listener>()

function notify(): void {
  for (const l of listeners) l(cached)
}

async function hydrate(): Promise<void> {
  if (hydrated) return
  hydrated = true
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (raw === 'false') cached = false
    else if (raw === 'true') cached = true
  } catch {
    // Keep the default: calls are announced.
  }
  notify()
}

void hydrate()

export function getAnnounceHuddleCalls(): boolean {
  return cached
}

export async function setAnnounceHuddleCallsPreference(enabled: boolean): Promise<void> {
  cached = enabled
  notify()
  try {
    await AsyncStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // The choice then lasts until the app restarts.
  }
}

/** Calls the listener now with the current value, and again whenever it changes. */
export function subscribeAnnounceHuddleCalls(listener: Listener): () => void {
  listeners.add(listener)
  listener(cached)
  void hydrate()
  return () => {
    listeners.delete(listener)
  }
}
