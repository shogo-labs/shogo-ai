// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Creators - Marketplace creators with marketplace metrics joined to
 * per-creator platform usage spend. Gated by the `creators:read` admin scope
 * (super admins always have access). Backed by GET /api/admin/creators.
 *
 * Each row links to the per-creator profile at /(admin)/creators/:userId.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Sparkles, Download, Star, DollarSign, Users, ChevronRight } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL, type AdminCreatorStat } from '../../../lib/api'

const CREATORS_URL = `${API_URL}/api/admin/creators`

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function StatCard({
  label,
  value,
  icon: Icon,
  accent = 'bg-primary/10',
  iconColor = 'text-primary',
}: {
  label: string
  value: string | number
  icon: React.ComponentType<{ size?: number; className?: string }>
  accent?: string
  iconColor?: string
}) {
  return (
    <View className="flex-1 min-w-[150px] rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</Text>
        <View className={cn('h-8 w-8 rounded-lg items-center justify-center', accent)}>
          <Icon size={16} className={iconColor} />
        </View>
      </View>
      <Text className="text-2xl font-bold text-foreground tracking-tight">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </Text>
    </View>
  )
}

const COLS = [
  { key: 'creator', label: 'Creator', width: 220, align: 'left' as const },
  { key: 'tier', label: 'Tier', width: 110, align: 'left' as const },
  { key: 'agents', label: 'Agents', width: 80, align: 'right' as const },
  { key: 'installs', label: 'Installs', width: 90, align: 'right' as const },
  { key: 'rating', label: 'Rating', width: 80, align: 'right' as const },
  { key: 'earnings', label: 'Earnings', width: 110, align: 'right' as const },
  { key: 'spend', label: 'Platform spend', width: 130, align: 'right' as const },
  { key: 'chevron', label: '', width: 40, align: 'right' as const },
]

function HeaderRow() {
  return (
    <View className="flex-row border-b border-border bg-muted/30">
      {COLS.map((col) => (
        <View key={col.key} style={{ width: col.width }} className="px-3 py-2.5">
          <Text
            className={cn(
              'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
              col.align === 'right' && 'text-right',
            )}
          >
            {col.label}
          </Text>
        </View>
      ))}
    </View>
  )
}

function CreatorRow({ c, onPress }: { c: AdminCreatorStat; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      role="button"
      accessibilityLabel={`Open ${c.displayName || c.name || 'creator'} profile`}
      className="flex-row border-b border-border/50 items-center active:bg-muted/40"
    >
      <View style={{ width: COLS[0].width }} className="px-3 py-3">
        <View className="flex-row items-center gap-1.5">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {c.displayName || c.name || 'Unknown'}
          </Text>
          {c.verified && <Star size={12} className="text-amber-500" />}
        </View>
        <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
          {c.email}
        </Text>
      </View>
      <View style={{ width: COLS[1].width }} className="px-3 py-3">
        <Text className="text-xs text-foreground capitalize">{c.creatorTier}</Text>
      </View>
      <View style={{ width: COLS[2].width }} className="px-3 py-3">
        <Text className="text-sm text-foreground text-right">{c.totalAgentsPublished.toLocaleString()}</Text>
      </View>
      <View style={{ width: COLS[3].width }} className="px-3 py-3">
        <Text className="text-sm text-foreground text-right">{c.totalInstalls.toLocaleString()}</Text>
      </View>
      <View style={{ width: COLS[4].width }} className="px-3 py-3">
        <Text className="text-sm text-foreground text-right">
          {c.averageAgentRating > 0 ? c.averageAgentRating.toFixed(1) : '—'}
        </Text>
      </View>
      <View style={{ width: COLS[5].width }} className="px-3 py-3">
        <Text className="text-sm text-foreground text-right">{usd(c.totalEarningsUsd)}</Text>
      </View>
      <View style={{ width: COLS[6].width }} className="px-3 py-3">
        <Text className="text-sm font-medium text-foreground text-right">{usd(c.spendUsd)}</Text>
      </View>
      <View style={{ width: COLS[7].width }} className="px-3 py-3 items-end">
        <ChevronRight size={16} className="text-muted-foreground" />
      </View>
    </Pressable>
  )
}

export default function AdminCreators() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [creators, setCreators] = useState<AdminCreatorStat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(CREATORS_URL, { credentials: 'include' })
      if (!res.ok) {
        setError(res.status === 403 ? 'You do not have access to creator stats.' : 'Failed to load creators.')
        setCreators([])
        return
      }
      const json = await res.json()
      setCreators(Array.isArray(json.data) ? json.data : [])
    } catch {
      setError('Failed to load creators.')
      setCreators([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const onRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const totals = useMemo(() => {
    return creators.reduce(
      (acc, c) => {
        acc.installs += c.totalInstalls
        acc.earnings += c.totalEarningsUsd
        acc.spend += c.spendUsd
        return acc
      },
      { installs: 0, earnings: 0, spend: 0 },
    )
  }, [creators])

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: isWide ? 32 : 16, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View className="mb-6">
        <View className="flex-row items-center gap-2">
          <Sparkles size={isWide ? 22 : 18} className="text-primary" />
          <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-xl')}>Creators</Text>
        </View>
        <Text className="text-sm text-muted-foreground mt-0.5">
          Marketplace creators with publishing metrics and platform usage. Tap a creator to view their profile.
        </Text>
      </View>

      {/* Summary cards */}
      <View className="flex-row flex-wrap gap-3 mb-6">
        <StatCard label="Creators" value={creators.length} icon={Users} accent="bg-blue-500/10" iconColor="text-blue-500" />
        <StatCard label="Total installs" value={totals.installs} icon={Download} accent="bg-emerald-500/10" iconColor="text-emerald-500" />
        <StatCard label="Total earnings" value={usd(totals.earnings)} icon={DollarSign} accent="bg-amber-500/10" iconColor="text-amber-500" />
        <StatCard label="Platform spend" value={usd(totals.spend)} icon={DollarSign} accent="bg-purple-500/10" iconColor="text-purple-500" />
      </View>

      {/* Table */}
      <View className="rounded-xl border border-border bg-card overflow-hidden">
        {error ? (
          <View className="h-32 items-center justify-center px-4">
            <Text className="text-sm text-muted-foreground text-center">{error}</Text>
          </View>
        ) : loading ? (
          <View className="p-4 gap-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <View key={i} className="h-10 bg-muted/50 rounded" />
            ))}
          </View>
        ) : creators.length === 0 ? (
          <View className="h-32 items-center justify-center">
            <Text className="text-sm text-muted-foreground">No creators yet</Text>
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              <HeaderRow />
              {creators.map((c) => (
                <CreatorRow
                  key={c.userId}
                  c={c}
                  onPress={() => router.push(`/(admin)/creators/${c.userId}` as any)}
                />
              ))}
            </View>
          </ScrollView>
        )}
      </View>
    </ScrollView>
  )
}
