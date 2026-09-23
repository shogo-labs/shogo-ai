// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useRef, useState } from 'react'
import { AppState, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { ChevronRight, Clock3, Folder, ListTodo, MessageSquare, XCircle } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useNotificationCollection, useProjectCollection } from '../../contexts/domain'
import { useIsRemoteSource } from '@shogo/shared-app/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { api, createHttpClient, type ActiveChatTurn, type AgentTask } from '../../lib/api'
import { agentTaskEvents } from '../../lib/agent-task-events'
import { openActiveChat } from '../../lib/open-active-chat'
import { notificationEvents } from '../../lib/notification-events'
import { PhoneListEmpty } from '../../components/phone/PhoneListRow'
import { readableAgentTaskError, taskStatusLabel } from '../../lib/agent-task-ui'
import { PersonalActivityScreen } from '../../components/personal/PersonalActivityScreen'
import {
  ActivityCard,
  ActivityEmptyCard,
  ActivityErrorBanner,
  ActivityLoadingState,
} from '../../components/activity/ActivityFeedPrimitives'

type ProjectActivityGroup = {
  id: string
  name: string
  publishStatus: string
  completed: number
  running: number
  failed: number
  total: number
  latestActivity: number
  latestChatActivity: number
  latestChatSessionId: string | null
}

const PROJECT_PENDING_PUBLISH_STATUSES = new Set(['building', 'uploading', 'configuring'])
const PROJECT_COMPLETED_PUBLISH_STATUSES = new Set(['live', 'published'])

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const parsed = Date.parse(String(value ?? ''))
  return Number.isNaN(parsed) ? 0 : parsed
}

