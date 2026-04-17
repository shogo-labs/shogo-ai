// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useActiveInstance — Platform-agnostic hook for tracking which remote Shogo
 * instance the user is controlling.
 *
 * null  = local (default — no remote instance selected)
 * {...} = remote instance via cloud tunnel
 *
 * Callers provide a storage adapter (AsyncStorage, localStorage wrapper, etc.)
 * and an apiUrl so this hook works identically on mobile, web, and desktop.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from 'react'
import type { ReactNode } from 'react'

// ─── Public types ───────────────────────────────────────────────────────────

export interface ActiveInstance {
  instanceId: string
  name: string
  hostname: string
  workspaceId: string
}

export interface ActiveInstanceContextValue {
  instance: ActiveInstance | null
  /**
   * Base URL for agent requests routed through the transparent proxy.
   * e.g. `${apiUrl}/api/instances/${id}/p`
   * null when controlling locally.
   */
  remoteAgentBaseUrl: string | null
  setInstance: (instance: ActiveInstance) => void
  clearInstance: () => void
}

/**
 * Minimal async key-value store — implemented by AsyncStorage on native,
 * or a thin localStorage wrapper on web.
 */
export interface InstanceStorageAdapter {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export interface ActiveInstanceProviderProps {
  children: ReactNode
  apiUrl: string
  storage: InstanceStorageAdapter
  /** Optional fetch wrapper (e.g. to add cookies on native). */
  fetchFn?: typeof fetch
  /** Extra options merged into every validation fetch. */
  fetchOptions?: RequestInit
}

// ─── Context ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'shogo:activeInstance'

const ActiveInstanceContext = createContext<ActiveInstanceContextValue>({
  instance: null,
  remoteAgentBaseUrl: null,
  setInstance: () => {},
  clearInstance: () => {},
})

// ─── Provider ───────────────────────────────────────────────────────────────

export function ActiveInstanceProvider({
  children,
  apiUrl,
  storage,
  fetchFn = fetch,
  fetchOptions,
}: ActiveInstanceProviderProps) {
  const [instance, setInstanceState] = useState<ActiveInstance | null>(null)
  const validatedRef = useRef(false)

  useEffect(() => {
    storage
      .getItem(STORAGE_KEY)
      .then(async (raw) => {
        if (!raw) return
        try {
          const restored: ActiveInstance = JSON.parse(raw)
          const valid = await validateInstance(restored, apiUrl, fetchFn, fetchOptions)
          if (valid) {
            setInstanceState(restored)
          } else {
            storage.removeItem(STORAGE_KEY).catch(() => {})
          }
        } catch {
          storage.removeItem(STORAGE_KEY).catch(() => {})
        }
        validatedRef.current = true
      })
      .catch(() => {
        validatedRef.current = true
      })
  }, [apiUrl, storage, fetchFn, fetchOptions])

  const setInstance = useCallback(
    (inst: ActiveInstance) => {
      setInstanceState(inst)
      storage.setItem(STORAGE_KEY, JSON.stringify(inst)).catch(() => {})
    },
    [storage],
  )

  const clearInstance = useCallback(() => {
    setInstanceState(null)
    storage.removeItem(STORAGE_KEY).catch(() => {})
  }, [storage])

  const remoteAgentBaseUrl = useMemo(() => {
    if (!instance || !apiUrl) return null
    return `${apiUrl}/api/instances/${instance.instanceId}/p`
  }, [instance, apiUrl])

  const value = useMemo<ActiveInstanceContextValue>(
    () => ({ instance, remoteAgentBaseUrl, setInstance, clearInstance }),
    [instance, remoteAgentBaseUrl, setInstance, clearInstance],
  )

  return (
    <ActiveInstanceContext.Provider value={value}>
      {children}
    </ActiveInstanceContext.Provider>
  )
}

export function useActiveInstance() {
  return useContext(ActiveInstanceContext)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function validateInstance(
  inst: ActiveInstance,
  apiUrl: string,
  fetchFn: typeof fetch,
  fetchOptions?: RequestInit,
): Promise<boolean> {
  if (!apiUrl) return false
  try {
    const res = await fetchFn(`${apiUrl}/api/instances/${inst.instanceId}`, {
      ...fetchOptions,
    })
    if (!res.ok) return false
    const data = await res.json()
    return data.workspaceId === inst.workspaceId
  } catch {
    return false
  }
}

// ─── localStorage adapter (for web / desktop) ──────────────────────────────

export const localStorageAdapter: InstanceStorageAdapter = {
  async getItem(key) {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem(key)
  },
  async setItem(key, value) {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(key, value)
  },
  async removeItem(key) {
    if (typeof window === 'undefined') return
    window.localStorage.removeItem(key)
  },
}
