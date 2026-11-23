// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A runtime whose work has not reached durable storage is one stop away from
 * losing it: a cold boot restores the durable copy, not what is in the guest.
 * On 2026-11-15 a workspace on fra-2 was marked UNTRUSTED and saved nothing for
 * a day and a half while the user kept working, and nothing in the UI said so
 * (SHO-442).
 *
 * The host now refuses to stop such a VM, so the work is not being deleted —
 * but it is also not being saved, and the user deserves to know before they
 * close the tab. This strip says which of the two states the runtime is in and
 * since when. It is deliberately NOT dismissible: a data-loss warning that can
 * be swiped away is a warning nobody sees twice.
 *
 * Mounted in `(app)` next to `AgentLimitBanner`, so it shows on web and desktop
 * alike. The project comes from the route, not from `useLastProjectContext`,
 * because that store is only populated by the phone bottom nav.
 */
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { usePathname } from 'expo-router'
import { AlertTriangle } from 'lucide-react-native'
import { Text } from './settings/account-sheet-chrome'
import { useDomainHttp } from '../contexts/domain'

/** `{state, since, lastSavedAt?, reason?}` from GET /projects/:id/runtime/status. */
export interface RuntimeDurability {
  state: 'ok' | 'saving-failing' | 'untrusted'
  since: number
  lastSavedAt?: number
  reason?: string
}

const POLL_MS = 30_000

function projectIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/\/(?:projects|project-chat|project-surface)\/([^/?]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

/** "3h 12m" — coarse on purpose; the exact second is not the point. */
export function formatUnsavedFor(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days}d ${restHours}h` : `${days}d`
}

export function DurabilityBanner() {
  const pathname = usePathname()
  const http = useDomainHttp()
  const projectId = projectIdFromPath(pathname)
  const [durability, setDurability] = useState<RuntimeDurability | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!projectId) {
      setDurability(null)
      return
    }
    let cancelled = false
    const read = async () => {
      try {
        const res = await http.get<{ durability?: RuntimeDurability }>(
          `/api/projects/${encodeURIComponent(projectId)}/runtime/status`,
        )
        if (cancelled || !alive.current) return
        setDurability(res.data?.durability ?? null)
        setNow(Date.now())
      } catch {
        // A status probe that fails says nothing about durability; keep the
        // last known state rather than flashing the banner off and on.
      }
    }
    void read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [projectId, http])

  if (!durability || durability.state === 'ok') return null

  const untrusted = durability.state === 'untrusted'
  const since = formatUnsavedFor(now - durability.since)
  return (
    <View
      testID="durability-banner"
      className={`flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-1.5 ${
        untrusted ? 'bg-error-700 dark:bg-error-100' : 'bg-warning-700 dark:bg-warning-100'
      }`}
    >
      <AlertTriangle size={12} className="text-white" />
      <Text className="text-xs font-medium text-white">
        Your latest changes aren&apos;t backed up yet (since {since} ago).
      </Text>
      <Text className="text-xs text-white/80">
        {untrusted
          ? "This workspace can't save to its history right now. We're keeping it running and retrying — don't close it."
          : "We're keeping this workspace running until they are."}
      </Text>
    </View>
  )
}
