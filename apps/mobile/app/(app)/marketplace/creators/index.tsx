// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Image,
  FlatList,
} from 'react-native'
import { observer } from 'mobx-react-lite'
import { useRouter } from 'expo-router'
import { ArrowLeft, Search, ShieldCheck, ChevronDown, X } from 'lucide-react-native'
import { useDomainHttp } from '../../../../contexts/domain'
import {
  HorizontalRail,
  MarketplaceHero,
  SectionHeader,
  TIER_BG,
  TIER_LABEL,
  type CreatorTier,
} from '../../../../components/marketplace'
import { useGridColumns } from '../../../../hooks/useGridColumns'

interface LeaderboardCreator {
  id: string
  displayName: string
  avatarUrl?: string | null
  creatorTier: CreatorTier
  reputationScore: number
  totalAgentsPublished: number
  totalInstalls: number
  /** Some endpoints expose a tier label / verified flag — kept optional so we degrade. */
  verified?: boolean
  bio?: string | null
}

interface LeaderboardResponse {
  items: LeaderboardCreator[]
  page: number
  totalPages: number
}

type TierFilter = 'all' | CreatorTier
type SortMode = 'reputation' | 'installs' | 'agents'

const SORT_LABELS: Record<SortMode, string> = {
  reputation: 'Top reputation',
  installs: 'Most installs',
  agents: 'Most agents',
}

const TIER_FILTERS: { value: TierFilter; label: string }[] = [
  { value: 'all', label: 'All tiers' },
  { value: 'master', label: 'Master' },
  { value: 'expert', label: 'Expert' },
  { value: 'craftsman', label: 'Craftsman' },
  { value: 'builder', label: 'Builder' },
  { value: 'newcomer', label: 'Newcomer' },
]

