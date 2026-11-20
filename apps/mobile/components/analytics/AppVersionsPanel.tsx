// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop installs: adoption area chart, version-share bar, and OS ring.
 *
 * Replaces the old version×OS table (SHO-477). The three charts answer the
 * questions an admin actually asks: "is the new release rolling out?", "what
 * share is each version?", and "what OS are my users on?"
 *
 * The filter chips (All / macOS / Windows / Linux / CLI) drive all three charts:
 * - All   → desktop devices, all OSes (OS ring visible)
 * - macOS / Windows / Linux → desktop devices on that OS (OS ring shows that OS)
 * - CLI   → CLI devices only (OS ring hidden)
 */

import { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native'
import Svg, { Circle, G } from 'react-native-svg'
import { cn } from '@shogo/shared-ui/primitives'
import { STACKED_PALETTE, StackedAreaChart, type StackedDay, type StackedSeries } from './StackedAreaChart'
import { shareRingSegments, seriesColor } from '../../lib/engagement-utils'

export type DeviceOsKey = 'macos' | 'windows' | 'linux' | 'unknown'
export type ReleaseChannel = 'stable' | 'beta'

export interface AppVersionOsCounts {
  macos: number
  windows: number
  linux: number
  unknown: number
}

export interface AppVersionRow {
  version: string
  channel: ReleaseChannel
  devices: number
  activeD7: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  os: AppVersionOsCounts
}

export interface AppVersionOsRow {
  os: DeviceOsKey
  arch: string | null
  devices: number
  active1d: number
  active7d: number
  active30d: number
}

export interface AppVersionOnLatest {
  version: string
  devices: number
  pct: number
  source: 'deployed' | 'inferred'
}

/** Shape of `/admin/analytics/app-installs` segments (desktop / cli / mobile). */
export interface InstallSegment {
  totalDevices: number
  active: { d1: number; d7: number; d30: number }
  newLast30d: number
  byVersion: Array<{ version: string; count: number; activeD7: number }>
  byPlatform: Array<{ platform: string; count: number }>
  distinctUsers: number
  byOs: AppVersionOsRow[]
  versions: AppVersionRow[]
  onLatest: AppVersionOnLatest | null
}

/** One point from `/admin/analytics/app-versions` → `adoption[]`. */
export interface AppVersionAdoptionPoint {
  date: string
  version: string
  channel: ReleaseChannel
  client: 'desktop' | 'cli' | 'unknown'
  os: 'macos' | 'windows' | 'linux' | 'unknown'
  devices: number
}

type FilterKey = 'all' | 'macos' | 'windows' | 'linux' | 'cli'

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'macos', label: 'macOS' },
  { key: 'windows', label: 'Windows' },
  { key: 'linux', label: 'Linux' },
  { key: 'cli', label: 'CLI' },
]

const OS_LABELS: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }
const OS_KEYS: Array<Exclude<DeviceOsKey, 'unknown'>> = ['macos', 'windows', 'linux']

const WIDE_LAYOUT_MIN_WIDTH = 640

/** Max version series shown individually; the rest fold into "Older". */
const MAX_VERSION_SERIES = 5

/** Neutral grey for the "Older" bucket. */
const OLDER_COLOR = '#94a3b8'

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural
}

function osTotal(segment: InstallSegment, key: Exclude<DeviceOsKey, 'unknown'>): number {
  let total = 0
  for (const row of segment.versions ?? []) total += row.os[key] ?? 0
  return total
}

function filterAdoption(points: AppVersionAdoptionPoint[], filter: FilterKey): AppVersionAdoptionPoint[] {
  if (filter === 'cli') return points.filter((p) => p.client === 'cli')
  if (filter === 'all') return points.filter((p) => p.client !== 'cli')
  return points.filter((p) => p.client !== 'cli' && p.os === filter)
}

/** Build series for the area chart: top-N versions + "Older". Deployed version gets index 0. */
function buildVersionSeries(
  points: AppVersionAdoptionPoint[],
  deployedVersion: string | null,
): { series: StackedSeries[]; days: StackedDay[] } {
  if (points.length === 0) return { series: [], days: [] }

  // Collect all unique days (sorted ascending) and all versions.
  const daysSet = new Set<string>()
  const versionTotals = new Map<string, number>()
  for (const p of points) {
    daysSet.add(p.date)
    versionTotals.set(p.version, (versionTotals.get(p.version) ?? 0) + p.devices)
  }

  // Sort days ascending for the chart.
  const sortedDays = [...daysSet].sort()

  // Rank versions by total devices. Deployed version sorts first.
  const ranked = [...versionTotals.entries()].sort(([va, ta], [vb, tb]) => {
    if (va === deployedVersion) return -1
    if (vb === deployedVersion) return 1
    return tb - ta
  })

  const topVersions = ranked.slice(0, MAX_VERSION_SERIES).map(([v]) => v)
  const hasOlder = ranked.length > MAX_VERSION_SERIES

  // Assign stable colors: deployed version → STACKED_PALETTE[0].
  const series: StackedSeries[] = topVersions.map((v, i) => ({
    id: v,
    label: v,
    color: seriesColor(v === 'Other' ? '__never__' : v, i, STACKED_PALETTE),
  }))
  if (hasOlder) {
    series.push({ id: '__older__', label: 'Older', color: OLDER_COLOR })
  }

  // Aggregate per day.
  const dayMap = new Map<string, Record<string, number>>()
  for (const day of sortedDays) dayMap.set(day, {})
  for (const p of points) {
    const bucket = topVersions.includes(p.version) ? p.version : '__older__'
    if (!hasOlder && bucket === '__older__') continue
    const dayValues = dayMap.get(p.date)!
    dayValues[bucket] = (dayValues[bucket] ?? 0) + p.devices
  }

  const days: StackedDay[] = sortedDays.map((date) => ({
    date,
    values: dayMap.get(date) ?? {},
  }))

  return { series, days }
}

