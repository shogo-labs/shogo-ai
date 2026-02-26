/**
 * Admin Users - User management with search, role filter, and pagination.
 *
 * Converted from apps/web/src/components/admin/pages/AdminUsers.tsx
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  Search,
  Shield,
  User,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

interface AdminUser {
  id: string
  name: string | null
  email: string
  role: string
  image: string | null
  emailVerified: boolean
  createdAt: string
  updatedAt: string
  _count: {
    sessions: number
    accounts: number
    members: number
    notifications: number
    starredProjects: number
  }
}

interface UsersResponse {
  users: AdminUser[]
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

async function adminUpdateUser(
  userId: string,
  input: { name?: string; role?: string }
): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/users/${userId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return res.json()
  } catch {
    return { ok: false }
  }
}

function UserRow({
  user,
  onPress,
  onToggleRole,
}: {
  user: AdminUser
  onPress: () => void
  onToggleRole: () => void
}) {
  const handleLongPress = () => {
    Alert.alert(
      user.name || user.email,
      undefined,
      [
        { text: 'View Details', onPress },
        {
          text: user.role === 'super_admin' ? 'Remove Admin' : 'Make Admin',
          onPress: onToggleRole,
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    )
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={handleLongPress}
      className="flex-row items-center p-3 border-b border-border active:bg-muted/30"
    >
      {/* Avatar */}
      <View className="h-9 w-9 rounded-full bg-primary/10 items-center justify-center mr-3">
        {user.image ? (
          <Image source={{ uri: user.image }} className="h-9 w-9 rounded-full" />
        ) : (
          <Text className="text-xs font-medium text-primary">
            {(user.name || user.email).charAt(0).toUpperCase()}
          </Text>
        )}
      </View>

      {/* Info */}
      <View className="flex-1 min-w-0 mr-2">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {user.name || 'Unnamed'}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {user.email}
        </Text>
      </View>

      {/* Role badge */}
      <View
        className={cn(
          'flex-row items-center gap-1 px-2 py-0.5 rounded-full mr-2',
          user.role === 'super_admin'
            ? 'bg-primary/10'
            : 'bg-muted'
        )}
      >
        {user.role === 'super_admin' ? (
          <Shield size={10} className="text-primary" />
        ) : (
          <User size={10} className="text-muted-foreground" />
        )}
        <Text
          className={cn(
            'text-[10px] font-medium',
            user.role === 'super_admin' ? 'text-primary' : 'text-muted-foreground'
          )}
        >
          {user.role === 'super_admin' ? 'Admin' : 'User'}
        </Text>
      </View>

      {/* Members count */}
      <Text className="text-xs text-muted-foreground mr-2">
        {user._count.members}ws
      </Text>

      {/* Date */}
      <Text className="text-xs text-muted-foreground">
        {new Date(user.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
      </Text>
    </Pressable>
  )
}

export default function AdminUsersPage() {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [roleFilter, setRoleFilter] = useState<string>('')
  const [data, setData] = useState<UsersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadUsers = useCallback(async () => {
    const params: Record<string, string> = {
      page: String(page),
      limit: '20',
    }
    if (search) params.search = search
    if (roleFilter) params.role = roleFilter

    const result = await fetchAdminJson<UsersResponse>('/users', params)
    setData(result)
    setLoading(false)
    setRefreshing(false)
  }, [page, search, roleFilter])

  useEffect(() => {
    setLoading(true)
    loadUsers()
  }, [loadUsers])

  const handleToggleRole = useCallback(
    async (userId: string, currentRole: string) => {
      const newRole = currentRole === 'super_admin' ? 'user' : 'super_admin'
      const label = newRole === 'super_admin' ? 'Make Admin' : 'Remove Admin'
      Alert.alert(
        label,
        `Are you sure you want to ${label.toLowerCase()} for this user?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: label,
            style: newRole === 'user' ? 'destructive' : 'default',
            onPress: async () => {
              const result = await adminUpdateUser(userId, { role: newRole })
              if (result.ok) loadUsers()
            },
          },
        ]
      )
    },
    [loadUsers]
  )

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  const onRefresh = () => {
    setRefreshing(true)
    loadUsers()
  }

  const ListHeader = () => (
    <View className="gap-3 mb-2">
      {/* Search */}
      <View className="flex-row items-center border border-border rounded-lg px-3 py-2 bg-card">
        <Search size={16} className="text-muted-foreground mr-2" />
        <TextInput
          placeholder="Search by name or email..."
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

      {/* Role filter */}
      <View className="flex-row items-center bg-muted rounded-lg p-0.5 gap-0.5">
        {[
          { value: '', label: 'All' },
          { value: 'user', label: 'Users' },
          { value: 'super_admin', label: 'Admins' },
        ].map((role) => (
          <Pressable
            key={role.value}
            onPress={() => {
              setRoleFilter(role.value)
              setPage(1)
            }}
            className={cn(
              'flex-1 items-center py-1.5 rounded-md',
              roleFilter === role.value ? 'bg-background shadow-sm' : ''
            )}
          >
            <Text
              className={cn(
                'text-xs font-medium',
                roleFilter === role.value ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {role.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Table header */}
      <View className="flex-row items-center px-3 py-2 bg-muted/50 rounded-t-lg border-b border-border">
        <Text className="flex-1 text-xs font-medium text-muted-foreground">User</Text>
        <Text className="text-xs font-medium text-muted-foreground mr-2">Role</Text>
        <Text className="text-xs font-medium text-muted-foreground mr-2">WS</Text>
        <Text className="text-xs font-medium text-muted-foreground">Joined</Text>
      </View>
    </View>
  )

  const ListFooter = () => {
    if (totalPages <= 1) return null
    return (
      <View className="flex-row items-center justify-between mt-3 px-1">
        <Text className="text-xs text-muted-foreground">
          {data?.total} users total
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
      <Users size={32} className="text-muted-foreground/50 mb-2" />
      <Text className="text-sm text-muted-foreground">No users found</Text>
    </View>
  )

  return (
    <View className="flex-1 bg-background px-4 pt-2">
      <FlatList
        data={data?.users ?? []}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={<ListHeader />}
        ListFooterComponent={<ListFooter />}
        ListEmptyComponent={loading ? null : <EmptyState />}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        renderItem={({ item }) => (
          <UserRow
            user={item}
            onPress={() => router.push(`/(admin)/users/${item.id}`)}
            onToggleRole={() => handleToggleRole(item.id, item.role)}
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
