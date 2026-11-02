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
  /**
   * The stored value, read synchronously — optional, and only implemented where
   * the storage can do it (web / desktop `localStorage`).
   *
   * Without this, a reloaded page paints before the async read and the network
   * validation have answered, and the selection appears a beat later — the
   * "flash" in SHO-130. With it, the selection is in view from the first render.
   */
  peekItem?(key: string): string | null
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
  const [instance, setInstanceState] = useState<ActiveInstance | null>(() =>
    readStoredInstance(storage),
  )
  const [instanceStatus, setInstanceStatus] = useState<InstanceStatus>('unknown')
  const validatedRef = useRef(false)
  const validationRef = useRef({ apiUrl, fetchFn, fetchOptions })

  validationRef.current = { apiUrl, fetchFn, fetchOptions }

  useEffect(() => {
    storage
      .getItem(STORAGE_KEY)
      .then(async (raw) => {
        if (!raw) return
        let restored: ActiveInstance
        try {
          restored = JSON.parse(raw)
        } catch {
          storage.removeItem(STORAGE_KEY).catch(() => {})
          validatedRef.current = true
          return
        }
        if (isRetiredMachineSelection(restored)) {
          storage.removeItem(STORAGE_KEY).catch(() => {})
          validatedRef.current = true
          return
        }
        // Paint the stored selection before asking the server about it. On web
        // the synchronous `peekItem` above has already done this; this covers
        // the async-storage platforms and the case where the peek was unavailable.
        setInstanceState((current) => current ?? restored)
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
          const hydrated = applyValidation(restored, result)
          setInstanceState(hydrated)
          setInstanceStatus(result.status ?? 'unknown')
          if (hydrated !== restored) {
            storage.setItem(STORAGE_KEY, JSON.stringify(hydrated)).catch(() => {})
          }
        } else if (result.unreachable) {
          // The server could not be asked (offline, a cold relay, a 5xx). That
          // is not evidence the machine was unpaired, so keep looking at it and
          // let the status poll settle it — dropping back to the cloud here is
          // the "flashes and stays in whatever workspace" half of SHO-130.
          setInstanceState(restored)
          setInstanceStatus('unknown')
        } else {
          setInstanceState(null)
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
  //
  // The poll must not restart because a poll *rewrote* the stored id: a machine
  // is named by whichever row the server picked, and rewriting it changes the
  // instance object. Depending on the object here re-ran the effect, which ran a
  // fresh tick, which rewrote the id again — 612,000 requests in one test run
  // when the server named the two rows alternately (SHO-241 §D). The identity of
  // the machine is its pairing (its workspace), not the
  // row id, so that is what this depends on; `instanceRef` keeps the tick reading
  // the freshest object without re-subscribing.
  const instanceRef = useRef(instance)
  instanceRef.current = instance

  useEffect(() => {
    if (!instance || !apiUrl) {
      setInstanceStatus('unknown')
      return
    }
    let cancelled = false
    const tick = async () => {
      const live = instanceRef.current
      if (!live) return
      const validation = validationRef.current
      const result = await validateInstance(
        live,
        validation.apiUrl,
        validation.fetchFn,
        validation.fetchOptions,
      )
      if (cancelled) return
      if (!result.valid) {
        // The server could not be asked (a cold relay, a 5xx, a dropped fetch).
        // That is not evidence the machine went away, and turning it into
        // `offline` fired the "stopped heartbeating" toast at a machine that was
        // heartbeating the whole time (SHO-241). Keep the last known status and
        // let the next tick settle it — with nothing known yet, `offline` is
        // still the honest answer, and it is what offers to wake the machine.
        if (result.unreachable) {
          setInstanceStatus((currentStatus) =>
            currentStatus === 'unknown' ? 'offline' : currentStatus,
          )
          return
        }
        // Instance was deleted or no longer belongs to this workspace.
        setInstanceStatus('offline')
        return
      }
      setInstanceStatus(result.status ?? 'unknown')
      // Late-arriving `kind` (older clients persisted without it). Update
      // the in-memory instance so SDKDomainProvider's remote gating
      // takes effect on the next render without waiting for re-mount.
      const refreshed = applyValidation(live, result)
      if (refreshed !== live) {
        setInstanceState((existing) => (existing ? applyValidation(existing, result) : existing))
        storage.setItem(STORAGE_KEY, JSON.stringify(refreshed)).catch(() => {})
      }
    }
    void tick()
    const id = setInterval(tick, 15000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the comment above
  }, [instance?.workspaceId, apiUrl, storage])

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

/**
 * The instance the last session left selected, read without awaiting anything.
 *
 * Only possible where the storage exposes a synchronous read (`localStorageAdapter`).
 * A corrupt value is treated as "nothing selected"; it is not the place to
 * clean up storage.
 */
/**
 * A selection stored by a build that opened a paired desktop's workspaces as a
 * "machine" (SHO-185). Those workspaces are normal workspaces now, listed by
 * `GET /workspaces` (SHO-285), so the old selection is dropped.
 */
const RETIRED_MACHINE_SOURCE = 'machine'

function isRetiredMachineSelection(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { source?: unknown }).source === RETIRED_MACHINE_SOURCE)
}

function readStoredInstance(storage: InstanceStorageAdapter): ActiveInstance | null {
  try {
    const raw = storage.peekItem?.(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ActiveInstance & { source?: string }
    if (!parsed || typeof parsed !== 'object' || !parsed.instanceId) return null
    return isRetiredMachineSelection(parsed) ? null : parsed
  } catch {
    return null
  }
}

/** What a validation poll learned about a live instance. */
type ValidationResult = {
  valid: boolean
  /**
   * The server could not be asked at all (network error, timeout, 5xx-ish).
   * Distinct from "asked and the answer was no": only the latter may clear the
   * stored selection.
   */
  unreachable?: boolean
  status?: InstanceStatus
  kind?: InstanceKind
  /**
   * The id this machine should be stored under, when the server's representative
   * row for it differs from the stored one. A machine has one `instances` row per
   * device key and the server names it by a stable one; a client that stored any
   * of the others would keep missing it (SHO-241).
   */
  instanceId?: string
}

/**
 * Fold a validation result into the stored instance, returning the *same*
 * object when nothing changed so callers can skip a re-render and a write.
 */
function applyValidation(inst: ActiveInstance, result: ValidationResult): ActiveInstance {
  const kindChanged = !!result.kind && result.kind !== inst.kind
  const idChanged = !!result.instanceId && result.instanceId !== inst.instanceId
  if (!kindChanged && !idChanged) return inst
  return {
    ...inst,
    ...(kindChanged ? { kind: result.kind } : {}),
    ...(idChanged ? { instanceId: result.instanceId } : {}),
  }
}

async function validateInstance(
  inst: ActiveInstance,
  apiUrl: string,
  fetchFn: typeof fetch,
  fetchOptions?: RequestInit,
): Promise<ValidationResult> {
  if (!apiUrl) return { valid: false }
  let res: Response
  try {
    res = await fetchFn(`${apiUrl}/api/instances/${inst.instanceId}`, {
      ...fetchOptions,
    })
  } catch {
    // Could not ask. Not the same as "the instance is gone" — the caller keeps
    // the last known status instead of reporting the machine offline (SHO-241).
    return { valid: false, unreachable: true }
  }
  if (res.status >= 500) return { valid: false, unreachable: true }
  try {
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
    return { valid: false, unreachable: true }
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
  // A `shogo worker` VM serves `/agent/*` and no data API, so its relay would
  // 502 every stateful call (SHO-120).
  if (instance.kind === 'cli-worker') return null
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
  /**
   * Same read as `getItem`, without the promise — so a provider mounting after
   * a reload paints the selection on its first render (see `readStoredInstance`).
   */
  peekItem(key) {
    if (typeof window === 'undefined') return null
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
}
