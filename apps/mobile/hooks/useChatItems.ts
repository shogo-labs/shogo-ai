// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Saved items, drafts synced across devices, scheduled messages, and
 * reminders ("Later").
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  teamChatApi,
  type Reminder,
  type SavedItem,
  type ScheduledMessage,
} from '../lib/team-chat-api'
import { useTeamChatEvents } from '../lib/team-chat-connection'

const api = teamChatApi()
const DRAFT_SAVE_MS = 700

function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      listeners.forEach((l) => l())
    },
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}

// ─── Saved ───────────────────────────────────────────────────────────────────

const savedIds = createStore<Set<string>>(new Set())
const savedLoaded = new Set<string>()

function setSavedLocal(messageId: string, on: boolean) {
  const next = new Set(savedIds.get())
  if (on) next.add(messageId)
  else next.delete(messageId)
  savedIds.set(next)
}

/** Keeps the saved-message set current; mount once per workspace view. */
export function useSavedFeed(workspaceId: string | null | undefined): void {
  useEffect(() => {
    if (!workspaceId || savedLoaded.has(workspaceId)) return
    savedLoaded.add(workspaceId)
    api.saved(workspaceId)
      .then((items) => savedIds.set(new Set([...savedIds.get(), ...items.map((i) => i.message.id)])))
      .catch(() => savedLoaded.delete(workspaceId))
  }, [workspaceId])
  useTeamChatEvents(workspaceId, (event) => {
    if (event.type === 'saved.changed') setSavedLocal(event.messageId, event.saved)
  })
}

export function useIsSaved(messageId: string): boolean {
  return useSyncExternalStore(savedIds.subscribe, () => savedIds.get().has(messageId), () => false)
}

export async function toggleSaved(messageId: string, on: boolean): Promise<void> {
  setSavedLocal(messageId, on)
  try {
    await api.save(messageId, on)
  } catch (err) {
    setSavedLocal(messageId, !on)
    throw err
  }
}

// ─── Drafts ──────────────────────────────────────────────────────────────────

const drafts = createStore<Map<string, string>>(new Map())
const draftsLoaded = new Set<string>()

export function draftKey(conversationId: string, threadRootId?: string | null): string {
  return `${conversationId}:${threadRootId ?? ''}`
}

function setDraftLocal(key: string, text: string) {
  const current = drafts.get()
  if ((current.get(key) ?? '') === text) return
  const next = new Map(current)
  if (text) next.set(key, text)
  else next.delete(key)
  drafts.set(next)
}

export function useDraftsFeed(workspaceId: string | null | undefined): void {
  useEffect(() => {
    if (!workspaceId || draftsLoaded.has(workspaceId)) return
    draftsLoaded.add(workspaceId)
    api.drafts(workspaceId)
      .then((list) => {
        const next = new Map(drafts.get())
        for (const d of list) if (!next.has(draftKey(d.conversationId, d.threadRootId))) next.set(draftKey(d.conversationId, d.threadRootId), d.text)
        drafts.set(next)
      })
      .catch(() => draftsLoaded.delete(workspaceId))
  }, [workspaceId])
  useTeamChatEvents(workspaceId, (event) => {
    if (event.type === 'draft.changed') setDraftLocal(draftKey(event.draft.conversationId, event.draft.threadRootId), event.draft.text)
  })
}

export function useHasDraft(conversationId: string): boolean {
  return useSyncExternalStore(drafts.subscribe, () => drafts.get().has(draftKey(conversationId)), () => false)
}

/**
 * The stored draft for a composer (in mention-token form) and a debounced
 * saver. Saving an empty string clears it everywhere.
 */
export function useDraft(conversationId: string, threadRootId?: string | null) {
  const key = draftKey(conversationId, threadRootId)
  const stored = useSyncExternalStore(drafts.subscribe, () => drafts.get().get(key) ?? '', () => '')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<{ key: string; conversationId: string; threadRootId: string | null; text: string } | null>(null)

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const p = pending.current
    pending.current = null
    if (p) void api.putDraft(p.conversationId, p.text, p.threadRootId).catch(() => {})
  }, [])

  useEffect(() => flush, [key, flush])

  const save = useCallback((text: string, opts: { immediate?: boolean } = {}) => {
    setDraftLocal(key, text)
    pending.current = { key, conversationId, threadRootId: threadRootId ?? null, text }
    if (timer.current) clearTimeout(timer.current)
    if (opts.immediate) flush()
    else timer.current = setTimeout(flush, DRAFT_SAVE_MS)
  }, [key, conversationId, threadRootId, flush])

  return { stored, save }
}

// ─── Later: saved, reminders, scheduled ─────────────────────────────────────

export function useLater(workspaceId: string | null | undefined) {
  const [saved, setSaved] = useState<SavedItem[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [scheduled, setScheduled] = useState<ScheduledMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const [s, r, sc] = await Promise.all([api.saved(workspaceId), api.reminders(workspaceId), api.scheduled(workspaceId)])
      setSaved(s)
      setReminders(r)
      setScheduled(sc)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { void refresh() }, [refresh])
  useTeamChatEvents(workspaceId, (event) => {
    if (event.type === 'saved.changed' || event.type === 'scheduled.failed' || (event.type === 'inbox.created' && event.item.kind === 'reminder')) {
      void refresh()
    }
  })

  return {
    saved, reminders, scheduled, loading, error, refresh,
    async unsave(messageId: string) {
      setSaved((list) => list.filter((i) => i.message.id !== messageId))
      await toggleSaved(messageId, false).catch(() => refresh())
    },
    async completeReminder(id: string) {
      setReminders((list) => list.filter((r) => r.id !== id))
      await api.updateReminder(id, { status: 'done' }).catch(() => refresh())
    },
    async snoozeReminder(id: string, remindAt: string) {
      const next = await api.updateReminder(id, { remindAt }).catch(() => null)
      if (next) setReminders((list) => list.map((r) => (r.id === id ? next : r)).sort((a, b) => a.remindAt.localeCompare(b.remindAt)))
    },
    async cancelScheduled(id: string) {
      setScheduled((list) => list.filter((s) => s.id !== id))
      await api.cancelScheduled(id).catch(() => refresh())
    },
    async reschedule(id: string, sendAt: string) {
      const next = await api.updateScheduled(id, { sendAt })
      setScheduled((list) => list.map((s) => (s.id === id ? next : s)).sort((a, b) => a.sendAt.localeCompare(b.sendAt)))
    },
  }
}
