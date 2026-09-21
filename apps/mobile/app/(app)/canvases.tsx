// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { ArrowUpRight, CalendarDays, LayoutGrid, MonitorPlay } from 'lucide-react-native'
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
      {loading ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator /></View>
      ) : canvases.length === 0 ? (
        <View className="flex-1 px-4 pt-4">
          <CanvasPageHeader count={0} />
          {error ? <Text className="mt-3 text-sm text-destructive">{error}</Text> : null}
          <PhoneListEmpty
            icon={<LayoutGrid size={44} className="text-muted-foreground" />}
            title="No published canvases yet"
            message="Publish a canvas from a project and it will appear here."
          />
        </View>
      ) : (
        <FlatList
          data={canvases}
          keyExtractor={(project) => project.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120, gap: 12 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load() }} />}
          ListHeaderComponent={
            <View>
              <CanvasPageHeader count={canvases.length} />
              {error ? <Text className="mb-3 text-sm text-destructive">{error}</Text> : null}
            </View>
          }
          renderItem={({ item: project }) => {
            const date = publishedDate(project.publishedAt)
            return (
              <Pressable
                onPress={() => openCanvas(project.id)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${project.name || 'Untitled project'} canvas`}
                className="overflow-hidden rounded-3xl border border-border/70 bg-card shadow-sm active:opacity-90"
              >
                <View className="relative h-48 w-full overflow-hidden bg-muted">
                  {project.thumbnailUrl ? (
                    <Image source={{ uri: project.thumbnailUrl }} resizeMode="cover" className="h-full w-full" />
                  ) : (
                    <View className="h-full w-full items-center justify-center bg-primary/5">
                      <View className="h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
                        <MonitorPlay size={28} className="text-primary" />
                      </View>
                      <Text className="mt-3 text-xs font-medium text-muted-foreground">Canvas preview</Text>
                    </View>
                  )}
                  <View className="absolute left-3 top-3 flex-row items-center rounded-full bg-background/90 px-2.5 py-1.5">
                    <View className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <Text className="text-[11px] font-semibold text-foreground">Live</Text>
                  </View>
                </View>
                <View className="px-4 py-4">
                  <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
                    {project.name || 'Untitled project'}
                  </Text>
                  <View className="mt-2 flex-row items-center justify-between">
                    <View className="flex-row items-center gap-1.5">
                      <CalendarDays size={14} className="text-muted-foreground" />
                      <Text className="text-[13px] text-muted-foreground">{date || 'Published recently'}</Text>
                    </View>
                    <View className="flex-row items-center gap-1 rounded-full bg-primary px-3 py-2">
                      <Text className="text-xs font-semibold text-primary-foreground">Open</Text>
                      <ArrowUpRight size={13} className="text-primary-foreground" />
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

function CanvasPageHeader({ count }: { count: number }) {
  return (
    <View className="mt-4 mb-4 overflow-hidden rounded-3xl border border-primary/15 bg-primary/5 px-5 py-5">
      <View className="absolute -right-7 -top-8 h-28 w-28 rounded-full bg-primary/10" />
      <Text className="text-xs font-bold uppercase tracking-[1.5px] text-primary">Published work</Text>
      <Text className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Canvases</Text>
      <View className="mt-2 flex-row items-center justify-between gap-4">
        <Text className="flex-1 text-sm leading-5 text-muted-foreground">
          A calm place to revisit the experiences you have shared.
        </Text>
        <View className="rounded-full bg-background px-3 py-1.5">
          <Text className="text-xs font-semibold text-foreground">
            {count} {count === 1 ? 'live canvas' : 'live canvases'}
          </Text>
        </View>
      </View>
    </View>
  )
}
