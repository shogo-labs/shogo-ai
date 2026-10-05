// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sign this desktop in to / out of Shogo Cloud from anywhere in the app (the
 * workspace switcher, Admin > General). On success the cloud workspace list
 * is refreshed, so cloud workspaces appear in or leave the switcher.
 */

import { useCallback, useState } from 'react'
import { refreshCloudWorkspaces, useCloudWorkspaces } from '../lib/workspace-route'

type DesktopCloudBridge = {
  startCloudLogin?: () => Promise<{ ok: boolean; error?: string }>
  signOutCloud?: () => Promise<{ ok: boolean; error?: string }>
}

function desktopBridge(): DesktopCloudBridge | null {
  if (typeof window === 'undefined') return null
  return ((window as any).shogoDesktop as DesktopCloudBridge | undefined) ?? null
}

async function apiUrl(): Promise<string> {
  return (await import('../lib/api-url')).API_URL
}

export function useCloudSession() {
  const cloud = useCloudWorkspaces()
  const [pending, setPending] = useState<'signin' | 'signout' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const signIn = useCallback(async (): Promise<boolean> => {
    const desktop = desktopBridge()
    if (!desktop?.startCloudLogin) {
      setError('Sign in from the Shogo Desktop app, or run `shogo login` in your terminal.')
      return false
    }
    setPending('signin')
    setError(null)
    try {
      const result = await desktop.startCloudLogin()
      if (!result?.ok) {
        if (result?.error && result.error !== 'Cancelled') setError(result.error)
        return false
      }
      await refreshCloudWorkspaces(await apiUrl())
      return true
    } catch (err: any) {
      setError(err?.message || 'Shogo Cloud sign-in failed')
      return false
    } finally {
      setPending(null)
    }
  }, [])

  const signOut = useCallback(async (): Promise<boolean> => {
    setPending('signout')
    setError(null)
    try {
      const base = await apiUrl()
      const desktop = desktopBridge()
      const result = desktop?.signOutCloud
        ? await desktop.signOutCloud()
        : await fetch(`${base}/api/local/cloud-login/signout`, { method: 'POST', credentials: 'include' })
            .then((res) => res.json().catch(() => ({ ok: res.ok })))
      if (result?.ok === false) {
        setError(result.error || 'Sign-out failed')
        return false
      }
      await refreshCloudWorkspaces(base)
      return true
    } catch (err: any) {
      setError(err?.message || 'Sign-out failed')
      return false
    } finally {
      setPending(null)
    }
  }, [])

  return { cloud, pending, error, signIn, signOut }
}