/** Fraction of each version on the most-recent day in the adoption array. */
function todayShareData(
  points: AppVersionAdoptionPoint[],
  topVersions: string[],
  hasOlder: boolean,
): Array<{ id: string; pct: number; devices: number }> {
  if (points.length === 0) return []
  const latestDay = points.map((p) => p.date).sort().at(-1)!
  const todayPoints = points.filter((p) => p.date === latestDay)
  const total = todayPoints.reduce((s, p) => s + p.devices, 0)
  if (total === 0) return []

  const counts = new Map<string, number>()
  for (const p of todayPoints) {
    const bucket = topVersions.includes(p.version) ? p.version : '__older__'
    if (!hasOlder && bucket === '__older__') continue
    counts.set(bucket, (counts.get(bucket) ?? 0) + p.devices)
  }

  return [...counts.entries()]
    .sort(([a], [b]) => {
      const ai = topVersions.indexOf(a)
      const bi = topVersions.indexOf(b)
      if (ai === -1 && bi === -1) return 0
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
    .map(([id, devices]) => ({ id, devices, pct: (devices / total) * 100 }))
}

// ---------------------------------------------------------------------------
// OS Ring
// ---------------------------------------------------------------------------

const OS_RING_SIZE = 100
const OS_RING_STROKE = 14
const OS_RING_RADIUS = (OS_RING_SIZE - OS_RING_STROKE) / 2
const OS_RING_PALETTE = ['#3b82f6', '#10b981', '#f97316', '#94a3b8']

function OsRing({ counts }: { counts: Array<{ os: string; devices: number }> }) {
  const total = counts.reduce((s, r) => s + r.devices, 0)
  if (total === 0) return null

  const shares = counts.map((r) => ({ id: r.os, pct: (r.devices / total) * 100 }))
  const segments = shareRingSegments(shares, OS_RING_RADIUS)

  return (
    <View className="flex-row items-center gap-4 flex-wrap">
      <View style={{ width: OS_RING_SIZE, height: OS_RING_SIZE }}>
        <Svg width={OS_RING_SIZE} height={OS_RING_SIZE}>
          <G rotation={-90} origin={`${OS_RING_SIZE / 2}, ${OS_RING_SIZE / 2}`}>
            <Circle
              cx={OS_RING_SIZE / 2}
              cy={OS_RING_SIZE / 2}
              r={OS_RING_RADIUS}
              stroke="#94a3b8"
              strokeOpacity={0.15}
              strokeWidth={OS_RING_STROKE}
              fill="none"
            />
            {segments.map((seg, i) => (
              <Circle
                key={seg.id}
                cx={OS_RING_SIZE / 2}
                cy={OS_RING_SIZE / 2}
                r={OS_RING_RADIUS}
                fill="none"
                stroke={OS_RING_PALETTE[i % OS_RING_PALETTE.length]}
                strokeWidth={OS_RING_STROKE}
                strokeDasharray={`${seg.dash} ${seg.gap}`}
                strokeDashoffset={seg.offset}
              />
            ))}
          </G>
        </Svg>
      </View>
      <View className="flex-1 min-w-[120px] gap-1.5">
        {counts.map((r, i) => (
          <View key={r.os} className="flex-row items-center gap-2">
            <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: OS_RING_PALETTE[i % OS_RING_PALETTE.length] }} />
            <Text className="text-xs text-foreground flex-1">{OS_LABELS[r.os] ?? r.os}</Text>
            <Text className="text-xs text-muted-foreground">{r.devices.toLocaleString()}</Text>
            <Text className="text-xs font-medium text-foreground w-10 text-right">
              {((r.devices / total) * 100).toFixed(1)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Horizontal version share bar
// ---------------------------------------------------------------------------

function VersionShareBar({
  shares,
  series,
}: {
  shares: Array<{ id: string; pct: number; devices: number }>
  series: StackedSeries[]
}) {
  if (shares.length === 0) return null
  const colorMap = new Map(series.map((s) => [s.id, s.color]))

  return (
    <View className="gap-2">
      <Text className="text-xs font-medium text-muted-foreground">Version share today</Text>
      <View className="flex-row h-5 rounded-full overflow-hidden">
        {shares.map((s) => (
          <View
            key={s.id}
            style={{ flex: s.pct, backgroundColor: colorMap.get(s.id) ?? OLDER_COLOR }}
          />
        ))}
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        {shares.map((s) => (
          <View key={s.id} className="flex-row items-center gap-1.5">
            <View className="h-2 w-2 rounded-full" style={{ backgroundColor: colorMap.get(s.id) ?? OLDER_COLOR }} />
            <Text className="text-xs text-foreground">{s.id === '__older__' ? 'Older' : s.id}</Text>
            <Text className="text-xs text-muted-foreground">· {s.pct.toFixed(1)}%</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function AppVersionsPanel({
  desktop,
  cli,
  adoption = [],
}: {
  desktop: InstallSegment
  cli?: InstallSegment | null
  adoption?: AppVersionAdoptionPoint[]
}) {
  const [filter, setFilter] = useState<FilterKey>('all')
  const { width } = useWindowDimensions()

  const activeSegment: InstallSegment | null = filter === 'cli' ? (cli ?? null) : desktop

  const latest = desktop.onLatest
  const desktopCount = desktop.totalDevices

  // Filtered adoption points.
  const filteredAdoption = useMemo(() => filterAdoption(adoption, filter), [adoption, filter])

  // Build the area chart series/days from filtered adoption.
  const { series, days } = useMemo(
    () => buildVersionSeries(filteredAdoption, latest?.version ?? null),
    [filteredAdoption, latest?.version],
  )

  const topVersions = series.filter((s) => s.id !== '__older__').map((s) => s.id)
  const hasOlder = series.some((s) => s.id === '__older__')

  const shareData = useMemo(
    () => todayShareData(filteredAdoption, topVersions, hasOlder),
    [filteredAdoption, topVersions, hasOlder],
  )

  // OS ring: aggregate from desktop segment versions.
  const osCounts = useMemo(() => {
    if (filter === 'cli') return []
    if (filter !== 'all') {
      const total = activeSegment ? osTotal(activeSegment, filter) : 0
      return total > 0 ? [{ os: filter, devices: total }] : []
    }
    return OS_KEYS
      .map((key) => ({ os: key, devices: osTotal(desktop, key) }))
      .filter((r) => r.devices > 0)
  }, [filter, desktop, activeSegment])

  return (
    <View className="rounded-xl border border-border/50 bg-muted/20 p-4 gap-4">
      {/* Headline */}
      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">Desktop versions</Text>
        <Text className="text-base font-bold text-foreground" testID="app-versions-headline">
          {latest
            ? `${latest.devices.toLocaleString()} of ${desktopCount.toLocaleString()} ${pluralize(desktopCount, 'desktop device')} on ${latest.version} (${latest.pct}%)`
            : `${desktopCount.toLocaleString()} ${pluralize(desktopCount, 'desktop device')} signed in — deployed release tag unknown`}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {latest
            ? latest.source === 'deployed'
              ? 'Compared against the release this API is running.'
              : 'This deployment pins no release tag, so the newest version seen is used.'
            : 'Set APP_VERSION on the api deployment to compare installs against a release.'}
        </Text>
      </View>

      {/* Filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {FILTERS.map((chip) => {
          const selected = filter === chip.key
          const segmentForChip = chip.key === 'cli' ? cli : desktop
          const count =
            chip.key === 'cli'
              ? segmentForChip?.totalDevices ?? 0
              : chip.key === 'all'
                ? desktop.totalDevices
                : segmentForChip
                  ? osTotal(segmentForChip, chip.key)
                  : 0
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
                {chip.label} · {count.toLocaleString()}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>

      {/* Adoption area chart */}
      {days.length > 0 ? (
        <View className="gap-1">
          <Text className="text-xs font-medium text-muted-foreground">Devices on each version</Text>
          <StackedAreaChart
            days={days}
            series={series}
            height={200}
            variant="area"
            formatY={(n) => String(Math.round(n))}
            formatTooltip={(n) => String(Math.round(n))}
            markToday={false}
          />
        </View>
      ) : (
        <Text className="text-xs text-muted-foreground">No adoption data for this filter</Text>
      )}

      {/* Version share today */}
      {shareData.length > 0 && (
        <VersionShareBar shares={shareData} series={series} />
      )}

      {/* OS ring (hidden for CLI) */}
      {filter !== 'cli' && osCounts.length > 0 && (
        <View className="gap-1">
          <Text className="text-xs font-medium text-muted-foreground">OS split</Text>
          <OsRing counts={osCounts} />
        </View>
      )}
    </View>
  )
}
