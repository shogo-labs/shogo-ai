// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ContentAnalyticsPanel
 *
 * Shared creator content-performance view used on BOTH the affiliate's own
 * content screen and the super-admin per-creator profile. Renders a date-range
 * selector, headline stat cards (views / engagement / likes / comments /
 * shares / posts with vs-previous-period deltas), a daily performance overview
 * chart, and a per-video stats list.
 *
 * Presentational + self-contained: the caller passes a `fetcher` that resolves
 * the analytics for a window (user endpoint vs admin endpoint), and this panel
 * owns the range/series/loading state.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, Linking } from 'react-native'
import Svg, { Path, Defs, LinearGradient, Stop, Line, Text as SvgText, Circle, G } from 'react-native-svg'
import {
  Eye,
  TrendingUp,
  ThumbsUp,
  MessageCircle,
  Share2,
  FileText,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { ContentAnalytics } from '../../lib/affiliate-api'

type SeriesId = 'views' | 'engagement' | 'likes' | 'comments' | 'shares'

interface MetricConfig {
  id: SeriesId | 'posts'
  label: string
  color: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}

const METRICS: MetricConfig[] = [
  { id: 'views', label: 'Views', color: '#3b82f6', icon: Eye },
  { id: 'engagement', label: 'Engagement', color: '#f97316', icon: TrendingUp },
  { id: 'likes', label: 'Likes', color: '#ef4444', icon: ThumbsUp },
  { id: 'comments', label: 'Comments', color: '#10b981', icon: MessageCircle },
  { id: 'shares', label: 'Shares', color: '#eab308', icon: Share2 },
  { id: 'posts', label: 'Posts', color: '#a855f7', icon: FileText },
]

/** Time-series metrics (everything except the discrete Posts count). */
const CHART_SERIES = METRICS.filter((m) => m.id !== 'posts') as (MetricConfig & { id: SeriesId })[]

const RANGE_PRESETS = [
  { id: '7', label: '7 days', days: 7 },
  { id: '28', label: '28 days', days: 28 },
  { id: '90', label: '90 days', days: 90 },
] as const

export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return String(Math.round(n))
}

function fmtDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function fmtDateShort(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return '—'
  }
}

export interface ContentAnalyticsPanelProps {
  /** Resolves analytics for a window. Return null when unavailable. */
  fetcher: (range: { from: string; to: string }) => Promise<ContentAnalytics | null>
  /** Re-fetch when this value changes (e.g. parent refresh counter). */
  refreshKey?: number
}

