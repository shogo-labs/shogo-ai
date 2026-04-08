// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform } from "react-native"
import * as SecureStore from "expo-secure-store"
import { safeGetItem, safeSetItem } from "./safe-storage"

const AGENT_MODE_KEY = "agent-mode-preference"

const LEGACY_MIGRATION: Record<string, string> = {
  basic: "claude-haiku-4-5-20251001",
  advanced: "claude-sonnet-4-6",
}

export async function loadModelPreference(): Promise<string | null> {
  try {
    let stored: string | null = null
    if (Platform.OS === "web") {
      stored = safeGetItem(AGENT_MODE_KEY)
    } else {
      stored = await SecureStore.getItemAsync(AGENT_MODE_KEY)
    }
    if (!stored) return null
    return LEGACY_MIGRATION[stored] ?? stored
  } catch {
    return null
  }
}

export async function saveModelPreference(modelId: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      safeSetItem(AGENT_MODE_KEY, modelId)
      return
    }
    await SecureStore.setItemAsync(AGENT_MODE_KEY, modelId)
  } catch {
    // Silently fail
  }
}
