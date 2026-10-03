// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace-scoped fanout for channel events (messages, reactions, agent
 * streaming, typing, presence).
 *
 * Events are delivered to local listeners immediately and, when Redis is
 * available, published on `conv:ws:<workspaceId>` so realtime sockets held by
 * other API pods receive them too. Each pod subscribes only to workspaces it
 * currently has listeners for. Desktop/local mode has no Redis and stays
 * in-process.
 */

import { EventEmitter } from 'events'
import type Redis from 'ioredis'
import { getPodId, getSharedRedis, whenReady } from './tunnel-redis'

export type ConversationEvent = { type: string; conversationId?: string; [key: string]: unknown }

export interface ConversationEnvelope {
  workspaceId: string
  event: ConversationEvent
  /** User ids allowed to receive the event; null means every workspace member. */
  audience: string[] | null
  origin: string
}

export type ConversationListener = (envelope: ConversationEnvelope) => void

const CHANNEL_PREFIX = 'conv:ws:'

const local = new EventEmitter()
local.setMaxListeners(0)

const refCounts = new Map<string, number>()
let publisherOverride: Pick<Redis, 'publish'> | null | undefined
let subscriber: Redis | null = null
let subscriberPromise: Promise<Redis | null> | null = null

function channelFor(workspaceId: string): string {
  return `${CHANNEL_PREFIX}${workspaceId}`
}

function publisher(): Pick<Redis, 'publish'> | null {
  return publisherOverride !== undefined ? publisherOverride : getSharedRedis()
}

function handleRedisMessage(channel: string, raw: string): void {
  if (!channel.startsWith(CHANNEL_PREFIX)) return
  let envelope: ConversationEnvelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    return
  }
  if (envelope.origin === getPodId()) return
  local.emit(envelope.workspaceId, envelope)
}

async function ensureSubscriber(): Promise<Redis | null> {
  if (subscriber) return subscriber
  if (subscriberPromise) return subscriberPromise
  subscriberPromise = (async () => {
    if (publisherOverride === undefined) await whenReady().catch(() => {})
    const pub = publisher() as Redis | null
    if (!pub || typeof (pub as any).duplicate !== 'function') return null
    const sub = pub.duplicate()
    sub.on('error', (err) => console.error('[ConversationBus] subscriber error:', err.message))
    sub.on('message', handleRedisMessage)
    subscriber = sub
    const workspaces = Array.from(refCounts.keys())
    if (workspaces.length) await sub.subscribe(...workspaces.map(channelFor))
    return sub
  })().finally(() => {
    subscriberPromise = null
  })
  return subscriberPromise
}

function retain(workspaceId: string): void {
  const next = (refCounts.get(workspaceId) ?? 0) + 1
  refCounts.set(workspaceId, next)
  if (next !== 1) return
  if (subscriber) {
    subscriber.subscribe(channelFor(workspaceId)).catch((err) => {
      console.error('[ConversationBus] subscribe failed:', err.message)
    })
  } else {
    void ensureSubscriber()
  }
}

function release(workspaceId: string): void {
  const next = (refCounts.get(workspaceId) ?? 0) - 1
  if (next > 0) {
    refCounts.set(workspaceId, next)
    return
  }
  refCounts.delete(workspaceId)
  subscriber?.unsubscribe(channelFor(workspaceId)).catch(() => {})
}

export function publishConversationEvent(
  workspaceId: string,
  event: ConversationEvent,
  audience: string[] | null = null,
): void {
  const envelope: ConversationEnvelope = { workspaceId, event, audience, origin: getPodId() }
  local.emit(workspaceId, envelope)
  const pub = publisher()
  if (!pub) return
  pub.publish(channelFor(workspaceId), JSON.stringify(envelope)).catch((err: Error) => {
    console.error('[ConversationBus] publish failed:', err.message)
  })
}

export function subscribeWorkspaceEvents(workspaceId: string, listener: ConversationListener): () => void {
  local.on(workspaceId, listener)
  retain(workspaceId)
  let active = true
  return () => {
    if (!active) return
    active = false
    local.off(workspaceId, listener)
    release(workspaceId)
  }
}

export function canReceive(envelope: ConversationEnvelope, userId: string): boolean {
  return envelope.audience === null || envelope.audience.includes(userId)
}

/** Test hook: swap the Redis publisher (null forces in-process only). */
export async function _resetConversationBusForTests(pub?: Pick<Redis, 'publish'> | null): Promise<void> {
  local.removeAllListeners()
  refCounts.clear()
  try { subscriber?.disconnect() } catch {}
  subscriber = null
  subscriberPromise = null
  publisherOverride = pub
}

export function _conversationBusSubscribedWorkspaces(): string[] {
  return Array.from(refCounts.keys())
}
