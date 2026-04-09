// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ActiveInstance Context
 *
 * Tracks which remote Shogo instance the user is controlling. When an instance
 * is active, the project interface routes agent requests through the cloud
 * proxy instead of hitting the local/direct agent URL.
 *
 * null = local (default — no remote instance selected)
 * { instanceId, name, ... } = remote instance via cloud tunnel
 */

import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { API_URL } from '../lib/api'
import { authClient } from '../lib/auth-client'

const STORAGE_KEY = 'shogo:activeInstance'

export interface ActiveInstance {
  instanceId: string
  name: string
  hostname: string
  workspaceId: string
}

interface ActiveInstanceContextValue {
  /** The currently active remote instance, or null for local. */
  instance: ActiveInstance | null
  /**
   * The base URL for agent requests. When a remote instance is active, this
   * points at the transparent proxy (e.g. ${API_URL}/api/instances/${id}/p).
   * Components use this as a drop-in replacement for agentUrl.
   * Returns null when no remote instance is selected (use normal agentUrl).
   */
  remoteAgentBaseUrl: string | null
  /** Select a remote instance to control. */
  setInstance: (instance: ActiveInstance) => void
  /** Clear the remote instance (return to local). */
  clearInstance: () => void
}

const ActiveInstanceContext = createContext<ActiveInstanceContextValue>({
  instance: null,
  remoteAgentBaseUrl: null,
  setInstance: () => {},
  clearInstance: () => {},
})

function getAuthHeaders(): Record<string, string> {
  if (Platform.OS === 'web') return {}
  const cookie = (authClient as any).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

async function validateInstance(inst: ActiveInstance): Promise<boolean> {
  if (!API_URL) return false
  try {
    const res = await fetch(
      `${API_URL}/api/instances/${inst.instanceId}`,
      {
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
        headers: { ...getAuthHeaders() },
      },
    )
    if (!res.ok) return false
    const data = await res.json()
    return data.workspaceId === inst.workspaceId
  } catch {
    return false
  }
}

export function ActiveInstanceProvider({ children }: { children: ReactNode }) {
  const [instance, setInstanceState] = useState<ActiveInstance | null>(null)
  const validatedRef = useRef(false)

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(async (raw) => {
        if (!raw) return
        try {
          const restored: ActiveInstance = JSON.parse(raw)
          const valid = await validateInstance(restored)
          if (valid) {
            setInstanceState(restored)
          } else {
            AsyncStorage.removeItem(STORAGE_KEY).catch(() => {})
          }
        } catch {
          AsyncStorage.removeItem(STORAGE_KEY).catch(() => {})
        }
        validatedRef.current = true
      })
      .catch(() => { validatedRef.current = true })
  }, [])

  const setInstance = useCallback((inst: ActiveInstance) => {
    setInstanceState(inst)
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(inst)).catch(() => {})
  }, [])

  const clearInstance = useCallback(() => {
    setInstanceState(null)
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {})
  }, [])

  const remoteAgentBaseUrl = useMemo(() => {
    if (!instance || !API_URL) return null
    return `${API_URL}/api/instances/${instance.instanceId}/p`
  }, [instance])

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
