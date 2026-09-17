// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, Text, View, useWindowDimensions } from 'react-native'
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
  const { width } = useWindowDimensions()
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
  const cardWidth = Math.max(0, (width - 32 - 12) / 2)

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
          numColumns={2}
          columnWrapperStyle={{ gap: 12 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120, gap: 12 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load() }} />}
          renderItem={({ item: project }) => {
            const date = publishedDate(project.publishedAt)
            return (
              <Pressable
                onPress={() => openCanvas(project.id)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${project.name || 'Untitled project'} canvas`}
                style={{ width: cardWidth }}
                className="overflow-hidden rounded-2xl bg-card active:bg-muted/60"
              >
                {project.thumbnailUrl ? (
                  <Image source={{ uri: project.thumbnailUrl }} resizeMode="cover" className="h-28 w-full bg-muted" />
                ) : (
                  <View className="h-28 items-center justify-center bg-muted">
                    <MonitorPlay size={30} className="text-muted-foreground" />
                  </View>
                )}
                <View className="p-3">
                  <Text className="font-semibold text-foreground" numberOfLines={1}>
                    {project.siteTitle || project.name || 'Untitled canvas'}
                  </Text>
                  <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
                    {project.name || 'Untitled project'}
                  </Text>
                  <View className="mt-3 flex-row items-center gap-1.5">
                    <View className="rounded-full bg-emerald-500/10 px-2 py-1">
                      <Text className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">Published</Text>
                    </View>
                    {date ? (
                      <View className="flex-row items-center gap-1">
                        <CalendarDays size={11} className="text-muted-foreground" />
                        <Text className="text-[10px] text-muted-foreground">{date}</Text>
                      </View>
                    ) : null}
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
