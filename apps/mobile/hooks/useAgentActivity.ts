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
 *
 * The poll cadence follows what the screen can see (SHO-602): 5 s only for a
 * caller that passes `watchRunning` and has a run to show, 60 s while a run is
 * off screen, 30 s when nothing is running. A turn edge off the realtime
 * connection is one uncached refresh, so the timer never has to be the thing
 * that makes a run appear or clear.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useDomainHttp, useNotificationCollection, useProjectCollection } from '../contexts/domain'
import { api, type ActiveChatTurn, type AgentTask } from '../lib/api'
import { activityPollMs, ACTIVITY_WATCHING_POLL_MS } from '../lib/activity-cadence'
import { workspaceActivity } from '../lib/workspace-activity'
import { agentTaskEvents } from '../lib/agent-task-events'
import { notificationEvents } from '../lib/notification-events'
import { useChatTurnEvents } from './useChatTurnEvents'
import { useWorkspaceDataScope, useWorkspaceInView } from './useWorkspaceInView'

const PROJECT_REFRESH_INTERVAL_MS = 30_000
/** A realtime turn edge is worth one refresh, coalesced with a second edge. */
const EDGE_REFRESH_MS = 150

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
  /**
   * This screen *is* the running list (the Activity feed): while something it
   * shows is running, keep the 5 s cadence. Everywhere else a running turn is
   * off screen, and 60 s plus the realtime edge is enough (SHO-602).
   */
  watchRunning?: boolean
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

export function useAgentActivity({ polling = false, light = false, watchRunning = false }: AgentActivityOptions = {}): AgentActivity {
  // The domain client, so the task list and the workspace's activity follow the
  // workspace in view — including a paired computer's own workspace (SHO-108).
  const http = useDomainHttp()
  const workspace = useWorkspaceInView()
  const notifications = useNotificationCollection()
  const projects = useProjectCollection()
  const { everyWorkspace } = useWorkspaceDataScope()
  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [activeChats, setActiveChats] = useState<ActiveChatTurn[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  const projectLoadAt = useRef(0)
  const projectLoadScope = useRef<string | null>(null)
  // The delay the poll loop should use next. Written from the answer the poll
  // just got, not from render state: the loop re-arms immediately after a load,
  // before React has committed the new rows (SHO-602).
  const cadenceRef = useRef<number>(activityPollMs({ watchingRunning: false, anyRunning: false }))
  // `watchRunning` is read inside `load`, which must not be rebuilt when it
  // changes: the poll loop's identity depends on `load`.
  const watchRunningRef = useRef(watchRunning)
  watchRunningRef.current = watchRunning
  // A turn edge off the realtime connection, wired by the poll effect.
  const refreshNowRef = useRef<(() => void) | null>(null)

  const load = useCallback(
    async (refreshProjects = false, fresh = false) => {
      if (inFlight.current) return inFlight.current
      const request = (async () => {
        try {
          setError(null)
          const projectFilter = !everyWorkspace && workspace?.id ? { workspaceId: workspace.id } : undefined
          const projectScope = everyWorkspace ? 'remote' : workspace?.id || 'local'
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
            // workspace's tasks on each poll. Both reads go through the shared
            // cache, so every mounted activity hook in the window shares ONE
            // request per workspace per 5 s instead of one each (SHO-277).
            workspaceActivity.agentTasks(http, workspace?.id, { fresh }),
            // Active chats are supplementary; a failure here must not hide agent tasks.
            workspace?.id ? workspaceActivity.activeChats(http, workspace.id, { fresh }).catch(() => null) : Promise.resolve([]),
          ])
          // A paired computer's workspace is resolved client-side, so keep the
          // local filter for that case; the server already scoped the rest.
          const scoped = everyWorkspace || !workspace?.id
            ? next.filter((task: { workspaceId?: string | null }) => !workspace?.id || task.workspaceId === workspace.id)
            : next
          // 5 s only while this screen is showing a run; a run elsewhere keeps
          // the 60 s safety net, nothing running asks every 30 s (SHO-602).
          const anyRunning = scoped.some(isTaskRunning) || (chats?.length ?? 0) > 0
          cadenceRef.current = activityPollMs({
            watchingRunning: watchRunningRef.current && anyRunning,
            anyRunning,
          })
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
    [http, everyWorkspace, light, notifications, projects, workspace?.id],
  )

  const running = useMemo(() => tasks.filter(isTaskRunning), [tasks])
  const failed = useMemo(() => tasks.filter(isTaskFailed), [tasks])

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
      // 5 s only while what this screen shows is running; a run elsewhere is a
      // 60 s safety net because its edges arrive on the socket, and an idle
      // screen asks every 30 s (SHO-602).
      pollTimer = setTimeout(async () => {
        await load()
        schedulePoll()
      }, cadenceRef.current)
    }
    const refreshAndSchedule = async () => {
      if (!live || !foreground()) return
      await load(true)
      schedulePoll()
    }
    // A turn started or ended somewhere else: one uncached read, coalesced with
    // any second edge, then back to the slow cadence.
    refreshNowRef.current = () => {
      if (!live || !polling || !foreground()) return
      clearPoll()
      pollTimer = setTimeout(async () => {
        await load(false, true)
        schedulePoll()
      }, EDGE_REFRESH_MS)
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
      refreshNowRef.current = null
      unsubscribeTasks()
      unsubscribeNotifications()
      appStateSubscription.remove()
    }
  }, [load, light, notifications, polling])

  // A turn edge off the realtime connection is what makes a run appear and
  // clear on this screen between two slow polls (SHO-602).
  useChatTurnEvents(polling ? workspace?.id : null, () => refreshNowRef.current?.())

  const refresh = useCallback(
    async ({ projects: withProjects = true, manual = false }: { projects?: boolean; manual?: boolean } = {}) => {
      if (manual) setRefreshing(true)
      // An explicit refresh is a request for the current state, not the answer
      // cached for every other mounted consumer (SHO-277).
      await load(withProjects, true)
    },
    [load],
  )
  const clearError = useCallback(() => setError(null), [])

  return { tasks, activeChats, running, failed, loading, refreshing, error, clearError, refresh }
}
