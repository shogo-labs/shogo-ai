// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Workspace Detail - Shows workspace info, members, projects, and billing summary.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  ArrowLeft,
  Building2,
  Users,
  FolderKanban,
  Calendar,
  Mail,
  ChevronRight,
  Shield,
  User,
  Globe,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

interface WorkspaceDetail {
  id: string
  name: string
  slug: string
  description: string | null
  createdAt: string
  updatedAt: string
  projects: Array<{
    id: string
    name: string
    status: string
    tier: string
    createdAt: string
  }>
  members: Array<{
    id: string
    userId: string
    role: string
    user?: { id: string; name: string | null; email: string; image: string | null }
  }>
  invitations: Array<{ id: string; email: string; role: string }>
  subscriptions: Array<{ id: string; status: string; plan: string }>
  _count?: {
    projects: number
    members: number
    folders: number
    invitations: number
    billingAccounts: number
  }
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

export default function AdminWorkspaceDetailPage() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadWorkspace = useCallback(async () => {
    if (!workspaceId) return
    const data = await fetchAdminJson<WorkspaceDetail>(`/workspaces/${workspaceId}`)
    setWorkspace(data)
    setLoading(false)
    setRefreshing(false)
  }, [workspaceId])

  useEffect(() => {
    loadWorkspace()
  }, [loadWorkspace])

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (!workspace) {
    return (
      <View className="flex-1 bg-background items-center justify-center p-6">
        <Text className="text-muted-foreground">Workspace not found.</Text>
        <Pressable
          onPress={() => router.replace('/(admin)/workspaces' as any)}
          className="mt-4 flex-row items-center gap-2"
        >
          <ArrowLeft size={16} className="text-primary" />
          <Text className="text-primary text-sm">Back to Workspaces</Text>
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
          onRefresh={() => { setRefreshing(true); loadWorkspace() }}
        />
      }
    >
      <View style={isWide ? { maxWidth: 1000, width: '100%' } : undefined}>
        <Pressable
          onPress={() => router.replace('/(admin)/workspaces' as any)}
          className={cn(
            'flex-row items-center gap-2 mb-4 self-start',
            isWide ? 'py-1.5 px-3 rounded-lg border border-border active:bg-muted/50' : 'active:opacity-60',
          )}
        >
          <ArrowLeft size={16} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground font-medium">Back to Workspaces</Text>
        </Pressable>

        {/* Header card */}
        <View className="rounded-xl border border-border bg-card p-5 mb-4">
          <View className="flex-row items-start gap-4">
            <View className={cn('rounded-lg bg-primary/10 items-center justify-center', isWide ? 'h-14 w-14' : 'h-12 w-12')}>
              <Building2 size={isWide ? 24 : 20} className="text-primary" />
            </View>
            <View className="flex-1">
              <Text className={cn('font-bold text-foreground', isWide ? 'text-xl' : 'text-lg')}>
                {workspace.name}
              </Text>
              <View className="flex-row items-center gap-1.5 mt-0.5">
                <Globe size={12} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">{workspace.slug}</Text>
              </View>
              {workspace.description && (
                <Text className="text-sm text-muted-foreground mt-2">{workspace.description}</Text>
              )}
            </View>
          </View>

          <View className="flex-row flex-wrap gap-4 mt-4 pt-3 border-t border-border">
            <View className="flex-row items-center gap-1.5">
              <Users size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {workspace.members?.length ?? 0} members
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              <FolderKanban size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {workspace.projects?.length ?? 0} projects
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              <Mail size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {workspace.invitations?.length ?? 0} pending invitations
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              <Calendar size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                Created {new Date(workspace.createdAt).toLocaleDateString()}
              </Text>
            </View>
          </View>
        </View>

        {/* Members + Projects */}
        <View className={cn(isWide ? 'flex-row gap-4' : 'gap-4')}>
          {/* Members */}
          <View className={cn('rounded-xl border border-border bg-card p-4', isWide ? 'flex-1' : '')}>
            <View className="flex-row items-center gap-2 mb-3">
              <Users size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Members ({workspace.members?.length ?? 0})
              </Text>
            </View>
            {!workspace.members?.length ? (
              <Text className="text-sm text-muted-foreground">No members</Text>
            ) : (
              <View className="gap-2">
                {workspace.members.slice(0, 20).map((m) => (
                  <Pressable
                    key={m.id}
                    onPress={() => router.push(`/(admin)/users/${m.userId}` as any)}
                    className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50 active:bg-muted"
                  >
                    <View className="flex-row items-center gap-2 flex-1 min-w-0">
                      <View className="h-7 w-7 rounded-full bg-primary/10 items-center justify-center">
                        <Text className="text-[10px] font-medium text-primary">
                          {(m.user?.name || m.user?.email || '?').charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <View className="flex-1 min-w-0">
                        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                          {m.user?.name || m.user?.email || m.userId.slice(0, 8)}
                        </Text>
                        {m.user?.email && m.user?.name && (
                          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                            {m.user.email}
                          </Text>
                        )}
                      </View>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <View className={cn(
                        'flex-row items-center gap-1 px-2 py-0.5 rounded-full',
                        m.role === 'owner' ? 'bg-primary/10' : 'bg-muted',
                      )}>
                        {m.role === 'owner' || m.role === 'admin' ? (
                          <Shield size={10} className={m.role === 'owner' ? 'text-primary' : 'text-muted-foreground'} />
                        ) : (
                          <User size={10} className="text-muted-foreground" />
                        )}
                        <Text className={cn(
                          'text-[10px] font-medium capitalize',
                          m.role === 'owner' ? 'text-primary' : 'text-muted-foreground',
                        )}>
                          {m.role}
                        </Text>
                      </View>
                      <ChevronRight size={14} className="text-muted-foreground" />
                    </View>
                  </Pressable>
                ))}
                {workspace.members.length > 20 && (
                  <Text className="text-xs text-muted-foreground text-center mt-1">
                    +{workspace.members.length - 20} more members
                  </Text>
                )}
              </View>
            )}
          </View>

          {/* Projects */}
          <View className={cn('rounded-xl border border-border bg-card p-4', isWide ? 'flex-1' : '')}>
            <View className="flex-row items-center gap-2 mb-3">
              <FolderKanban size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Projects ({workspace.projects?.length ?? 0})
              </Text>
            </View>
            {!workspace.projects?.length ? (
              <Text className="text-sm text-muted-foreground">No projects</Text>
            ) : (
              <View className="gap-2">
                {workspace.projects.slice(0, 20).map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => router.push(`/(admin)/projects/${p.id}` as any)}
                    className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50 active:bg-muted"
                  >
                    <View className="flex-1 min-w-0 mr-2">
                      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <View className={cn(
                        'px-2 py-0.5 rounded-full',
                        p.status === 'published' ? 'bg-green-100 dark:bg-green-900/30' : 'bg-muted',
                      )}>
                        <Text className={cn(
                          'text-[10px] font-medium capitalize',
                          p.status === 'published' ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
                        )}>
                          {p.status}
                        </Text>
                      </View>
                      <View className="px-2 py-0.5 rounded-full bg-muted">
                        <Text className="text-[10px] font-medium text-muted-foreground capitalize">
                          {p.tier}
                        </Text>
                      </View>
                      <ChevronRight size={14} className="text-muted-foreground" />
                    </View>
                  </Pressable>
                ))}
                {workspace.projects.length > 20 && (
                  <Text className="text-xs text-muted-foreground text-center mt-1">
                    +{workspace.projects.length - 20} more projects
                  </Text>
                )}
              </View>
            )}
          </View>
        </View>
      </View>
    </ScrollView>
  )
}
