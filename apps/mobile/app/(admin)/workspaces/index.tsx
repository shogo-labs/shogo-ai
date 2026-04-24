// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Workspaces - Workspace listing with search, instance-size filter, and pagination.
 *
 * Responsive: on desktop (>=900px) shows a table-style layout with extra columns,
 * on mobile shows a compact card list.
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
  Building2,
  ChevronLeft,
  ChevronRight,
  Users,
  FolderKanban,
  CreditCard,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

interface AdminWorkspace {
  id: string
  name: string
  slug: string
  description: string | null
  instanceSize: string
  createdAt: string
  updatedAt: string
  _count: {
    projects: number
    members: number
    subscriptions: number
    apiKeys: number
    meetings: number
    instances: number
  }
}

interface WorkspacesResponse {
  workspaces: AdminWorkspace[]
  total: number
  page: number
  limit: number
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

const INSTANCE_SIZE_COLORS: Record<string, { bg: string; text: string }> = {
  micro: { bg: 'bg-muted', text: 'text-muted-foreground' },
  small: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  medium: { bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-400' },
  large: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-400' },
  xlarge: { bg: 'bg-pink-100 dark:bg-pink-900/30', text: 'text-pink-700 dark:text-pink-400' },
}

function WorkspaceRow({
  workspace,
  onPress,
  isWide,
}: {
  workspace: AdminWorkspace
  onPress: () => void
  isWide: boolean
}) {
  const sizeStyle = INSTANCE_SIZE_COLORS[workspace.instanceSize] ?? INSTANCE_SIZE_COLORS.micro

  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-row items-center border-b border-border active:bg-muted/30',
        isWide ? 'px-4 py-3' : 'p-3',
      )}
    >
      <View className="h-9 w-9 rounded-lg bg-primary/10 items-center justify-center mr-3">
        <Building2 size={16} className="text-primary" />
      </View>

      <View className={cn('min-w-0 mr-2', isWide ? 'w-[280px]' : 'flex-1')}>
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {workspace.name}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {workspace.slug}
        </Text>
      </View>

      <View className={cn('px-2 py-0.5 rounded-full mr-3', sizeStyle.bg)}>
        <Text className={cn('text-[10px] font-medium capitalize', sizeStyle.text)}>
          {workspace.instanceSize}
        </Text>
      </View>

      {isWide && (
        <View className="flex-row items-center gap-1 w-[70px] justify-center mr-3">
          <Users size={10} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {workspace._count.members}
          </Text>
        </View>
      )}

      {isWide && (
        <View className="flex-row items-center gap-1 w-[70px] justify-center mr-3">
          <FolderKanban size={10} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {workspace._count.projects}
          </Text>
        </View>
      )}

      {isWide && (
        <View className="flex-row items-center gap-1 w-[70px] justify-center mr-3">
          <CreditCard size={10} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {workspace._count.subscriptions}
          </Text>
        </View>
      )}

      {!isWide && (
        <View className="flex-row items-center gap-2 mr-2">
          <Text className="text-xs text-muted-foreground">
            {workspace._count.members}m
          </Text>
          <Text className="text-xs text-muted-foreground">
            {workspace._count.projects}p
          </Text>
        </View>
      )}

      <Text className={cn('text-xs text-muted-foreground', isWide ? 'w-[90px] text-right ml-auto' : 'flex-shrink-0')}>
        {new Date(workspace.createdAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          ...(isWide ? { year: 'numeric' } : {}),
        })}
      </Text>
    </Pressable>
  )
}

const SIZE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'micro', label: 'Micro' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'XL' },
]

export default function AdminWorkspacesPage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [sizeFilter, setSizeFilter] = useState<string>('')
  const [data, setData] = useState<WorkspacesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadWorkspaces = useCallback(async () => {
    const params: Record<string, string> = {
      page: String(page),
      limit: '20',
    }
    if (search) params.search = search
    if (sizeFilter) params.instanceSize = sizeFilter

    const result = await fetchAdminJson<WorkspacesResponse>('/workspaces', params)
    setData(result)
    setLoading(false)
    setRefreshing(false)
  }, [page, search, sizeFilter])

  useEffect(() => {
    setLoading(true)
    loadWorkspaces()
  }, [loadWorkspaces])

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  const onRefresh = () => {
    setRefreshing(true)
    loadWorkspaces()
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
            placeholder="Search workspaces..."
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
            isWide ? 'w-[360px]' : '',
          )}
        >
          {SIZE_OPTIONS.map((s) => (
            <Pressable
              key={s.value}
              onPress={() => {
                setSizeFilter(s.value)
                setPage(1)
              }}
              className={cn(
                'flex-1 items-center py-1.5 rounded-md',
                sizeFilter === s.value ? 'bg-background shadow-sm' : '',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  sizeFilter === s.value ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {s.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {isWide && data && (
        <Text className="text-xs text-muted-foreground">
          {data.total} workspace{data.total !== 1 ? 's' : ''} total
          {sizeFilter ? ` (filtered by ${sizeFilter})` : ''}
        </Text>
      )}

      <View
        className={cn(
          'flex-row items-center bg-muted/50 rounded-t-lg border-b border-border',
          isWide ? 'px-4 py-2.5' : 'px-3 py-2',
        )}
      >
        <View className="w-9 mr-3" />
        <Text className={cn('text-xs font-medium text-muted-foreground', isWide ? 'w-[280px]' : 'flex-1')}>
          Workspace
        </Text>
        <Text className="text-xs font-medium text-muted-foreground mr-3">Size</Text>
        {isWide && (
          <Text className="text-xs font-medium text-muted-foreground w-[70px] text-center mr-3">
            Members
          </Text>
        )}
        {isWide && (
          <Text className="text-xs font-medium text-muted-foreground w-[70px] text-center mr-3">
            Projects
          </Text>
        )}
        {isWide && (
          <Text className="text-xs font-medium text-muted-foreground w-[70px] text-center mr-3">
            Subs
          </Text>
        )}
        <Text className={cn('text-xs font-medium text-muted-foreground', isWide ? 'w-[90px] text-right ml-auto' : 'flex-shrink-0')}>
          Created
        </Text>
      </View>
    </View>
  )

  const ListFooter = () => {
    if (totalPages <= 1) return null
    return (
      <View className="flex-row items-center justify-between mt-3 px-1">
        <Text className="text-xs text-muted-foreground">
          {data?.total} workspaces total
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
      <Text className="text-sm text-muted-foreground">No workspaces found</Text>
    </View>
  )

  return (
    <View className={cn('flex-1 bg-background', isWide ? 'px-8 pt-6' : 'px-4 pt-2')}>
      <View className="flex-1">
        <FlatList
          data={data?.workspaces ?? []}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={<ListHeader />}
          ListFooterComponent={<ListFooter />}
          ListEmptyComponent={loading ? null : <EmptyState />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          renderItem={({ item }) => (
            <WorkspaceRow
              workspace={item}
              isWide={isWide}
              onPress={() => router.push(`/(admin)/workspaces/${item.id}` as any)}
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
