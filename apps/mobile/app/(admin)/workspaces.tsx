/**
 * Admin Workspaces - Workspace management with search, grid cards, and pagination.
 *
 * Responsive layout: cards in a multi-column grid on desktop, single column on mobile.
 * The admin layout provides a persistent sidebar on desktop, so no nav header is needed here.
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
  Users,
  FolderKanban,
  ChevronLeft,
  ChevronRight,
  Mail,
  Folder,
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
  isWide,
  onPress,
}: {
  workspace: AdminWorkspace
  isWide: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'rounded-xl border border-border bg-card mb-3 active:border-primary/30',
        isWide ? 'p-5' : 'p-4',
      )}
      style={isWide ? { minWidth: 320, flexBasis: '48%' } : undefined}
    >
      <View className="flex-row items-center gap-3 mb-3">
        <View className={cn(
          'rounded-lg bg-primary/10 items-center justify-center',
          isWide ? 'h-11 w-11' : 'h-10 w-10',
        )}>
          <Building2 size={isWide ? 22 : 20} className="text-primary" />
        </View>
        <View className="flex-1 min-w-0">
          <Text
            className={cn(
              'font-semibold text-foreground',
              isWide ? 'text-base' : 'text-sm',
            )}
            numberOfLines={1}
          >
            {workspace.name}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {workspace.slug}
          </Text>
        </View>
      </View>

      {isWide && workspace.description && (
        <Text className="text-sm text-muted-foreground mb-3" numberOfLines={2}>
          {workspace.description}
        </Text>
      )}

      <View className="flex-row items-center flex-wrap gap-x-4 gap-y-1.5">
        <View className="flex-row items-center gap-1.5">
          <Users size={14} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {workspace._count.members} members
          </Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <FolderKanban size={14} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">
            {workspace._count.projects} projects
          </Text>
        </View>
        {isWide && (
          <>
            <View className="flex-row items-center gap-1.5">
              <Folder size={14} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {workspace._count.folders} folders
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              <Mail size={14} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {workspace._count.invitations} invitations
              </Text>
            </View>
          </>
        )}
      </View>

      <Text className="text-xs text-muted-foreground mt-2">
        Created {new Date(workspace.createdAt).toLocaleDateString()}
      </Text>
    </Pressable>
  )
}

export default function AdminWorkspacesPage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
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
    <View className={cn('mb-4', isWide && 'mb-6')}>
      <View className={cn('mb-4', isWide && 'mb-5')}>
        <Text className={cn(
          'font-bold text-foreground',
          isWide ? 'text-2xl' : 'text-lg',
        )}>
          Workspaces
        </Text>
        <Text className={cn(
          'text-muted-foreground mt-1',
          isWide ? 'text-sm' : 'text-xs',
        )}>
          Browse and manage all platform workspaces
        </Text>
      </View>

      <View className={cn(
        'flex-row items-center border border-border rounded-lg bg-card',
        isWide ? 'px-4 py-2.5' : 'px-3 py-2',
      )}>
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

      {data && !loading && (
        <Text className="text-xs text-muted-foreground mt-2">
          {data.total} workspace{data.total !== 1 ? 's' : ''} found
        </Text>
      )}
    </View>
  )

  const ListFooter = () => {
    if (totalPages <= 1) return null
    return (
      <View className={cn(
        'flex-row items-center justify-between mt-3 px-1',
        isWide && 'mt-5',
      )}>
        <Text className="text-xs text-muted-foreground">
          Page {page} of {totalPages} &middot; {data?.total} total
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

  if (isWide) {
    return (
      <View className="flex-1 bg-background px-8 pt-6" style={{ maxWidth: 1200 }}>
        <FlatList
          data={data?.workspaces ?? []}
          keyExtractor={(item) => item.id}
          numColumns={2}
          columnWrapperStyle={{ gap: 16 }}
          ListHeaderComponent={<ListHeader />}
          ListFooterComponent={<ListFooter />}
          ListEmptyComponent={loading ? null : <EmptyState />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          renderItem={({ item }) => (
            <View style={{ flex: 1 }}>
              <WorkspaceCard
                workspace={item}
                isWide={isWide}
                onPress={() => {}}
              />
            </View>
          )}
          contentContainerStyle={{ paddingBottom: 32 }}
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
            isWide={isWide}
            onPress={() => {}}
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
