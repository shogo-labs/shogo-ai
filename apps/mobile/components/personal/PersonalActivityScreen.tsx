// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useState } from 'react'
import { AppState, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { CheckCircle2, CircleAlert, Clock3, Sparkles, Square } from 'lucide-react-native'
import { isApprovalPending } from '@shogo/shared-app'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api, type ActiveChatTurn, type PersonalWorkspaceActivity } from '../../lib/api'
import { canStopRunningChat, chatFromActivityItem, chatTitle, elapsedLabel, sortRunningChats } from '../../lib/activity-feed'
import { openActiveChat } from '../../lib/open-active-chat'
import { stopRunningChat } from '../../lib/stop-running-chat'
import { AgentAvatar } from '../team-chat/AgentAvatar'
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
  const router = useRouter()
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
    let focused = true
    let appState = AppState.currentState
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const schedule = () => {
      clearTimer()
      if (!focused || (appState !== 'active' && appState !== null)) return
      timer = setTimeout(async () => {
        await load()
        schedule()
      }, 5_000)
    }
    const refresh = async () => {
      if (!focused || (appState !== 'active' && appState !== null)) return
      await load()
      schedule()
    }

    void refresh()
    const subscription = AppState.addEventListener('change', (nextState) => {
      appState = nextState
      if (appState === 'active') void refresh()
      else clearTimer()
    })
    return () => {
      focused = false
      clearTimer()
      subscription.remove()
    }
  }, [load]))

  const pendingApprovals = useMemo(() => items.filter(isApprovalPending), [items])
  const activeChats = useMemo(() => items.filter((item) => item.type === 'chat_turn').map(chatFromActivityItem), [items])
  // One agent's runs next to each other, newest first — the same order the
  // Activity feed's strip and the team Activity screen use.
  const runningChats = useMemo(() => sortRunningChats(activeChats), [activeChats])
  const [stopError, setStopError] = useState<string | null>(null)
  const stopChat = (chat: ActiveChatTurn) => {
    setStopError(null)
    void stopRunningChat(chat, workspace?.id ?? null)
      .catch((err: unknown) => setStopError(err instanceof Error ? err.message : 'That run could not be stopped.'))
  }
  const feedItems = useMemo(
    () => items.filter((item) => item.type !== 'chat_turn' && !isApprovalPending(item)),
    [items],
  )

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
      {stopError ? (
        <View className="mt-6">
          <ActivityErrorBanner message={stopError} onRetry={() => setStopError(null)} />
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
          {runningChats.length > 0 ? (
            <View className="mt-6 gap-3">
              <Text className="text-lg font-semibold text-foreground">Happening now</Text>
              {runningChats.map((chat) => {
                const agent = chat.agentName?.trim() || chat.projectName || 'Agent'
                const where = chat.conversationName
                  ? `#${chat.conversationName}`
                  : chat.projectHidden
                    ? 'Companion'
                    : chat.projectName || 'Workspace chat'
                const title = chatTitle(chat)
                return (
                  <ActivityCard
                    key={`${chat.chatSessionId}:${chat.turnId}`}
                    tone="primary"
                    icon={<AgentAvatar name={agent} projectId={chat.projectId} workspaceId={workspace?.id ?? null} size={30} />}
                    title={title}
                    subtitle={`${agent} · ${where} · ${elapsedLabel(chat.startedAt)}`}
                    trailing={
                      canStopRunningChat(chat) ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Stop ${title}`}
                          testID={`stop-${chat.chatSessionId}`}
                          hitSlop={8}
                          // Stop ends the run; it never opens the chat behind it.
                          onPress={(event) => {
                            event?.stopPropagation?.()
                            void stopChat(chat)
                          }}
                          className="h-8 w-8 items-center justify-center rounded-full border border-border active:bg-accent"
                        >
                          <Square size={11} className="fill-primary text-primary" />
                        </Pressable>
                      ) : undefined
                    }
                    onPress={() => openActiveChat(router, chat)}
                    accessibilityLabel={`${title}, running`}
                  />
                )
              })}
            </View>
          ) : null}
          {!error && feedItems.length === 0 && pendingApprovals.length === 0 && activeChats.length === 0 ? (
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
