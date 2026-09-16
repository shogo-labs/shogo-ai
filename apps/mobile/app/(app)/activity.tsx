// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, Platform, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { ChevronRight, CircleAlert, Clock3, Folder, ListTodo, XCircle } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useNotificationCollection } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api, createHttpClient, type AgentTask } from '../../lib/api'
import { agentTaskEvents } from '../../lib/agent-task-events'
import { notificationEvents } from '../../lib/notification-events'
import { PhoneListEmpty } from '../../components/phone/PhoneListRow'
import { readableAgentTaskError, taskStatusLabel } from '../../lib/agent-task-ui'
import { filterNotificationsForPlatform } from '../../lib/notification-policy'

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const parsed = Date.parse(String(value ?? ''))
  return Number.isNaN(parsed) ? 0 : parsed
}

function elapsed(task: AgentTask) {
  const start = task.startedAt || task.queuedAt || task.createdAt
  const epoch = Date.parse(start)
  if (!Number.isFinite(epoch)) return '—'
  const minutes = Math.max(0, Math.floor((Date.now() - epoch) / 60_000))
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <View className="mt-6 flex-row items-center justify-between px-4">
      <Text className="text-base font-semibold uppercase tracking-[1.5px] text-muted-foreground">{title}</Text>
      {typeof count === 'number' ? (
        <View className="min-w-6 items-center rounded-full bg-muted px-2 py-1">
          <Text className="text-[11px] font-semibold text-muted-foreground">{count}</Text>
        </View>
      ) : null}
    </View>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone: 'primary' | 'success' | 'muted' }) {
  return (
    <View className="flex-1 items-center justify-center px-3 py-5">
      <Text className={cn(
        'text-3xl font-semibold',
        tone === 'primary' ? 'text-primary' : tone === 'success' ? 'text-emerald-700 dark:text-emerald-300' : 'text-foreground',
      )}>{value}</Text>
      <Text className="mt-2 text-xs font-medium text-muted-foreground">{label}</Text>
    </View>
  )
}

function StatusPill({ label, tone }: { label: string; tone: 'success' | 'primary' | 'danger' | 'muted' }) {
  return (
    <View className={cn(
      'rounded-full px-3 py-2',
      tone === 'success' ? 'bg-emerald-500/10' : tone === 'primary' ? 'bg-background' : tone === 'danger' ? 'bg-destructive/10' : 'bg-muted',
    )}>
      <Text className={cn(
        'text-[10px] font-medium',
        tone === 'success' ? 'text-emerald-700 dark:text-emerald-300' : tone === 'primary' ? 'text-primary' : tone === 'danger' ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground',
      )}>{label}</Text>
    </View>
  )
}

function EmptyActivityCard({ title, message }: { title: string; message: string }) {
  return (
    <View className="mx-4 mt-3 rounded-2xl border border-dashed border-border bg-card/60 px-4 py-5">
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-xl bg-muted">
          <CircleAlert size={18} className="text-muted-foreground" />
        </View>
        <View className="flex-1">
          <Text className="text-base font-medium text-foreground">{title}</Text>
          <Text className="mt-1 text-xs leading-5 text-muted-foreground">{message}</Text>
        </View>
      </View>
    </View>
  )
}

