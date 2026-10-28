// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One load / update / delete path for the signed-in user's workspace-agent
 * chats. Home, the phone drawer and the side-chats screen all read and mutate
 * through this hook, so a rename in one place lands everywhere and there is a
 * single `listWorkspaceSessions` call site.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import {
  useChatSessionCollection,
  useDomainActions,
  useDomainHttp,
} from '../contexts/domain'
import { api } from '../lib/api'
import { chatActivityEvents, chatSessionEvents } from '../lib/chat-session-events'
import { sortSideChats, type SideChatItem } from '../lib/side-chats'

export type WorkspaceChat = SideChatItem & {
  workspaceId?: string
  isPrimary?: boolean
  messageCount?: number
}

type CreateWorkspaceChatOpts = Parameters<typeof api.createWorkspaceSession>[2]

export type WorkspaceChatChanges = {
  name?: string
  isPinned?: boolean
  isArchived?: boolean
}

/** Fast cadence while one of this person's chats is running. */
const POLL_RUNNING_MS = 5_000
/** Slow cadence so a turn started elsewhere (schedule, trigger, handoff, a
 *  second window) still shows up without hammering the endpoint. */
const POLL_IDLE_MS = 15_000
/** How long an optimistic start survives without the server confirming it, so
 *  a turn that never really started can't spin forever. */
const UNCONFIRMED_START_MS = 10_000

/** Same contents → keep the previous value, so a poll only re-renders on news. */
function sameStringMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) if (b.get(key) !== value) return false
  return true
}

