// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Platform } from 'react-native'
import { PlatformApi, type CloudLoginStatus } from '@shogo-ai/sdk'
import { createHttpClient } from '../lib/api'

type CloudLoginResult = {
  ok: boolean
  error?: string
}

function getDesktopBridge(): {
  startCloudLogin?: () => Promise<CloudLoginResult>
  onCloudLoginResult?: (callback: (result: CloudLoginResult) => void) => void
  removeCloudLoginListener?: () => void
} | null {
  if (typeof window === 'undefined') return null
  return (window as any).shogoDesktop ?? null
}

export function useCloudSignIn() {
  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])
  const [cloudStatus, setCloudStatus] = useState<CloudLoginStatus | null>(null)
  const [loginState, setLoginState] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [loginError, setLoginError] = useState<string | null>(null)

  const refreshCloudStatus = useCallback(async () => {
    try {
      const status = await platform.cloudLoginStatus()
      setCloudStatus(status)
      return status
    } catch (error: any) {
      setLoginError(error?.message || 'Unable to check Shogo Cloud sign-in')
      return null
    }
  }, [platform])

  useEffect(() => {
    let cancelled = false
    void refreshCloudStatus().then(() => {
      if (cancelled) return
      setLoginState((current) => current === 'connecting' ? current : 'idle')
    })

    const desktop = getDesktopBridge()
    desktop?.onCloudLoginResult?.((result) => {
      if (cancelled) return
      if (result.ok) {
        setLoginState('idle')
        setLoginError(null)
        void refreshCloudStatus()
      } else {
        setLoginState('error')
        setLoginError(result.error || 'Shogo Cloud sign-in was cancelled')
      }
    })

    return () => {
      cancelled = true
      desktop?.removeCloudLoginListener?.()
    }
  }, [refreshCloudStatus])

  const startSignIn = useCallback(async () => {
    const desktop = getDesktopBridge()
    if (!desktop?.startCloudLogin) {
      setLoginState('error')
      setLoginError(
        Platform.OS === 'web'
          ? 'Browser preview cannot complete sign-in. Use the Shogo Desktop app or run `shogo login` in your terminal.'
          : 'Cloud sign-in is available from the Shogo Desktop app.',
      )
      return false
    }

    setLoginState('connecting')
    setLoginError(null)
    try {
      const result = await desktop.startCloudLogin()
      if (!result?.ok) {
        setLoginState('error')
        setLoginError(result?.error || 'Could not start Shogo Cloud sign-in')
        return false
      }
      setLoginState('idle')
      await refreshCloudStatus()
      return true
    } catch (error: any) {
      setLoginState('error')
      setLoginError(error?.message || 'Shogo Cloud sign-in failed')
      return false
    }
  }, [refreshCloudStatus])

  return {
    cloudStatus,
    loginState,
    loginError,
    startSignIn,
    refreshCloudStatus,
  }
}
