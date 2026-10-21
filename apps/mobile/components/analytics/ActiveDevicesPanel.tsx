// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which device is alive, not just how many.
 *
 * The version table answers "which builds are installed"; this answers "which
 * machines are still running" — one row per device with an online badge driven
 * by the desktop's 5-minute heartbeat. Stale keys are hidden by default, since
 * 89% of production's live keys had not been seen in 30 days and made counts
 * look far healthier than the product was.
 */

import { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'

export type ActiveDeviceClient = 'desktop' | 'cli' | 'unknown'
export type ActiveDeviceOs = 'macos' | 'windows' | 'linux' | 'unknown'

export interface ActiveDeviceRow {
  id: string
  client: ActiveDeviceClient
  os: ActiveDeviceOs
  osLabel: string
  arch: string | null
  version: string
  channel: 'stable' | 'beta'
  userId: string | null
  firstSeenAt: string
  lastSeenAt: string | null
  online: boolean
  idleHours: number | null
}

export interface ActiveDevicesData {
  generatedAt: string
  onlineWindowMinutes: number
  windowDays: number
  includeDormant: boolean
  totals: { devices: number; online: number; active: number; dormant: number }
  devices: ActiveDeviceRow[]
}

type FilterKey = 'all' | 'macos' | 'windows' | 'linux' | 'cli'

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'macos', label: 'macOS' },
  { key: 'windows', label: 'Windows' },
  { key: 'linux', label: 'Linux' },
  { key: 'cli', label: 'CLI' },
]

function matchesFilter(device: ActiveDeviceRow, filter: FilterKey): boolean {
  if (filter === 'all') return true
  if (filter === 'cli') return device.client === 'cli'
  return device.client !== 'cli' && device.os === filter
}

/** "just now" / "3h" / "12d" — the age of the last heartbeat. */
export function formatIdle(idleHours: number | null, online: boolean): string {
  if (online) return 'online'
  if (idleHours === null) return 'never'
  if (idleHours < 1) return `${Math.max(1, Math.round(idleHours * 60))}m`
  if (idleHours < 48) return `${Math.round(idleHours)}h`
  return `${Math.round(idleHours / 24)}d`
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural
}

export function ActiveDevicesPanel({
  data,
  loading = false,
}: {
  data: ActiveDevicesData | null
  loading?: boolean
}) {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [showDormant, setShowDormant] = useState(false)

  const windowDays = data?.windowDays ?? 7

  const visible = useMemo(() => {
    const all = data?.devices ?? []
    return all
      .filter((device) => matchesFilter(device, filter))
      .filter((device) => showDormant || device.online || isActiveWithin(device, windowDays))
  }, [data, filter, showDormant, windowDays])

  const counts = useMemo(() => {
    const all = (data?.devices ?? []).filter((device) => matchesFilter(device, filter))
    return {
      total: all.length,
      online: all.filter((device) => device.online).length,
      active: all.filter((device) => isActiveWithin(device, windowDays)).length,
    }
  }, [data, filter, windowDays])

  return (
    <View className="rounded-xl border border-border/50 bg-muted/20 p-4 gap-4">
      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">Active devices</Text>
        <Text className="text-base font-bold text-foreground" testID="active-devices-headline">
          {data
            ? `${counts.online.toLocaleString()} online now · ${counts.active.toLocaleString()} active in ${windowDays}d · ${data.totals.devices.toLocaleString()} live keys`
            : loading
              ? 'Loading devices…'
              : 'No device data'}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {data
            ? `Online means a heartbeat in the last ${data.onlineWindowMinutes} min (desktop every 5 min, mobile on foreground). ${data.totals.dormant.toLocaleString()} of ${data.totals.devices.toLocaleString()} keys are dormant.`
            : 'A device counts as online when its heartbeat is recent.'}
        </Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {FILTERS.map((chip) => {
          const selected = filter === chip.key
          const all = (data?.devices ?? []).filter((device) => matchesFilter(device, chip.key))
          return (
            <Pressable
              key={chip.key}
              onPress={() => setFilter(chip.key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              className={cn(
                'rounded-full border px-3 py-1.5',
                selected ? 'border-primary bg-primary/10' : 'border-border bg-card',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  selected ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                {chip.label} · {all.length.toLocaleString()}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>

      <Pressable
        onPress={() => setShowDormant((value) => !value)}
        accessibilityRole="switch"
        accessibilityState={{ checked: showDormant }}
        testID="active-devices-toggle"
      >
        <Text className="text-xs font-medium text-primary">
          {showDormant ? '◉' : '○'} Show dormant keys ({(data?.totals.dormant ?? 0).toLocaleString()})
        </Text>
      </Pressable>

      {visible.length === 0 ? (
        <Text className="text-xs text-muted-foreground">
          {data ? `No device active in the last ${windowDays} days — enable dormant keys to see them` : 'No device data for this filter'}
        </Text>
      ) : (
        <View className="gap-2">
          {visible.map((device) => (
            <View
              key={device.id}
              testID="active-device-row"
              className="flex-row items-center gap-3 rounded-lg border border-border/50 bg-card px-3 py-2"
            >
              <View
                className={cn(
                  'h-2 w-2 rounded-full',
                  device.online ? 'bg-green-500' : 'bg-muted-foreground/40',
                )}
              />
              <View className="flex-1 gap-0.5">
                <View className="flex-row items-center gap-1.5 flex-wrap">
                  <Text className="text-xs font-semibold text-foreground">{device.version}</Text>
                  <Text className="text-xs text-muted-foreground">{device.osLabel}</Text>
                  {device.channel === 'beta' && (
                    <Text className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600">
                      Beta
                    </Text>
                  )}
                  {device.client === 'cli' && (
                    <Text className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                      CLI
                    </Text>
                  )}
                </View>
                <Text className="text-[10px] text-muted-foreground">{device.id}</Text>
              </View>
              <Text
                className={cn(
                  'text-xs font-medium',
                  device.online ? 'text-green-600' : 'text-muted-foreground',
                )}
              >
                {formatIdle(device.idleHours, device.online)}
              </Text>
            </View>
          ))}
          {visible.length < counts.total && (
            <Text className="text-[10px] text-muted-foreground">
              Showing {visible.length.toLocaleString()} of {counts.total.toLocaleString()} {pluralize(counts.total, 'device')}
            </Text>
          )}
        </View>
      )}
    </View>
  )
}

function isActiveWithin(device: ActiveDeviceRow, days: number): boolean {
  if (device.online) return true
  if (device.idleHours === null) return false
  return device.idleHours <= days * 24
}
