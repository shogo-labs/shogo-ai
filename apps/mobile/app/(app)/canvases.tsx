// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { CalendarDays, LayoutGrid, MonitorPlay } from 'lucide-react-native'
import { observer } from 'mobx-react-lite'
import { useIsRemoteSource } from '@shogo/shared-app/domain'
import { useProjectCollection } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { PhoneListEmpty } from '../../components/phone/PhoneListRow'

function publishedDate(value?: number) {
  if (!value) return null
  return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(new Date(value))
}

export default observer(function CanvasesScreen() {
  const router = useRouter()
  const projects = useProjectCollection()
  const workspace = useActiveWorkspace()
  const isRemoteSource = useIsRemoteSource()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const filter = !isRemoteSource && workspace?.id ? { workspaceId: workspace.id } : undefined
      await projects.loadAll(filter)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load canvases')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [isRemoteSource, projects, workspace?.id])

  useFocusEffect(useCallback(() => {
    void load()
  }, [load]))

  const canvases = useMemo(
    () => projects.all
      .filter((project) => {
        if (!isRemoteSource && workspace?.id && project.workspaceId !== workspace.id) return false
        return project.publishStatus === 'live' && Boolean(project.publishedSubdomain || project.publishedAt)
      })
      .sort((a, b) => (b.publishedAt || b.updatedAt) - (a.publishedAt || a.updatedAt)),
    [isRemoteSource, projects.all, workspace?.id],
  )
  const openCanvas = (projectId: string) => {
    router.push({
      pathname: '/(app)/projects/[id]' as any,
      params: { id: projectId, tab: 'canvas', openCanvas: '1', tabNonce: String(Date.now()) },
    } as any)
  }

  return (
    <View className="flex-1 bg-background">
      {error ? <Text className="px-4 pb-3 text-sm text-destructive">{error}</Text> : null}
      {loading ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator /></View>
      ) : canvases.length === 0 ? (
        <PhoneListEmpty
          icon={<LayoutGrid size={44} className="text-muted-foreground" />}
          title="No published canvases yet"
          message="Publish a canvas from a project and it will appear here."
        />
      ) : (
        <FlatList
          data={canvases}
          keyExtractor={(project) => project.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 120, gap: 14 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load() }} />}
          renderItem={({ item: project }) => {
            const date = publishedDate(project.publishedAt)
            return (
              <Pressable
                onPress={() => openCanvas(project.id)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${project.name || 'Untitled project'} canvas`}
                className="overflow-hidden rounded-2xl border border-border/70 bg-card active:opacity-90"
              >
                <View className="relative h-44 w-full overflow-hidden bg-muted">
                  {project.thumbnailUrl ? (
                    <Image source={{ uri: project.thumbnailUrl }} resizeMode="cover" className="h-full w-full" />
                  ) : (
                    <View className="h-full w-full items-center justify-center">
                      <MonitorPlay size={32} className="text-muted-foreground" />
                      <Text className="mt-2 text-xs text-muted-foreground">Canvas preview</Text>
                    </View>
                  )}
                </View>
                <View className="px-4 py-3.5">
                  <Text className="text-[12px] font-semibold uppercase tracking-[1.4px] text-foreground/70" numberOfLines={1}>
                    {project.name || 'Untitled project'}
                  </Text>
                  <View className="mt-2 flex-row items-center justify-between">
                    <View className="flex-row items-center gap-2">
                      <View className="flex-row items-center rounded-full bg-emerald-500/10 px-2.5 py-1.5">
                        <View className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        <Text className="text-[11px] font-medium text-emerald-400">Published</Text>
                      </View>
                      <View className="flex-row items-center gap-1.5">
                        <CalendarDays size={14} className="text-foreground/55" />
                        <Text className="text-[13px] text-foreground/60">{date || 'recently'}</Text>
                      </View>
                    </View>
                    <View className="rounded-full border border-primary px-3 py-2">
                      <Text className="text-xs font-medium text-primary">Open canvas</Text>
                    </View>
                  </View>
                </View>
              </Pressable>
            )
          }}
        />
      )}
    </View>
  )
})
