// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hooks for chat preferences and the activity inbox: everyone's custom
 * status, your own settings, and the inbox with its live unread count.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  teamChatApi,
  type ChatSettings,
  type InboxItem,
  type SentMessage,
  type UserStatus,
} from '../lib/team-chat-api'
import { useTeamChatEvents } from '../lib/team-chat-connection'
import { useMentionables } from './useTeamChat'
import { useWorkspaceUser } from './useWorkspaceUser'

const api = teamChatApi()

// ─── Statuses ────────────────────────────────────────────────────────────────

const statusStore = new Map<string, Record<string, UserStatus>>()
const statusListeners = new Set<() => void>()
let statusVersion = 0
let feedWorkspaceId: string | null = null

function setStatuses(workspaceId: string, next: Record<string, UserStatus>) {
  statusStore.set(workspaceId, next)
  statusVersion++
  statusListeners.forEach((l) => l())
}

export function liveStatus(status: UserStatus | null | undefined, now = Date.now()): UserStatus | null {
  if (!status) return null
  const expired = status.expiresAt && new Date(status.expiresAt).getTime() <= now
  const emoji = expired ? null : status.emoji
  const text = expired ? null : status.text
  if (!emoji && !text && !status.dnd) return null
  return { ...status, emoji, text }
}

/** Keeps the workspace status map current; mount once per workspace view. */
export function useStatusFeed(workspaceId: string | null | undefined): void {
  const mentionables = useMentionables(workspaceId)
  useEffect(() => {
    if (workspaceId) feedWorkspaceId = workspaceId
  }, [workspaceId])
  useEffect(() => {
    if (workspaceId && mentionables?.statuses) setStatuses(workspaceId, mentionables.statuses)
  }, [workspaceId, mentionables])
  useTeamChatEvents(workspaceId, (event) => {
    if (!workspaceId || event.type !== 'status.changed') return
    const current = { ...(statusStore.get(workspaceId) ?? {}) }
    if (event.status) current[event.userId] = event.status
    else delete current[event.userId]
    setStatuses(workspaceId, current)
  })
}

/** Status for a person; omit the workspace to use the one whose feed is mounted. */
export function useUserStatus(workspaceId: string | null | undefined, userId: string | null | undefined): UserStatus | null {
  useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
    () => statusVersion,
    () => statusVersion,
  )
  const ws = workspaceId === undefined ? feedWorkspaceId : workspaceId
  if (!ws || !userId) return null
  return liveStatus(statusStore.get(ws)?.[userId])
}

// ─── Own settings ────────────────────────────────────────────────────────────

// Own settings are shared per workspace, so the notifier hears a change made
// on the settings screen without reloading.
const settingsStore = new Map<string, ChatSettings>()
const settingsListeners = new Set<(workspaceId: string) => void>()

function publishSettings(workspaceId: string, next: ChatSettings) {
  settingsStore.set(workspaceId, next)
  settingsListeners.forEach((l) => l(workspaceId))
}

/** Own chat settings for a workspace, read by any component that needs them. */
export function useChatSettings(workspaceId: string | null | undefined) {
  const [settings, setSettings] = useState<ChatSettings | null>(() =>
    workspaceId ? settingsStore.get(workspaceId) ?? null : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!workspaceId) return
    const sync = (id: string) => {
      if (id !== workspaceId) return
      const cached = settingsStore.get(id)
      if (cached) setSettings(cached)
    }
    settingsListeners.add(sync)
    return () => { settingsListeners.delete(sync) }
  }, [workspaceId])

  // A change saved in another tab or on another device arrives as an event, so this
  // client doesn't keep playing a stale message tone until it reloads.
  useTeamChatEvents(workspaceId, (event) => {
    if (event.type === 'settings.changed' && workspaceId) publishSettings(workspaceId, event.settings)
  })

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    api.chatSettings(workspaceId)
      .then((s) => { if (!cancelled) publishSettings(workspaceId, s) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load settings') })
    return () => { cancelled = true }
  }, [workspaceId])

  const update = useCallback(async (patch: Partial<ChatSettings>) => {
    if (!workspaceId) return
    setSaving(true)
    const optimistic = { ...(settingsStore.get(workspaceId) ?? {}), ...patch } as ChatSettings
    publishSettings(workspaceId, optimistic)
    try {
      publishSettings(workspaceId, await api.updateChatSettings(workspaceId, patch))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
      api.chatSettings(workspaceId).then((s) => publishSettings(workspaceId, s)).catch(() => {})
    } finally {
      setSaving(false)
    }
  }, [workspaceId])

  return { settings, error, saving, update }
}