function elapsed(task: { startedAt?: string | null; queuedAt?: string | null; createdAt?: string }) {
  const start = task.startedAt || task.queuedAt || task.createdAt || ''
  const epoch = Date.parse(start)
  if (!Number.isFinite(epoch)) return '—'
  const minutes = Math.max(0, Math.floor((Date.now() - epoch) / 60_000))
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function SectionHeader({ title, count, subtitle }: { title: string; count?: number; subtitle?: string }) {
  return (
    <View className="mt-7 flex-row items-center justify-between px-4">
      <View className="flex-1 pr-3">
        <Text className="text-[17px] font-semibold text-foreground">{title}</Text>
        {subtitle ? <Text className="mt-1 text-[13px] leading-5 text-muted-foreground">{subtitle}</Text> : null}
      </View>
      {typeof count === 'number' ? (
        <View className="min-w-7 items-center rounded-full border border-border/80 bg-card px-2.5 py-1">
          <Text className="text-[12px] font-semibold text-muted-foreground">{count}</Text>
        </View>
      ) : null}
    </View>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone: 'primary' | 'success' | 'danger' | 'muted' }) {
  return (
    <View className="flex-1 items-start justify-center px-4 py-4">
      <Text className={cn(
        'text-[25px] font-semibold tracking-[-0.4px]',
        tone === 'primary' ? 'text-primary' : tone === 'success' ? 'text-emerald-700 dark:text-emerald-300' : tone === 'danger' ? 'text-destructive' : 'text-foreground',
      )}>{value}</Text>
      <Text className="mt-1 text-[11px] leading-4 text-muted-foreground">{label}</Text>
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

function projectOutcome(project: Pick<ProjectActivityGroup, 'running' | 'failed' | 'total' | 'publishStatus'>): {
  label: 'Completed' | 'Pending' | 'Failed' | 'No activity'
} {
  if (project.failed > 0 || project.publishStatus === 'failed') return { label: 'Failed' }
  if (project.running > 0 || PROJECT_PENDING_PUBLISH_STATUSES.has(project.publishStatus)) return { label: 'Pending' }
  if (PROJECT_COMPLETED_PUBLISH_STATUSES.has(project.publishStatus)) return { label: 'Completed' }
  if (project.total === 0) return { label: 'No activity' }
  return { label: 'Completed' }
}

function completedActivityCount(group: Pick<ProjectActivityGroup, 'completed' | 'total' | 'publishStatus'>): number {
  // A published project is a completed workspace activity even when it has no
  // agent-task rows attached to it.
  return group.completed + (group.total === 0 && PROJECT_COMPLETED_PUBLISH_STATUSES.has(group.publishStatus) ? 1 : 0)
}

function pendingActivityCount(group: Pick<ProjectActivityGroup, 'running' | 'total' | 'publishStatus'>): number {
  return group.running + (group.total === 0 && PROJECT_PENDING_PUBLISH_STATUSES.has(group.publishStatus) ? 1 : 0)
}

function failedActivityCount(group: Pick<ProjectActivityGroup, 'failed' | 'total' | 'publishStatus'>): number {
  return group.failed + (group.total === 0 && group.publishStatus === 'failed' ? 1 : 0)
}

function ProjectActivityCard({ group, onPress }: { group: ProjectActivityGroup; onPress: () => void }) {
  const completed = completedActivityCount(group)
  const pending = pendingActivityCount(group)
  const failed = failedActivityCount(group)
  const hasStatus = completed > 0 || pending > 0 || failed > 0

  return (
    <Pressable onPress={onPress} className="mx-4 mt-3 rounded-2xl border border-border/80 bg-card p-4 shadow-sm active:bg-muted/50">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted"><Folder size={19} className="text-muted-foreground" /></View>
        <View className="flex-1">
          <Text className="font-semibold text-foreground" numberOfLines={1}>{group.name}</Text>
          {group.total > 0 ? <Text className="mt-1 text-xs text-muted-foreground">{`${group.total} tracked ${group.total === 1 ? 'task' : 'tasks'}`}</Text> : null}
        </View>
        <ChevronRight size={17} className="text-muted-foreground" />
      </View>
      <View className="mt-4 flex-row flex-wrap gap-2">
        {hasStatus ? <>
          {completed > 0 ? <StatusPill label={`${completed} completed`} tone="success" /> : null}
          {pending > 0 ? <StatusPill label={`${pending} pending`} tone="primary" /> : null}
          {failed > 0 ? <StatusPill label={`${failed} failed`} tone="danger" /> : null}
        </> : <StatusPill label="No activity yet" tone="muted" />}
      </View>
    </Pressable>
  )
}

const PROJECT_REFRESH_INTERVAL_MS = 30_000

const TeamActivityScreen = observer(function TeamActivityScreen() {
  const router = useRouter()
  const http = useMemo(() => createHttpClient(), [])
  const workspace = useActiveWorkspace()
  const notifications = useNotificationCollection()
  const projects = useProjectCollection()
  const isRemoteSource = useIsRemoteSource()
  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [activeChats, setActiveChats] = useState<ActiveChatTurn[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadInFlight = useRef<Promise<void> | null>(null)
  const projectLoadAt = useRef(0)
  const projectLoadScope = useRef<string | null>(null)

  const load = useCallback(async (refreshProjects = false) => {
    if (loadInFlight.current) return loadInFlight.current

    const request = (async () => {
      try {
        setError(null)
        const projectFilter = !isRemoteSource && workspace?.id
          ? { workspaceId: workspace.id }
          : undefined
        const projectScope = isRemoteSource ? 'remote' : workspace?.id || 'local'
        const shouldLoadProjects = refreshProjects
          || projectLoadScope.current !== projectScope
          || Date.now() - projectLoadAt.current >= PROJECT_REFRESH_INTERVAL_MS
        const projectLoad = shouldLoadProjects
          ? projects.loadAll(projectFilter).then(() => {
              projectLoadAt.current = Date.now()
              projectLoadScope.current = projectScope
            })
          : Promise.resolve()
        const [, , next, chats] = await Promise.all([
          notifications.loadAll(),
          projectLoad,
          api.listAgentTasks(http),
          // Active chats are supplementary; a failure here must not hide agent tasks.
          workspace?.id
            ? api.listWorkspaceActiveChats(http, workspace.id).catch(() => null)
            : Promise.resolve([]),
        ])
        setTasks(next.filter((task) => !workspace?.id || task.workspaceId === workspace.id))
        if (chats) setActiveChats(chats)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not load activity')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    })()

    loadInFlight.current = request
    const clearInFlight = () => {
      if (loadInFlight.current === request) loadInFlight.current = null
    }
    void request.then(clearInFlight, clearInFlight)
    return request
  }, [http, isRemoteSource, notifications, projects, workspace?.id])

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
      await load(true)
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

  const agentTasks = tasks
  const active = useMemo(() => agentTasks.filter((task) => task.status === 'queued' || task.status === 'running'), [agentTasks])
  const runningCount = active.length + activeChats.length
  const failedOrCancelled = useMemo(() => agentTasks.filter((task) => task.status === 'failed' || task.status === 'cancelled'), [agentTasks])
  const projectList = projects.all
  const projectActivity = useMemo(() => {
    const groups = new Map<string, ProjectActivityGroup>()

    for (const project of projectList) {
      if (!isRemoteSource && workspace?.id && project.workspaceId !== workspace.id) continue
      groups.set(project.id, {
        id: project.id,
        name: project.name || 'Untitled project',
        publishStatus: project.publishStatus,
        completed: 0,
        running: 0,
        failed: 0,
        total: 0,
        latestActivity: Math.max(project.updatedAt || 0, project.lastMessageAt || 0, project.createdAt || 0),
        latestChatActivity: 0,
        latestChatSessionId: null,
      })
    }

    for (const task of agentTasks) {
      const taskActivity = timestamp(task.updatedAt || task.completedAt || task.startedAt || task.createdAt)
      if (!task.projectId) continue
      const group = groups.get(task.projectId) ?? {
        id: task.projectId,
        name: task.projectName || 'Untitled project',
        publishStatus: 'idle',
        completed: 0,
        running: 0,
        failed: 0,
        total: 0,
        latestActivity: 0,
        latestChatActivity: 0,
        latestChatSessionId: null,
      }
      group.total += 1
      group.latestActivity = Math.max(group.latestActivity, taskActivity)
      if (task.status === 'completed') group.completed += 1
      if (task.status === 'queued' || task.status === 'running') group.running += 1
      if (task.status === 'failed' || task.status === 'cancelled') group.failed += 1
      if (task.chatSessionId && taskActivity >= group.latestChatActivity) {
        group.latestChatActivity = taskActivity
        group.latestChatSessionId = task.chatSessionId
      }
      groups.set(task.projectId, group)
    }
    return [...groups.values()].sort((a, b) => b.latestActivity - a.latestActivity)
  }, [agentTasks, isRemoteSource, projectList, workspace?.id])
  const failedProjectsCount = useMemo(
    () => projectActivity.filter((project) => projectOutcome(project).label === 'Failed').length,
    [projectActivity],
  )
  const pendingProjectsCount = useMemo(
    () => projectActivity.filter((project) => projectOutcome(project).label === 'Pending').length,
    [projectActivity],
  )
  const completedProjectsCount = useMemo(
    () => projectActivity.filter((project) => projectOutcome(project).label === 'Completed').length,
    [projectActivity],
  )

  const openTaskChat = (task: AgentTask) => {
    if (task.projectId) {
      router.push({ pathname: '/(app)/projects/[id]' as any, params: { id: task.projectId, ...(task.chatSessionId ? { chatSessionId: task.chatSessionId } : {}) } } as any)
    } else {
      router.replace('/(app)' as any)
    }
  }

  const openProject = (group: ProjectActivityGroup) => {
    router.push({
      pathname: '/(app)/projects/[id]' as any,
      params: { id: group.id, ...(group.latestChatSessionId ? { chatSessionId: group.latestChatSessionId } : {}) },
    } as any)
  }

  return (
    <View className="flex-1 bg-background">
      {error ? (
        <View className="mx-4 mt-3">
          <ActivityErrorBanner
            message={readableAgentTaskError(error, 'We could not refresh activity.')}
            onRetry={() => { setError(null); setRefreshing(true); void load(true) }}
          />
        </View>
      ) : null}
      {loading ? <ActivityLoadingState /> : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="pb-36 pt-2"
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(true) }} />}
        >
          <View className="px-4 pb-1 pt-4">
            <Text className="text-[28px] font-semibold tracking-[-0.6px] text-foreground">Activity</Text>
            <Text className="mt-1 text-[15px] leading-5 text-muted-foreground">A calm view of agent work and project progress.</Text>
          </View>

          <SectionHeader title="Workspace overview" subtitle="Current status across your projects" />
          <View className="mx-4 mt-3 overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm">
            <View className="flex-row">
              <View className="flex-1 border-r border-border/80"><Metric label="Pending" value={pendingProjectsCount} tone="primary" /></View>
              <View className="flex-1 border-r border-border/80"><Metric label="Completed" value={completedProjectsCount} tone="success" /></View>
              <View className="flex-1"><Metric label="Needs attention" value={failedProjectsCount} tone="danger" /></View>
            </View>
          </View>

          <SectionHeader title="Running now" count={runningCount} subtitle="Live agent work and active chats across this workspace" />
          {runningCount === 0 ? (
            <View className="mx-4 mt-3">
              <ActivityEmptyCard title="No agents or chats are currently working" message="When you start an agent or send a chat message, its live progress will appear here." />
            </View>
          ) : <>
            {active.map((task) => (
            <View key={task.id} className="mx-4 mt-3">
              <ActivityCard
                tone="primary"
                icon={<Clock3 size={19} className="text-primary" />}
                title={task.title}
                subtitle={`${task.projectName || 'Home'} · ${taskStatusLabel(task.status)} · ${elapsed(task)}`}
                message={<View className="rounded-xl bg-background/70 px-3 py-2.5"><Text className="text-sm leading-5 text-foreground" numberOfLines={2}>{task.currentStep || 'Waiting for the agent…'}</Text></View>}
                trailing={<ChevronRight size={17} className="mt-0.5 text-primary" />}
                onPress={() => openTaskChat(task)}
              />
            </View>
            ))}
            {activeChats.map((chat) => (
              <View key={`${chat.chatSessionId}:${chat.turnId}`} className="mx-4 mt-3">
                <ActivityCard
                  tone="primary"
                  icon={<MessageSquare size={19} className="text-primary" />}
                  title={chat.sessionName}
                  subtitle={`${chat.projectHidden ? 'Companion' : chat.projectName || 'Workspace chat'} · Chatting · ${elapsed(chat)}`}
                  message={<View className="rounded-xl bg-background/70 px-3 py-2.5"><Text className="text-sm leading-5 text-foreground">An agent is responding in this chat.</Text></View>}
                  trailing={<ChevronRight size={17} className="mt-0.5 text-primary" />}
                  onPress={() => openActiveChat(router, chat)}
                />
              </View>
            ))}
          </>}

          <SectionHeader title="Workspace projects" count={projectActivity.length} subtitle="Monitor every project in this workspace" />
          {projectActivity.length === 0 ? (
            <View className="mx-4 mt-3">
              <ActivityEmptyCard title="No projects in this workspace yet" message="Projects created in this network space will appear here with their current status." />
            </View>
          ) : projectActivity.map((group) => (
            <ProjectActivityCard key={group.id} group={group} onPress={() => openProject(group)} />
          ))}

          {failedOrCancelled.length > 0 ? <>
            <SectionHeader title="Needs attention" count={failedOrCancelled.length} />
            {failedOrCancelled.map((task) => (
              <View key={task.id} className="mx-4 mt-3">
                <ActivityCard
                  tone="destructive"
                  icon={<XCircle size={19} className="text-destructive" />}
                  title={task.title}
                  subtitle={`${task.projectName || 'Home'} · ${taskStatusLabel(task.status)}`}
                  message={<Text className="text-sm leading-5 text-foreground" numberOfLines={3}>{readableAgentTaskError(task.errorMessage, 'This task did not complete.')}</Text>}
                  onPress={() => openTaskChat(task)}
                  accessibilityLabel={`Open ${task.title} activity`}
                />
              </View>
            ))}
          </> : null}

          {agentTasks.length === 0 && activeChats.length === 0 && projectActivity.length === 0 ? <View className="mx-4 mt-4"><PhoneListEmpty icon={<ListTodo size={44} className="text-muted-foreground" />} title="Nothing to report yet" message="Create a project or start a task to see activity here." /></View> : null}
        </ScrollView>
      )}
    </View>
  )
})

export default observer(function ActivityScreenRoute() {
  const experience = useWorkspaceExperience()
  return experience.homeScreen === 'companion' ? <PersonalActivityScreen /> : <TeamActivityScreen />
})
