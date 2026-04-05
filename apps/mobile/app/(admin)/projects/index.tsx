// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Projects - Project listing with search, status/tier filters, and pagination.
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
  FolderKanban,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Globe,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

interface AdminProject {
  id: string
  name: string
  description: string | null
  workspaceId: string
  tier: string
  status: string
  publishedSubdomain: string | null
  createdAt: string
  updatedAt: string
  _count: {
    members: number
    featureSessions: number
    chatSessions: number
    usageEvents: number
    checkpoints: number
    starredBy: number
  }
}

interface ProjectsResponse {
  projects: AdminProject[]
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

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  published: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  draft: { bg: 'bg-muted', text: 'text-muted-foreground' },
  archived: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400' },
}

function ProjectRow({
  project,
  onPress,
  isWide,
}: {
  project: AdminProject
  onPress: () => void
  isWide: boolean
}) {
  const statusStyle = STATUS_COLORS[project.status] ?? STATUS_COLORS.draft

  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-row items-center border-b border-border active:bg-muted/30',
        isWide ? 'px-4 py-3' : 'p-3',
      )}
    >
      <View className="h-9 w-9 rounded-lg bg-primary/10 items-center justify-center mr-3">
        <FolderKanban size={16} className="text-primary" />
      </View>

      <View className={cn('min-w-0 mr-2', isWide ? 'w-[280px]' : 'flex-1')}>
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {project.name}
        </Text>
        {isWide && project.description && (
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {project.description}
          </Text>
        )}
        {!isWide && (
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {project.workspaceId.slice(0, 8)}...
          </Text>
        )}
      </View>

      <View className={cn('flex-row items-center gap-1.5 mr-3', !isWide && 'mr-2')}>
        <View className={cn('px-2 py-0.5 rounded-full', statusStyle.bg)}>
          <Text className={cn('text-[10px] font-medium capitalize', statusStyle.text)}>
            {project.status}
          </Text>
        </View>
      </View>

      {isWide && (
        <View className="px-2 py-0.5 rounded-full bg-muted mr-3">
          <Text className="text-[10px] font-medium text-muted-foreground capitalize">
            {project.tier}
          </Text>
        </View>
      )}

      {isWide && (
        <View className="flex-row items-center gap-1 w-[60px] justify-center mr-3">
          <MessageSquare size={10} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {project._count.chatSessions}
          </Text>
        </View>
      )}

      {isWide && project.publishedSubdomain && (
        <View className="flex-row items-center gap-1 mr-3">
          <Globe size={10} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {project.publishedSubdomain}
          </Text>
        </View>
      )}

      <Text className={cn('text-xs text-muted-foreground', isWide ? 'w-[90px] text-right ml-auto' : 'flex-shrink-0')}>
        {new Date(project.createdAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          ...(isWide ? { year: 'numeric' } : {}),
        })}
      </Text>
    </Pressable>
  )
}

export default function AdminProjectsPage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [data, setData] = useState<ProjectsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadProjects = useCallback(async () => {
    const params: Record<string, string> = {
      page: String(page),
      limit: '20',
    }
    if (search) params.search = search
    if (statusFilter) params.status = statusFilter

    const result = await fetchAdminJson<ProjectsResponse>('/projects', params)
    setData(result)
    setLoading(false)
    setRefreshing(false)
  }, [page, search, statusFilter])

  useEffect(() => {
    setLoading(true)
    loadProjects()
  }, [loadProjects])

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  const onRefresh = () => {
    setRefreshing(true)
    loadProjects()
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
            placeholder="Search projects..."
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
            isWide ? 'w-[280px]' : '',
          )}
        >
          {[
            { value: '', label: 'All' },
            { value: 'draft', label: 'Draft' },
            { value: 'published', label: 'Published' },
            { value: 'archived', label: 'Archived' },
          ].map((s) => (
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
      </View>

      {isWide && data && (
        <Text className="text-xs text-muted-foreground">
          {data.total} project{data.total !== 1 ? 's' : ''} total
          {statusFilter ? ` (filtered by ${statusFilter})` : ''}
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
          Project
        </Text>
        <Text className="text-xs font-medium text-muted-foreground mr-3">Status</Text>
        {isWide && (
          <Text className="text-xs font-medium text-muted-foreground mr-3">Tier</Text>
        )}
        {isWide && (
          <Text className="text-xs font-medium text-muted-foreground w-[60px] text-center mr-3">
            Chats
          </Text>
        )}
        {isWide && (
          <Text className="text-xs font-medium text-muted-foreground mr-3">
            Subdomain
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
          {data?.total} projects total
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
      <FolderKanban size={32} className="text-muted-foreground/50 mb-2" />
      <Text className="text-sm text-muted-foreground">No projects found</Text>
    </View>
  )

  return (
    <View className={cn('flex-1 bg-background', isWide ? 'px-8 pt-6' : 'px-4 pt-2')}>
      <View
        className="flex-1"
      >
        <FlatList
          data={data?.projects ?? []}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={<ListHeader />}
          ListFooterComponent={<ListFooter />}
          ListEmptyComponent={loading ? null : <EmptyState />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          renderItem={({ item }) => (
            <ProjectRow
              project={item}
              isWide={isWide}
              onPress={() => router.push(`/(admin)/projects/${item.id}` as any)}
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
