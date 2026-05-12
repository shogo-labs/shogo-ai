// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Credit Grants - Listing of `WorkspaceGrant` rows with search,
 * status filter, and a "New grant" button.
 *
 * A grant gives a workspace `freeSeats` (deducted from the Stripe seat
 * quantity, with a minimum of 1 paid seat) plus `monthlyIncludedUsd`
 * (stacked on top of the plan-included USD).
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  Search,
  Gift,
  Plus,
  ChevronLeft,
  ChevronRight,
  Building2,
  Users,
  DollarSign,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

interface AdminGrant {
  id: string
  workspaceId: string
  freeSeats: number
  monthlyIncludedUsd: number
  startsAt: string
  expiresAt: string | null
  note: string | null
  createdByUserId: string | null
  createdAt: string
  updatedAt: string
}

interface GrantsResponse {
  workspaceGrants: AdminGrant[]
  total: number
  page: number
  limit: number
}

interface WorkspaceLite {
  id: string
  name: string
  slug: string
}

async function fetchAdminJson<T>(path: string, params?: Record<string, string>): Promise<T | null> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : ''
  try {
    const res = await fetch(`${API_BASE}${path}${qs}`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'all', label: 'All' },
] as const

type StatusFilter = (typeof STATUS_OPTIONS)[number]['value']

function isActive(grant: AdminGrant, now: Date = new Date()): boolean {
  const starts = new Date(grant.startsAt)
  if (starts > now) return false
  if (grant.expiresAt && new Date(grant.expiresAt) <= now) return false
  return true
}

function GrantRow({
  grant,
  workspace,
  onPress,
  isWide,
}: {
  grant: AdminGrant
  workspace?: WorkspaceLite
  onPress: () => void
  isWide: boolean
}) {
  const active = isActive(grant)
  const expiresLabel = grant.expiresAt
    ? `Expires ${new Date(grant.expiresAt).toLocaleDateString()}`
    : 'No expiry'

  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-row items-center border-b border-border active:bg-muted/30',
        isWide ? 'px-4 py-3' : 'p-3',
      )}
    >
      <View className="h-9 w-9 rounded-lg bg-primary/10 items-center justify-center mr-3">
        <Gift size={16} className="text-primary" />
      </View>

      <View className={cn('min-w-0 mr-2', isWide ? 'w-[280px]' : 'flex-1')}>
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {workspace?.name ?? `Workspace ${grant.workspaceId.slice(0, 8)}…`}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {grant.note || expiresLabel}
        </Text>
      </View>

      <View className="flex-row items-center gap-1 mr-3 w-[80px]">
        <Users size={11} className="text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">
          {grant.freeSeats} seat{grant.freeSeats === 1 ? '' : 's'}
        </Text>
      </View>

      <View className="flex-row items-center gap-1 mr-3 w-[100px]">
        <DollarSign size={11} className="text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">
          ${grant.monthlyIncludedUsd.toFixed(0)}/mo
        </Text>
      </View>

      <View
        className={cn(
          'px-2 py-0.5 rounded-full mr-3',
          active
            ? 'bg-green-100 dark:bg-green-900/30'
            : 'bg-muted',
        )}
      >
        <Text
          className={cn(
            'text-[10px] font-medium capitalize',
            active
              ? 'text-green-700 dark:text-green-400'
              : 'text-muted-foreground',
          )}
        >
          {active ? 'Active' : 'Expired'}
        </Text>
      </View>

      {isWide && (
        <Text className="text-xs text-muted-foreground w-[90px] text-right ml-auto">
          {new Date(grant.createdAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </Text>
      )}
    </Pressable>
  )
}

