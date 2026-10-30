// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { DevSettings } from 'react-native'
import * as Updates from 'expo-updates'
import { setEnvOverride, type EnvOverride } from './env-override'
import { clearTeamChatCache } from './team-chat-cache'
import { clearChatHistory } from './chat-history-store'

/**
 * Persisted native state that points at server-side records of one backend.
 * Auth is already namespaced per env; in-memory stores reset on reload.
 */
const SERVER_SCOPED_ASYNC_KEYS = ['shogo:activeInstance']

async function clearServerScopedState(): Promise<void> {
  await Promise.all([
    AsyncStorage.multiRemove(SERVER_SCOPED_ASYNC_KEYS).catch(() => {}),
    clearTeamChatCache(),
    clearChatHistory(),
  ])
}

export async function reloadApp(): Promise<void> {
  try {
    await Updates.reloadAsync()
    return
  } catch {
    // reloadAsync is unavailable in dev clients / Expo Go.
  }
  DevSettings.reload()
}

/** Saves the new backend, drops caches from the old one, and reloads JS. */
export async function switchEnvironment(override: EnvOverride | null): Promise<void> {
  await clearServerScopedState()
  await setEnvOverride(override)
  await reloadApp()
}
