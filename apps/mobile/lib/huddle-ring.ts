// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Incoming huddle calls: someone started a huddle in a DM with you. A ring
 * lasts until you answer or decline (here or on another device), the huddle
 * ends, or it times out.
 */
import { useSyncExternalStore } from 'react'
import type { ActiveHuddle, ConversationKind, TeamChatEvent } from './team-chat-api'
import { teamChatApi } from './team-chat-api'
import { joinHuddleCall } from './huddle-call'

export const RING_TIMEOUT_MS = 45_000

export interface IncomingRing {
  conversationId: string
  workspaceId: string
  huddleId: string
  kind: ConversationKind
  from: { userId: string; name: string; image: string | null }
  at: number
}

let rings: IncomingRing[] = []
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** Huddles already rung here (answered, declined, or timed out), so catching up never rings them twice. */
const settled = new Set<string>()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getRings(): IncomingRing[] {
  return rings
}

export function useIncomingRings(): IncomingRing[] {
  return useSyncExternalStore(subscribe, getRings, getRings)
}

export function dismissRing(conversationId: string): void {
  const timer = timers.get(conversationId)
  if (timer) clearTimeout(timer)
  timers.delete(conversationId)
  const ring = rings.find((r) => r.conversationId === conversationId)
  if (!ring) return
  settled.add(ring.huddleId)
  rings = rings.filter((r) => r.conversationId !== conversationId)
  emit()
}

function startRing(ring: IncomingRing, remainingMs: number): void {
  if (settled.has(ring.huddleId) || rings.some((r) => r.huddleId === ring.huddleId)) return
  dismissRing(ring.conversationId)
  rings = [...rings, ring]
  timers.set(ring.conversationId, setTimeout(() => dismissRing(ring.conversationId), remainingMs))
  emit()
}

/**
 * Catch up after (re)connecting: ring for DM huddles that started moments ago
 * without you, whose ring event this app missed.
 */
export function restoreRings(workspaceId: string, huddles: ActiveHuddle[], me: string | null): void {
  const now = Date.now()
  for (const huddle of huddles) {
    if (!huddle.ringing || huddle.startedById === me) continue
    const from = huddle.participants.find((p) => p.userId === huddle.startedById)
    if (!from) continue
    const remaining = RING_TIMEOUT_MS - (now - new Date(huddle.startedAt).getTime())
    if (remaining <= 0) continue
    startRing(
      {
        conversationId: huddle.conversationId,
        workspaceId,
        huddleId: huddle.id,
        kind: huddle.conversationKind,
        from: { userId: from.userId, name: from.name, image: from.image },
        at: now,
      },
      remaining,
    )
  }
}

/** Feed realtime events in; `me` is the signed-in user. */
export function applyRingEvent(workspaceId: string, event: TeamChatEvent, me: string | null): void {
  if (event.type === 'huddle.ring') {
    if (event.from.userId === me) return
    startRing(
      { conversationId: event.conversationId, workspaceId, huddleId: event.huddleId, kind: event.conversationKind, from: event.from, at: Date.now() },
      RING_TIMEOUT_MS,
    )
    return
  }
  const ring = 'conversationId' in event ? rings.find((r) => r.conversationId === event.conversationId) : undefined
  if (!ring) return
  if (event.type === 'huddle.declined' && event.userId === me) dismissRing(ring.conversationId)
  if (event.type === 'huddle.updated') {
    const huddle = event.huddle
    if (!huddle || huddle.id !== ring.huddleId || huddle.participants.some((p) => p.userId === me)) dismissRing(ring.conversationId)
  }
}

export function answerRing(ring: IncomingRing, label: string): Promise<void> {
  dismissRing(ring.conversationId)
  return joinHuddleCall({ conversationId: ring.conversationId, workspaceId: ring.workspaceId, label, kind: ring.kind })
}

export async function declineRing(ring: IncomingRing): Promise<void> {
  dismissRing(ring.conversationId)
  await teamChatApi().declineHuddle(ring.conversationId).catch(() => {})
}

export function _resetRingsForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  settled.clear()
  rings = []
  emit()
}
