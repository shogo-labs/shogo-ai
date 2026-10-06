// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The last glance snapshot, kept on disk. The widget is redrawn by Android on
 * its own schedule (added, resized, periodic), possibly before the app has
 * published anything this launch, so it reads the last one from here.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { AgentGlanceSnapshot } from '../agent-glance'

export const ANDROID_GLANCE_KEY = 'shogo.glance.v1'

export function parseStoredGlance(raw: string | null): AgentGlanceSnapshot | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<AgentGlanceSnapshot> | null
    if (!value || value.version !== 1 || !Array.isArray(value.agents) || typeof value.generatedAt !== 'number') return null
    return value as AgentGlanceSnapshot
  } catch {
    return null
  }
}

export async function saveGlance(snapshot: AgentGlanceSnapshot): Promise<void> {
  await AsyncStorage.setItem(ANDROID_GLANCE_KEY, JSON.stringify(snapshot))
}

export async function loadGlance(): Promise<AgentGlanceSnapshot | null> {
  return parseStoredGlance(await AsyncStorage.getItem(ANDROID_GLANCE_KEY))
}
