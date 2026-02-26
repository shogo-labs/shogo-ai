/**
 * Admin Workspaces - Workspace management with search, grid cards, and pagination.
 *
 * Converted from apps/web/src/components/admin/pages/AdminWorkspaces.tsx
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
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  Search,
  Building2,
  Users,
  FolderKanban,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'

const API_BASE = `${API_URL}/api/admin`

interface AdminWorkspace {
  id: string
  name: string
  slug: string
  description: string | null
  createdAt: string
  updatedAt: string
  _count: {
    projects: number
    members: number
    billingAccounts: number
    invitations: number
    folders: number
    subscriptions: number
    creditLedgers: number
    usageEvents: number
    starredProjects: number
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

function WorkspaceCard({
  workspace,
  onPress,
}: {
  workspace: AdminWorkspace
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      className="rounded-xl border border-border bg-card p-4 mb-3 active:border-primary/30"
    >
      <View className="flex-row items-center gap-3 mb-3">
        <View className="h-10 w-10 rounded-lg bg-primary/10 items-center justify-center">
          <Building2 size={20} className="text-primary" />
        </View>
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {workspace.name}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {workspace.slug}
          </Text>
        </View>
      </View>

      <View className="flex-row items-center gap-4">
        <View className="flex-row items-center gap-1">
          <Users size={14} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {workspace._count.members} members
          </Text>
        </View>
        <View className="flex-row items-center gap-1">
          <FolderKanban size={14} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {workspace._count.projects} projects
          </Text>
        </View>
      </View>

      <Text className="text-xs text-muted-foreground mt-2">
        Created {new Date(workspace.createdAt).toLocaleDateString()}
      </Text>
    </Pressable>
  )
}

export default function AdminWorkspacesPage() {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<WorkspacesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadWorkspaces = useCallback(async () => {
    const params: Record<string, string> = {
      page: String(page),
      limit: '20',
    }
    if (search) params.search = search

    const result = await fetchAdminJson<WorkspacesResponse>('/workspaces', params)
    setData(result)
    setLoading(false)
    setRefreshing(false)
  }, [page, search])

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
    <View className="mb-3">
      {/* Header text */}
      <View className="mb-3">
        <Text className="text-xs text-muted-foreground">
          Browse and manage all platform workspaces
        </Text>
      </View>

      {/* Search */}
      <View className="flex-row items-center border border-border rounded-lg px-3 py-2 bg-card">
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
    </View>
  )

  const ListFooter = () => {
    if (totalPages <= 1) return null
    return (
      <View className="flex-row items-center justify-between mt-2 px-1">
        <Text className="text-xs text-muted-foreground">
          {data?.total} workspaces total
        </Text>
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className={cn(
              'p-2 rounded-md border border-border',
              page === 1 && 'opacity-30'
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
              page >= totalPages && 'opacity-30'
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
    <View className="flex-1 bg-background px-4 pt-2">
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
          <WorkspaceCard
            workspace={item}
            onPress={() => {
              // Workspace detail not yet implemented; could navigate to detail page
            }}
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
  )
}
