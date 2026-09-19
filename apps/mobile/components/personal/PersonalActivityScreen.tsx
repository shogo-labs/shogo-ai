// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState } from 'react'
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { CheckCircle2, CircleAlert, Clock3, Sparkles } from 'lucide-react-native'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api, type PersonalWorkspaceActivity } from '../../lib/api'

function activityIcon(item: PersonalWorkspaceActivity) {
  if (item.type === 'goal_event' && item.kind === 'blocker') return <CircleAlert size={17} className="text-destructive" />
  if (item.type === 'agent_task' && item.status === 'completed') return <CheckCircle2 size={17} className="text-emerald-500" />
  if (item.type === 'agent_task' && (item.status === 'running' || item.status === 'queued')) return <Clock3 size={17} className="text-primary" />
  return <Sparkles size={17} className="text-muted-foreground" />
}

export const PersonalActivityScreen = observer(function PersonalActivityScreen() {
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const [items, setItems] = useState<PersonalWorkspaceActivity[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh = false) => {
    if (!workspace?.id) return
    if (refresh) setRefreshing(true)
    try {
      setError(null)
      setItems(await api.listWorkspaceActivity(http, workspace.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load activity')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [http, workspace?.id])

  useFocusEffect(useCallback(() => {
    void load()
  }, [load]))

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="mx-auto w-full max-w-2xl px-4 pb-10 pt-5"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />}
    >
      <Text className="text-2xl font-semibold text-foreground">Activity</Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        A quiet record of what your companion is doing and learning.
      </Text>

      {loading ? (
        <View className="items-center py-14"><ActivityIndicator /></View>
      ) : error ? (
        <Text className="mt-8 text-center text-sm text-destructive">{error}</Text>
      ) : items.length === 0 ? (
        <View className="mt-8 rounded-2xl border border-dashed border-border px-5 py-8">
          <Text className="text-center text-base font-medium text-foreground">Nothing here yet</Text>
          <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
            Progress updates and completed work will appear here.
          </Text>
        </View>
      ) : (
        <View className="mt-6 gap-3">
          {items.map((item) => (
            <View key={`${item.type}-${item.id}`} className="rounded-2xl border border-border bg-card p-4">
              <View className="flex-row items-start gap-3">
                <View className="h-8 w-8 items-center justify-center rounded-full bg-muted">
                  {activityIcon(item)}
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-semibold text-foreground">
                    {item.type === 'goal_event' ? item.goalTitle || 'Goal update' : item.title || 'Agent task'}
                  </Text>
                  <Text className="mt-1 text-sm leading-5 text-muted-foreground">
                    {item.message || item.resultSummary || item.currentStep || item.errorMessage || readableStatus(item.status)}
                  </Text>
                  <Text className="mt-2 text-xs text-muted-foreground">{formatDate(item.createdAt)}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  )
})

function readableStatus(status?: string) {
  if (!status) return 'Updated'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'recently'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
