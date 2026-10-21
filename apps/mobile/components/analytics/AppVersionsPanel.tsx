// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop installs: one row per (version, channel) with macOS / Windows / Linux
 * device counts, an OS filter and the "N of M on <tag>" headline.
 *
 * Replaces the old `byVersion.slice(0, 4)` / `byPlatform.slice(0, 4)` lists,
 * which could never show the 66 (OS, version) pairs production actually has and
 * counted `darwin-arm64` as a second operating system.
 */

import { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'

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

type FilterKey = 'all' | 'macos' | 'windows' | 'linux' | 'cli'

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'macos', label: 'macOS' },
  { key: 'windows', label: 'Windows' },
  { key: 'linux', label: 'Linux' },
  { key: 'cli', label: 'CLI' },
]

const OS_COLUMNS: Array<{ key: Exclude<DeviceOsKey, 'unknown'>; label: string }> = [
  { key: 'macos', label: 'macOS' },
  { key: 'windows', label: 'Windows' },
  { key: 'linux', label: 'Linux' },
]

const WIDE_LAYOUT_MIN_WIDTH = 640

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function osTotal(segment: InstallSegment, key: Exclude<DeviceOsKey, 'unknown'>): number {
  let total = 0
  for (const row of segment.versions ?? []) total += row.os[key] ?? 0
  return total
}

export function AppVersionsPanel({
  desktop,
  cli,
}: {
  desktop: InstallSegment
  cli?: InstallSegment | null
}) {
  const [filter, setFilter] = useState<FilterKey>('all')
  const { width } = useWindowDimensions()
  const wide = width >= WIDE_LAYOUT_MIN_WIDTH

  const activeSegment: InstallSegment | null = filter === 'cli' ? (cli ?? null) : desktop
  const osKey = filter === 'macos' || filter === 'windows' || filter === 'linux' ? filter : null

  const rows = useMemo(() => {
    const all = activeSegment?.versions ?? []
    const filtered = osKey ? all.filter((row) => (row.os[osKey] ?? 0) > 0) : all
    return [...filtered].sort(
      (a, b) =>
        (osKey ? (b.os[osKey] ?? 0) - (a.os[osKey] ?? 0) : b.devices - a.devices) ||
        b.devices - a.devices ||
        b.version.localeCompare(a.version, undefined, { numeric: true }),
    )
  }, [activeSegment, osKey])

  const latest = desktop.onLatest
  const desktopCount = desktop.totalDevices

  return (
    <View className="rounded-xl border border-border/50 bg-muted/20 p-4 gap-4">
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

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {FILTERS.map((chip) => {
          const selected = filter === chip.key
          const segmentForChip = chip.key === 'cli' ? cli : desktop
          const count = chip.key === 'cli'
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
                {chip.label} · {count.toLocaleString()}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>

      {rows.length === 0 ? (
        <Text className="text-xs text-muted-foreground">No device data for this filter</Text>
      ) : wide ? (
        <View className="gap-1">
          <View className="flex-row items-center gap-2 border-b border-border/60 pb-2">
            <Text className="flex-1 text-xs font-medium text-muted-foreground">Version</Text>
            {OS_COLUMNS.map((column) => (
              <Text
                key={column.key}
                className="w-16 text-right text-xs font-medium text-muted-foreground"
              >
                {column.label}
              </Text>
            ))}
            <Text className="w-12 text-right text-xs font-medium text-muted-foreground">7d</Text>
            <Text className="w-20 text-right text-xs font-medium text-muted-foreground">Last seen</Text>
          </View>
          {rows.map((row) => (
            <View key={`${row.version}-${row.channel}`} className="flex-row items-center gap-2 py-1">
              <View className="flex-1 flex-row items-center gap-1.5">
                <Text className="text-xs text-foreground">{row.version}</Text>
                {row.channel === 'beta' && (
                  <Text className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600">
                    Beta
                  </Text>
                )}
              </View>
              {OS_COLUMNS.map((column) => (
                <Text key={column.key} className="w-16 text-right text-xs text-foreground">
                  {(row.os[column.key] ?? 0).toLocaleString()}
                </Text>
              ))}
              <Text className="w-12 text-right text-xs text-muted-foreground">
                {row.activeD7.toLocaleString()}
              </Text>
              <Text className="w-20 text-right text-xs text-muted-foreground">
                {formatLastSeen(row.lastSeenAt)}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <View className="gap-2">
          {rows.map((row) => (
            <View
              key={`${row.version}-${row.channel}`}
              className="rounded-lg border border-border/50 bg-card p-3 gap-1.5"
            >
              <View className="flex-row items-center justify-between gap-2">
                <View className="flex-row items-center gap-1.5 flex-wrap">
                  <Text className="text-sm font-semibold text-foreground">{row.version}</Text>
                  {row.channel === 'beta' && (
                    <Text className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600">
                      Beta
                    </Text>
                  )}
                </View>
                <Text className="text-xs text-muted-foreground">
                  {formatLastSeen(row.lastSeenAt)}
                </Text>
              </View>
              <View className="flex-row items-center gap-4 flex-wrap">
                {OS_COLUMNS.map((column) => (
                  <Text key={column.key} className="text-xs text-muted-foreground">
                    {column.label}{' '}
                    <Text className="text-xs font-semibold text-foreground">
                      {(row.os[column.key] ?? 0).toLocaleString()}
                    </Text>
                  </Text>
                ))}
                <Text className="text-xs text-muted-foreground">
                  Active 7d <Text className="text-xs font-semibold text-foreground">{row.activeD7.toLocaleString()}</Text>
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
