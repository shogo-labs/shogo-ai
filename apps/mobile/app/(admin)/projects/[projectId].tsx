// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Project Detail - Shows full project info, workspace link, members, and chat sessions.
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
  FolderKanban,
  Building2,
  Users,
  MessageSquare,
  Calendar,
  Globe,
  ChevronRight,
  Shield,
  User,
  Star,
  GitBranch,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

interface ProjectDetail {
  id: string
  name: string
  description: string | null
  workspaceId: string
  tier: string
  status: string
  schemas: string[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
  publishedSubdomain: string | null
  publishedAt: string | null
  accessLevel: string
  category: string | null
  siteTitle: string | null
  siteDescription: string | null
  knativeServiceName: string | null
  workspace?: { id: string; name: string; slug: string }
  members: Array<{
    id: string
    userId: string
    role: string
    user?: { id: string; name: string | null; email: string }
  }>
  chatSessions: Array<{
    id: string
    createdAt: string
  }>
  starredBy: Array<{ id: string; userId: string }>
  githubConnection: { id: string; repoFullName: string } | null
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

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  published: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  draft: { bg: 'bg-muted', text: 'text-muted-foreground' },
  archived: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400' },
}

export default function AdminProjectDetailPage() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadProject = useCallback(async () => {
    if (!projectId) return
    const data = await fetchAdminJson<ProjectDetail>(`/projects/${projectId}`)
    setProject(data)
    setLoading(false)
    setRefreshing(false)
  }, [projectId])

  useEffect(() => {
    loadProject()
  }, [loadProject])

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (!project) {
    return (
      <View className="flex-1 bg-background items-center justify-center p-6">
        <Text className="text-muted-foreground">Project not found.</Text>
        <Pressable
          onPress={() => router.replace('/(admin)/projects' as any)}
          className="mt-4 flex-row items-center gap-2"
        >
          <ArrowLeft size={16} className="text-primary" />
          <Text className="text-primary text-sm">Back to Projects</Text>
        </Pressable>
      </View>
    )
  }

  const statusStyle = STATUS_COLORS[project.status] ?? STATUS_COLORS.draft

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
          onRefresh={() => { setRefreshing(true); loadProject() }}
        />
      }
    >
      <View style={isWide ? { maxWidth: 1000, width: '100%' } : undefined}>
        <Pressable
          onPress={() => router.replace('/(admin)/projects' as any)}
          className={cn(
            'flex-row items-center gap-2 mb-4 self-start',
            isWide ? 'py-1.5 px-3 rounded-lg border border-border active:bg-muted/50' : 'active:opacity-60',
          )}
        >
          <ArrowLeft size={16} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground font-medium">Back to Projects</Text>
        </Pressable>

        {/* Header card */}
        <View className="rounded-xl border border-border bg-card p-5 mb-4">
          <View className="flex-row items-start gap-4">
            <View className={cn('rounded-lg bg-primary/10 items-center justify-center', isWide ? 'h-14 w-14' : 'h-12 w-12')}>
              <FolderKanban size={isWide ? 24 : 20} className="text-primary" />
            </View>
            <View className="flex-1">
              <Text className={cn('font-bold text-foreground', isWide ? 'text-xl' : 'text-lg')}>
                {project.name}
              </Text>
              {project.description && (
                <Text className="text-sm text-muted-foreground mt-1">{project.description}</Text>
              )}
              <View className="flex-row items-center gap-2 mt-2.5 flex-wrap">
                <View className={cn('px-2.5 py-1 rounded-full', statusStyle.bg)}>
                  <Text className={cn('text-xs font-medium capitalize', statusStyle.text)}>
                    {project.status}
                  </Text>
                </View>
                <View className="px-2.5 py-1 rounded-full bg-muted">
                  <Text className="text-xs font-medium text-muted-foreground capitalize">
                    {project.tier}
                  </Text>
                </View>
                <View className="px-2.5 py-1 rounded-full bg-muted">
                  <Text className="text-xs font-medium text-muted-foreground capitalize">
                    {project.accessLevel}
                  </Text>
                </View>
                {project.category && (
                  <View className="px-2.5 py-1 rounded-full bg-muted">
                    <Text className="text-xs font-medium text-muted-foreground capitalize">
                      {project.category}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>

          {/* Workspace link */}
          {project.workspace && (
            <Pressable
              onPress={() => router.push(`/(admin)/workspaces/${project.workspaceId}` as any)}
              className="flex-row items-center gap-2 mt-4 pt-3 border-t border-border active:opacity-70"
            >
              <Building2 size={14} className="text-muted-foreground" />
              <Text className="text-sm text-foreground font-medium">
                {project.workspace.name}
              </Text>
              <Text className="text-xs text-muted-foreground">({project.workspace.slug})</Text>
              <ChevronRight size={14} className="text-muted-foreground ml-auto" />
            </Pressable>
          )}

          {/* Metadata row */}
          <View className="flex-row flex-wrap gap-4 mt-3 pt-3 border-t border-border">
            {project.publishedSubdomain && (
              <View className="flex-row items-center gap-1.5">
                <Globe size={12} className="text-muted-foreground" />
                <Text className="text-xs text-muted-foreground">{project.publishedSubdomain}</Text>
              </View>
            )}
            {project.githubConnection && (
              <View className="flex-row items-center gap-1.5">
                <GitBranch size={12} className="text-muted-foreground" />
                <Text className="text-xs text-muted-foreground">{project.githubConnection.repoFullName}</Text>
              </View>
            )}
            <View className="flex-row items-center gap-1.5">
              <Star size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {project.starredBy?.length ?? 0} stars
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              <Calendar size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                Created {new Date(project.createdAt).toLocaleDateString()}
              </Text>
            </View>
            {project.publishedAt && (
              <View className="flex-row items-center gap-1.5">
                <Calendar size={12} className="text-muted-foreground" />
                <Text className="text-xs text-muted-foreground">
                  Published {new Date(project.publishedAt).toLocaleDateString()}
                </Text>
              </View>
            )}
          </View>

          {project.knativeServiceName && (
            <View className="mt-3 pt-3 border-t border-border">
              <Text className="text-xs text-muted-foreground">
                Knative: <Text className="font-mono">{project.knativeServiceName}</Text>
              </Text>
            </View>
          )}
        </View>

        {/* Members + Chat Sessions */}
        <View className={cn(isWide ? 'flex-row gap-4' : 'gap-4')}>
          {/* Members */}
          <View className={cn('rounded-xl border border-border bg-card p-4', isWide ? 'flex-1' : '')}>
            <View className="flex-row items-center gap-2 mb-3">
              <Users size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Members ({project.members?.length ?? 0})
              </Text>
            </View>
            {!project.members?.length ? (
              <Text className="text-sm text-muted-foreground">No members</Text>
            ) : (
              <View className="gap-2">
                {project.members.slice(0, 20).map((m) => (
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
                      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                        {m.user?.name || m.user?.email || m.userId.slice(0, 8)}
                      </Text>
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
              </View>
            )}
          </View>

          {/* Chat Sessions */}
          <View className={cn('rounded-xl border border-border bg-card p-4', isWide ? 'flex-1' : '')}>
            <View className="flex-row items-center gap-2 mb-3">
              <MessageSquare size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Recent Chat Sessions ({project.chatSessions?.length ?? 0})
              </Text>
            </View>
            {!project.chatSessions?.length ? (
              <Text className="text-sm text-muted-foreground">No chat sessions</Text>
            ) : (
              <View className="gap-2">
                {project.chatSessions.slice(0, 15).map((session) => (
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
    </ScrollView>
  )
}
