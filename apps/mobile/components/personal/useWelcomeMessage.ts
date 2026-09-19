// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-time "welcome" banner shown the first time a user opens their
 * personal companion's primary chat on this device.
 *
 * There's no server-side "is this session brand new" signal worth adding
 * (`getOrCreatePrimaryWorkspaceSession` is idempotent and doesn't
 * distinguish create-vs-fetch to callers, and threading that through would
 * make an otherwise-pure GET stateful) — a per-device, AsyncStorage-backed
 * "have I seen this" flag is simpler, survives reloads, and matches the
 * existing `lib/notifications/preferences.ts` pattern for small client-only
 * prefs. Keyed by workspace id so switching personal workspaces (e.g. two
 * accounts on one device) shows the welcome once per workspace.
 */
import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY_PREFIX = 'shogo:personal-shell-welcome-seen:'

export function useWelcomeMessage(workspaceId: string | undefined): {
  showWelcome: boolean
  dismissWelcome: () => void
} {
  const [showWelcome, setShowWelcome] = useState(false)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    AsyncStorage.getItem(STORAGE_KEY_PREFIX + workspaceId)
      .then((seen) => {
        if (!cancelled && seen !== 'true') setShowWelcome(true)
      })
      .catch(() => {
        // Storage unavailable — default to not showing rather than risk
        // repeating the banner on every open.
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const dismissWelcome = useCallback(() => {
    setShowWelcome(false)
    if (!workspaceId) return
    AsyncStorage.setItem(STORAGE_KEY_PREFIX + workspaceId, 'true').catch(() => {
      // Non-fatal: worst case the banner reappears next open.
    })
  }, [workspaceId])

  return { showWelcome, dismissWelcome }
}
