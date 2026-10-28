// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sync to cloud (Settings → Remote control)
 *
 * A paired desktop's records live on the desktop; the cloud keeps a copy so the
 * Studio can read them while the machine is asleep (SHO-185). This is the switch
 * that stops that copy: turning it off deletes it, so the thread that asked for
 * a machine workspace goes back to being purely local.
 *
 * The switch is on by default, reads `syncEnabled` from `GET /api/machines`, and
 * confirms before it deletes anything — turning it back on re-sends a full
 * snapshot rather than a stream of edits for rows the cloud no longer has.
 */

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Platform, Pressable, Switch, View } from 'react-native'
import { CloudOff, Cloud as CloudIcon } from 'lucide-react-native'
import { Text } from './account-sheet-chrome'
import { API_URL } from '../../lib/api'
import { authClient } from '../../lib/auth-client'

function getAuthHeaders(): Record<string, string> {
  if (Platform.OS === 'web') return {}
  const cookie = (authClient as any).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

interface MachineRow {
  id: string
  name: string
  status: 'online' | 'heartbeat' | 'offline'
  kind?: 'desktop' | 'cli-worker'
  syncEnabled?: boolean
  lastSyncedAt?: string | null
  /** A completed snapshot exists, so the cloud can read this machine's workspace. */
  copyReady?: boolean
  /** Why the last push was refused, as the desktop reported it (SHO-241). */
  lastSyncError?: string | null
  /** Change-log rows the desktop still has to push. */
  pendingChanges?: number | null
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function MachineSyncSettings() {
  const [rows, setRows] = useState<MachineRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchOptions: RequestInit = {
    credentials: Platform.OS === 'web' ? ('include' as const) : ('omit' as const),
    headers: { ...getAuthHeaders() },
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL ?? ''}/api/machines`, fetchOptions)
      if (!res.ok) {
        setError(`Could not load your machines (HTTP ${res.status})`)
        setRows([])
        return
      }
      const data = (await res.json()) as { machines?: MachineRow[] }
      setRows((data.machines ?? []).filter((row) => (row.kind ?? 'desktop') === 'desktop'))
      setError(null)
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setEnabled = useCallback(
    async (row: MachineRow, enabled: boolean) => {
      setBusyId(row.id)
      setError(null)
      try {
        const res = await fetch(`${API_URL ?? ''}/api/machines/${row.id}/sync-settings`, {
          ...fetchOptions,
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...fetchOptions.headers },
          body: JSON.stringify({ enabled }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
          setError(body.error?.message ?? `Could not change sync (HTTP ${res.status})`)
          return
        }
        await load()
      } catch (err: any) {
        setError(String(err?.message ?? err))
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

  const onToggle = useCallback(
    (row: MachineRow, next: boolean) => {
      if (next) {
        void setEnabled(row, true)
        return
      }
      Alert.alert(
        'Stop syncing this Mac?',
        `The cloud copy of ${row.name}'s workspace is deleted, so its projects and chats are only readable on the Mac until you turn this back on.`,
        [
          { text: 'Keep syncing', style: 'cancel' },
          { text: 'Delete the copy', style: 'destructive', onPress: () => void setEnabled(row, false) },
        ],
      )
    },
    [setEnabled],
  )

  if (loading) {
    return (
      <View className="flex-row items-center gap-2 py-3">
        <ActivityIndicator size="small" />
        <Text className="text-sm text-muted-foreground">Checking your machines…</Text>
      </View>
    )
  }

  if (!rows.length) return null

  return (
    <View className="mt-6">
      <Text className="text-sm font-semibold text-foreground">Sync to cloud</Text>
      <Text className="mt-1 text-xs leading-5 text-muted-foreground">
        Keep a read-only copy of this Mac's workspace in the cloud, so you can read it from
        another device while the Mac is asleep. Writes always go to the Mac.
      </Text>

      {error ? (
        <Text className="mt-2 text-xs text-destructive">{error}</Text>
      ) : null}

      <View className="mt-3 gap-2">
        {rows.map((row) => {
          const enabled = row.syncEnabled ?? true
          return (
            <View
              key={row.id}
              className="flex-row items-center justify-between rounded-xl border border-border bg-card px-3 py-3"
            >
              <View className="mr-3 flex-1">
                <View className="flex-row items-center gap-2">
                  {enabled ? (
                    <CloudIcon size={15} className="text-muted-foreground" />
                  ) : (
                    <CloudOff size={15} className="text-muted-foreground" />
                  )}
                  <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                    {row.name}
                  </Text>
                </View>
                <Text className="mt-1 text-xs text-muted-foreground">
                  {enabled
                    ? row.copyReady === false
                      ? row.status === 'offline'
                        ? 'No cloud copy yet — last synced never'
                        : `No cloud copy yet — first sync running${
                            row.pendingChanges ? ` (${row.pendingChanges} changes queued)` : ''
                          }`
                      : row.status === 'offline'
                        ? `Offline — last synced ${relativeTime(row.lastSyncedAt)}`
                        : `Last synced ${relativeTime(row.lastSyncedAt)}`
                    : 'Not syncing — the cloud has no copy of this Mac'}
                </Text>
                {enabled && row.lastSyncError ? (
                  <Text className="mt-1 text-xs text-destructive">
                    Sync error: {row.lastSyncError}
                  </Text>
                ) : null}
              </View>
              {busyId === row.id ? (
                <ActivityIndicator size="small" />
              ) : (
                <Pressable
                  accessibilityRole="switch"
                  accessibilityState={{ checked: enabled }}
                  accessibilityLabel={`Sync ${row.name} to cloud`}
                  onPress={() => onToggle(row, !enabled)}
                >
                  <Switch
                    value={enabled}
                    onValueChange={(next) => onToggle(row, next)}
                    pointerEvents="none"
                  />
                </Pressable>
              )}
            </View>
          )
        })}
      </View>
    </View>
  )
}
