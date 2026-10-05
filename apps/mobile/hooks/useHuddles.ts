// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live huddles in a workspace, keyed by conversation. Loaded once per
 * (re)connect and kept current by `huddle.updated` events, so banners and
 * header buttons agree without each fetching on its own.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { teamChatApi, type Huddle, type TeamChatEvent } from '../lib/team-chat-api'
import { useTeamChatEvents } from '../lib/team-chat-connection'

interface WorkspaceHuddles {
  enabled: boolean | null
  byConversation: Map<string, Huddle>
}

const workspaces = new Map<string, WorkspaceHuddles>()
const inflight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
const taps = new Set<(event: TeamChatEvent) => void>()
let lastTapped: TeamChatEvent | null = null
let version = 0

/** Hear every huddle event from workspaces whose huddles are on screen, once each. */
export function tapHuddleEvents(fn: (event: TeamChatEvent) => void): () => void {
  taps.add(fn)
  return () => taps.delete(fn)
}

function emit() {
  version++
  listeners.forEach((l) => l())
}

function entry(workspaceId: string): WorkspaceHuddles {
  let ws = workspaces.get(workspaceId)
  if (!ws) {
    ws = { enabled: null, byConversation: new Map() }
    workspaces.set(workspaceId, ws)
  }
  return ws
}

/** Record a conversation's huddle (null when none is live). */
export function setConversationHuddle(workspaceId: string, conversationId: string, huddle: Huddle | null): void {
  const ws = entry(workspaceId)
  if (huddle && huddle.participants.length) ws.byConversation.set(conversationId, huddle)
  else ws.byConversation.delete(conversationId)
  emit()
}

export function getConversationHuddle(workspaceId: string, conversationId: string): Huddle | null {
  return workspaces.get(workspaceId)?.byConversation.get(conversationId) ?? null
}

export function applyHuddleEvent(workspaceId: string, event: TeamChatEvent): void {
  if (event.type !== 'huddle.updated') return
  setConversationHuddle(workspaceId, event.conversationId, event.huddle)
}

function refresh(workspaceId: string): Promise<void> {
  const running = inflight.get(workspaceId)
  if (running) return running
  const p = Promise.resolve()
    .then(() => teamChatApi().huddles(workspaceId))
    .then(({ enabled, huddles }) => {
      const ws = entry(workspaceId)
      ws.enabled = enabled
      ws.byConversation = new Map(huddles.filter((h) => h.participants.length).map((h) => [h.conversationId, h]))
      emit()
    })
    .catch(() => {})
    .finally(() => inflight.delete(workspaceId))
  inflight.set(workspaceId, p)
  return p
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function useWorkspaceHuddles(workspaceId: string | null | undefined): WorkspaceHuddles | null {
  useEffect(() => {
    if (workspaceId && entry(workspaceId).enabled === null) void refresh(workspaceId)
  }, [workspaceId])
  useTeamChatEvents(workspaceId, (event) => {
    if (!workspaceId) return
    if (event.type === 'ready') void refresh(workspaceId)
    else applyHuddleEvent(workspaceId, event)
    if (event.type.startsWith('huddle.') && event !== lastTapped) {
      lastTapped = event
      taps.forEach((tap) => tap(event))
    }
  })
  useSyncExternalStore(subscribe, () => version, () => version)
  return workspaceId ? entry(workspaceId) : null
}

/** Whether this server has huddles set up (null until known) and the conversation's live huddle. */
export function useConversationHuddle(
  workspaceId: string | null | undefined,
  conversationId: string | null | undefined,
): { enabled: boolean | null; huddle: Huddle | null } {
  const ws = useWorkspaceHuddles(workspaceId)
  return {
    enabled: ws?.enabled ?? null,
    huddle: (conversationId && ws?.byConversation.get(conversationId)) || null,
  }
}

/** Every live huddle the person can see, for sidebar indicators. */
export function useActiveHuddles(workspaceId: string | null | undefined): Huddle[] {
  const ws = useWorkspaceHuddles(workspaceId)
  return ws ? [...ws.byConversation.values()] : []
}

export function _resetHuddlesForTests(): void {
  workspaces.clear()
  inflight.clear()
  emit()
}
