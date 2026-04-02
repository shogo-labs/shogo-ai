// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform } from "react-native"
import * as SecureStore from "expo-secure-store"
import type { InteractionMode } from "../components/chat/ChatInput"

const INTERACTION_MODE_KEY = "interaction-mode-preference"

export async function loadInteractionModePreference(): Promise<InteractionMode | null> {
  try {
    if (Platform.OS === "web") {
      const stored =
        typeof localStorage !== "undefined" ? localStorage.getItem(INTERACTION_MODE_KEY) : null
      if (stored === "agent" || stored === "plan" || stored === "ask") return stored
      return null
    }
    const stored = await SecureStore.getItemAsync(INTERACTION_MODE_KEY)
    if (stored === "agent" || stored === "plan" || stored === "ask") return stored
    return null
  } catch {
    return null
  }
}

export async function saveInteractionModePreference(value: InteractionMode): Promise<void> {
  try {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(INTERACTION_MODE_KEY, value)
      }
      return
    }
    await SecureStore.setItemAsync(INTERACTION_MODE_KEY, value)
  } catch {
    // Silently fail
  }
}
