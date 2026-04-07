// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform } from "react-native"
import * as SecureStore from "expo-secure-store"
import type { AgentMode } from "../components/chat/ChatInput"
import { safeGetItem, safeSetItem } from "./safe-storage"

const AGENT_MODE_KEY = "agent-mode-preference"

export async function loadAgentModePreference(): Promise<AgentMode | null> {
  try {
    if (Platform.OS === "web") {
      const stored = safeGetItem(AGENT_MODE_KEY)
      if (stored === "basic" || stored === "advanced") return stored
      return null
    }
    const stored = await SecureStore.getItemAsync(AGENT_MODE_KEY)
    if (stored === "basic" || stored === "advanced") return stored
    return null
  } catch {
    return null
  }
}

export async function saveAgentModePreference(value: AgentMode): Promise<void> {
  try {
    if (Platform.OS === "web") {
      safeSetItem(AGENT_MODE_KEY, value)
      return
    }
    await SecureStore.setItemAsync(AGENT_MODE_KEY, value)
  } catch {
    // Silently fail
  }
}