export function ContentAnalyticsPanel({ fetcher, refreshKey = 0 }: ContentAnalyticsPanelProps) {
  const [presetId, setPresetId] = useState<(typeof RANGE_PRESETS)[number]['id']>('7')
  const [data, setData] = useState<ContentAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'daily' | 'total'>('daily')
  const [hidden, setHidden] = useState<Set<SeriesId>>(new Set())

  const range = useMemo(() => {
    const days = RANGE_PRESETS.find((p) => p.id === presetId)?.days ?? 7
    const to = new Date()
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [presetId])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetcher(range)
      setData(res)
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status
      setError(status === 503 ? 'Content analytics are not available yet.' : 'Failed to load analytics.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [fetcher, range])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const toggleSeries = useCallback((id: SeriesId) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      // Never hide the last visible series.
      else if (next.size < CHART_SERIES.length - 1) next.add(id)
      return next
    })
  }, [])

  const visibleSeries = CHART_SERIES.filter((s) => !hidden.has(s.id))

  // Transform daily points into chart days; cumulative when mode === 'total'.
  const chartDays = useMemo(() => {
    if (!data) return []
    const running: Record<SeriesId, number> = { views: 0, engagement: 0, likes: 0, comments: 0, shares: 0 }
    return data.daily.map((d) => {
      const values: Record<string, number> = {}
      for (const s of CHART_SERIES) {
        const v = d[s.id]
        if (mode === 'total') {
          running[s.id] += v
          values[s.id] = running[s.id]
        } else {
          values[s.id] = v
        }
      }
      return { date: d.date, values }
    })
  }, [data, mode])

  return (
    <View className="rounded-xl border border-border bg-card p-4 gap-4">
      {/* Header + range presets */}
      <View className="flex-row items-center justify-between flex-wrap gap-2">
        <View className="flex-row items-center gap-2">
          <TrendingUp size={16} className="text-primary" />
          <Text className="text-sm font-semibold text-foreground">Content performance</Text>
        </View>
        <View className="flex-row gap-1.5">
          {RANGE_PRESETS.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => setPresetId(p.id)}
              className={cn(
                'px-2.5 py-1 rounded-md border active:opacity-80',
                presetId === p.id ? 'border-primary bg-primary/10' : 'border-border',
              )}
            >
              <Text
                className={cn(
                  'text-[11px] font-semibold',
                  presetId === p.id ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {loading ? (
        <View className="h-72 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View className="h-32 items-center justify-center">
          <Text className="text-sm text-muted-foreground">{error}</Text>
        </View>
      ) : !data || data.videos.length === 0 ? (
        <View className="h-32 items-center justify-center">
          <Text className="text-sm text-muted-foreground">No tracked videos yet.</Text>
          <Text className="text-xs text-muted-foreground mt-1">
            Stats appear once connected handles are polled.
          </Text>
        </View>
      ) : (
        <>
          {/* Stat cards */}
          <View className="flex-row flex-wrap gap-2">
            {METRICS.map((m) => (
              <StatCard
                key={m.id}
                metric={m}
                value={data.totals[m.id]}
                deltaPct={data.deltaPct[m.id]}
              />
            ))}
          </View>

          {/* Performance overview */}
          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              <Text className="text-xs font-semibold text-foreground">Performance overview</Text>
              <View className="flex-row rounded-md border border-border overflow-hidden">
                {(['daily', 'total'] as const).map((m) => (
                  <Pressable
                    key={m}
                    onPress={() => setMode(m)}
                    className={cn('px-2.5 py-1', mode === m ? 'bg-primary' : 'bg-transparent')}
                  >
                    <Text
                      className={cn(
                        'text-[11px] font-semibold',
                        mode === m ? 'text-primary-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {m === 'daily' ? 'Daily' : 'Running total'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <PerformanceChart days={chartDays} series={visibleSeries} />

            {/* Legend (tap to toggle) */}
            <View className="flex-row flex-wrap gap-x-4 gap-y-1.5 mt-1">
              {CHART_SERIES.map((s) => {
                const off = hidden.has(s.id)
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => toggleSeries(s.id)}
                    className="flex-row items-center gap-1.5 active:opacity-70"
                  >
                    <View
                      style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: off ? '#94a3b8' : s.color }}
                    />
                    <Text className={cn('text-[11px]', off ? 'text-muted-foreground line-through' : 'text-foreground')}>
                      {s.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </View>

          {/* Videos list */}
          <View className="gap-2">
            <Text className="text-xs font-semibold text-foreground">Videos ({data.videos.length})</Text>
            <View className="gap-1.5">
              {data.videos.slice(0, 50).map((v) => (
                <VideoRow key={v.id} video={v} />
              ))}
            </View>
          </View>
        </>
      )}
    </View>
  )
}

function StatCard({
  metric,
  value,
  deltaPct,
}: {
  metric: MetricConfig
  value: number
  deltaPct: number | null
}) {
  const Icon = metric.icon
  const deltaColor =
    deltaPct == null ? 'text-muted-foreground' : deltaPct >= 0 ? 'text-emerald-600' : 'text-red-600'
  const deltaText =
    deltaPct == null ? '—' : `${deltaPct >= 0 ? '+' : ''}${deltaPct}%`
  return (
    <View className="flex-1 min-w-[140px] rounded-lg border border-border bg-background p-3">
      <View className="flex-row items-center gap-1.5 mb-1.5">
        <Icon size={13} className="text-muted-foreground" />
        <Text className="text-[11px] font-medium text-muted-foreground">{metric.label}</Text>
      </View>
      <Text className="text-xl font-bold text-foreground tracking-tight">{compactNumber(value)}</Text>
      <Text className={cn('text-[10px] mt-0.5', deltaColor)}>{deltaText} vs previous period</Text>
    </View>
  )
}

function VideoRow({ video }: { video: ContentAnalytics['videos'][number] }) {
  const title = video.caption?.trim() || video.url || video.id
  const open = useCallback(() => {
    if (video.url) Linking.openURL(video.url).catch(() => {})
  }, [video.url])
  return (
    <Pressable
      onPress={open}
      disabled={!video.url}
      className="rounded-lg border border-border/60 px-3 py-2.5 gap-1.5 active:opacity-80"
    >
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text className="text-[10px] text-muted-foreground capitalize">{video.platform}</Text>
      </View>
      <View className="flex-row flex-wrap gap-x-3 gap-y-0.5">
        <Stat icon={Eye} value={video.views} />
        <Stat icon={ThumbsUp} value={video.likes} />
        <Stat icon={MessageCircle} value={video.comments} />
        <Stat icon={Share2} value={video.shares} />
        <Text className="text-[10px] text-muted-foreground">@{video.handle}</Text>
        <Text className="text-[10px] text-muted-foreground">{fmtDateShort(video.postedAt)}</Text>
        {video.periodViews > 0 ? (
          <Text className="text-[10px] text-emerald-600">+{compactNumber(video.periodViews)} this period</Text>
        ) : null}
      </View>
    </Pressable>
  )
}

function Stat({
  icon: Icon,
  value,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  value: number
}) {
  return (
    <View className="flex-row items-center gap-1">
      <Icon size={11} className="text-muted-foreground" />
      <Text className="text-[10px] text-foreground">{compactNumber(value)}</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Overlay multi-series area chart (pure react-native-svg)
// ---------------------------------------------------------------------------

const PADDING = { top: 16, right: 20, bottom: 26, left: 48 }

function PerformanceChart({
  days,
  series,
  height = 240,
}: {
  days: { date: string; values: Record<string, number> }[]
  series: { id: SeriesId; label: string; color: string }[]
  height?: number
}) {
  const [width, setWidth] = useState(720)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const innerW = Math.max(0, width - PADDING.left - PADDING.right)
  const innerH = Math.max(0, height - PADDING.top - PADDING.bottom)

  const yMax = useMemo(() => {
    let max = 0
    for (const d of days) for (const s of series) max = Math.max(max, d.values[s.id] ?? 0)
    return max
  }, [days, series])

  const niceMax = useMemo(() => {
    if (yMax <= 0) return 1
    const exp = Math.pow(10, Math.floor(Math.log10(yMax)))
    const candidates = [1, 2, 2.5, 5, 10].map((c) => c * exp)
    return candidates.find((c) => c >= yMax) ?? yMax
  }, [yMax])

  if (days.length === 0 || yMax === 0) {
    return (
      <View
        className="rounded-lg border border-border bg-background items-center justify-center"
        style={{ height }}
      >
        <Text className="text-sm text-muted-foreground">No activity in this period</Text>
      </View>
    )
  }

  const stepX = days.length > 1 ? innerW / (days.length - 1) : innerW
  const xFor = (i: number) => PADDING.left + i * stepX
  const yFor = (v: number) => PADDING.top + innerH - (v / niceMax) * innerH

  const linePaths = series.map((s) =>
    days.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(2)} ${yFor(d.values[s.id] ?? 0).toFixed(2)}`).join(' '),
  )
  const areaPaths = series.map((s, si) => {
    const base = yFor(0).toFixed(2)
    return `${linePaths[si]} L ${xFor(days.length - 1).toFixed(2)} ${base} L ${xFor(0).toFixed(2)} ${base} Z`
  })

  const yTicks = [0, niceMax * 0.25, niceMax * 0.5, niceMax * 0.75, niceMax]
  const xTickCount = Math.min(6, days.length)
  const xTickIdxs: number[] = []
  for (let i = 0; i < xTickCount; i++) {
    xTickIdxs.push(Math.round((i / Math.max(1, xTickCount - 1)) * (days.length - 1)))
  }
  const hover = hoverIdx != null ? days[hoverIdx] : null

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ width: '100%' }}>
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
        <Defs>
          {series.map((s) => (
            <LinearGradient key={`g-${s.id}`} id={`cperf-${s.id}`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={s.color} stopOpacity={0.35} />
              <Stop offset="1" stopColor={s.color} stopOpacity={0.04} />
            </LinearGradient>
          ))}
        </Defs>

        {yTicks.map((t, i) => (
          <G key={`yt-${i}`}>
            <Line
              x1={PADDING.left}
              x2={PADDING.left + innerW}
              y1={yFor(t)}
              y2={yFor(t)}
              stroke="#94a3b8"
              strokeOpacity={0.18}
              strokeWidth={1}
            />
            <SvgText x={PADDING.left - 8} y={yFor(t) + 4} fontSize={10} fill="#94a3b8" textAnchor="end">
              {compactNumber(t)}
            </SvgText>
          </G>
        ))}

        {series.map((s, si) => (
          <G key={`s-${s.id}`}>
            <Path d={areaPaths[si]} fill={`url(#cperf-${s.id})`} />
            <Path d={linePaths[si]} fill="none" stroke={s.color} strokeWidth={2} />
          </G>
        ))}

        {xTickIdxs.map((idx) => (
          <SvgText
            key={`xt-${idx}`}
            x={xFor(idx)}
            y={PADDING.top + innerH + 18}
            fontSize={10}
            fill="#94a3b8"
            textAnchor="middle"
          >
            {fmtDay(days[idx].date)}
          </SvgText>
        ))}

        {hover != null && hoverIdx != null && (
          <G>
            <Line
              x1={xFor(hoverIdx)}
              x2={xFor(hoverIdx)}
              y1={PADDING.top}
              y2={PADDING.top + innerH}
              stroke="#94a3b8"
              strokeOpacity={0.6}
              strokeWidth={1}
            />
            {series.map((s) => (
              <Circle
                key={`hc-${s.id}`}
                cx={xFor(hoverIdx)}
                cy={yFor(hover.values[s.id] ?? 0)}
                r={3}
                fill="#fff"
                stroke={s.color}
                strokeWidth={1.5}
              />
            ))}
          </G>
        )}
      </Svg>

      {/* Hover hit-areas */}
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', top: 0, left: PADDING.left, right: PADDING.right, height, flexDirection: 'row' }}
      >
        {days.map((_, i) => (
          <Pressable
            key={`hit-${i}`}
            onHoverIn={() => setHoverIdx(i)}
            onHoverOut={() => setHoverIdx(null)}
            onPressIn={() => setHoverIdx(i)}
            onPressOut={() => setHoverIdx(null)}
            style={{ flex: 1, height: '100%' }}
          />
        ))}
      </View>

      {hover && hoverIdx != null && (
        <View
          className="absolute rounded-md border border-border bg-popover px-3 py-2 shadow-lg"
          style={{
            top: PADDING.top + 4,
            left: Math.min(Math.max(PADDING.left + 8, xFor(hoverIdx) - 80), Math.max(PADDING.left, width - 188)),
            minWidth: 168,
          }}
        >
          <Text className="text-[11px] font-medium text-foreground mb-1">{fmtDay(hover.date)}</Text>
          {series.map((s) => (
            <View key={s.id} className="flex-row items-center gap-1.5">
              <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }} />
              <Text className="text-[10px] text-muted-foreground flex-1" numberOfLines={1}>
                {s.label}
              </Text>
              <Text className="text-[10px] font-mono text-foreground">{compactNumber(hover.values[s.id] ?? 0)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
