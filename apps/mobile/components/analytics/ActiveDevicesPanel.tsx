// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Active devices: last-seen bar chart + per-machine list behind a disclosure.
 *
 * Replaces the flat per-device table (SHO-477). The chart answers "how many
 * machines are really alive?" by OS bucket; the per-device list is still there
 * for drill-down but stays collapsed by default.
 */

import { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  ActiveDevicesTrendChart,
  type DeviceActivityTimeseries,
} from './SharedAnalytics'
import { LoadErrorNotice } from './LoadErrorNotice'

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

export function isActiveWithin(device: ActiveDeviceRow, days: number): boolean {
  if (device.online) return true
  if (device.idleHours === null) return false
  return device.idleHours <= days * 24
}

// ---------------------------------------------------------------------------
// Recency buckets
// ---------------------------------------------------------------------------

export interface RecencyBucket {
  label: string
  osCounts: { os: ActiveDeviceOs; count: number }[]
  total: number
}

const BUCKET_ORDER = ['online', 'today', '1-7d', '7-30d', 'dormant'] as const
type BucketKey = (typeof BUCKET_ORDER)[number]

const BUCKET_LABELS: Record<BucketKey, string> = {
  online: 'Online now',
  today: 'Today',
  '1-7d': '1–7 days',
  '7-30d': '7–30 days',
  dormant: 'Dormant',
}

function deviceBucket(device: ActiveDeviceRow): BucketKey {
  if (device.online) return 'online'
  if (device.idleHours === null) return 'dormant'
  if (device.idleHours <= 24) return 'today'
  if (device.idleHours <= 7 * 24) return '1-7d'
  if (device.idleHours <= 30 * 24) return '7-30d'
  return 'dormant'
}

/**
 * Bucket devices by last-seen recency, stacked by OS.
 * Bucket boundaries agree with `isActiveWithin` and the `online` flag so
 * the headline counts and bar never disagree.
 */
export function bucketDevicesByRecency(devices: ActiveDeviceRow[]): RecencyBucket[] {
  const buckets = new Map<BucketKey, Map<ActiveDeviceOs, number>>()
  for (const key of BUCKET_ORDER) buckets.set(key, new Map())

  for (const device of devices) {
    const key = deviceBucket(device)
    const osCounts = buckets.get(key)!
    osCounts.set(device.os, (osCounts.get(device.os) ?? 0) + 1)
  }

  return BUCKET_ORDER.map((key) => {
    const osCounts = buckets.get(key)!
    const rows = [...osCounts.entries()].map(([os, count]) => ({ os, count }))
    return {
      label: BUCKET_LABELS[key],
      osCounts: rows,
      total: rows.reduce((s, r) => s + r.count, 0),
    }
  })
}

// ---------------------------------------------------------------------------
// Last-seen bar chart (stacked by OS)
// ---------------------------------------------------------------------------

const OS_COLORS: Record<ActiveDeviceOs, string> = {
  macos: '#3b82f6',
  windows: '#10b981',
  linux: '#f97316',
  unknown: '#94a3b8',
}
const OS_DISPLAY: Record<ActiveDeviceOs, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  unknown: 'Other',
}