// ─── Inbox ───────────────────────────────────────────────────────────────────

/** Unread inbox items in total, and how many of them are thread replies. */
export interface InboxCounts {
  unread: number
  unreadThreads: number
}

const NO_INBOX: InboxCounts = { unread: 0, unreadThreads: 0 }
const unreadStore = new Map<string, InboxCounts>()
const unreadListeners = new Set<() => void>()

function setUnread(workspaceId: string, next: Partial<InboxCounts> & { unread: number }) {
  const prev = unreadStore.get(workspaceId) ?? NO_INBOX
  const unread = Math.max(0, next.unread)
  const unreadThreads = Math.max(0, Math.min(next.unreadThreads ?? prev.unreadThreads, unread))
  if (prev.unread === unread && prev.unreadThreads === unreadThreads) return
  unreadStore.set(workspaceId, { unread, unreadThreads })
  unreadListeners.forEach((l) => l())
}

/** Live unread counts for the Activity inbox; mount the feed once via `useInboxFeed`. */
export function useInboxCounts(workspaceId: string | null | undefined): InboxCounts {
  return useSyncExternalStore(
    (cb) => {
      unreadListeners.add(cb)
      return () => unreadListeners.delete(cb)
    },
    () => (workspaceId ? unreadStore.get(workspaceId) ?? NO_INBOX : NO_INBOX),
    () => (workspaceId ? unreadStore.get(workspaceId) ?? NO_INBOX : NO_INBOX),
  )
}

/** Live count of unread inbox items; mount the feed once via `useInboxFeed`. */
export function useInboxUnread(workspaceId: string | null | undefined): number {
  return useInboxCounts(workspaceId).unread
}

export function useInboxFeed(workspaceId: string | null | undefined): void {
  const load = useCallback(() => {
    if (!workspaceId) return
    api.inbox(workspaceId, { unreadOnly: true, limit: 1 })
      .then((p) => setUnread(workspaceId, { unread: p.unread, unreadThreads: p.unreadThreads ?? 0 }))
      .catch(() => {})
  }, [workspaceId])
  useEffect(load, [load])
  useTeamChatEvents(workspaceId, (event) => {
    if (!workspaceId) return
    if (event.type === 'ready') load()
    else if (event.type === 'inbox.created') {
      const prev = unreadStore.get(workspaceId) ?? NO_INBOX
      setUnread(workspaceId, {
        unread: prev.unread + 1,
        unreadThreads: prev.unreadThreads + (event.item.kind === 'thread' ? 1 : 0),
      })
    }
    else if (event.type === 'inbox.read') {
      setUnread(workspaceId, { unread: event.unread, unreadThreads: event.unreadThreads })
    }
  })
}