export default function AdminGrantsPage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [data, setData] = useState<GrantsResponse | null>(null)
  const [workspaces, setWorkspaces] = useState<Record<string, WorkspaceLite>>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadGrants = useCallback(async () => {
    const params: Record<string, string> = {
      page: String(page),
      limit: '20',
      orderBy: 'createdAt',
      order: 'desc',
    }
    if (search) params.search = search

    const result = await fetchAdminJson<GrantsResponse>('/workspace-grants', params)
    setData(result)
    setLoading(false)
    setRefreshing(false)
  }, [page, search])

  useEffect(() => {
    setLoading(true)
    loadGrants()
  }, [loadGrants])

  // Hydrate workspace names for the rows we have.
  useEffect(() => {
    if (!data?.workspaceGrants?.length) return
    const missing = data.workspaceGrants
      .map((g) => g.workspaceId)
      .filter((id) => !workspaces[id])
    if (missing.length === 0) return
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(
        Array.from(new Set(missing)).slice(0, 50).map(async (id) => {
          const w = await fetchAdminJson<WorkspaceLite>(`/workspaces/${id}`)
          return [id, w] as const
        }),
      )
      if (cancelled) return
      setWorkspaces((prev) => {
        const next = { ...prev }
        for (const [id, w] of entries) {
          if (w) next[id] = { id: w.id, name: w.name, slug: w.slug }
        }
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [data?.workspaceGrants, workspaces])

  const filtered = (data?.workspaceGrants ?? []).filter((g) => {
    if (statusFilter === 'all') return true
    return statusFilter === 'active' ? isActive(g) : !isActive(g)
  })

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  const onRefresh = () => {
    setRefreshing(true)
    loadGrants()
  }

  const ListHeader = () => (
    <View className="gap-3 mb-2">
      <View className={cn(isWide ? 'flex-row items-center gap-3' : 'gap-3')}>
        <View
          className={cn(
            'flex-row items-center border border-border rounded-lg px-3 py-2 bg-card',
            isWide ? 'flex-1' : '',
          )}
        >
          <Search size={16} className="text-muted-foreground mr-2" />
          <TextInput
            placeholder="Search by workspace id or note…"
            placeholderTextColor="#9ca3af"
            value={search}
            onChangeText={(t) => {
              setSearch(t)
              setPage(1)
            }}
            autoCapitalize="none"
            autoCorrect={false}
            className="flex-1 text-foreground text-sm"
          />
        </View>

        <View
          className={cn(
            'flex-row items-center bg-muted rounded-lg p-0.5 gap-0.5',
            isWide ? 'w-[260px]' : '',
          )}
        >
          {STATUS_OPTIONS.map((s) => (
            <Pressable
              key={s.value}
              onPress={() => {
                setStatusFilter(s.value)
                setPage(1)
              }}
              className={cn(
                'flex-1 items-center py-1.5 rounded-md',
                statusFilter === s.value ? 'bg-background shadow-sm' : '',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  statusFilter === s.value ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {s.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={() => router.push('/(admin)/grants/new' as any)}
          className="flex-row items-center gap-1.5 bg-primary px-3 py-2 rounded-lg active:opacity-80"
        >
          <Plus size={14} className="text-primary-foreground" />
          <Text className="text-sm font-medium text-primary-foreground">New grant</Text>
        </Pressable>
      </View>

      {isWide && data && (
        <Text className="text-xs text-muted-foreground">
          {data.total} grant{data.total !== 1 ? 's' : ''} total
        </Text>
      )}

      <View
        className={cn(
          'flex-row items-center bg-muted/50 rounded-t-lg border-b border-border',
          isWide ? 'px-4 py-2.5' : 'px-3 py-2',
        )}
      >
        <View className="w-9 mr-3" />
        <Text
          className={cn(
            'text-xs font-medium text-muted-foreground',
            isWide ? 'w-[280px]' : 'flex-1',
          )}
        >
          Workspace
        </Text>
        <Text className="text-xs font-medium text-muted-foreground w-[80px] mr-3">
          Free seats
        </Text>
        <Text className="text-xs font-medium text-muted-foreground w-[100px] mr-3">
          Monthly USD
        </Text>
        <Text className="text-xs font-medium text-muted-foreground mr-3">Status</Text>
        {isWide && (
          <Text className="text-xs font-medium text-muted-foreground w-[90px] text-right ml-auto">
            Created
          </Text>
        )}
      </View>
    </View>
  )

  const ListFooter = () => {
    if (totalPages <= 1) return null
    return (
      <View className="flex-row items-center justify-between mt-3 px-1">
        <Text className="text-xs text-muted-foreground">
          {data?.total} grants total
        </Text>
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className={cn(
              'p-2 rounded-md border border-border',
              page === 1 && 'opacity-30',
            )}
          >
            <ChevronLeft size={16} className="text-foreground" />
          </Pressable>
          <Text className="text-xs text-muted-foreground">
            {page} / {totalPages}
          </Text>
          <Pressable
            onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className={cn(
              'p-2 rounded-md border border-border',
              page >= totalPages && 'opacity-30',
            )}
          >
            <ChevronRight size={16} className="text-foreground" />
          </Pressable>
        </View>
      </View>
    )
  }

  const EmptyState = () => (
    <View className="items-center justify-center py-16">
      <Building2 size={32} className="text-muted-foreground/50 mb-2" />
      <Text className="text-sm text-muted-foreground">
        No {statusFilter === 'all' ? '' : statusFilter} grants
      </Text>
    </View>
  )

  return (
    <View className={cn('flex-1 bg-background', isWide ? 'px-8 pt-6' : 'px-4 pt-2')}>
      <View className="flex-1">
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={<ListHeader />}
          ListFooterComponent={<ListFooter />}
          ListEmptyComponent={loading ? null : <EmptyState />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          renderItem={({ item }) => (
            <GrantRow
              grant={item}
              workspace={workspaces[item.workspaceId]}
              isWide={isWide}
              onPress={() => router.push(`/(admin)/grants/${item.id}` as any)}
            />
          )}
          contentContainerStyle={{ paddingBottom: 20 }}
          showsVerticalScrollIndicator={false}
        />
        {loading && !refreshing && (
          <View className="absolute inset-0 items-center justify-center bg-background/80">
            <ActivityIndicator size="large" />
          </View>
        )}
      </View>
    </View>
  )
}
