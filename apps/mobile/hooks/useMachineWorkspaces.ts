// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useMachineWorkspaces — a paired desktop's own workspaces for the switcher
 * (SHO-54).
 *
 * Reads `/api/machines` (owner-scoped, across cloud workspaces) and then each
 * machine's `/api/machines/:id/workspaces`, which relays the desktop's
 * `/api/local/machine`. The list response already carries the last heartbeat
 * snapshot, so an offline machine still renders its last-known workspaces
 * instead of the group vanishing.
 *
 * Presence changes on the server without any event reaching the client, so the
 * list re-reads itself once per heartbeat window — otherwise the row keeps
 * whatever status it had when the switcher first mounted, and a machine that
 * was asleep at mount never gets its live workspaces.
 *
 * The live per-machine read is only made while that machine is online; the
 * relay wakes a sleeping machine, which must not happen on every poll.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AppState } from "react-native"
import { API_URL } from "../lib/api"
import type { MachineGroupData, MachinePresence } from "../components/layout/sidebar/MachineWorkspacesGroup"

/** Cloud presence is heartbeat-driven; one read per window keeps it inside 60 s. */
const POLL_MS = 30_000

interface MachineListItem {
  id: string
  name: string
  hostname?: string
  kind?: string
  status?: MachinePresence
  lastSeenAt?: string | null
  snapshot?: {
    workspaces?: MachineGroupData["workspaces"]
  } | null
}

function toPresence(status: string | undefined): MachinePresence {
  return status === "online" || status === "heartbeat" || status === "offline" ? status : "offline"
}

export interface UseMachineWorkspacesResult {
  machines: MachineGroupData[]
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useMachineWorkspaces(): UseMachineWorkspacesResult {
  const [machines, setMachines] = useState<MachineGroupData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  /** Polls must not flash the group's spinner — only the first load does. */
  const loadedOnce = useRef(false)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!API_URL) return

    let live = true
    let appState = AppState.currentState
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    // React Native can report null briefly during launch; treat that as foreground.
    const foreground = () => appState === "active" || appState === null

    const clearPoll = () => {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
    }
    const schedulePoll = () => {
      clearPoll()
      if (!live || !foreground()) return
      pollTimer = setTimeout(() => void poll(), POLL_MS)
    }

    const load = async () => {
      if (!loadedOnce.current) setLoading(true)
      setError(null)
      try {
        const res = await fetch(`${API_URL}/api/machines`, { credentials: "include" })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (live) {
            setMachines([])
            setError((body as any)?.error?.message ?? `Could not load your machines (HTTP ${res.status})`)
          }
          return
        }
        const list = ((body as any)?.machines ?? []) as MachineListItem[]
        if (!live) return

        // Render the cached snapshot immediately — an offline machine keeps its
        // rows (greyed) instead of disappearing from the switcher.
        const seeded: MachineGroupData[] = list.map((machine) => ({
          id: machine.id,
          name: machine.name,
          status: toPresence(machine.status),
          lastSeenAt: machine.lastSeenAt ?? null,
          stale: toPresence(machine.status) !== "online",
          workspaces: machine.snapshot?.workspaces ?? [],
        }))
        setMachines(seeded)

        // Only a machine with a live tunnel gets the extra read: the relay wakes
        // a sleeping one with a high-priority push, and then waits for it. Doing
        // that every poll would spam a laptop that is shut. Its rows stay on the
        // heartbeat snapshot until it is online again.
        const resolved = await Promise.all(
          seeded.map(async (machine) => {
            if (machine.status !== "online") return machine
            try {
              const wsRes = await fetch(`${API_URL}/api/machines/${machine.id}/workspaces`, {
                credentials: "include",
              })
              if (!wsRes.ok) return machine
              const wsBody = (await wsRes.json()) as any
              return {
                ...machine,
                status: toPresence(wsBody?.status ?? machine.status),
                stale: !!wsBody?.stale,
                workspaces: (wsBody?.workspaces ?? machine.workspaces) as MachineGroupData["workspaces"],
              }
            } catch {
              return machine
            }
          }),
        )
        if (live) setMachines(resolved)
      } catch (err: any) {
        if (live) {
          setMachines([])
          setError(err?.message ?? "Could not reach Shogo Cloud")
        }
      } finally {
        loadedOnce.current = true
        if (live) setLoading(false)
      }
    }

    const poll = async () => {
      if (!live || !foreground()) return
      await load()
      schedulePoll()
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

  return useMemo(() => ({ machines, loading, error, refresh }), [machines, loading, error, refresh])
}
