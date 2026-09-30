// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * React hooks for workspace team chat: the sidebar's conversation list,
 * a live timeline (channel or thread), mentionable people/agents, and
 * typing indicators. REST loads state; the shared realtime connection keeps
 * it current and triggers a backfill after every reconnect.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../contexts/auth'
import {
  newClientMsgId,
  teamChatApi,
  type ChatMessage,
  type ConversationSummary,
  type Mentionables,
  type TeamChatEvent,
} from '../lib/team-chat-api'
import { useTeamChatEvents } from '../lib/team-chat-connection'
import { setActiveChannelNotificationContext } from '../lib/notifications/chat-notifier'
import { cacheList, cacheTimeline, readCachedList, readCachedTimeline } from '../lib/team-chat-cache'
import {
  addOptimistic,
  applyListEvent,
  applyTimelineEvent,
  emptyTimeline,
  failOptimistic,
  groupForSidebar,
  lastConfirmedSeq,
  mergePage,
  removeOptimistic,
  trimToNewest,
  type TimelineScope,
  type TimelineState,
} from '../lib/team-chat-state'

const api = teamChatApi()
const PAGE_SIZE = 50
/** Past this many loaded messages, a timeline scrolled to the latest drops its oldest pages. */
export const TIMELINE_SOFT_LIMIT = 600
const TIMELINE_TRIM_TO = 300

// ─── Which conversation is on screen (suppresses its unread badge) ──────────

let activeConversationId: string | null = null
const activeListeners = new Set<() => void>()

export function setActiveConversation(id: string | null): void {
  if (activeConversationId === id) return
  activeConversationId = id
  setActiveChannelNotificationContext(id)
  activeListeners.forEach((l) => l())
}

export function useActiveConversationId(): string | null {
  return useSyncExternalStore(
    (cb) => {
      activeListeners.add(cb)
      return () => activeListeners.delete(cb)
    },
    () => activeConversationId,
    () => activeConversationId,
  )
}

export function useMyUserId(): string | null {
  const { user } = useAuth()
  return (user as { id?: string } | null)?.id ?? null
}

// ─── Conversation list ───────────────────────────────────────────────────────

const listCache = new Map<string, ConversationSummary[]>()
const listChangedListeners = new Set<(workspaceId: string) => void>()

/** Ask mounted lists to refetch (after creating/joining/leaving a conversation). */
export function invalidateConversationList(workspaceId: string): void {
  listChangedListeners.forEach((l) => l(workspaceId))
}

export function useConversationList(workspaceId: string | null | undefined) {
  const me = useMyUserId()
  const active = useActiveConversationId()
  const [list, setList] = useState<ConversationSummary[]>(() => (workspaceId ? listCache.get(workspaceId) ?? [] : []))
  const [loading, setLoading] = useState(!workspaceId || !listCache.has(workspaceId))
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) return
    if (inflight.current) return inflight.current
    const run = (async () => {
      try {
        const next = await api.list(workspaceId)
        listCache.set(workspaceId, next)
        setList(next)
        setError(null)
        if (me) cacheList(me, workspaceId, next)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load conversations')
      } finally {
        setLoading(false)
        inflight.current = null
      }
    })()
    inflight.current = run
    return run
  }, [workspaceId, me])

  useEffect(() => {
    setList(workspaceId ? listCache.get(workspaceId) ?? [] : [])
    if (workspaceId && me && !listCache.has(workspaceId)) {
      void readCachedList(me, workspaceId).then((cached) => {
        if (!cached || listCache.has(workspaceId)) return
        setList(cached)
        setLoading(false)
      })
    }
    void refresh()
  }, [workspaceId, me, refresh])

  useEffect(() => {
    const onChanged = (id: string) => {
      if (id === workspaceId) void refresh()
    }
    listChangedListeners.add(onChanged)
    return () => {
      listChangedListeners.delete(onChanged)
    }
  }, [workspaceId, refresh])

  const activeRef = useRef(active)
  activeRef.current = active
  useTeamChatEvents(workspaceId, (event) => {
    if (!workspaceId || !me) return
    if (event.type === 'ready') {
      void refresh()
      return
    }
    setList((current) => {
      const update = applyListEvent(current, event, me, activeRef.current)
      if (update.refetch) queueMicrotask(() => void refresh())
      if (update.list !== current) {
        listCache.set(workspaceId, update.list)
        cacheList(me, workspaceId, update.list)
      }
      return update.list
    })
  })

  useEffect(() => {
    if (!active) return
    setList((current) => current.map((c) => (c.id === active ? { ...c, unreadCount: 0, mentionCount: 0 } : c)))
  }, [active])

  const groups = useMemo(() => groupForSidebar(list), [list])
  return { list, groups, loading, error, refresh }
}

// ─── Mentionables ────────────────────────────────────────────────────────────

const mentionablesCache = new Map<string, { at: number; data: Mentionables }>()
const mentionablesInflight = new Map<string, Promise<Mentionables>>()

