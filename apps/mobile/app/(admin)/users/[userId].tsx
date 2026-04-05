// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin User Detail - Detailed view of a single user with workspaces and sessions.
 *
 * Responsive: on desktop (>=900px) uses wider padding, maxWidth 900, a back button,
 * and places workspace memberships and sessions side-by-side.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Image,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Shield,
  User,
  Building2,
  MessageSquare,
  Trash2,
  ArrowLeft,
  Calendar,
  Mail,
  CheckCircle,
  ChevronRight,
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
import { usePlatformConfig } from '../../../lib/platform-config'

const API_BASE = `${API_URL}/api/admin`

interface UserDetail {
  id: string
  name: string | null
  email: string
  role: string
  image: string | null
  emailVerified: boolean
  createdAt: string
  updatedAt: string
  members: Array<{
    id: string
    role: string
    workspaceId: string
    userId: string
    workspace?: { id: string; name: string; slug: string }
  }>
  sessions: Array<{
    id: string
    createdAt: string
    expiresAt: string
  }>
}

async function fetchAdminJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

async function adminUpdateUser(
  userId: string,
  input: { role?: string }
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

async function adminDeleteUser(userId: string): Promise<{ ok?: boolean; error?: { code: string; message: string } }> {
  try {
    const res = await fetch(`${API_BASE}/users/${userId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    return res.json()
  } catch {
    return { error: { code: 'network_error', message: 'Network error. Please try again.' } }
  }
}

export default function AdminUserDetailPage() {
  const { userId } = useLocalSearchParams<{ userId: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const { localMode } = usePlatformConfig()

  const [user, setUser] = useState<UserDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showRoleDialog, setShowRoleDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [workspaceNames, setWorkspaceNames] = useState<Record<string, string>>({})

  const loadUser = useCallback(async () => {
    if (!userId) return
    const data = await fetchAdminJson<UserDetail>(`/users/${userId}`)
    setUser(data)
    setLoading(false)
    setRefreshing(false)

    if (data?.members?.length) {
      const names: Record<string, string> = {}
      await Promise.all(
        data.members.map(async (m) => {
          if (m.workspace?.name) {
            names[m.workspaceId] = m.workspace.name
            return
          }
          const ws = await fetchAdminJson<{ name: string; slug: string }>(`/workspaces/${m.workspaceId}`)
          if (ws) names[m.workspaceId] = ws.name
        })
      )
      setWorkspaceNames(names)
    }
  }, [userId])

  useEffect(() => {
    loadUser()
  }, [loadUser])

  const confirmToggleRole = async () => {
    if (!user) return
    const newRole = user.role === 'super_admin' ? 'user' : 'super_admin'
    const result = await adminUpdateUser(user.id, { role: newRole })
    setShowRoleDialog(false)
    if (result.ok) loadUser()
  }

  const confirmDelete = async () => {
    if (!user) return
    const result = await adminDeleteUser(user.id)
    setShowDeleteDialog(false)
    if (result.ok) {
      router.replace('/(admin)/users' as any)
    } else if (result.error) {
      // Re-open won't happen; user sees the page still
    }
  }

  const isPromoting = user?.role !== 'super_admin'

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (!user) {
    return (
      <View className="flex-1 bg-background items-center justify-center p-6">
        <Text className="text-muted-foreground">User not found.</Text>
        <Pressable
          onPress={() => router.replace('/(admin)/users' as any)}
          className="mt-4 flex-row items-center gap-2"
        >
          <ArrowLeft size={16} className="text-primary" />
          <Text className="text-primary text-sm">Back to Users</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={
        isWide
          ? { paddingHorizontal: 32, paddingTop: 24, paddingBottom: 48, alignItems: 'center' }
          : { padding: 16, paddingBottom: 40 }
      }
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            loadUser()
          }}
        />
      }
    >
      <View>
        <Pressable
          onPress={() => router.replace('/(admin)/users' as any)}
          className={cn(
            'flex-row items-center gap-2 mb-4 self-start',
            isWide ? 'py-1.5 px-3 rounded-lg border border-border active:bg-muted/50' : 'active:opacity-60',
          )}
        >
          <ArrowLeft size={16} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground font-medium">Back to Users</Text>
        </Pressable>

        {/* User header card */}
        <View className="rounded-xl border border-border bg-card p-5 mb-4">
          <View className={cn('items-start', isWide ? 'flex-row' : 'flex-row')}>
            <View
              className={cn(
                'rounded-full bg-primary/10 items-center justify-center mr-4',
                isWide ? 'h-16 w-16' : 'h-14 w-14',
              )}
            >
              {user.image ? (
                <Image
                  source={{ uri: user.image }}
                  className={cn(isWide ? 'h-16 w-16' : 'h-14 w-14', 'rounded-full')}
                />
              ) : (
                <Text className={cn('font-semibold text-primary', isWide ? 'text-xl' : 'text-lg')}>
                  {(user.name || user.email).charAt(0).toUpperCase()}
                </Text>
              )}
            </View>

            <View className="flex-1">
              <Text className={cn('font-bold text-foreground', isWide ? 'text-xl' : 'text-lg')}>
                {user.name || 'Unnamed'}
              </Text>
              <View className="flex-row items-center gap-1.5 mt-0.5">
                <Mail size={12} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">{user.email}</Text>
              </View>
              <View className="flex-row items-center gap-2 mt-2.5 flex-wrap">
                <View
                  className={cn(
                    'flex-row items-center gap-1 px-2.5 py-1 rounded-full',
                    user.role === 'super_admin' ? 'bg-primary/10' : 'bg-muted',
                  )}
                >
                  {user.role === 'super_admin' ? (
                    <Shield size={12} className="text-primary" />
                  ) : (
                    <User size={12} className="text-muted-foreground" />
                  )}
                  <Text
                    className={cn(
                      'text-xs font-medium',
                      user.role === 'super_admin' ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {user.role === 'super_admin' ? 'Super Admin' : 'User'}
                  </Text>
                </View>
                {user.emailVerified && (
                  <View className="flex-row items-center gap-1 px-2.5 py-1 rounded-full bg-green-100 dark:bg-green-900/30">
                    <CheckCircle size={11} className="text-green-600 dark:text-green-400" />
                    <Text className="text-xs font-medium text-green-700 dark:text-green-400">
                      Verified
                    </Text>
                  </View>
                )}
              </View>
            </View>

            {isWide && !localMode && (
              <View className="flex-row gap-2 ml-4">
                <Pressable
                  onPress={() => setShowRoleDialog(true)}
                  className="items-center px-4 py-2 rounded-lg border border-border active:bg-muted/50"
                >
                  <Text className="text-sm font-medium text-foreground">
                    {user.role === 'super_admin' ? 'Remove Admin' : 'Make Admin'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setShowDeleteDialog(true)}
                  className="flex-row items-center gap-1.5 px-4 py-2 rounded-lg bg-destructive active:opacity-90"
                >
                  <Trash2 size={14} className="text-destructive-foreground" />
                  <Text className="text-sm font-medium text-destructive-foreground">
                    Delete
                  </Text>
                </Pressable>
              </View>
            )}
          </View>

          {!isWide && !localMode && (
            <View className="flex-row gap-2 mt-4">
              <Pressable
                onPress={() => setShowRoleDialog(true)}
                className="flex-1 items-center py-2.5 rounded-lg border border-border"
              >
                <Text className="text-sm font-medium text-foreground">
                  {user.role === 'super_admin' ? 'Remove Admin' : 'Make Admin'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setShowDeleteDialog(true)}
                className="flex-row items-center justify-center gap-1.5 py-2.5 px-4 rounded-lg bg-destructive"
              >
                <Trash2 size={14} className="text-destructive-foreground" />
                <Text className="text-sm font-medium text-destructive-foreground">
                  Delete
                </Text>
              </Pressable>
            </View>
          )}

          <View className="flex-row gap-4 mt-4 pt-3 border-t border-border">
            <View className="flex-row items-center gap-1.5 flex-1">
              <Calendar size={12} className="text-muted-foreground" />
              <View>
                <Text className="text-xs text-muted-foreground">Joined</Text>
                <Text className="text-sm font-medium text-foreground">
                  {new Date(user.createdAt).toLocaleDateString()}
                </Text>
              </View>
            </View>
            <View className="flex-row items-center gap-1.5 flex-1">
              <Calendar size={12} className="text-muted-foreground" />
              <View>
                <Text className="text-xs text-muted-foreground">Last Updated</Text>
                <Text className="text-sm font-medium text-foreground">
                  {new Date(user.updatedAt).toLocaleDateString()}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* Workspaces + Sessions */}
        <View className={cn(isWide ? 'flex-row gap-4' : 'gap-4')}>
          <View className={cn('rounded-xl border border-border bg-card p-4', isWide ? 'flex-1' : '')}>
            <View className="flex-row items-center gap-2 mb-3">
              <Building2 size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Workspace Memberships ({user.members?.length ?? 0})
              </Text>
            </View>
            {!user.members?.length ? (
              <Text className="text-sm text-muted-foreground">No workspaces</Text>
            ) : (
              <View className="gap-2">
                {user.members.map((m) => (
                  <Pressable
                    key={m.id}
                    onPress={() => router.push(`/(admin)/workspaces/${m.workspaceId}` as any)}
                    className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50 active:bg-muted"
                  >
                    <View className="flex-1 min-w-0 mr-2">
                      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                        {workspaceNames[m.workspaceId] || `Workspace ${m.workspaceId.slice(0, 8)}...`}
                      </Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <View className="bg-muted px-2 py-0.5 rounded-full">
                        <Text className="text-xs font-medium text-muted-foreground capitalize">
                          {m.role}
                        </Text>
                      </View>
                      <ChevronRight size={14} className="text-muted-foreground" />
                    </View>
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          <View className={cn('rounded-xl border border-border bg-card p-4', isWide ? 'flex-1' : '')}>
            <View className="flex-row items-center gap-2 mb-3">
              <MessageSquare size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Recent Sessions ({user.sessions?.length ?? 0})
              </Text>
            </View>
            {!user.sessions?.length ? (
              <Text className="text-sm text-muted-foreground">No sessions</Text>
            ) : (
              <View className="gap-2">
                {user.sessions.slice(0, 10).map((session) => (
                  <View
                    key={session.id}
                    className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50"
                  >
                    <Text className="text-xs font-medium font-mono text-foreground" numberOfLines={1}>
                      {session.id.slice(0, 16)}...
                    </Text>
                    <Text className="text-xs text-muted-foreground ml-3">
                      {new Date(session.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        </View>
      </View>

      {/* Role toggle dialog */}
      <AlertDialog isOpen={showRoleDialog} onClose={() => setShowRoleDialog(false)} size="sm">
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
                ? `Are you sure you want to make ${user?.email} a super admin? They will have full platform access.`
                : `Are you sure you want to remove admin privileges from ${user?.email}?`}
            </UIText>
          </AlertDialogBody>
          <AlertDialogFooter>
            <Button variant="outline" action="secondary" onPress={() => setShowRoleDialog(false)}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button action={isPromoting ? 'primary' : 'negative'} onPress={confirmToggleRole}>
              <ButtonText>{isPromoting ? 'Make Admin' : 'Remove Admin'}</ButtonText>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation dialog */}
      <AlertDialog isOpen={showDeleteDialog} onClose={() => setShowDeleteDialog(false)} size="sm">
        <AlertDialogBackdrop />
        <AlertDialogContent>
          <AlertDialogHeader>
            <Heading size="md" className="text-typography-950">
              Delete User
            </Heading>
          </AlertDialogHeader>
          <AlertDialogBody className="mt-3 mb-4">
            <UIText size="sm" className="text-typography-700">
              Are you sure you want to delete {user?.email}? This action cannot be undone.
            </UIText>
          </AlertDialogBody>
          <AlertDialogFooter>
            <Button variant="outline" action="secondary" onPress={() => setShowDeleteDialog(false)}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button action="negative" onPress={confirmDelete}>
              <ButtonText>Delete User</ButtonText>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollView>
  )
}
