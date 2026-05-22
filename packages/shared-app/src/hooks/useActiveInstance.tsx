// SPDX-License-Identifier: MIT
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

/**
 * Discriminator for the two kinds of remote machines a workspace can
 * have:
 *
 *  - `desktop`     The Shogo desktop app, hosting a local apps/api +
 *                  project database. Stateful API calls
 *                  (`/api/projects`, `/api/chat-sessions`, etc.) are
 *                  served by the desktop and must be tunneled when
 *                  Studio targets it remotely.
 *  - `cli-worker`  A `shogo worker` CLI instance on a self-hosted host
 *                  (VPS, dev VM, paired CI runner). cli-workers are
 *                  execution targets only — they do NOT host an
 *                  apps/api, so stateful data still lives in the cloud.
 *                  Studio must NOT tunnel `/api/projects` etc. through
 *                  a cli-worker; those calls go to cloud directly.
 *
 * Wire format matches `formatInstanceKind` in
 * `apps/api/src/routes/instances.ts`.
 */
export type InstanceKind = 'desktop' | 'cli-worker'

export interface ActiveInstance {
  instanceId: string
  name: string
  hostname: string
  workspaceId: string
  /**
   * Kind of remote (desktop vs cli-worker). Optional for backward-
   * compatibility with state persisted by older clients that didn't
   * record this field; consumers that need to gate on it should treat
   * `undefined` as "unknown" and fall back to safe-for-both behavior
   * (no remote tunneling of stateful APIs). The validation poll re-
   * fetches `/api/instances/:id` and rehydrates the kind, so the
   * window where this is unknown is at most one poll.
   */
  kind?: InstanceKind
  /**
   * Where this instance came from. `'local'` (or `undefined` for
   * older persisted state) means the local API's own registry;
   * any other value is the hostname of the cloud upstream the
   * local API federated the row from (e.g.
   * `studio.staging.shogo.ai`). Used by `useInstancePicker` to
   * decide whether the auto-clear-on-workspace-change effect
   * applies — federated rows are cloud-scoped and survive local
   * workspace switches.
   */
  origin?: string
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
  const validationRef = useRef({ apiUrl, fetchFn, fetchOptions })

  validationRef.current = { apiUrl, fetchFn, fetchOptions }

  useEffect(() => {
    storage
      .getItem(STORAGE_KEY)
      .then(async (raw) => {
        if (!raw) return
        try {
          const restored: ActiveInstance = JSON.parse(raw)
          const validation = validationRef.current
          const result = await validateInstance(
            restored,
            validation.apiUrl,
            validation.fetchFn,
            validation.fetchOptions,
          )
          if (result.valid) {
            // Hydrate `kind` from the validation response. Older clients
            // persisted instances without this field and the SDKDomainProvider's
            // remote-API gating depends on it — re-storing here keeps
            // subsequent loads on the new shape so the gate kicks in
            // immediately on the next mount instead of after the first poll.
            const hydrated: ActiveInstance = result.kind ? { ...restored, kind: result.kind } : restored
            setInstanceState(hydrated)
            setInstanceStatus(result.status ?? 'unknown')
            if (result.kind && restored.kind !== result.kind) {
              storage.setItem(STORAGE_KEY, JSON.stringify(hydrated)).catch(() => {})
            }
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
  }, [apiUrl, storage])

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
      const validation = validationRef.current
      const result = await validateInstance(
        instance,
        validation.apiUrl,
        validation.fetchFn,
        validation.fetchOptions,
      )
      if (cancelled) return
      if (!result.valid) {
        // Instance was deleted or no longer belongs to this workspace.
        setInstanceStatus('offline')
        return
      }
      setInstanceStatus(result.status ?? 'unknown')
      // Late-arriving `kind` (older clients persisted without it). Update
      // the in-memory instance so SDKDomainProvider's remote gating
      // takes effect on the next render without waiting for re-mount.
      if (result.kind && instance.kind !== result.kind) {
        const refreshed = { ...instance, kind: result.kind }
        setInstanceState(refreshed)
        storage.setItem(STORAGE_KEY, JSON.stringify(refreshed)).catch(() => {})
      }
    }
    void tick()
    const id = setInterval(tick, 15000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [instance, apiUrl, storage])

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
): Promise<{ valid: boolean; status?: InstanceStatus; kind?: InstanceKind }> {
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
    const kind: InstanceKind | undefined =
      data.kind === 'desktop' || data.kind === 'cli-worker' ? data.kind : undefined
    return { valid: true, status, kind }
  } catch {
    return { valid: false }
  }
}

// ─── Remote-routing gate ───────────────────────────────────────────────────

/**
 * Decide whether Studio should route stateful API calls
 * (`/api/projects`, `/api/chat-sessions`, `/api/chat-messages`,
 * `/api/folders`, `/api/starred-projects`, `/api/tool-call-logs`) through
 * the cloud's transparent proxy `/api/instances/<id>/p/*` to the
 * currently-selected remote instance, or keep them on the cloud
 * backend.
 *
 * Returns the URL to pass as `SDKDomainProvider`'s `remoteProxyBaseUrl`,
 * or `null` to leave the interceptor disabled (Studio fetches data from
 * cloud).
 *
 * Decision matrix:
 *
 *   instance.kind     | remoteProxyBaseUrl   | rationale
 *   ──────────────────┼──────────────────────┼──────────────────────────────
 *   undefined (local) | null                 | no remote — cloud is canonical
 *   'desktop'         | remoteAgentBaseUrl   | desktop hosts apps/api locally;
 *                     |                      | tunnel to it for fresh data
 *   'cli-worker'      | null                 | cli-worker is execution-only
 *                     |                      | (no apps/api locally); tunnel
 *                     |                      | would 502 with code
 *                     |                      | CLI_WORKER_HAS_NO_DATA_API
 *   undefined (older  | null                 | safe default — better to read
 *   client persisted  |                      | from cloud than to brick the
 *   without `kind`)   |                      | sidebar with 502s
 *
 * Note that this only gates the SDKDomainProvider data API. Agent
 * execution still flows through `remoteAgentBaseUrl` regardless of
 * kind — see `apps/mobile/app/(app)/projects/[id]/_layout.tsx`'s
 * construction of `${remoteAgentBaseUrl}/api/projects/<id>/agent-proxy`,
 * which the worker tunnel forwards to the agent-runtime as `/agent/*`.
 *
 * Pure function on purpose: it has no React deps so unit tests can
 * exercise the decision matrix directly.
 */
export function computeRemoteProxyBaseUrl(
  instance: ActiveInstance | null | undefined,
  remoteAgentBaseUrl: string | null,
): string | null {
  if (!instance || !remoteAgentBaseUrl) return null
  if (instance.kind === 'desktop') return remoteAgentBaseUrl
  return null
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
