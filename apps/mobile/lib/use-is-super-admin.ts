// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Lightweight super-admin check for UI affordances (e.g. the "Manage models"
 * link in the model picker). Caches the result module-globally so mounting it
 * in hot components like the chat input doesn't re-hit `/api/me` each time.
 *
 * Uses a standalone HTTP client rather than the domain-bound `useSDKHttp` so it
 * is safe to mount in surfaces that live outside an `SDKDomainProvider` (e.g.
 * a compact chat input on a non-project screen).
 */
import { useEffect, useState } from 'react'
import { api, createHttpClient } from './api'

let cached: boolean | null = null
let inflight: Promise<boolean> | null = null

/** Returns true once `/api/me` confirms the user is a super admin. */
export function useIsSuperAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState<boolean>(cached ?? false)

  useEffect(() => {
    if (cached !== null) {
      setIsAdmin(cached)
      return
    }
    let cancelled = false
    if (!inflight) {
      inflight = api
        .getMe(createHttpClient())
        .then((data) => {
          cached = !!(data?.ok && data.data?.role === 'super_admin')
          return cached
        })
        .catch(() => {
          cached = false
          return false
        })
        .finally(() => {
          inflight = null
        })
    }
    inflight.then((v) => {
      if (!cancelled) setIsAdmin(v)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return isAdmin
}
