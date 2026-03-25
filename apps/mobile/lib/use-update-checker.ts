// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useState, useCallback, useRef } from 'react'
import { Platform } from 'react-native'
import { API_URL } from './api'

const BUILD_HASH = process.env.EXPO_PUBLIC_BUILD_HASH || 'dev'
const POLL_INTERVAL_MS = 60_000

export function useUpdateChecker() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const dismissed = useRef(false)

  const dismiss = useCallback(() => {
    dismissed.current = true
    setUpdateAvailable(false)
  }, [])

  useEffect(() => {
    if (Platform.OS !== 'web' || BUILD_HASH === 'dev') return

    const isLocalMode =
      process.env.EXPO_PUBLIC_LOCAL_MODE === 'true' ||
      (typeof window !== 'undefined' && !!(window as any).shogoDesktop?.isDesktop)
    if (isLocalMode) return

    const check = async () => {
      if (dismissed.current) return
      try {
        const res = await fetch(`${API_URL}/api/version`, {
          signal: AbortSignal.timeout(5000),
        })
        const data = await res.json()
        if (data.buildHash && data.buildHash !== BUILD_HASH) {
          setUpdateAvailable(true)
        }
      } catch {
        // Network error or timeout — skip this check
      }
    }

    check()
    const id = setInterval(check, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return { updateAvailable, dismiss }
}