export default observer(function CreatorsDirectoryScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const numColumns = useGridColumns()

  const [allCreators, setAllCreators] = useState<LeaderboardCreator[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [tierFilter, setTierFilter] = useState<TierFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('reputation')
  const [sortOpen, setSortOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const res = await http.get<LeaderboardResponse>(
        '/api/marketplace/creators/leaderboard?limit=100',
      )
      setAllCreators(res.data.items ?? [])
      setError(null)
    } catch (err: any) {
      console.error('[Creators] load failed:', err)
      setError('Failed to load creators')
    } finally {
      setLoading(false)
    }
  }, [http])

  useEffect(() => {
    load()
  }, [load])

  // Derived: filtered + sorted creators
  const visible = useMemo(() => {
    let list = allCreators.slice()
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((c) => c.displayName.toLowerCase().includes(q))
    if (tierFilter !== 'all') list = list.filter((c) => c.creatorTier === tierFilter)
    list.sort((a, b) => {
      if (sortMode === 'installs') return b.totalInstalls - a.totalInstalls
      if (sortMode === 'agents') return b.totalAgentsPublished - a.totalAgentsPublished
      return b.reputationScore - a.reputationScore
    })
    return list
  }, [allCreators, search, tierFilter, sortMode])

  // Featured = top 3 by reputation
  const featured = useMemo(() => {
    return [...allCreators]
      .sort((a, b) => b.reputationScore - a.reputationScore)
      .slice(0, 6)
  }, [allCreators])

  const handlePress = useCallback(
    (id: string) => router.push(`/(app)/marketplace/creators/${id}` as any),
    [router],
  )

  const ListHeader = (
    <View>
      <View className="px-5 pt-4 pb-3 gap-3">
        <View className="flex-row items-center gap-2">
          <View className="flex-row items-center bg-card border border-input rounded-xl px-3 h-11 flex-1">
            <Search size={16} color="#71717a" />
            <TextInput
              className="flex-1 ml-2 text-sm text-foreground web:outline-none"
              placeholder="Search creators…"
              placeholderTextColor="#71717a"
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {search.length > 0 && (
              <Pressable onPress={() => setSearch('')} hitSlop={6}>
                <X size={14} color="#71717a" />
              </Pressable>
            )}
          </View>
          <View className="relative">
            <Pressable
              onPress={() => setSortOpen((v) => !v)}
              className="flex-row items-center gap-1.5 px-3 h-11 rounded-xl border border-border bg-card"
            >
              <Text className="text-xs font-medium text-foreground">
                {SORT_LABELS[sortMode]}
              </Text>
              <ChevronDown size={12} color="#71717a" />
            </Pressable>
            {sortOpen && (
              <View
                className="absolute right-0 top-12 rounded-xl border border-border bg-card overflow-hidden shadow-lg"
                style={{ width: 170, zIndex: 50 }}
              >
                {(Object.keys(SORT_LABELS) as SortMode[]).map((k) => (
                  <Pressable
                    key={k}
                    onPress={() => {
                      setSortMode(k)
                      setSortOpen(false)
                    }}
                    className={`px-3 py-2.5 active:bg-muted ${k === sortMode ? 'bg-muted/50' : ''}`}
                  >
                    <Text className="text-xs text-foreground">{SORT_LABELS[k]}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        </View>

        {/* Tier filter pills */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingRight: 16 }}
        >
          {TIER_FILTERS.map((t) => (
            <Pressable
              key={t.value}
              onPress={() => setTierFilter(t.value)}
              className={`rounded-full px-3 h-8 items-center justify-center border ${
                tierFilter === t.value ? 'bg-primary border-primary' : 'bg-card border-border'
              }`}
            >
              <Text
                className={`text-xs font-medium ${
                  tierFilter === t.value ? 'text-primary-foreground' : 'text-foreground'
                }`}
              >
                {t.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Featured creators rail */}
      {featured.length > 0 && tierFilter === 'all' && !search && (
        <View className="mb-6 mt-2">
          <SectionHeader
            title="Featured creators"
            subtitle="Builders earning the most reputation this season"
          />
          <HorizontalRail
            items={featured}
            keyExtractor={(c) => c.id}
            itemWidth={260}
            renderItem={(c) => (
              <CreatorSpotlight creator={c} onPress={() => handlePress(c.id)} />
            )}
          />
        </View>
      )}

      <View className="px-5 mb-3">
        <SectionHeader
          title={
            search
              ? `Search results`
              : tierFilter === 'all'
                ? `All creators`
                : `${TIER_LABEL[tierFilter as CreatorTier]} creators`
          }
          subtitle={loading ? 'Loading…' : `${visible.length} creator${visible.length === 1 ? '' : 's'}`}
          padded={false}
        />
      </View>
    </View>
  )

  return (
    <View className="flex-1 bg-background">
      {/* Top bar */}
      <View className="flex-row items-center gap-3 px-5 pt-3 pb-2">
        <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
          <ArrowLeft size={20} color="#71717a" />
        </Pressable>
        <Text className="text-base font-semibold text-foreground flex-1">Creators</Text>
      </View>

      <MarketplaceHero
        eyebrow="Creators"
        title="Meet the people building agents on Shogo"
        subtitle="From hobbyists to studios. Browse the directory or jump into someone's profile to see what they've shipped."
        accent="#7c3aed"
        compact
      />

      {error ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-foreground font-medium mb-1">Couldn&apos;t load creators</Text>
          <Text className="text-muted-foreground text-sm text-center mb-4">{error}</Text>
          <Pressable onPress={load} className="bg-primary px-4 py-2 rounded-lg">
            <Text className="text-primary-foreground text-sm font-medium">Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          key={`grid-${numColumns}`}
          data={visible}
          keyExtractor={(c) => c.id}
          numColumns={numColumns}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 32 }}
          ListHeaderComponent={ListHeader}
          renderItem={({ item }) => (
            <View className="flex-1 m-1.5">
              <CreatorGridCard creator={item} onPress={() => handlePress(item.id)} />
            </View>
          )}
          ListEmptyComponent={
            !loading ? (
              <View className="items-center py-20 px-6">
                <Search size={32} color="#a1a1aa" />
                <Text className="text-foreground font-medium mt-3 mb-1">
                  No creators match
                </Text>
                <Text className="text-muted-foreground text-sm text-center">
                  Try a different tier or clear your search.
                </Text>
              </View>
            ) : (
              <View className="items-center py-12">
                <ActivityIndicator size="small" />
              </View>
            )
          }
        />
      )}
    </View>
  )
})

// ── Sub-components ─────────────────────────────────────────────────

function CreatorSpotlight({
  creator,
  onPress,
}: {
  creator: LeaderboardCreator
  onPress: () => void
}) {
  const tierBg = TIER_BG[creator.creatorTier] ?? TIER_BG.newcomer
  return (
    <Pressable
      onPress={onPress}
      className="rounded-2xl border border-border bg-card p-4 active:opacity-90"
    >
      <View className="flex-row items-center gap-3 mb-3">
        {creator.avatarUrl ? (
          <Image
            source={{ uri: creator.avatarUrl }}
            style={{ width: 48, height: 48, borderRadius: 999 }}
          />
        ) : (
          <View
            className={`${tierBg} rounded-full items-center justify-center`}
            style={{ width: 48, height: 48 }}
          >
            <Text className="text-white font-bold text-lg">
              {creator.displayName.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View className="flex-1 min-w-0">
          <View className="flex-row items-center gap-1">
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {creator.displayName}
            </Text>
            {creator.verified && <ShieldCheck size={12} color="#3b82f6" />}
          </View>
          <Text className="text-xs text-muted-foreground capitalize">
            {TIER_LABEL[creator.creatorTier]} · {creator.reputationScore} rep
          </Text>
        </View>
      </View>
      <View className="flex-row gap-4">
        <Stat label="Agents" value={String(creator.totalAgentsPublished)} />
        <Stat label="Installs" value={formatCount(creator.totalInstalls)} />
      </View>
    </Pressable>
  )
}

function CreatorGridCard({
  creator,
  onPress,
}: {
  creator: LeaderboardCreator
  onPress: () => void
}) {
  const tierBg = TIER_BG[creator.creatorTier] ?? TIER_BG.newcomer
  return (
    <Pressable
      onPress={onPress}
      className="rounded-2xl border border-border bg-card px-4 py-4 active:opacity-90"
    >
      <View className="items-center gap-2">
        {creator.avatarUrl ? (
          <Image
            source={{ uri: creator.avatarUrl }}
            style={{ width: 56, height: 56, borderRadius: 999 }}
          />
        ) : (
          <View
            className={`${tierBg} rounded-full items-center justify-center`}
            style={{ width: 56, height: 56 }}
          >
            <Text className="text-white font-bold text-xl">
              {creator.displayName.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View className="items-center gap-0.5 max-w-full">
          <View className="flex-row items-center gap-1">
            <Text
              className="text-sm font-semibold text-foreground text-center"
              numberOfLines={1}
            >
              {creator.displayName}
            </Text>
            {creator.verified && <ShieldCheck size={12} color="#3b82f6" />}
          </View>
          <Text className="text-[11px] text-muted-foreground capitalize">
            {TIER_LABEL[creator.creatorTier]}
          </Text>
        </View>
      </View>
      <View className="border-t border-border mt-3 pt-3 flex-row justify-between">
        <MiniStat label="Agents" value={String(creator.totalAgentsPublished)} />
        <MiniStat label="Installs" value={formatCount(creator.totalInstalls)} />
        <MiniStat label="Rep" value={String(creator.reputationScore)} />
      </View>
    </Pressable>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text className="text-sm font-semibold text-foreground">{value}</Text>
      <Text
        className="text-[10px] text-muted-foreground mt-0.5 uppercase"
        style={{ letterSpacing: 0.4 }}
      >
        {label}
      </Text>
    </View>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <View className="items-center">
      <Text className="text-xs font-semibold text-foreground">{value}</Text>
      <Text className="text-[10px] text-muted-foreground mt-0.5">{label}</Text>
    </View>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}
