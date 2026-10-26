// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from 'react'
import { AppState, Linking, Platform } from 'react-native'

import {
  getNotificationPermissionState,
  requestNotificationPermissionFromGesture,
  type NotificationPermissionState,
} from './chat-notifier'

/**
 * Current notification permission, re-read when the app or tab comes back to
 * the foreground (the user may have changed it in Settings meanwhile).
 * `request` must be called from a press handler so browsers show the prompt.
 */
export function useNotificationPermission(): {
  state: NotificationPermissionState | null
  request: () => Promise<void>
  openSettings: () => void
} {
  const [state, setState] = useState<NotificationPermissionState | null>(null)

  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void getNotificationPermissionState().then((s) => {
        if (mounted) setState(s)
      })
    }
    refresh()
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh()
    })
    const onFocus = () => refresh()
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('focus', onFocus)
    return () => {
      mounted = false
      sub.remove()
      if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
    }
  }, [])

  const request = useCallback(async () => {
    setState(await requestNotificationPermissionFromGesture())
  }, [])

  const openSettings = useCallback(() => {
    if (Platform.OS !== 'web') void Linking.openSettings().catch(() => {})
  }, [])

  return { state, request, openSettings }
}
