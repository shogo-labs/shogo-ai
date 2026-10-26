// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What agents in this workspace are doing: queued and running tasks, chats an
 * agent is answering right now, and failures. Shared by the Activity feed,
 * the Home "Running now" strip and the rail badge.
 *
 * `polling` keeps it fresh while a screen showing it is focused (agent state
 * changes on the server, so the in-process event bus alone cannot tell us when
 * background work finishes). `light` skips the project and notification
 * loads for callers that only need the agent rows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useIsRemoteSource } from '@shogo/shared-app/domain'
import { useDomainHttp, useNotificationCollection, useProjectCollection } from '../contexts/domain'
import { api, type ActiveChatTurn, type AgentTask } from '../lib/api'
import { agentTaskEvents } from '../lib/agent-task-events'
import { notificationEvents } from '../lib/notification-events'
import { useActiveWorkspace } from './useActiveWorkspace'

const PROJECT_REFRESH_INTERVAL_MS = 30_000
const POLL_MS = 5_000

/** Same tasks, same order, nothing about them changed: keep the previous array. */
function sameTasks(prev: AgentTask[], next: AgentTask[]): boolean {
  if (prev === next) return true
  if (prev.length !== next.length) return false
  for (let i = 0; i < next.length; i += 1) {
    const a = prev[i] as AgentTask & { updatedAt?: string }
    const b = next[i] as AgentTask & { updatedAt?: string }
    if (a.id !== b.id || a.status !== b.status || a.updatedAt !== b.updatedAt) return false
  }
  return true
}

/** Same active turns: compare by chat, turn id and status only. */
function sameActiveChats(prev: ActiveChatTurn[], next: ActiveChatTurn[]): boolean {
  if (prev === next) return true
  if (prev.length !== next.length) return false
  for (let i = 0; i < next.length; i += 1) {
    const a = prev[i] as unknown as Record<string, unknown>
    const b = next[i] as unknown as Record<string, unknown>
    if (a.chatSessionId !== b.chatSessionId || a.status !== b.status || a.turnId !== b.turnId) return false
  }
  return true
}

export interface AgentActivityOptions {
  /** Poll while true; pass the screen's focus state. */
  polling?: boolean
  light?: boolean
}

export interface AgentActivity {
  tasks: AgentTask[]
  activeChats: ActiveChatTurn[]
  /** Queued or running tasks. */
  running: AgentTask[]
  failed: AgentTask[]
  loading: boolean
  refreshing: boolean
  error: string | null
  clearError: () => void
  refresh: (opts?: { projects?: boolean; manual?: boolean }) => Promise<void>
}

export function isTaskRunning(task: Pick<AgentTask, 'status'>): boolean {
  return task.status === 'queued' || task.status === 'running'
}

export function isTaskFailed(task: Pick<AgentTask, 'status'>): boolean {
  return task.status === 'failed' || task.status === 'cancelled'
}

export function useAgentActivity({ polling = false, light = false }: AgentActivityOptions = {}): AgentActivity {
  // The domain client, so the task list and the workspace's activity follow the
  // workspace in view — including a paired computer's own workspace (SHO-108).
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const notifications = useNotificationCollection()
  const projects = useProjectCollection()
  const isRemoteSource = useIsRemoteSource()
  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [activeChats, setActiveChats] = useState<ActiveChatTurn[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  const projectLoadAt = useRef(0)
  const projectLoadScope = useRef<string | null>(null)

  const load = useCallback(
    async (refreshProjects = false) => {
      if (inFlight.current) return inFlight.current
      const request = (async () => {
        try {
          setError(null)
          const projectFilter = !isRemoteSource && workspace?.id ? { workspaceId: workspace.id } : undefined
          const projectScope = isRemoteSource ? 'remote' : workspace?.id || 'local'
          const shouldLoadProjects =
            !light &&
            (refreshProjects ||
              projectLoadScope.current !== projectScope ||
              Date.now() - projectLoadAt.current >= PROJECT_REFRESH_INTERVAL_MS)
          const projectLoad = shouldLoadProjects
            ? projects.loadAll(projectFilter).then(() => {
                projectLoadAt.current = Date.now()
                projectLoadScope.current = projectScope
              })
            : Promise.resolve()
          const [, , next, chats] = await Promise.all([
            light ? Promise.resolve() : notifications.loadAll(),
            projectLoad,
            // Only this workspace's tasks: the route filters server-side, so a
            // multi-workspace account no longer downloads every other
            // workspace's tasks on each poll.
            api.listAgentTasks(http, workspace?.id ? { workspaceId: workspace.id } : {}),
            // Active chats are supplementary; a failure here must not hide agent tasks.
            workspace?.id ? api.listWorkspaceActiveChats(http, workspace.id).catch(() => null) : Promise.resolve([]),
          ])
          // A paired computer's workspace is resolved client-side, so keep the
          // local filter for that case; the server already scoped the rest.
          const scoped = isRemoteSource || !workspace?.id
            ? next.filter((task: { workspaceId?: string | null }) => !workspace?.id || task.workspaceId === workspace.id)
            : next
          setTasks((prev) => (sameTasks(prev, scoped) ? prev : scoped))
          if (chats) setActiveChats((prev) => (sameActiveChats(prev, chats) ? prev : chats))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Could not load activity')
        } finally {
          setLoading(false)
          setRefreshing(false)
        }
      })()
      inFlight.current = request
      const clear = () => {
        if (inFlight.current === request) inFlight.current = null
      }
      void request.then(clear, clear)
      return request
    },
    [http, isRemoteSource, light, notifications, projects, workspace?.id],
  )

  useEffect(() => {
    let live = true
    let appState = AppState.currentState
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    // React Native can report null briefly during launch; treat that as foreground.
    const foreground = () => appState === 'active' || appState === null

    const clearPoll = () => {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
    }
    const schedulePoll = () => {
      clearPoll()
      if (!live || !polling || !foreground()) return
      pollTimer = setTimeout(async () => {
        await load()
        schedulePoll()
      }, POLL_MS)
    }
    const refreshAndSchedule = async () => {
      if (!live || !foreground()) return
      await load(true)
      schedulePoll()
    }

    void refreshAndSchedule()
    const unsubscribeTasks = agentTaskEvents.subscribe(() => void refreshAndSchedule())
    const unsubscribeNotifications = light
      ? () => {}
      : notificationEvents.subscribe(() => {
          if (live && foreground()) void notifications.loadAll()
        })
    const appStateSubscription = AppState.addEventListener('change', (next) => {
      appState = next
      if (appState === 'active') void refreshAndSchedule()
      else clearPoll()
    })
    return () => {
      live = false
      clearPoll()
      unsubscribeTasks()
      unsubscribeNotifications()
      appStateSubscription.remove()
    }
  }, [load, light, notifications, polling])

  const refresh = useCallback(
    async ({ projects: withProjects = true, manual = false }: { projects?: boolean; manual?: boolean } = {}) => {
      if (manual) setRefreshing(true)
      await load(withProjects)
    },
    [load],
  )
  const clearError = useCallback(() => setError(null), [])
  const running = useMemo(() => tasks.filter(isTaskRunning), [tasks])
  const failed = useMemo(() => tasks.filter(isTaskFailed), [tasks])

  return { tasks, activeChats, running, failed, loading, refreshing, error, clearError, refresh }
}
