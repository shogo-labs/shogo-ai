// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace presence driven by realtime socket heartbeats. A user is active
 * while any of their sockets heartbeats; entries expire on their own so a
 * crashed pod never leaves someone stuck online.
 */

import { getPodId, getSharedRedis } from '../lib/tunnel-redis'
import { publishConversationEvent } from '../lib/conversation-bus'

export type PresenceStatus = 'active' | 'away' | 'offline'

const TTL_SECONDS = 75
const localSockets = new Map<string, number>()
const memory = new Map<string, { status: PresenceStatus; expiresAt: number; pod: string }>()
const lastPublished = new Map<string, PresenceStatus>()

const key = (workspaceId: string, userId: string) => `presence:${workspaceId}:${userId}`

function localKey(workspaceId: string, userId: string) {
  return `${workspaceId}:${userId}`
}

async function write(workspaceId: string, userId: string, status: PresenceStatus): Promise<void> {
  const redis = getSharedRedis()
  const k = key(workspaceId, userId)
  if (status === 'offline') {
    if (redis) {
      const current = await redis.get(k).catch(() => null)
      if (current && current.split('|')[1] === getPodId()) await redis.del(k).catch(() => {})
    }
    memory.delete(k)
    return
  }
  if (redis) await redis.set(k, `${status}|${getPodId()}`, 'EX', TTL_SECONDS).catch(() => {})
  memory.set(k, { status, expiresAt: Date.now() + TTL_SECONDS * 1000, pod: getPodId() })
}

/**
 * Called on socket open (active), heartbeat (active/away), and close
 * (offline). Close only goes offline when this pod has no other socket for
 * the user.
 */
export async function recordPresence(workspaceId: string, userId: string, status: PresenceStatus): Promise<void> {
  const lk = localKey(workspaceId, userId)
  if (status === 'offline') {
    const remaining = Math.max(0, (localSockets.get(lk) ?? 1) - 1)
    if (remaining > 0) {
      localSockets.set(lk, remaining)
      return
    }
    localSockets.delete(lk)
  }
  await write(workspaceId, userId, status)
  if (lastPublished.get(lk) !== status) {
    lastPublished.set(lk, status)
    publishConversationEvent(workspaceId, { type: 'presence', userId, status })
  }
  if (status === 'offline') lastPublished.delete(lk)
}

/** Track one more socket for a user (paired with recordPresence(..., 'offline') on close). */
export function registerPresenceSocket(workspaceId: string, userId: string): void {
  const lk = localKey(workspaceId, userId)
  localSockets.set(lk, (localSockets.get(lk) ?? 0) + 1)
}

export async function getPresence(workspaceId: string, userIds: string[]): Promise<Record<string, PresenceStatus>> {
  const result: Record<string, PresenceStatus> = {}
  const redis = getSharedRedis()
  if (redis && userIds.length) {
    const values = await redis.mget(...userIds.map((id) => key(workspaceId, id))).catch(() => null)
    if (values) {
      userIds.forEach((id, i) => {
        result[id] = (values[i]?.split('|')[0] as PresenceStatus) || 'offline'
      })
      return result
    }
  }
  for (const id of userIds) {
    const entry = memory.get(key(workspaceId, id))
    result[id] = entry && entry.expiresAt > Date.now() ? entry.status : 'offline'
  }
  return result
}

export function _resetPresenceForTests(): void {
  localSockets.clear()
  memory.clear()
  lastPublished.clear()
}
