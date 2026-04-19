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

// SecureStore keys must match /^[A-Za-z0-9._-]+$/ on native; use '_' as the
// separator so the same key format works on both web and native.
function projectKey(projectId: string): string {
  return `${AGENT_MODE_KEY}_${projectId}`
}

async function readKey(key: string): Promise<string | null> {
  try {
    if (Platform.OS === "web") {
      return safeGetItem(key)
    }
    return await SecureStore.getItemAsync(key)
  } catch {
    return null
  }
}

async function writeKey(key: string, value: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      safeSetItem(key, value)
      return
    }
    await SecureStore.setItemAsync(key, value)
  } catch {
    // Silently fail
  }
}

export async function loadModelPreference(projectId?: string): Promise<string | null> {
  let stored: string | null = null
  if (projectId) {
    stored = await readKey(projectKey(projectId))
  }
  if (!stored) {
    stored = await readKey(AGENT_MODE_KEY)
  }
  if (!stored) return null
  return LEGACY_MIGRATION[stored] ?? stored
}

export async function saveModelPreference(modelId: string, projectId?: string): Promise<void> {
  if (projectId) {
    await writeKey(projectKey(projectId), modelId)
  }
  await writeKey(AGENT_MODE_KEY, modelId)
}