export function useInbox(workspaceId: string | null | undefined, unreadOnly: boolean) {
  const [items, setItems] = useState<InboxItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const req = useRef(0)
  const appending = useRef(false)

  const load = useCallback(async (before?: string, beforeId?: string) => {
    if (!workspaceId) return
    const id = ++req.current
    if (before) setLoadingMore(true)
    else setLoading(true)
    try {
      const page = await api.inbox(workspaceId, { unreadOnly, before, beforeId })
      if (id !== req.current) return
      setItems((prev) => (before ? [...prev, ...page.items] : page.items))
      setHasMore(page.hasMore)
      setUnread(workspaceId, { unread: page.unread, unreadThreads: page.unreadThreads ?? 0 })
      setError(null)
    } catch (err) {
      if (id === req.current) setError(err instanceof Error ? err.message : 'Could not load inbox')
    } finally {
      if (id === req.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [workspaceId, unreadOnly])

  /**
   * Refresh the newest page in place, keeping the pages already loaded.
   *
   * `inbox.read` and `ready` are frequent — every mark-read, every SSE
   * reconnect — so a plain reload here (`load()` with no cursor) would replace
   * the whole list with page one. Paging down and then clicking a row, or
   * simply losing the socket for a second, would throw away everything loaded
   * below the first page and drop the reader back to the top.
   */
  const syncHead = useCallback(async () => {
    if (!workspaceId) return
    const id = ++req.current
    try {
      const page = await api.inbox(workspaceId, { unreadOnly })
      if (id !== req.current) return
      setItems((prev) => {
        if (!prev.length) return page.items
        const headIds = new Set(page.items.map((i) => i.id))
        const older = prev.filter((i) => !headIds.has(i.id))
        return older.length ? [...page.items, ...older] : page.items
      })
      setHasMore(page.hasMore)
      setUnread(workspaceId, { unread: page.unread, unreadThreads: page.unreadThreads ?? 0 })
      setError(null)
    } catch {
      // Keep the list we have; the next ready or pull-to-refresh retries.
    }
  }, [workspaceId, unreadOnly])

  useEffect(() => { void load() }, [load])

  useTeamChatEvents(workspaceId, (event) => {
    if (event.type === 'inbox.created') setItems((prev) => (prev.some((i) => i.id === event.item.id) ? prev : [event.item, ...prev]))
    else if (event.type === 'inbox.read' || event.type === 'ready') void syncHead()
  })

  const markRead = useCallback(async (ids: string[] | 'all', unread = false) => {
    if (!workspaceId) return
    const now = new Date().toISOString()
    setItems((prev) => prev.map((i) => (ids === 'all' || ids.includes(i.id) ? { ...i, readAt: unread ? null : now } : i)))
    await api.markInboxRead(workspaceId, ids === 'all' ? { all: true } : { ids, unread }).catch(() => {})
  }, [workspaceId])

  const loadMore = useCallback(() => {
    const last = items[items.length - 1]
    // Two presses can land before the first page arrives; the ref keeps them
    // from stacking up identical requests.
    if (!hasMore || !last || appending.current) return
    appending.current = true
    // Both halves of the cursor: `createdAt` alone drops rows that share the
    // boundary millisecond.
    void load(last.createdAt, last.id).finally(() => { appending.current = false })
  }, [items, hasMore, load])

  return { items, hasMore, loading, loadingMore, error, markRead, loadMore, refresh: load }
}

/**
 * The messages the viewer sent, for the Activity panel's Sent view. Nothing is
 * fetched until the view is opened (`enabled`), so people who never look at it
 * pay for nothing.
 *
 * The server stays the truth: a send from another window triggers a refetch
 * rather than splicing a row into the list here.
 */
export function useSentMessages(workspaceId: string | null | undefined, enabled: boolean) {
  const viewer = useWorkspaceUser(workspaceId)
  const [items, setItems] = useState<SentMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const req = useRef(0)
  const lastRefetch = useRef(0)

  const load = useCallback(async (
    cursor?: { before: string; beforeId: string },
    opts: { manual?: boolean } = {},
  ) => {
    if (!workspaceId || !enabled) return
    const id = ++req.current
    if (opts.manual) setRefreshing(true)
    else setLoading(true)
    try {
      const page = await api.sentMessages(workspaceId, cursor ?? {})
      if (id !== req.current) return
      setItems((prev) => (cursor ? [...prev, ...page.items] : page.items))
      setHasMore(page.hasMore)
      setError(null)
    } catch (err) {
      if (id === req.current) setError(err instanceof Error ? err.message : 'Could not load sent messages')
    } finally {
      if (id === req.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [workspaceId, enabled])

  useEffect(() => {
    if (enabled) void load()
  }, [enabled, load])

  useTeamChatEvents(workspaceId, (event) => {
    if (!enabled || !workspaceId) return
    if (event.type === 'ready') {
      void load()
      return
    }
    if (event.type !== 'message.created') return
    // Only our own sends, and at most one refetch a second, so a burst of
    // messages cannot turn into a burst of list requests.
    if (event.message.authorType !== 'user') return
    if (viewer && event.message.authorUserId && event.message.authorUserId !== viewer.id) return
    const now = Date.now()
    if (now - lastRefetch.current < 1000) return
    lastRefetch.current = now
    void load()
  })

  const loadMore = useCallback(() => {
    const last = items[items.length - 1]
    if (!hasMore || loading || !last) return
    void load({ before: last.createdAt, beforeId: last.id })
  }, [items, hasMore, loading, load])

  const refresh = useCallback(() => {
    void load(undefined, { manual: true })
  }, [load])

  return { items, hasMore, loading, refreshing, error, loadMore, refresh }
}