function RecencyBarChart({ buckets }: { buckets: RecencyBucket[] }) {
  const maxTotal = Math.max(...buckets.map((b) => b.total), 1)

  return (
    <View className="gap-2">
      {buckets.map((bucket) => (
        <View key={bucket.label} className="gap-0.5">
          <View className="flex-row items-center justify-between">
            <Text className="text-xs text-muted-foreground w-20">{bucket.label}</Text>
            <Text className="text-xs font-semibold text-foreground">
              {bucket.total.toLocaleString()}
            </Text>
          </View>
          <View className="flex-row h-4 rounded-sm overflow-hidden bg-muted/30" style={{ flex: 1 }}>
            {bucket.osCounts.map((r) => (
              <View
                key={r.os}
                style={{
                  flex: r.count / maxTotal,
                  backgroundColor: OS_COLORS[r.os],
                  opacity: 0.85,
                }}
              />
            ))}
          </View>
        </View>
      ))}
      {/* OS legend */}
      <View className="flex-row flex-wrap gap-x-4 gap-y-1 mt-1">
        {(Object.keys(OS_COLORS) as ActiveDeviceOs[])
          .filter((os) => buckets.some((b) => b.osCounts.some((r) => r.os === os && r.count > 0)))
          .map((os) => (
            <View key={os} className="flex-row items-center gap-1.5">
              <View className="h-2 w-2 rounded-full" style={{ backgroundColor: OS_COLORS[os] }} />
              <Text className="text-xs text-muted-foreground">{OS_DISPLAY[os]}</Text>
            </View>
          ))}
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function ActiveDevicesPanel({
  data,
  loading = false,
  trend = null,
  trendLoading = false,
  trendError = null,
}: {
  data: ActiveDevicesData | null
  loading?: boolean
  /** Devices-active-per-day series; null while it has never been recorded. */
  trend?: DeviceActivityTimeseries | null
  trendLoading?: boolean
  /** Set when `/analytics/devices-timeseries` failed, so a flat chart isn't read as "no devices". */
  trendError?: string | null
}) {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [showDormant, setShowDormant] = useState(false)
  const [showDevices, setShowDevices] = useState(false)

  const windowDays = data?.windowDays ?? 7

  const filteredDevices = useMemo(
    () => (data?.devices ?? []).filter((device) => matchesFilter(device, filter)),
    [data, filter],
  )

  const visible = useMemo(
    () =>
      filteredDevices.filter(
        (device) => showDormant || device.online || isActiveWithin(device, windowDays),
      ),
    [filteredDevices, showDormant, windowDays],
  )

  // Every count below comes from the same filtered set, so the headline's three
  // numbers add up and never pair a chip-filtered online count with a global
  // dormant one. `dormant` uses the API's rule (`!isActiveWithin`).
  const counts = useMemo(() => {
    const active = filteredDevices.filter((d) => isActiveWithin(d, windowDays)).length
    return {
      total: filteredDevices.length,
      online: filteredDevices.filter((d) => d.online).length,
      active,
      dormant: filteredDevices.length - active,
    }
  }, [filteredDevices, windowDays])

  const recencyBuckets = useMemo(
    () => bucketDevicesByRecency(filteredDevices),
    [filteredDevices],
  )

  return (
    <View className="rounded-xl border border-border/50 bg-muted/20 p-4 gap-4">
      {/* Headline */}
      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">Active devices</Text>
        <Text className="text-base font-bold text-foreground" testID="active-devices-headline">
          {data
            ? `${counts.online.toLocaleString()} online now · ${counts.active.toLocaleString()} active in ${windowDays}d · ${counts.dormant.toLocaleString()} dormant`
            : loading
              ? 'Loading devices…'
              : 'No device data'}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {data
            ? `Online means a heartbeat in the last ${data.onlineWindowMinutes} min (desktop every 5 min, mobile on foreground). Across all keys, ${data.totals.dormant.toLocaleString()} of ${data.totals.devices.toLocaleString()} are dormant.`
            : 'A device counts as online when its heartbeat is recent.'}
        </Text>
      </View>

      {/* Active devices over time (SHO-477 section 5) */}
      <View className="gap-1">
        <ActiveDevicesTrendChart data={trend} loading={trendLoading} />
        <LoadErrorNotice errors={trendError ? { 'the device activity trend': trendError } : {}} />
      </View>

      {/* Filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {FILTERS.map((chip) => {
          const selected = filter === chip.key
          const all = (data?.devices ?? []).filter((device) => matchesFilter(device, chip.key))
          return (
            <Pressable
              key={chip.key}
              onPress={() => setFilter(chip.key)}
              accessibilityRole="button"
              aria-selected={selected}
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

      {/* Last-seen recency bar chart */}
      {data ? (
        <RecencyBarChart buckets={recencyBuckets} />
      ) : (
        <Text className="text-xs text-muted-foreground">No device data for this filter</Text>
      )}

      {/* Per-device list behind disclosure */}
      {data && (
        <View className="gap-3">
          <Pressable
            onPress={() => setShowDevices((v) => !v)}
            accessibilityRole="button"
            testID="show-devices-toggle"
          >
            <Text className="text-xs font-medium text-primary">
              {showDevices ? '▾' : '▸'} Show devices ({filteredDevices.length.toLocaleString()})
            </Text>
          </Pressable>

          {showDevices && (
            <View className="gap-2">
              <Pressable
                onPress={() => setShowDormant((value) => !value)}
                accessibilityRole="switch"
                aria-checked={showDormant}
                testID="active-devices-toggle"
              >
                <Text className="text-xs font-medium text-primary">
                  {showDormant ? '◉' : '○'} Show dormant keys ({(data?.totals.dormant ?? 0).toLocaleString()})
                </Text>
              </Pressable>

              {visible.length === 0 ? (
                <Text className="text-xs text-muted-foreground">
                  {`No device active in the last ${windowDays} days — enable dormant keys to see them`}
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
          )}
        </View>
      )}
    </View>
  )
}
