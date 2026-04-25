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

export type InstanceStatus = 'online' | 'heartbeat' | 'offline' | 'unknown'

export interface ActiveInstanceContextValue {
  instance: ActiveInstance | null
  /**
   * Base URL for agent requests routed through the transparent proxy.
   * e.g. `${apiUrl}/api/instances/${id}/p`
   * null when controlling locally.
   */
  remoteAgentBaseUrl: string | null
  /**
   * Live status of the active instance, refreshed every 15s while selected.
   * 'unknown' until the first poll completes.
   * Consumers can use this to render a toast / badge when the chosen
   * machine drops mid-conversation.
   */
  instanceStatus: InstanceStatus
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
  instanceStatus: 'unknown',
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
  const [instanceStatus, setInstanceStatus] = useState<InstanceStatus>('unknown')
  const validatedRef = useRef(false)

  useEffect(() => {
    storage
      .getItem(STORAGE_KEY)
      .then(async (raw) => {
        if (!raw) return
        try {
          const restored: ActiveInstance = JSON.parse(raw)
          const result = await validateInstance(restored, apiUrl, fetchFn, fetchOptions)
          if (result.valid) {
            setInstanceState(restored)
            setInstanceStatus(result.status ?? 'unknown')
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

  // Live status polling — detects mid-conversation disconnects so the UI can
  // toast "machine offline, continue in cloud?". Only runs when an instance
  // is actively selected. 15s interval matches mobile EnvironmentPicker poll.
  useEffect(() => {
    if (!instance || !apiUrl) {
      setInstanceStatus('unknown')
      return
    }
    let cancelled = false
    const tick = async () => {
      const result = await validateInstance(instance, apiUrl, fetchFn, fetchOptions)
      if (cancelled) return
      if (!result.valid) {
        // Instance was deleted or no longer belongs to this workspace.
        setInstanceStatus('offline')
        return
      }
      setInstanceStatus(result.status ?? 'unknown')
    }
    void tick()
    const id = setInterval(tick, 15000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [instance, apiUrl, fetchFn, fetchOptions])

  const setInstance = useCallback(
    (inst: ActiveInstance) => {
      setInstanceState(inst)
      setInstanceStatus('unknown')
      storage.setItem(STORAGE_KEY, JSON.stringify(inst)).catch(() => {})
    },
    [storage],
  )

  const clearInstance = useCallback(() => {
    setInstanceState(null)
    setInstanceStatus('unknown')
    storage.removeItem(STORAGE_KEY).catch(() => {})
  }, [storage])

  const remoteAgentBaseUrl = useMemo(() => {
    if (!instance || !apiUrl) return null
    return `${apiUrl}/api/instances/${instance.instanceId}/p`
  }, [instance, apiUrl])

  const value = useMemo<ActiveInstanceContextValue>(
    () => ({ instance, remoteAgentBaseUrl, instanceStatus, setInstance, clearInstance }),
    [instance, remoteAgentBaseUrl, instanceStatus, setInstance, clearInstance],
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
): Promise<{ valid: boolean; status?: InstanceStatus }> {
  if (!apiUrl) return { valid: false }
  try {
    const res = await fetchFn(`${apiUrl}/api/instances/${inst.instanceId}`, {
      ...fetchOptions,
    })
    if (!res.ok) return { valid: false }
    const data = await res.json()
    if (data.workspaceId !== inst.workspaceId) return { valid: false }
    const status: InstanceStatus =
      data.status === 'online' || data.status === 'heartbeat' || data.status === 'offline'
        ? data.status
        : 'unknown'
    return { valid: true, status }
  } catch {
    return { valid: false }
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
