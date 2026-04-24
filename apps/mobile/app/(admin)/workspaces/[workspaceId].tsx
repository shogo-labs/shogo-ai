// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Workspace Detail - Shows full workspace info, members, projects, and subscriptions.
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
  ChevronRight,
  Shield,
  User,
  CreditCard,
  Key,
  Database,
  HardDrive,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

interface WorkspaceMember {
  id: string
  userId: string
  role: string
  createdAt: string
  user?: { id: string; name: string | null; email: string }
}

interface WorkspaceProject {
  id: string
  name: string
  description: string | null
  status: string
  tier: string
  createdAt: string
}

interface WorkspaceSubscription {
  id: string
  planId: string
  status: string
  currentPeriodEnd: string | null
  createdAt: string
}

interface WorkspaceApiKey {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

interface WorkspaceStorageUsage {
  id: string
  bytesUsed: string | number
  updatedAt: string
}

interface InstanceSubscription {
  id: string
  status: string
  createdAt: string
}

interface WorkspaceDetail {
  id: string
  name: string
  slug: string
  description: string | null
  instanceSize: string
  ssoSettings: unknown
  createdAt: string
  updatedAt: string
  members?: WorkspaceMember[]
  projects?: WorkspaceProject[]
  subscriptions?: WorkspaceSubscription[]
  apiKeys?: WorkspaceApiKey[]
  storageUsage?: WorkspaceStorageUsage | null
  instanceSubscription?: InstanceSubscription | null
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

const INSTANCE_SIZE_COLORS: Record<string, { bg: string; text: string }> = {
  micro: { bg: 'bg-muted', text: 'text-muted-foreground' },
  small: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  medium: { bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-400' },
  large: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-400' },
  xlarge: { bg: 'bg-pink-100 dark:bg-pink-900/30', text: 'text-pink-700 dark:text-pink-400' },
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  published: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  draft: { bg: 'bg-muted', text: 'text-muted-foreground' },
  archived: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400' },
  active: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  trialing: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  past_due: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400' },
  canceled: { bg: 'bg-muted', text: 'text-muted-foreground' },
}

function formatBytes(input: string | number | undefined | null): string {
  if (input == null) return '0 B'
  const n = typeof input === 'string' ? Number(input) : input
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export default function AdminWorkspaceDetailPage() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [userNames, setUserNames] = useState<Record<string, { name: string | null; email: string }>>({})

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

  // Hydrate user display info for member list since the generated admin
  // GET doesn't include nested `user` for members.
  useEffect(() => {
    if (!workspace?.members?.length) return
    const missing = workspace.members
      .map((m) => m.userId)
      .filter((id) => id && !userNames[id])
    if (missing.length === 0) return
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(
        missing.slice(0, 30).map(async (id) => {
          const u = await fetchAdminJson<{ id: string; name: string | null; email: string }>(`/users/${id}`)
          return [id, u ? { name: u.name, email: u.email } : null] as const
        })
      )
      if (cancelled) return
      setUserNames((prev) => {
        const next = { ...prev }
        for (const [id, val] of entries) {
          if (val) next[id] = val
        }
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [workspace?.members, userNames])

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

  const sizeStyle = INSTANCE_SIZE_COLORS[workspace.instanceSize] ?? INSTANCE_SIZE_COLORS.micro

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
              <Text className="text-xs text-muted-foreground font-mono mt-0.5">
                {workspace.slug}
              </Text>
              {workspace.description && (
                <Text className="text-sm text-muted-foreground mt-2">{workspace.description}</Text>
              )}
              <View className="flex-row items-center gap-2 mt-2.5 flex-wrap">
                <View className={cn('px-2.5 py-1 rounded-full', sizeStyle.bg)}>
                  <Text className={cn('text-xs font-medium capitalize', sizeStyle.text)}>
                    {workspace.instanceSize}
                  </Text>
                </View>
                {workspace.instanceSubscription && (
                  <View className="px-2.5 py-1 rounded-full bg-muted flex-row items-center gap-1">
                    <Database size={10} className="text-muted-foreground" />
                    <Text className="text-xs font-medium text-muted-foreground">
                      Dedicated instance
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>

          {/* Metadata row */}
          <View className="flex-row flex-wrap gap-4 mt-4 pt-3 border-t border-border">
            <View className="flex-row items-center gap-1.5">
              <Calendar size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                Created {new Date(workspace.createdAt).toLocaleDateString()}
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              <Calendar size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                Updated {new Date(workspace.updatedAt).toLocaleDateString()}
              </Text>
            </View>
            {workspace.storageUsage && (
              <View className="flex-row items-center gap-1.5">
                <HardDrive size={12} className="text-muted-foreground" />
                <Text className="text-xs text-muted-foreground">
                  {formatBytes(workspace.storageUsage.bytesUsed)} storage
                </Text>
              </View>
            )}
          </View>

          <View className="mt-3 pt-3 border-t border-border">
            <Text className="text-xs text-muted-foreground">
              ID: <Text className="font-mono">{workspace.id}</Text>
            </Text>
          </View>
        </View>

        {/* Stats row */}
        <View className={cn('mb-4', isWide ? 'flex-row gap-4' : 'gap-2')}>
          <StatCard
            icon={<Users size={16} className="text-foreground" />}
            label="Members"
            value={workspace.members?.length ?? 0}
            isWide={isWide}
          />
          <StatCard
            icon={<FolderKanban size={16} className="text-foreground" />}
            label="Projects"
            value={workspace.projects?.length ?? 0}
            isWide={isWide}
          />
          <StatCard
            icon={<CreditCard size={16} className="text-foreground" />}
            label="Subscriptions"
            value={workspace.subscriptions?.length ?? 0}
            isWide={isWide}
          />
          <StatCard
            icon={<Key size={16} className="text-foreground" />}
            label="API Keys"
            value={workspace.apiKeys?.length ?? 0}
            isWide={isWide}
          />
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
                {workspace.members.slice(0, 25).map((m) => {
                  const info = userNames[m.userId] ?? (m.user ? { name: m.user.name, email: m.user.email } : null)
                  const displayName = info?.name || info?.email || `User ${m.userId.slice(0, 8)}...`
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => router.push(`/(admin)/users/${m.userId}` as any)}
                      className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50 active:bg-muted"
                    >
                      <View className="flex-row items-center gap-2 flex-1 min-w-0">
                        <View className="h-7 w-7 rounded-full bg-primary/10 items-center justify-center">
                          <Text className="text-[10px] font-medium text-primary">
                            {displayName.charAt(0).toUpperCase()}
                          </Text>
                        </View>
                        <View className="flex-1 min-w-0">
                          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                            {displayName}
                          </Text>
                          {info?.email && info?.name && (
                            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                              {info.email}
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
                  )
                })}
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
                {workspace.projects.slice(0, 25).map((p) => {
                  const statusStyle = STATUS_COLORS[p.status] ?? STATUS_COLORS.draft
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => router.push(`/(admin)/projects/${p.id}` as any)}
                      className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50 active:bg-muted"
                    >
                      <View className="flex-1 min-w-0 mr-2">
                        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                          {p.name}
                        </Text>
                        {p.description && (
                          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                            {p.description}
                          </Text>
                        )}
                      </View>
                      <View className="flex-row items-center gap-2">
                        <View className={cn('px-2 py-0.5 rounded-full', statusStyle.bg)}>
                          <Text className={cn('text-[10px] font-medium capitalize', statusStyle.text)}>
                            {p.status}
                          </Text>
                        </View>
                        <ChevronRight size={14} className="text-muted-foreground" />
                      </View>
                    </Pressable>
                  )
                })}
              </View>
            )}
          </View>
        </View>

        {/* Subscriptions */}
        {!!workspace.subscriptions?.length && (
          <View className="rounded-xl border border-border bg-card p-4 mt-4">
            <View className="flex-row items-center gap-2 mb-3">
              <CreditCard size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Subscriptions ({workspace.subscriptions.length})
              </Text>
            </View>
            <View className="gap-2">
              {workspace.subscriptions.map((s) => {
                const statusStyle = STATUS_COLORS[s.status] ?? STATUS_COLORS.canceled
                return (
                  <View
                    key={s.id}
                    className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50"
                  >
                    <View className="flex-1 min-w-0 mr-2">
                      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                        {s.planId}
                      </Text>
                      {s.currentPeriodEnd && (
                        <Text className="text-xs text-muted-foreground">
                          Renews {new Date(s.currentPeriodEnd).toLocaleDateString()}
                        </Text>
                      )}
                    </View>
                    <View className={cn('px-2 py-0.5 rounded-full', statusStyle.bg)}>
                      <Text className={cn('text-[10px] font-medium capitalize', statusStyle.text)}>
                        {s.status}
                      </Text>
                    </View>
                  </View>
                )
              })}
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  )
}

function StatCard({
  icon,
  label,
  value,
  isWide,
}: {
  icon: React.ReactNode
  label: string
  value: number
  isWide: boolean
}) {
  return (
    <View
      className={cn(
        'rounded-xl border border-border bg-card p-3',
        isWide ? 'flex-1' : 'flex-row items-center justify-between',
      )}
    >
      <View className={cn('flex-row items-center gap-2', isWide ? 'mb-1' : '')}>
        {icon}
        <Text className="text-xs text-muted-foreground font-medium">{label}</Text>
      </View>
      <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-lg')}>
        {value}
      </Text>
    </View>
  )
}
