// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live view of the macOS privacy permissions exposed by the Electron shell.
 *
 * macOS grants happen out-of-process (System Settings), so the status is
 * re-read on an interval while mounted and whenever the window regains focus.
 * Without the desktop bridge every permission reports `unsupported`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EMPTY_PERMISSION_STATUS,
  getDesktopBridge,
  type LocalAppInfo,
  type PermissionKind,
  type PermissionStatus,
} from './desktop-bridge'

const POLL_MS = 1500

export interface UseOsPermissions {
  status: PermissionStatus
  /** True once the first status read has finished. */
  ready: boolean
  /** Kind currently being requested, if any. */
  requesting: PermissionKind | null
  /** True after a request sent the user to System Settings and it is not granted yet. */
  awaitingSettings: Partial<Record<PermissionKind, boolean>>
  request: (kind: PermissionKind) => Promise<void>
  openSettings: (kind: PermissionKind) => Promise<void>
  refresh: () => Promise<void>
  relaunch: () => Promise<void>
}

export function useOsPermissions(options: { poll?: boolean } = {}): UseOsPermissions {
  const poll = options.poll ?? true
  const [status, setStatus] = useState<PermissionStatus>(EMPTY_PERMISSION_STATUS)
  const [ready, setReady] = useState(false)
  const [requesting, setRequesting] = useState<PermissionKind | null>(null)
  const [awaitingSettings, setAwaitingSettings] = useState<Partial<Record<PermissionKind, boolean>>>({})
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const applyStatus = useCallback((next: PermissionStatus) => {
    if (!mounted.current) return
    setStatus(next)
    setAwaitingSettings((prev) => {
      let changed = false
      const copy = { ...prev }
      for (const k of Object.keys(prev) as PermissionKind[]) {
        if (next[k] === 'granted' && copy[k]) {
          copy[k] = false
          changed = true
        }
      }
      return changed ? copy : prev
    })
  }, [])

  const refresh = useCallback(async () => {
    const perms = getDesktopBridge()?.permissions
    if (!perms) {
      if (mounted.current) setReady(true)
      return
    }
    try {
      applyStatus(await perms.getStatus())
    } catch (err) {
      console.warn('[OsPermissions] getStatus failed:', err)
    } finally {
      if (mounted.current) setReady(true)
    }
  }, [applyStatus])

  useEffect(() => {
    void refresh()
    if (!poll || !getDesktopBridge()?.permissions) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    const onFocus = () => void refresh()
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onFocus)
    }
    return () => {
      clearInterval(timer)
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onFocus)
      }
    }
  }, [poll, refresh])

  const request = useCallback(
    async (kind: PermissionKind) => {
      const perms = getDesktopBridge()?.permissions
      if (!perms) return
      setRequesting(kind)
      try {
        const result = await perms.request(kind)
        if (result.status) applyStatus(result.status)
        if (result.openedSettings && mounted.current) {
          setAwaitingSettings((prev) => ({ ...prev, [kind]: true }))
        }
      } catch (err) {
        console.warn('[OsPermissions] request failed:', err)
      } finally {
        if (mounted.current) setRequesting(null)
      }
    },
    [applyStatus],
  )

  const openSettings = useCallback(async (kind: PermissionKind) => {
    await getDesktopBridge()?.permissions?.openSettings(kind)
  }, [])

  const relaunch = useCallback(async () => {
    await getDesktopBridge()?.permissions?.relaunch()
  }, [])

  return { status, ready, requesting, awaitingSettings, request, openSettings, refresh, relaunch }
}

/** Installed state of the local apps the user can scope Shogo's access to. */
export function useLocalApps(): { apps: LocalAppInfo[]; loaded: boolean } {
  const [apps, setApps] = useState<LocalAppInfo[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const perms = getDesktopBridge()?.permissions
    if (!perms) {
      setLoaded(true)
      return
    }
    perms
      .listLocalApps()
      .then((list) => {
        if (!cancelled) setApps(list)
      })
      .catch((err) => console.warn('[OsPermissions] listLocalApps failed:', err))
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { apps, loaded }
}
