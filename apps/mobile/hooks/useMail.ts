// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared, per-workspace cache of the Shogo Mail overview (`GET /mail`): the
 * domains and mailboxes. The channel list reads it to mark mailbox
 * conversations, the conversation screen to find its mailbox, and the
 * Settings → Email tab to manage both. One fetch serves every reader.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { mailApi, type Mailbox, type MailOverview } from '../lib/mail-api'

const api = mailApi()

interface Entry {
  overview: MailOverview | null
  error: string | null
  loading: boolean
  loadedAt: number
  inflight: Promise<void> | null
  mailboxIds: Set<string>
}

const STALE_MS = 60_000
const entries = new Map<string, Entry>()
const listeners = new Map<string, Set<() => void>>()
const EMPTY: Entry = { overview: null, error: null, loading: false, loadedAt: 0, inflight: null, mailboxIds: new Set() }

function emit(workspaceId: string) {
  listeners.get(workspaceId)?.forEach((l) => l())
}

function entryFor(workspaceId: string): Entry {
  let e = entries.get(workspaceId)
  if (!e) {
    e = { ...EMPTY, mailboxIds: new Set() }
    entries.set(workspaceId, e)
  }
  return e
}

function load(workspaceId: string, force = false): Promise<void> {
  const current = entryFor(workspaceId)
  if (current.inflight) return current.inflight
  if (!force && current.loadedAt && Date.now() - current.loadedAt < STALE_MS) return Promise.resolve()
  const inflight = (async () => {
    entries.set(workspaceId, { ...entryFor(workspaceId), loading: true })
    emit(workspaceId)
    try {
      const overview = await api.overview(workspaceId)
      const mailboxIds = new Set(
        (overview.mailboxes ?? []).filter((m) => !m.archivedAt).map((m) => m.conversationId),
      )
      entries.set(workspaceId, { overview, error: null, loading: false, loadedAt: Date.now(), inflight: null, mailboxIds })
    } catch (err) {
      entries.set(workspaceId, {
        ...entryFor(workspaceId),
        error: err instanceof Error ? err.message : String(err),
        loading: false,
        loadedAt: Date.now(),
        inflight: null,
      })
    }
    emit(workspaceId)
  })()
  entries.set(workspaceId, { ...entryFor(workspaceId), inflight })
  return inflight
}

/** Refetch the overview now, e.g. after creating a mailbox or a domain. */
export function invalidateMail(workspaceId: string): Promise<void> {
  return load(workspaceId, true)
}

/** Replace the cached overview with one the caller already has. */
export function setMailOverview(workspaceId: string, update: (o: MailOverview) => MailOverview) {
  const e = entryFor(workspaceId)
  if (!e.overview) return
  const overview = update(e.overview)
  const mailboxIds = new Set((overview.mailboxes ?? []).filter((m) => !m.archivedAt).map((m) => m.conversationId))
  entries.set(workspaceId, { ...e, overview, mailboxIds })
  emit(workspaceId)
}

function useEntry(workspaceId: string | null | undefined): Entry {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!workspaceId) return () => {}
      let set = listeners.get(workspaceId)
      if (!set) {
        set = new Set()
        listeners.set(workspaceId, set)
      }
      set.add(cb)
      return () => {
        set!.delete(cb)
      }
    },
    [workspaceId],
  )
  const snapshot = useCallback(() => (workspaceId ? entries.get(workspaceId) ?? EMPTY : EMPTY), [workspaceId])
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (workspaceId) void load(workspaceId)
  }, [workspaceId])
  return entry
}

export function useMailOverview(workspaceId: string | null | undefined) {
  const entry = useEntry(workspaceId)
  const refresh = useCallback(() => (workspaceId ? invalidateMail(workspaceId) : Promise.resolve()), [workspaceId])
  return { overview: entry.overview, error: entry.error, loading: entry.loading && !entry.overview, refresh }
}

/** Conversation ids that are mailboxes (for the mail icon in the channel list). */
export function useMailboxConversationIds(workspaceId: string | null | undefined): Set<string> {
  return useEntry(workspaceId).mailboxIds
}

/** The mailbox a conversation is, or null when it is an ordinary conversation. */
export function useMailboxForConversation(
  workspaceId: string | null | undefined,
  conversationId: string | null | undefined,
): Mailbox | null {
  const entry = useEntry(workspaceId)
  if (!conversationId || !entry.mailboxIds.has(conversationId)) return null
  return entry.overview?.mailboxes.find((m) => m.conversationId === conversationId && !m.archivedAt) ?? null
}
