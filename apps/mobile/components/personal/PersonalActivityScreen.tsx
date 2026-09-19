// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { CheckCircle2, CircleAlert, Clock3, Sparkles } from 'lucide-react-native'
import { isApprovalPending } from '@shogo/shared-app'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api, type PersonalWorkspaceActivity } from '../../lib/api'
import {
  ActivityCard,
  ActivityEmptyCard,
  ActivityErrorBanner,
  ActivityLoadingState,
} from '../activity/ActivityFeedPrimitives'
import { NeedsYourOkSection } from './NeedsYourOkSection'

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

  const pendingApprovals = useMemo(() => items.filter(isApprovalPending), [items])
  const feedItems = useMemo(() => items.filter((item) => !isApprovalPending(item)), [items])

  const dismissApproval = useCallback((eventId: string) => {
    setItems((current) => current.filter((item) => item.id !== eventId))
  }, [])

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

      {error ? (
        <View className="mt-6">
          <ActivityErrorBanner message={error} onRetry={() => void load(true)} />
        </View>
      ) : null}

      {loading ? (
        <ActivityLoadingState />
      ) : (
        <>
          {pendingApprovals.length > 0 && workspace?.id ? (
            <View className="mt-6">
              <NeedsYourOkSection
                workspaceId={workspace.id}
                items={pendingApprovals}
                onResolved={dismissApproval}
              />
            </View>
          ) : null}
          {!error && feedItems.length === 0 && pendingApprovals.length === 0 ? (
            <View className="mt-8">
              <ActivityEmptyCard
                title="Nothing here yet"
                message="Progress updates and completed work will appear here."
              />
            </View>
          ) : (
            <View className="mt-6 gap-3">
              {feedItems.map((item) => (
                <ActivityCard
                  key={`${item.type}-${item.id}`}
                  icon={activityIcon(item)}
                  title={item.type === 'goal_event' ? item.goalTitle || 'Goal update' : item.title || 'Agent task'}
                  message={item.message || item.resultSummary || item.currentStep || item.errorMessage || readableStatus(item.status)}
                  footer={formatDate(item.createdAt)}
                />
              ))}
            </View>
          )}
        </>
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
