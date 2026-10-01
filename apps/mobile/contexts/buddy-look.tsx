// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from './auth'
import { api, createHttpClient } from '../lib/api'
import { setIslandBuddyLook } from '../lib/desktop-island'
import { safeGetItem, safeSetItem } from '../lib/safe-storage'
import {
  DEFAULT_BUDDY_LOOK,
  normalizeBuddyLook,
  sameLook,
  type BuddyLook,
} from '../components/island/buddy/look'

const CACHE_PREFIX = 'shogo-buddy-look-v1:'

function readCache(userId: string): BuddyLook | null {
  try {
    const raw = safeGetItem(CACHE_PREFIX + userId)
    return raw ? normalizeBuddyLook(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

function writeCache(userId: string, look: BuddyLook) {
  try {
    safeSetItem(CACHE_PREFIX + userId, JSON.stringify(look))
  } catch {}
}

interface BuddyLookCtx {
  look: BuddyLook
  setLook: (look: BuddyLook) => void
  saving: boolean
  error: string
}

const BuddyLookContext = createContext<BuddyLookCtx>({
  look: DEFAULT_BUDDY_LOOK,
  setLook: () => {},
  saving: false,
  error: '',
})

/**
 * The signed-in user's Shogo buddy look. Saved on the account, cached per user
 * so the island shows the right Shogo before `/api/me` answers, and published
 * to the desktop island whenever it changes.
 */
export function BuddyLookProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const { user, isAuthenticated } = useAuth()
  const userId = enabled && isAuthenticated ? user?.id ?? null : null
  const [look, setLookState] = useState<BuddyLook>(DEFAULT_BUDDY_LOOK)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** Set once the user picks a look, so a slow `/api/me` can't overwrite it. */
  const touched = useRef(false)
  const lookRef = useRef(look)
  lookRef.current = look
  const userIdRef = useRef(userId)
  userIdRef.current = userId
  /** The look the server last acknowledged; a failed save rolls back to it. */
  const confirmed = useRef<BuddyLook>(DEFAULT_BUDDY_LOOK)
  /** Only one save is in flight; picks made meanwhile collapse into the newest. */
  const sending = useRef(false)
  const queued = useRef<BuddyLook | null>(null)

  useEffect(() => {
    touched.current = false
    queued.current = null
    setError('')
    if (!userId) {
      confirmed.current = DEFAULT_BUDDY_LOOK
      setLookState(DEFAULT_BUDDY_LOOK)
      return
    }
    const cached = readCache(userId) ?? DEFAULT_BUDDY_LOOK
    confirmed.current = cached
    setLookState(cached)

    let cancelled = false
    void api
      .getMe(createHttpClient())
      .then((res) => {
        if (cancelled || touched.current) return
        const next = normalizeBuddyLook(res?.data?.buddyLook)
        confirmed.current = next
        setLookState((prev) => (sameLook(prev, next) ? prev : next))
        writeCache(userId, next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [userId])

  // Another app window changed the look.
  useEffect(() => {
    if (!userId || typeof window === 'undefined') return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CACHE_PREFIX + userId || !event.newValue) return
      try {
        const next = normalizeBuddyLook(JSON.parse(event.newValue))
        setLookState((prev) => (sameLook(prev, next) ? prev : next))
      } catch {}
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [userId])

  useEffect(() => {
    if (enabled) setIslandBuddyLook(look)
  }, [enabled, look])

  const flush = useCallback((owner: string) => {
    const next = queued.current
    if (!next || sending.current) return
    queued.current = null
    sending.current = true
    setSaving(true)
    api
      .setBuddyLook(createHttpClient(), next)
      .then(() => {
        if (userIdRef.current === owner) confirmed.current = next
      })
      .catch(() => {
        if (userIdRef.current !== owner || queued.current || !sameLook(lookRef.current, next)) return
        const fallback = confirmed.current
        setLookState(fallback)
        writeCache(owner, fallback)
        setError('Could not save your Shogo. Try again.')
      })
      .finally(() => {
        sending.current = false
        if (queued.current && userIdRef.current === owner) flush(owner)
        else setSaving(false)
      })
  }, [])

  const setLook = useCallback(
    (next: BuddyLook) => {
      if (!userId || sameLook(lookRef.current, next)) return
      touched.current = true
      setLookState(next)
      writeCache(userId, next)
      setError('')
      queued.current = next
      flush(userId)
    },
    [userId, flush],
  )

  const value = useMemo(() => ({ look, setLook, saving, error }), [look, setLook, saving, error])
  return <BuddyLookContext.Provider value={value}>{children}</BuddyLookContext.Provider>
}

export function useBuddyLook() {
  return useContext(BuddyLookContext)
}