export default function ActivityScreen() {
  const router = useRouter()
  const http = useMemo(() => createHttpClient(), [])
  const workspace = useActiveWorkspace()
  const notifications = useNotificationCollection()
  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadInFlight = useRef(false)

  const load = useCallback(async () => {
    if (loadInFlight.current) return
    loadInFlight.current = true
    try {
      setError(null)
      await notifications.loadAll()
      const next = await api.listAgentTasks(http)
      setTasks(next.filter((task) => !workspace?.id || task.workspaceId === workspace.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load activity')
    } finally {
      loadInFlight.current = false
      setLoading(false)
      setRefreshing(false)
    }
  }, [http, notifications, workspace?.id])

  useFocusEffect(useCallback(() => {
    let isFocused = true
    let appState = AppState.currentState
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    const clearPoll = () => {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
    }
    const schedulePoll = () => {
      clearPoll()
      // React Native can report null briefly during launch. Treat that as
      // foreground so the initial Activity load is never skipped.
      if (!isFocused || (appState !== 'active' && appState !== null)) return
      pollTimer = setTimeout(async () => {
        await load()
        schedulePoll()
      }, 5_000)
    }
    const refreshAndSchedule = async () => {
      if (!isFocused || (appState !== 'active' && appState !== null)) return
      await load()
      schedulePoll()
    }

    void refreshAndSchedule()
    const unsubscribeTasks = agentTaskEvents.subscribe(() => void refreshAndSchedule())
    const unsubscribeNotifications = notificationEvents.subscribe(() => {
      if (!isFocused || (appState !== 'active' && appState !== null)) return
      void notifications.loadAll()
    })
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      appState = nextState
      if (appState === 'active') void refreshAndSchedule()
      else clearPoll()
    })
    // Agent state changes on the server, so the process-local event bus cannot
    // update this screen when work finishes in the background. Poll while the
    // screen is focused so Live Now and project counts converge without a
    // manual pull-to-refresh.
    return () => {
      isFocused = false
      clearPoll()
      unsubscribeTasks()
      unsubscribeNotifications()
      appStateSubscription.remove()
    }
  }, [load]))

  const active = useMemo(() => tasks.filter((task) => task.status === 'queued' || task.status === 'running'), [tasks])
  const completed = useMemo(() => tasks.filter((task) => task.status === 'completed'), [tasks])
  const failedOrCancelled = useMemo(() => tasks.filter((task) => task.status === 'failed' || task.status === 'cancelled'), [tasks])
  const projectActivity = useMemo(() => {
    const groups = new Map<string, {
      id: string | null
      name: string
      completed: number
      running: number
      failed: number
      total: number
      latestChatActivity: number
      latestChatSessionId: string | null
    }>()
    for (const task of tasks) {
      const key = task.projectId || 'home'
      const taskActivity = timestamp(task.updatedAt || task.completedAt || task.startedAt || task.createdAt)
      const group = groups.get(key) ?? {
        id: task.projectId,
        name: task.projectName || 'Home',
        completed: 0,
        running: 0,
        failed: 0,
        total: 0,
        latestChatActivity: 0,
        latestChatSessionId: null,
      }
      group.total += 1
      if (task.status === 'completed') group.completed += 1
      if (task.status === 'queued' || task.status === 'running') group.running += 1
      if (task.status === 'failed') group.failed += 1
      if (task.chatSessionId && taskActivity >= group.latestChatActivity) {
        group.latestChatActivity = taskActivity
        group.latestChatSessionId = task.chatSessionId
      }
      groups.set(key, group)
    }
    return [...groups.values()].sort((a, b) => b.total - a.total)
  }, [tasks])

  const openTaskChat = (task: AgentTask) => {
    if (task.projectId) {
      router.push({ pathname: '/(app)/projects/[id]' as any, params: { id: task.projectId, ...(task.chatSessionId ? { chatSessionId: task.chatSessionId } : {}) } } as any)
    } else {
      router.replace('/(app)' as any)
    }
  }

  const unreadNotifications = filterNotificationsForPlatform(notifications.all, Platform.OS)
    .filter((notification: any) => !notification.readAt).length

  return (
    <View className="flex-1 bg-background">
      {error ? (
        <View className="mx-4 mt-3 flex-row items-start gap-2 rounded-2xl border border-destructive bg-destructive/10 px-3 py-3">
          <CircleAlert size={18} className="mt-0.5 text-destructive" />
          <Text className="flex-1 text-sm leading-5 text-destructive">{readableAgentTaskError(error, 'We could not refresh activity.')}</Text>
          <Pressable onPress={() => { setError(null); setRefreshing(true); void load() }} accessibilityLabel="Try loading activity again" className="rounded-lg px-2 py-1 active:bg-destructive/10">
            <Text className="text-sm font-semibold text-destructive">Try again</Text>
          </Pressable>
        </View>
      ) : null}
      {loading ? <View className="flex-1 items-center justify-center"><ActivityIndicator /></View> : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="pb-32"
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load() }} />}
        >
          <SectionHeader title="Overview" />
          <View className="mx-4 mt-3 overflow-hidden rounded-3xl bg-card">
            <View className="flex-row">
              <Metric label="Active" value={active.length} tone="primary" />
              <Metric label="Completed" value={completed.length} tone="success" />
              <Metric label="Unread" value={unreadNotifications} tone="muted" />
            </View>
          </View>

          <SectionHeader title="Live now" count={active.length} />
          {active.length === 0 ? <EmptyActivityCard title="No agents are currently working" message="When you start an agent, its live progress will appear here." /> : active.map((task) => (
            <Pressable key={task.id} onPress={() => openTaskChat(task)} className="mx-4 mt-3 rounded-2xl border border-primary bg-primary/5 p-4 active:bg-primary/10">
              <View className="flex-row items-start gap-3">
                <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10"><Clock3 size={19} className="text-primary" /></View>
                <View className="flex-1">
                  <View className="flex-row items-start gap-2"><Text className="flex-1 font-semibold text-foreground" numberOfLines={2}>{task.title}</Text><ChevronRight size={17} className="mt-0.5 text-primary" /></View>
                  <Text className="mt-1 text-xs text-muted-foreground">{task.projectName || 'Home'} · {taskStatusLabel(task.status)} · {elapsed(task)}</Text>
                  <View className="mt-3 rounded-xl bg-background/70 px-3 py-2.5"><Text className="text-sm leading-5 text-foreground" numberOfLines={2}>{task.currentStep || 'Waiting for the agent…'}</Text></View>
                </View>
              </View>
            </Pressable>
          ))}

          <SectionHeader title="Project activity" count={projectActivity.length} />
          {projectActivity.length === 0 ? <EmptyActivityCard title="No tracked projects yet" message="Project-level progress will appear here once a task is created." /> : projectActivity.map((group) => (
            <Pressable key={group.id || 'home'} disabled={!group.id} onPress={() => group.id && router.push({ pathname: '/(app)/projects/[id]' as any, params: { id: group.id, ...(group.latestChatSessionId ? { chatSessionId: group.latestChatSessionId } : {}) } } as any)} className={cn('mx-4 mt-3 rounded-2xl bg-card p-4', group.id ? 'active:bg-muted/50' : 'opacity-90')}>
              <View className="flex-row items-center gap-3">
                <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted"><Folder size={19} className="text-muted-foreground" /></View>
                <View className="flex-1"><Text className="font-semibold text-foreground">{group.name}</Text><Text className="mt-1 text-xs text-muted-foreground">{group.total} tracked {group.total === 1 ? 'task' : 'tasks'}</Text></View>
                {group.id ? <ChevronRight size={17} className="text-muted-foreground" /> : null}
              </View>
              <View className="mt-4 flex-row flex-wrap gap-2"><StatusPill label={`${group.completed} completed`} tone={group.completed > 0 ? 'success' : 'muted'} /><StatusPill label={`${group.running} running`} tone={group.running > 0 ? 'primary' : 'muted'} /><StatusPill label={`${group.failed} failed`} tone={group.failed > 0 ? 'danger' : 'muted'} /></View>
            </Pressable>
          ))}

          {failedOrCancelled.length > 0 ? <>
            <SectionHeader title="Needs attention" count={failedOrCancelled.length} />
            {failedOrCancelled.map((task) => <Pressable key={task.id} onPress={() => openTaskChat(task)} accessibilityLabel={`Open ${task.title} activity`} className="mx-4 mt-3 rounded-2xl border border-destructive bg-destructive/5 p-4 active:bg-destructive/10"><View className="flex-row items-start gap-3"><View className="h-10 w-10 items-center justify-center rounded-xl bg-destructive/10"><XCircle size={19} className="text-destructive" /></View><View className="flex-1"><View className="flex-row items-start gap-2"><Text className="flex-1 font-semibold text-foreground">{task.title}</Text><ChevronRight size={17} className="text-destructive" /></View><Text className="mt-1 text-xs text-muted-foreground">{task.projectName || 'Home'} · {taskStatusLabel(task.status)}</Text><Text className="mt-3 text-sm leading-5 text-foreground" numberOfLines={3}>{readableAgentTaskError(task.errorMessage, 'This task did not complete.')}</Text></View></View></Pressable>)}
          </> : null}

          {tasks.length === 0 ? <View className="mx-4 mt-4"><PhoneListEmpty icon={<ListTodo size={44} className="text-muted-foreground" />} title="Nothing to report yet" message="Start a task and its progress and result will be collected here." /></View> : null}
        </ScrollView>
      )}
    </View>
  )
}