function fetchMentionables(workspaceId: string): Promise<Mentionables> {
  const running = mentionablesInflight.get(workspaceId)
  if (running) return running
  const p = api.mentionables(workspaceId)
    .then((next) => {
      mentionablesCache.set(workspaceId, { at: Date.now(), data: next })
      return next
    })
    .finally(() => mentionablesInflight.delete(workspaceId))
  mentionablesInflight.set(workspaceId, p)
  return p
}

export function useMentionables(workspaceId: string | null | undefined): Mentionables | null {
  const cached = workspaceId ? mentionablesCache.get(workspaceId) : undefined
  const [data, setData] = useState<Mentionables | null>(cached?.data ?? null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!workspaceId) return
    const hit = mentionablesCache.get(workspaceId)
    if (hit) setData(hit.data)
    if (hit && Date.now() - hit.at < 60_000) return
    let cancelled = false
    fetchMentionables(workspaceId).then((next) => {
      if (!cancelled) setData(next)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [workspaceId, version])
  useTeamChatEvents(workspaceId, (event) => {
    if (!workspaceId || event.type !== 'groups.changed') return
    mentionablesCache.delete(workspaceId)
    setVersion((v) => v + 1)
  })
  return data
}

// ─── Timeline ────────────────────────────────────────────────────────────────

export interface SendInput {
  text: string
  alsoSentToChannel?: boolean
  attachmentIds?: string[]
}

export function useConversationTimeline(
  workspaceId: string | null | undefined,
  conversationId: string | null | undefined,
  threadRootId: string | null = null,
) {
  const me = useMyUserId()
  const { user } = useAuth()
  const [state, setState] = useState<TimelineState>(emptyTimeline)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const scope = useMemo<TimelineScope | null>(
    () => (conversationId ? { conversationId, threadRootId } : null),
    [conversationId, threadRootId],
  )

  const loadInitial = useCallback(async () => {
    if (!conversationId) return
    setLoading(true)
    try {
      const page = await api.messages(conversationId, { threadRootId: threadRootId ?? undefined, limit: PAGE_SIZE })
      setState((s) => mergePage(s, page, 'initial'))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load messages')
    } finally {
      setLoading(false)
    }
  }, [conversationId, threadRootId])

  useEffect(() => {
    setState(emptyTimeline)
    let fresh = false
    if (conversationId && !threadRootId && me) {
      void readCachedTimeline(me, conversationId).then((cached) => {
        if (!cached?.messages.length || fresh) return
        setState((s) => (s.messages.length ? s : { ...emptyTimeline, messages: cached.messages, hasMoreOlder: cached.hasMoreOlder }))
        setLoading(false)
      })
    }
    void loadInitial().finally(() => {
      fresh = true
    })
    return () => {
      fresh = true
    }
  }, [loadInitial, conversationId, threadRootId, me])

  useEffect(() => {
    if (!conversationId || threadRootId || !me || loading) return
    cacheTimeline(me, conversationId, state.messages, state.hasMoreOlder)
  }, [state.messages, state.hasMoreOlder, conversationId, threadRootId, me, loading])

  const backfill = useCallback(async () => {
    if (!conversationId) return
    if (threadRootId) return loadInitial()
    const after = lastConfirmedSeq(stateRef.current)
    if (!after) return loadInitial()
    try {
      const page = await api.messages(conversationId, { afterSeq: after, limit: 200 })
      setState((s) => mergePage(s, page, 'newer'))
    } catch {
      // The next reconnect retries.
    }
  }, [conversationId, threadRootId, loadInitial])

  useTeamChatEvents(workspaceId, (event: TeamChatEvent) => {
    if (!scope) return
    if (event.type === 'ready') {
      void backfill().then(() => {
        for (const m of stateRef.current.messages) if (m.pending === 'failed') void retryRef.current(m)
      })
      return
    }
    setState((s) => applyTimelineEvent(s, event, scope))
  })

  /** Keep long sessions light: once scrolled back to the latest, forget old pages. */
  const trimOld = useCallback(() => {
    if (threadRootId) return
    setState((s) => (s.messages.length > TIMELINE_SOFT_LIMIT ? trimToNewest(s, TIMELINE_TRIM_TO) : s))
  }, [threadRootId])

  const loadOlder = useCallback(async () => {
    const s = stateRef.current
    if (!conversationId || threadRootId || !s.hasMoreOlder) return
    const oldest = s.messages.find((m) => !m.pending)
    if (!oldest) return
    const page = await api.messages(conversationId, { beforeSeq: oldest.seq, limit: PAGE_SIZE })
    setState((cur) => mergePage(cur, page, 'older'))
  }, [conversationId, threadRootId])

  const sendWithClientId = useCallback(async (clientMsgId: string, input: SendInput) => {
    if (!conversationId) return
    try {
      const message = await api.post(conversationId, {
        text: input.text,
        threadRootId,
        alsoSentToChannel: input.alsoSentToChannel,
        clientMsgId,
        attachmentIds: input.attachmentIds,
      })
      if (scope) setState((s) => applyTimelineEvent(s, { type: 'message.created', conversationId, message }, scope))
    } catch {
      setState((s) => failOptimistic(s, clientMsgId))
    }
  }, [conversationId, threadRootId, scope])

  const send = useCallback(async (input: SendInput) => {
    if (!conversationId || !workspaceId) return
    const clientMsgId = newClientMsgId()
    const optimistic: ChatMessage = {
      id: `pending-${clientMsgId}`,
      conversationId,
      workspaceId,
      seq: Number.MAX_SAFE_INTEGER,
      threadRootId,
      replyCount: 0,
      lastReplyAt: null,
      alsoSentToChannel: !!input.alsoSentToChannel,
      authorType: 'user',
      author: me ? { id: me, name: (user as { name?: string } | null)?.name ?? 'You', image: null } : null,
      authorUserId: me,
      authorAgent: null,
      text: input.text,
      blocks: null,
      clientMsgId,
      agentSessionId: null,
      agentStatus: null,
      reactions: [],
      attachments: [],
      editedAt: null,
      deletedAt: null,
      createdAt: new Date().toISOString(),
    }
    setState((s) => addOptimistic(s, optimistic))
    await sendWithClientId(clientMsgId, input)
  }, [conversationId, workspaceId, threadRootId, me, user, sendWithClientId])

  const retry = useCallback(async (message: ChatMessage) => {
    if (!message.clientMsgId) return
    const clientMsgId = message.clientMsgId
    setState((s) => ({
      ...s,
      messages: s.messages.map((m) => (m.clientMsgId === clientMsgId && m.pending ? { ...m, pending: 'sending' } : m)),
    }))
    await sendWithClientId(clientMsgId, { text: message.text, alsoSentToChannel: message.alsoSentToChannel })
  }, [sendWithClientId])

  const retryRef = useRef(retry)
  retryRef.current = retry

  const discard = useCallback((message: ChatMessage) => {
    if (message.clientMsgId) setState((s) => removeOptimistic(s, message.clientMsgId!))
  }, [])

  const edit = useCallback(async (messageId: string, text: string) => {
    const message = await api.edit(messageId, text)
    if (scope && conversationId) setState((s) => applyTimelineEvent(s, { type: 'message.updated', conversationId, message }, scope))
  }, [scope, conversationId])

  const remove = useCallback(async (messageId: string) => {
    await api.remove(messageId)
  }, [])

  const react = useCallback(async (messageId: string, emoji: string) => {
    const reactions = await api.react(messageId, emoji)
    if (scope && conversationId) {
      setState((s) => applyTimelineEvent(s, { type: 'reaction.changed', conversationId, messageId, reactions }, scope))
    }
  }, [scope, conversationId])

  const stopAgent = useCallback((messageId: string) => api.stopAgent(messageId), [])

  return { state, loading, error, reload: loadInitial, loadOlder, trimOld, send, retry, discard, edit, remove, react, stopAgent }
}

// ─── Read state ──────────────────────────────────────────────────────────────

/** Mark the channel read up to its newest message while it's on screen. */
export function useMarkReadWhileVisible(conversationId: string | null | undefined, newestSeq: number, visible: boolean) {
  const lastSent = useRef(0)
  useEffect(() => {
    lastSent.current = 0
  }, [conversationId])
  useEffect(() => {
    if (!conversationId || !visible || newestSeq <= lastSent.current) return
    const timer = setTimeout(() => {
      lastSent.current = newestSeq
      api.markRead(conversationId, newestSeq).catch(() => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [conversationId, newestSeq, visible])
}

// ─── Typing ──────────────────────────────────────────────────────────────────

const TYPING_TTL_MS = 5_000

export function useTypingUsers(
  workspaceId: string | null | undefined,
  conversationId: string | null | undefined,
  threadRootId: string | null = null,
): string[] {
  const [typing, setTyping] = useState<Record<string, { name: string; at: number }>>({})
  useTeamChatEvents(workspaceId, (event) => {
    if (event.type === 'typing' && event.conversationId === conversationId && (event.threadRootId ?? null) === threadRootId) {
      setTyping((t) => ({ ...t, [event.userId]: { name: event.name, at: Date.now() } }))
    } else if (event.type === 'message.created' && event.message.conversationId === conversationId && event.message.authorUserId) {
      const author = event.message.authorUserId
      setTyping((t) => {
        if (!t[author]) return t
        const { [author]: _gone, ...rest } = t
        return rest
      })
    }
  })
  useEffect(() => {
    const timer = setInterval(() => {
      setTyping((t) => {
        const now = Date.now()
        const entries = Object.entries(t).filter(([, v]) => now - v.at < TYPING_TTL_MS)
        return entries.length === Object.keys(t).length ? t : Object.fromEntries(entries)
      })
    }, 1_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => setTyping({}), [conversationId, threadRootId])
  return Object.values(typing).map((v) => v.name)
}
