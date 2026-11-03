// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useWorkspaceHosts — the paired desktops that host workspaces, for the
 * switcher's host badge (SHO-285).
 *
 * A hosted workspace is a normal cloud workspace (`GET /workspaces` lists it,
 * with `hostInstanceId`); this hook only supplies each host's name and
 * presence so the row can say "Host: Russell's MacBook · online". It never
 * reads workspaces from the machine.
 *
 * Presence changes on the server without any event reaching the client, so the
 * list re-reads itself once per heartbeat window while the app is foreground.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { AppState } from "react-native"
import { API_URL } from "../lib/api"
import type { WorkspaceHostInfo, MachinePresence } from "../lib/workspace-entries"

/** Cloud presence is heartbeat-driven; one read per window keeps it inside 60 s. */
const POLL_MS = 30_000

interface MachineListItem {
  id: string
  name: string
  kind?: string
  status?: string
  lastSeenAt?: string | null
}

function toPresence(status: string | undefined): MachinePresence {
  return status === "online" || status === "heartbeat" || status === "offline" ? status : "offline"
}

export interface UseWorkspaceHostsResult {
  hosts: WorkspaceHostInfo[]
  error: string | null
  refresh: () => void
}

export function useWorkspaceHosts(): UseWorkspaceHostsResult {
  const [hosts, setHosts] = useState<WorkspaceHostInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!API_URL) return

    let live = true
    let appState = AppState.currentState
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    const foreground = () => appState === "active" || appState === null

    const clearPoll = () => {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
    }

    const load = async () => {
      try {
        const res = await fetch(`${API_URL}/api/machines`, { credentials: "include" })
        const body = await res.json().catch(() => ({}))
        if (!live) return
        if (!res.ok) {
          setError((body as any)?.error?.message ?? `Could not load your machines (HTTP ${res.status})`)
          return
        }
        setError(null)
        const list = ((body as any)?.machines ?? []) as MachineListItem[]
        setHosts(
          list.map((machine) => ({
            instanceId: machine.id,
            hostname: machine.name,
            kind: machine.kind,
            presence: toPresence(machine.status),
            lastSeenAt: machine.lastSeenAt ?? null,
          })),
        )
      } catch (err: any) {
        if (live) setError(err?.message ?? "Could not reach Shogo Cloud")
      }
    }

    const poll = async () => {
      if (!live || !foreground()) return
      await load()
      clearPoll()
      if (live && foreground()) pollTimer = setTimeout(() => void poll(), POLL_MS)
    }

    void poll()
    const appStateSubscription = AppState.addEventListener("change", (next) => {
      appState = next
      if (next === "active") void poll()
      else clearPoll()
    })

    return () => {
      live = false
      clearPoll()
      appStateSubscription.remove()
    }
  }, [nonce])

  return useMemo(() => ({ hosts, error, refresh }), [hosts, error, refresh])
}
