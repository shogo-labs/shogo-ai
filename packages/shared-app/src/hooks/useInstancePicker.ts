// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useInstancePicker — Platform-agnostic business logic for the instance picker.
 *
 * Handles instance list fetching, connection requests with polling, and
 * disconnect. The hook is pure React state — no UI — so any consumer
 * (mobile, web, desktop) can build its own UI on top.
 */

import { useState, useEffect, useCallback } from 'react'
import type { ActiveInstance } from './useActiveInstance'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Instance {
  id: string
  name: string
  hostname: string
  status: 'online' | 'heartbeat' | 'offline'
  workspaceId: string
  os?: string | null
  lastSeenAt?: string | null
  /**
   * Kind of remote machine the instance represents. Mirrors the wire
   * format from `apps/api`'s `formatInstanceKind`. Studio uses this
   * to decide whether stateful API calls (`/api/projects` etc.)
   * should be tunneled to the instance (desktop) or kept on the
   * cloud backend (cli-worker).
   */
  kind?: 'desktop' | 'cli-worker'
  /**
   * Where this instance row came from. `'local'` means the local API's
   * own registry; any other value is the hostname of the upstream cloud
   * the local API federated the row from (e.g. `studio.staging.shogo.ai`).
   * Set by `GET /api/instances` when `SHOGO_LOCAL_MODE=true` and a
   * cloud upstream is configured.
   */
  origin?: string
  /**
   * Name of the cloud workspace this machine's key was issued in. Returned by
   * `GET /api/instances?scope=owner`, which is the only list that can hold
   * machines from several workspaces at once.
   */
  workspaceName?: string | null
}

export interface UseInstancePickerOptions {
  workspaceId: string | undefined
  /**
   * `'workspace'` (default) lists the machines filed under the workspace the
   * picker is choosing a runtime for. `'owner'` lists every machine the signed-in
   * user registered, whichever cloud workspace is open — the Settings → Remote
   * control list, which must agree with the workspace switcher's.
   */
  scope?: 'workspace' | 'owner'
  apiUrl: string
  activeInstance: ActiveInstance | null
  setInstance: (inst: ActiveInstance) => void
  clearInstance: () => void
  /** Optional fetch wrapper (e.g. agentFetch with cookie injection). */
  fetchFn?: typeof fetch
  /** Extra options merged into every fetch (e.g. credentials). */
  fetchOptions?: RequestInit
  /** Max number of polls when waiting for a connect. Default 35 (70s — survives a full desktop idle poll cycle). */
  connectPollCount?: number
  /** Milliseconds between connect polls. Default 2000. */
  connectPollIntervalMs?: number
}

export interface UseInstancePickerResult {
  instances: Instance[]
  loading: boolean
  connecting: string | null
  connectError: string | null
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
  refresh: () => Promise<void>
  select: (inst: Instance) => Promise<void>
  disconnect: () => void
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useInstancePicker({
  workspaceId,
  scope = 'workspace',
  apiUrl,
  activeInstance,
  setInstance,
  clearInstance,
  fetchFn = fetch,
  fetchOptions,
  connectPollCount = 35,
  connectPollIntervalMs = 2000,
}: UseInstancePickerOptions): UseInstancePickerResult {
  const [isOpen, setIsOpen] = useState(false)
  const [instances, setInstances] = useState<Instance[]>([])
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)

  // Auto-clear when workspace changes. Federated instances (origin set
  // to the cloud host instead of `'local'`) are cloud-scoped: their
  // workspaceId is the cloud's, which never matches the local one.
  // Clearing them on every local workspace switch would defeat the
  // whole point of federation, so skip them here — the user can pick
  // a different machine explicitly via the picker.
  useEffect(() => {
    if (!activeInstance || !workspaceId) return
    // A machine workspace is not scoped to the cloud workspace on screen —
    // it belongs to the desktop. Clearing it on every cloud workspace switch
    // would eject the user from their own Mac (SHO-54).
    if (activeInstance.source === 'machine') return
    const isFederated = !!activeInstance.origin && activeInstance.origin !== 'local'
    if (isFederated) return
    if (activeInstance.workspaceId !== workspaceId) {
      clearInstance()
    }
  }, [activeInstance, workspaceId, clearInstance])

  const loadInstances = useCallback(async () => {
    if (scope === 'workspace' && !workspaceId) return
    setLoading(true)
    setConnectError(null)
    try {
      const query =
        scope === 'owner'
          ? 'scope=owner'
          : `workspaceId=${encodeURIComponent(workspaceId as string)}`
      const res = await fetchFn(`${apiUrl}/api/instances?${query}`, { ...fetchOptions })
      if (!res.ok) {
        setInstances([])
        return
      }
      const data = await res.json()
      setInstances((data.instances ?? []) as Instance[])
    } catch {
      setInstances([])
    } finally {
      setLoading(false)
    }
  }, [workspaceId, scope, apiUrl, fetchFn, fetchOptions])

  // Refresh when popover opens
  useEffect(() => {
    if (isOpen) loadInstances()
  }, [isOpen, loadInstances])

  const select = useCallback(
    async (inst: Instance) => {
      setConnectError(null)

      if (inst.status !== 'online') {
        setConnecting(inst.id)
        try {
          await fetchFn(`${apiUrl}/api/instances/${inst.id}/request-connect`, {
            method: 'POST',
            ...fetchOptions,
            headers: {
              'Content-Type': 'application/json',
              ...((fetchOptions?.headers as Record<string, string>) ?? {}),
            },
          })

          for (let i = 0; i < connectPollCount; i++) {
            await new Promise((r) => setTimeout(r, connectPollIntervalMs))
            // Poll the local API's list endpoint with the picker's
            // (local) workspaceId — NOT inst.workspaceId, which for
            // federated rows is the cloud workspace id the local
            // membership check would reject as 403.
            const listRes = await fetchFn(
              `${apiUrl}/api/instances?workspaceId=${encodeURIComponent(workspaceId ?? inst.workspaceId)}`,
              { ...fetchOptions },
            )
            if (!listRes.ok) continue
            const listData = await listRes.json()
            const updated = (listData.instances ?? []) as Instance[]
            const found = updated.find((u) => u.id === inst.id)
            if (found && found.status === 'online') {
              setInstance({
                instanceId: found.id,
                name: found.name,
                hostname: found.hostname,
                workspaceId: found.workspaceId,
                kind: found.kind,
                origin: found.origin,
              })
              setInstances(updated)
              setConnecting(null)
              setIsOpen(false)
              return
            }
          }
          setConnectError(
            `Could not connect to ${inst.name}. Make sure the desktop app is running.`,
          )
        } catch {
          setConnectError(
            `Failed to reach ${inst.name}. Check your network connection.`,
          )
        }
        setConnecting(null)
        return
      }

      // Already online — select immediately
      setInstance({
        instanceId: inst.id,
        name: inst.name,
        hostname: inst.hostname,
        workspaceId: inst.workspaceId,
        kind: inst.kind,
        origin: inst.origin,
      })
      setIsOpen(false)
    },
    [apiUrl, fetchFn, fetchOptions, setInstance, connectPollCount, connectPollIntervalMs, workspaceId],
  )

  const disconnect = useCallback(() => {
    clearInstance()
    setIsOpen(false)
  }, [clearInstance])

  return {
    instances,
    loading,
    connecting,
    connectError,
    isOpen,
    open: useCallback(() => setIsOpen(true), []),
    close: useCallback(() => setIsOpen(false), []),
    toggle: useCallback(() => setIsOpen((v) => !v), []),
    refresh: loadInstances,
    select,
    disconnect,
  }
}
