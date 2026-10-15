// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Don't show again" for the mention-nudge card (MentionNudgeCard): once set,
 * sending a message that mentions someone outside the channel no longer
 * offers to add them. Lightweight, AsyncStorage-backed, device-wide — same
 * shape as lib/notifications/preferences.ts.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = 'shogo:mention-nudge-dismissed'

let cachedValue = false
let hasHydrated = false

async function hydrate() {
  if (hasHydrated) return
  hasHydrated = true
  try {
    cachedValue = (await AsyncStorage.getItem(STORAGE_KEY)) === 'true'
  } catch {
    // keep default
  }
}

void hydrate()

export function getMentionNudgeDismissed(): boolean {
  return cachedValue
}

export async function dismissMentionNudgeForever(): Promise<void> {
  cachedValue = true
  try {
    await AsyncStorage.setItem(STORAGE_KEY, 'true')
  } catch {
    // ignore persistence errors
  }
}
