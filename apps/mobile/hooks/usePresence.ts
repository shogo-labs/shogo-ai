// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who's online in a workspace, and who is in a huddle. Only people currently
 * on screen are fetched: each `usePresence`/`useInHuddle` call registers
 * interest, the store loads those ids in one batch that carries both, and live
 * `presence` / `huddle.presence` events keep them current. Watched ids are
 * refetched after a reconnect and every minute, since a server that dies lets
 * heartbeats lapse without sending "offline".
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { teamChatApi, type PresenceStatus } from '../lib/team-chat-api'
import { useTeamChatEvents } from '../lib/team-chat-connection'

const REFRESH_MS = 60_000
const BATCH_DELAY_MS = 50

const statuses = new Map<string, PresenceStatus>()
const huddles = new Map<string, boolean>()
const watched = new Map<string, Map<string, number>>()
const queued = new Map<string, Set<string>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
let version = 0
let feedWorkspaceId: string | null = null

const key = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`

function emit() {
  version++
  listeners.forEach((l) => l())
}

function apply(workspaceId: string, next: Record<string, PresenceStatus>) {
  let changed = false
  for (const [userId, status] of Object.entries(next)) {
    const k = key(workspaceId, userId)
    if (statuses.get(k) !== status) {
      statuses.set(k, status)
      changed = true
    }
  }
  if (changed) emit()
}

/** One person's huddle state, from a live event. */
function applyHuddle(workspaceId: string, userId: string, inHuddle: boolean) {
  const k = key(workspaceId, userId)
  if (huddles.get(k) === inHuddle) return
  huddles.set(k, inHuddle)
  emit()
}

/**
 * A whole batch's worth, where the response names only the ids that are in a
 * huddle — everyone else in the batch is explicitly not, which is what clears
 * a badge whose huddle ended while we weren't listening.
 */
function applyHuddleBatch(workspaceId: string, inHuddle: string[], batch: string[]) {
  const notIn = new Set(batch)
  for (const userId of inHuddle) {
    notIn.delete(userId)
    applyHuddle(workspaceId, userId, true)
  }
  for (const userId of notIn) applyHuddle(workspaceId, userId, false)
}

function load(workspaceId: string, userIds: string[]) {
  const ids = (queued.get(workspaceId) ?? new Set<string>())
  userIds.forEach((id) => ids.add(id))
  queued.set(workspaceId, ids)
  if (timers.has(workspaceId)) return
  timers.set(
    workspaceId,
    setTimeout(() => {
      timers.delete(workspaceId)
      const batch = [...(queued.get(workspaceId) ?? [])]
      queued.delete(workspaceId)
      if (!batch.length) return
      Promise.resolve()
        .then(() => teamChatApi().presence(workspaceId, batch))
        .then((result) => {
          apply(workspaceId, result.presence)
          applyHuddleBatch(workspaceId, result.huddle, batch)
        })
        .catch(() => {})
    }, BATCH_DELAY_MS),
  )
}

function watch(workspaceId: string, userId: string): () => void {
  const counts = watched.get(workspaceId) ?? new Map<string, number>()
  watched.set(workspaceId, counts)
  const n = counts.get(userId) ?? 0
  counts.set(userId, n + 1)
  if (n === 0 && !statuses.has(key(workspaceId, userId))) load(workspaceId, [userId])
  return () => {
    const left = (counts.get(userId) ?? 1) - 1
    if (left > 0) counts.set(userId, left)
    else counts.delete(userId)
  }
}

const lastRefresh = new Map<string, number>()

/** Several feeds may be mounted (sidebar and conversation screen); refresh once. */
function refreshWatched(workspaceId: string, force = false) {
  const now = Date.now()
  if (!force && now - (lastRefresh.get(workspaceId) ?? 0) < REFRESH_MS / 2) return
  lastRefresh.set(workspaceId, now)
  const ids = [...(watched.get(workspaceId)?.keys() ?? [])]
  if (ids.length) load(workspaceId, ids)
}

/** Keeps presence live for a workspace; mount once per workspace view. */
export function usePresenceFeed(workspaceId: string | null | undefined): void {
  useEffect(() => {
    if (workspaceId && feedWorkspaceId !== workspaceId) {
      feedWorkspaceId = workspaceId
      emit()
    }
  }, [workspaceId])
  const state = useTeamChatEvents(workspaceId, (event) => {
    if (!workspaceId) return
    if (event.type === 'presence') apply(workspaceId, { [event.userId]: event.status })
    else if (event.type === 'huddle.presence') applyHuddle(workspaceId, event.userId, event.inHuddle)
  })
  const wasOpen = useRef(false)
  useEffect(() => {
    if (!workspaceId) return
    if (state === 'open' && !wasOpen.current) refreshWatched(workspaceId, true)
    wasOpen.current = state === 'open'
  }, [workspaceId, state])
  useEffect(() => {
    if (!workspaceId) return
    const timer = setInterval(() => refreshWatched(workspaceId), REFRESH_MS)
    return () => clearInterval(timer)
  }, [workspaceId])
}

/** A person's presence; omit the workspace to use the one whose feed is mounted. */
export function usePresence(workspaceId: string | null | undefined, userId: string | null | undefined): PresenceStatus | null {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
    () => version,
  )
  const ws = workspaceId === undefined ? feedWorkspaceId : workspaceId
  useEffect(() => {
    if (!ws || !userId) return
    return watch(ws, userId)
  }, [ws, userId])
  if (!ws || !userId) return null
  return statuses.get(key(ws, userId)) ?? null
}

/** Whether this person is in a huddle right now, for the badge beside their name. */
export function useInHuddle(workspaceId: string | null | undefined, userId: string | null | undefined): boolean {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
    () => version,
  )
  const ws = workspaceId === undefined ? feedWorkspaceId : workspaceId
  useEffect(() => {
    if (!ws || !userId) return
    return watch(ws, userId)
  }, [ws, userId])
  if (!ws || !userId) return false
  return huddles.get(key(ws, userId)) ?? false
}

export function _resetPresenceForTests(): void {
  statuses.clear()
  huddles.clear()
  watched.clear()
  queued.clear()
  timers.forEach((t) => clearTimeout(t))
  timers.clear()
  lastRefresh.clear()
  feedWorkspaceId = null
  version++
}