export function useWorkspaceChats(workspaceId: string | undefined) {
  const http = useDomainHttp()
  const actions = useDomainActions()
  const chatSessions = useChatSessionCollection()
  const [sessions, setSessions] = useState<WorkspaceChat[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  // A turn this client watched start — painted before the next server poll.
  const [localRunningIds, setLocalRunningIds] = useState<Set<string>>(new Set())
  const localRunningAtRef = useRef(new Map<string, number>())
  // Turns the server reports running: session id → turn startedAt.
  const [serverRunning, setServerRunning] = useState<Map<string, string>>(new Map())
  // Turns this client watched end, with when it happened. Held until the
  // server agrees, so the spinner stops the moment the reply lands instead of
  // one poll later — and released if the server reports a NEWER turn.
  const [finishedAt, setFinishedAt] = useState<Map<string, number>>(new Map())
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())
  const openChatIdRef = useRef<string | null>(null)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  // The last server answer, so a poll can spot the turn that just ended — the
  // one case that has no local event at all (you are on another screen, or the
  // turn came from a schedule).
  const serverRunningRef = useRef(new Set<string>())
  // The cadence the last good poll asked for, so a failed one can keep it.
  const wasRunningRef = useRef(false)
  // Tightens the pending poll to the fast cadence the moment a turn starts here,
  // so a quick reply gets polled before it can finish unseen.
  const tightenPollRef = useRef<(() => void) | null>(null)
  // Read through a ref so the poll callback keeps one identity for its whole
  // life: it runs on a timer, and an unstable callback would restart the loop
  // on every render.
  const httpRef = useRef(http)
  httpRef.current = http

  const refresh = useCallback(async () => {
    if (!workspaceId) return
    try {
      const all = await api.listWorkspaceSessions(http, workspaceId)
      setSessions(all)
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [http, workspaceId])

  useEffect(() => {
    setSessions([])
    setLoading(true)
  }, [workspaceId])

  useEffect(() => {
    setLocalRunningIds(new Set())
    localRunningAtRef.current = new Map()
    setServerRunning(new Map())
    serverRunningRef.current = new Set()
    wasRunningRef.current = false
    setFinishedAt(new Map())
    setCompletedIds(new Set())
    openChatIdRef.current = null
  }, [workspaceId])

  /**
   * The server is the authority on what is running: a turn started by a
   * schedule, a trigger, a handoff or another window has no local event at all.
   * A failed poll keeps the last known set so a blip can't flash spinners off.
   * Returns whether any of this person's chats is running, which is what sets
   * the polling cadence.
   */
  const pollActiveChats = useCallback(async (): Promise<boolean> => {
    if (!workspaceId) return false
    try {
      const chats = await api.listWorkspaceActiveChats(httpRef.current, workspaceId)
      const startedAt = new Map<string, string>()
      for (const chat of chats) startedAt.set(chat.chatSessionId, chat.startedAt)
      // A turn that stops being reported has really ended — the only signal for
      // a turn that finished while you were on another screen. It is not a dot
      // for the chat you are looking at, and not for a project chat that has no
      // row here.
      const knownIds = new Set(sessionsRef.current.map((session) => session.id))
      const now = Date.now()
      const ended: string[] = []
      const considerEnded = (id: string) => {
        if (startedAt.has(id)) return
        if (id === openChatIdRef.current) return
        if (knownIds.size > 0 && !knownIds.has(id)) return
        ended.push(id)
      }
      for (const id of serverRunningRef.current) considerEnded(id)
      // A turn this client watched start is equally known to have ended once the
      // server stops reporting it — the quick reply that finished before any
      // poll ever saw it running. Only past the grace window, so an optimistic
      // start the server has not caught up with yet does not read as an ending.
      for (const [id, startedAtLocal] of localRunningAtRef.current) {
        if (serverRunningRef.current.has(id)) continue
        if (now - startedAtLocal < UNCONFIRMED_START_MS) continue
        considerEnded(id)
      }
      serverRunningRef.current = new Set(startedAt.keys())
      // The endpoint answers for the whole workspace, including project chats.
      // Only this person's workspace chats have rows in this list.
      if (knownIds.size > 0) {
        for (const id of [...startedAt.keys()]) {
          if (!knownIds.has(id)) startedAt.delete(id)
        }
      }
      setServerRunning((current) =>
        sameStringMap(current, startedAt) ? current : startedAt,
      )
      // The server no longer reports the turn: nothing left to suppress.
      setFinishedAt((current) => {
        let changed = false
        const next = new Map(current)
        for (const id of current.keys()) {
          if (startedAt.has(id)) continue
          next.delete(id)
          changed = true
        }
        return changed ? next : current
      })
      // An optimistic start the server has had time to report and does not.
      setLocalRunningIds((current) => {
        let changed = false
        const next = new Set(current)
        for (const id of current) {
          if (startedAt.has(id)) continue
          const startedAtLocal = localRunningAtRef.current.get(id) ?? 0
          if (now - startedAtLocal < UNCONFIRMED_START_MS) continue
          localRunningAtRef.current.delete(id)
          next.delete(id)
          changed = true
        }
        return changed ? next : current
      })
      if (ended.length > 0) {
        setCompletedIds((current) => {
          let changed = false
          const next = new Set(current)
          for (const id of ended) {
            if (!next.has(id)) {
              next.add(id)
              changed = true
            }
          }
          return changed ? next : current
        })
      }
      // A local start has to keep the fast cadence too: a quick reply can begin
      // and end between two idle polls, and only a poll can see that it ended.
      const fast = startedAt.size > 0 || localRunningAtRef.current.size > 0
      wasRunningRef.current = fast
      return fast
    } catch {
      // Keep the last known set and the cadence it implies, so a blip neither
      // flashes spinners off nor drops a running turn to the idle interval.
      return wasRunningRef.current || localRunningAtRef.current.size > 0
    }
  }, [workspaceId])

  const touchChat = useCallback((sessionId: string, lastActiveAt: number) => {
    setSessions((current) => {
      const index = current.findIndex((session) => session.id === sessionId)
      if (index < 0) return current
      const session = current[index]
      const previous = session.lastActiveAt
        ? new Date(session.lastActiveAt).getTime()
        : 0
      if (Number.isFinite(previous) && previous >= lastActiveAt) return current
      const next = [...current]
      next[index] = {
        ...session,
        lastActiveAt: new Date(lastActiveAt).toISOString(),
      }
      return next
    })
  }, [])

  // A chat created / renamed / archived anywhere (this hook, the agent screen,
  // another window) refreshes every list through this one subscription; a send
  // anywhere only re-stamps that row's time.
  useEffect(() => {
    if (!workspaceId) return
    return chatSessionEvents.subscribe((event) => {
      if (event.touchedSessionId && event.lastActiveAt) {
        touchChat(event.touchedSessionId, event.lastActiveAt)
      }
      if (!event.refresh || event.workspaceId !== workspaceId) return
      void refresh()
    })
  }, [refresh, touchChat, workspaceId])

  /**
   * What is running, as far as this client can tell: the server's answer, plus
   * any turn this client watched start (painted instantly), minus any turn this
   * client watched end (stopped instantly). A local emit that goes blank — the
   * publisher switching chats or unmounting — is not an "everything finished"
   * signal and must never clear a spinner the server still reports.
   */
  useEffect(() => {
    if (!workspaceId) return
    return chatActivityEvents.subscribe((event) => {
      if (event.workspaceId !== workspaceId) return
      if (event.streamingSessionIds.length > 0) {
        const started = event.streamingSessionIds
        let fresh = false
        for (const id of started) {
          if (localRunningAtRef.current.has(id)) continue
          localRunningAtRef.current.set(id, Date.now())
          fresh = true
        }
        // A turn just started here: get a poll in before it can finish unseen.
        if (fresh) tightenPollRef.current?.()
        setLocalRunningIds((current) => {
          let changed = false
          const next = new Set(current)
          for (const id of started) {
            if (next.has(id)) continue
            next.add(id)
            changed = true
          }
          return changed ? next : current
        })
        setFinishedAt((current) => {
          let changed = false
          const next = new Map(current)
          for (const id of started) {
            if (!next.delete(id)) continue
            changed = true
          }
          return changed ? next : current
        })
        setCompletedIds((current) => {
          let changed = false
          const next = new Set(current)
          for (const id of started) {
            if (!next.delete(id)) continue
            changed = true
          }
          return changed ? next : current
        })
      }

      const finished = event.finishedSessionIds ?? []
      if (finished.length === 0) return
      const endedAt = Date.now()
      setFinishedAt((current) => {
        const next = new Map(current)
        for (const id of finished) next.set(id, endedAt)
        return next
      })
      setLocalRunningIds((current) => {
        let changed = false
        const next = new Set(current)
        for (const id of finished) {
          localRunningAtRef.current.delete(id)
          if (!next.delete(id)) continue
          changed = true
        }
        return changed ? next : current
      })
      setCompletedIds((current) => {
        let changed = false
        const next = new Set(current)
        for (const id of finished) {
          // The chat on screen was watched, so it is read, not "new".
          if (id === openChatIdRef.current) {
            if (!next.delete(id)) continue
          } else if (!next.has(id)) next.add(id)
          else continue
          changed = true
        }
        return changed ? next : current
      })
    })
  }, [workspaceId])

  // Poll while the list is on screen, always taking the fast cadence once one
  // of this person's chats is running. Stops entirely in the background.
  useEffect(() => {
    if (!workspaceId) return
    let live = true
    let appState = AppState.currentState
    let timer: ReturnType<typeof setTimeout> | null = null
    // React Native can report null briefly during launch; treat that as foreground.
    const foreground = () => appState === 'active' || appState === null

    const clearPoll = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const schedulePoll = (running: boolean) => {
      clearPoll()
      if (!live || !foreground()) return
      // A turn started here keeps the fast cadence even before the server has
      // confirmed it: a quick reply can begin and end between two idle polls,
      // and only a poll can see that it ended.
      const fast = running || localRunningAtRef.current.size > 0
      timer = setTimeout(async () => {
        schedulePoll(await pollActiveChats())
      }, fast ? POLL_RUNNING_MS : POLL_IDLE_MS)
    }
    const pollNow = async () => {
      schedulePoll(await pollActiveChats())
    }
    // Bring the pending poll forward to the fast cadence, never push it back.
    tightenPollRef.current = () => {
      if (!live || !foreground() || !timer) return
      clearPoll()
      timer = setTimeout(async () => {
        schedulePoll(await pollActiveChats())
      }, POLL_RUNNING_MS)
    }

    void pollNow()
    const appStateSubscription = AppState.addEventListener('change', (next) => {
      appState = next
      if (appState === 'active') void pollNow()
      else clearPoll()
    })
    return () => {
      live = false
      clearPoll()
      tightenPollRef.current = null
      appStateSubscription.remove()
    }
  }, [pollActiveChats, workspaceId])

  const ensureLoaded = useCallback(
    async (sessionId: string) => {
      if (!chatSessions.get(sessionId)) await chatSessions.loadById(sessionId)
    },
    [chatSessions],
  )

  const markSeen = useCallback((sessionId: string | null | undefined) => {
    openChatIdRef.current = sessionId ?? null
    if (!sessionId) return
    setCompletedIds((current) => {
      if (!current.has(sessionId)) return current
      const next = new Set(current)
      next.delete(sessionId)
      return next
    })
  }, [])

  const updateChat = useCallback(
    async (sessionId: string, changes: WorkspaceChatChanges) => {
      const previous = sessionsRef.current
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, ...changes } : session,
        ),
      )
      try {
        await ensureLoaded(sessionId)
        await actions.updateChatSession(sessionId, changes)
        if (workspaceId) {
          chatSessionEvents.emit({ workspaceId, refresh: true })
        }
      } catch {
        setSessions(previous)
        void refresh()
      }
    },
    [actions, ensureLoaded, refresh, workspaceId],
  )

  const deleteChat = useCallback(
    async (sessionId: string) => {
      const previous = sessionsRef.current
      setSessions((current) =>
        current.filter((session) => session.id !== sessionId),
      )
      try {
        await actions.deleteChatSession(sessionId)
      } catch {
        setSessions(previous)
        void refresh()
      }
    },
    [actions, refresh],
  )

  /** Create a chat, prepend it optimistically, and hand the row to the caller. */
  const createChat = useCallback(
    async (fields: CreateWorkspaceChatOpts = {}): Promise<WorkspaceChat | null> => {
      if (!workspaceId || creating) return null
      setCreating(true)
      try {
        const session = await api.createWorkspaceSession(http, workspaceId, fields)
        // Stamp the row so it ranks as the most recent chat even if the server
        // response omits timestamps; sortSideChats would otherwise push it last.
        const now = new Date().toISOString()
        const row: WorkspaceChat = {
          ...session,
          createdAt: session.createdAt ?? now,
          lastActiveAt: session.lastActiveAt ?? now,
        }
        setSessions((current) => [
          row,
          ...current.filter((item) => item.id !== session.id),
        ])
        return row
      } catch {
        return null
      } finally {
        setCreating(false)
      }
    },
    [creating, http, workspaceId],
  )

  // The union the rows paint from (see the activity subscription above). Ids
  // outside this person's chat list have no row — the API answers for the whole
  // workspace, project chats included — so they never count as running.
  const streamingIds = useMemo(() => {
    const known = new Set(sessions.map((session) => session.id))
    const keep = (id: string) => known.size === 0 || known.has(id)
    const ids = new Set<string>()
    for (const id of serverRunning.keys()) if (keep(id)) ids.add(id)
    for (const id of localRunningIds) if (keep(id)) ids.add(id)
    for (const [id, endedAt] of finishedAt) {
      // A turn the server reports starting after the one we watched end is a
      // new turn on the same chat — it must spin like any other.
      const startedAt = serverRunning.get(id)
      if (startedAt && new Date(startedAt).getTime() > endedAt) continue
      ids.delete(id)
    }
    return ids
  }, [finishedAt, localRunningIds, serverRunning, sessions])

  // A turn running right now counts as activity: its row reads "now" and sorts
  // to the top of its group even when the last message is older.
  const sessionsWithActivity = useMemo(() => {
    if (serverRunning.size === 0) return sessions
    return sessions.map((session) => {
      const startedAt = serverRunning.get(session.id)
      if (!startedAt) return session
      const current = session.lastActiveAt
        ? new Date(session.lastActiveAt).getTime()
        : 0
      const next = new Date(startedAt).getTime()
      if (!Number.isFinite(next) || next <= current) return session
      return { ...session, lastActiveAt: startedAt }
    })
  }, [serverRunning, sessions])

  const active = useMemo(
    () =>
      sortSideChats(
        sessionsWithActivity.filter((session) => !session.isArchived),
      ),
    [sessionsWithActivity],
  )
  const archived = useMemo(
    () =>
      sortSideChats(
        sessionsWithActivity.filter((session) => session.isArchived),
      ),
    [sessionsWithActivity],
  )

  return {
    sessions: sessionsWithActivity,
    active,
    archived,
    loading,
    creating,
    streamingIds,
    completedIds,
    markSeen,
    refresh,
    createChat,
    updateChat,
    deleteChat,
  }
}
