// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Users - User management with search, role filter, and pagination.
 *
 * Responsive: on desktop (>=900px) shows extra table columns (Sessions, Starred),
 * inline search + filter row, and constrains content to maxWidth 1200.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  ActivityIndicator,
  Image,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  Search,
  Shield,
  User,
  Users,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogBody,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog'
import { Heading } from '@/components/ui/heading'
import { Text as UIText } from '@/components/ui/text'
import { Button, ButtonText } from '@/components/ui/button'
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
  isWide,
}: {
  user: AdminUser
  onPress: () => void
  onToggleRole: () => void
  isWide: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-row items-center border-b border-border active:bg-muted/30',
        isWide ? 'px-4 py-3' : 'p-3',
      )}
    >
      <View className="h-9 w-9 rounded-full bg-primary/10 items-center justify-center mr-3">
        {user.image ? (
          <Image source={{ uri: user.image }} className="h-9 w-9 rounded-full" />
        ) : (
          <Text className="text-xs font-medium text-primary">
            {(user.name || user.email).charAt(0).toUpperCase()}
          </Text>
        )}
      </View>

      <View className={cn('min-w-0 mr-2', isWide ? 'w-[260px]' : 'flex-1')}>
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {user.name || 'Unnamed'}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {user.email}
        </Text>
      </View>

      <View
        className={cn(
          'flex-row items-center gap-1 px-2 py-0.5 rounded-full mr-3',
          user.role === 'super_admin' ? 'bg-primary/10' : 'bg-muted',
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
            user.role === 'super_admin' ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          {user.role === 'super_admin' ? 'Admin' : 'User'}
        </Text>
      </View>

      <Text className={cn('text-xs text-muted-foreground', isWide ? 'w-[60px] text-center' : 'mr-2')}>
        {user._count.members}
        {!isWide && 'ws'}
      </Text>

      {isWide && (
        <Text className="text-xs text-muted-foreground w-[60px] text-center">
          {user._count.sessions}
        </Text>
      )}

      {isWide && (
        <Text className="text-xs text-muted-foreground w-[60px] text-center">
          {user._count.starredProjects}
        </Text>
      )}

      <Text className={cn('text-xs text-muted-foreground', isWide ? 'w-[80px] text-right' : 'flex-shrink-0')}>
        {new Date(user.createdAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          ...(isWide ? { year: 'numeric' } : {}),
        })}
      </Text>

      <Pressable
        onPress={(e) => {
          e.stopPropagation()
          onToggleRole()
        }}
        className={cn(
          'ml-2 p-1.5 rounded-md',
          user.role === 'super_admin'
            ? 'active:bg-destructive/10'
            : 'active:bg-primary/10',
        )}
        hitSlop={4}
      >
        {user.role === 'super_admin' ? (
          <ShieldOff size={14} className="text-muted-foreground" />
        ) : (
          <ShieldCheck size={14} className="text-muted-foreground" />
        )}
      </Pressable>
    </Pressable>
  )
}

export default function AdminUsersPage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [roleFilter, setRoleFilter] = useState<string>('')
  const [data, setData] = useState<UsersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [roleDialog, setRoleDialog] = useState<{ userId: string; name: string; currentRole: string } | null>(null)

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

  const confirmToggleRole = useCallback(async () => {
    if (!roleDialog) return
    const newRole = roleDialog.currentRole === 'super_admin' ? 'user' : 'super_admin'
    const result = await adminUpdateUser(roleDialog.userId, { role: newRole })
    setRoleDialog(null)
    if (result.ok) loadUsers()
  }, [roleDialog, loadUsers])

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  const onRefresh = () => {
    setRefreshing(true)
    loadUsers()
  }

  const isPromoting = roleDialog?.currentRole !== 'super_admin'

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

        <View
          className={cn(
            'flex-row items-center bg-muted rounded-lg p-0.5 gap-0.5',
            isWide ? 'w-[240px]' : '',
          )}
        >
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
                roleFilter === role.value ? 'bg-background shadow-sm' : '',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  roleFilter === role.value ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {role.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {isWide && data && (
        <Text className="text-xs text-muted-foreground">
          {data.total} user{data.total !== 1 ? 's' : ''} total
          {roleFilter ? ` (filtered by ${roleFilter === 'super_admin' ? 'admins' : 'users'})` : ''}
        </Text>
      )}

      <View
        className={cn(
          'flex-row items-center bg-muted/50 rounded-t-lg border-b border-border',
          isWide ? 'px-4 py-2.5' : 'px-3 py-2',
        )}
      >
        <View className={cn('mr-3', isWide ? 'w-9' : 'w-9')} />
        <Text className={cn('text-xs font-medium text-muted-foreground', isWide ? 'w-[260px]' : 'flex-1')}>
          User
        </Text>
        <Text className="text-xs font-medium text-muted-foreground mr-3">Role</Text>
        <Text className={cn('text-xs font-medium text-muted-foreground', isWide ? 'w-[60px] text-center' : 'mr-2')}>
          WS
        </Text>
        {isWide && (
          <Text className="text-xs font-medium text-muted-foreground w-[60px] text-center">
            Sessions
          </Text>
        )}
        {isWide && (
          <Text className="text-xs font-medium text-muted-foreground w-[60px] text-center">
            Starred
          </Text>
        )}
        <Text className={cn('text-xs font-medium text-muted-foreground', isWide ? 'w-[80px] text-right' : 'flex-shrink-0')}>
          Joined
        </Text>
        <View className="ml-2 w-[26px]" />
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
      <Users size={32} className="text-muted-foreground/50 mb-2" />
      <Text className="text-sm text-muted-foreground">No users found</Text>
    </View>
  )

  return (
    <View className={cn('flex-1 bg-background', isWide ? 'px-8 pt-6' : 'px-4 pt-2')}>
      <View
        className="flex-1"
        style={isWide ? { maxWidth: 1200, width: '100%', alignSelf: 'center' } : undefined}
      >
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
              isWide={isWide}
              onPress={() => router.push(`/(admin)/users/${item.id}`)}
              onToggleRole={() =>
                setRoleDialog({ userId: item.id, name: item.name || item.email, currentRole: item.role })
              }
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

      <AlertDialog isOpen={!!roleDialog} onClose={() => setRoleDialog(null)} size="sm">
        <AlertDialogBackdrop />
        <AlertDialogContent>
          <AlertDialogHeader>
            <Heading size="md" className="text-typography-950">
              {isPromoting ? 'Promote to Super Admin' : 'Remove Super Admin'}
            </Heading>
          </AlertDialogHeader>
          <AlertDialogBody className="mt-3 mb-4">
            <UIText size="sm" className="text-typography-700">
              {isPromoting
                ? `Are you sure you want to make ${roleDialog?.name} a super admin? They will have full platform access.`
                : `Are you sure you want to remove admin privileges from ${roleDialog?.name}?`}
            </UIText>
          </AlertDialogBody>
          <AlertDialogFooter>
            <Button variant="outline" action="secondary" onPress={() => setRoleDialog(null)}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button action={isPromoting ? 'primary' : 'negative'} onPress={confirmToggleRole}>
              <ButtonText>{isPromoting ? 'Make Admin' : 'Remove Admin'}</ButtonText>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </View>
  )
}
