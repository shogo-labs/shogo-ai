// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fanout for a recording's live transcript.
 *
 * The API pod holding the recorder's audio socket publishes partial and final
 * text; viewers (SSE streams) may be connected to any pod. Events go to local
 * listeners immediately and, when Redis is available, are published on
 * `meeting:live:<meetingId>` for the other pods. Desktop/local mode has no
 * Redis and stays in-process. Each pod subscribes only to meetings it has
 * viewers for.
 */

import { EventEmitter } from 'events'
import type Redis from 'ioredis'
import { getPodId, getSharedRedis, whenReady } from './tunnel-redis'

export type MeetingLiveEvent =
  | { type: 'partial'; itemId: string; text: string; start: number }
  | { type: 'final'; itemId: string; segment: { start: number; end: number; text: string } }
  | { type: 'status'; state: 'ok' | 'error'; message?: string }
  | { type: 'done' }

interface Envelope {
  meetingId: string
  event: MeetingLiveEvent
  origin: string
}

const CHANNEL_PREFIX = 'meeting:live:'

const local = new EventEmitter()
local.setMaxListeners(0)

const refCounts = new Map<string, number>()
let publisherOverride: Pick<Redis, 'publish'> | null | undefined
let subscriber: Redis | null = null
let subscriberPromise: Promise<Redis | null> | null = null

const channelFor = (meetingId: string) => `${CHANNEL_PREFIX}${meetingId}`

function publisher(): Pick<Redis, 'publish'> | null {
  return publisherOverride !== undefined ? publisherOverride : getSharedRedis()
}

function handleRedisMessage(channel: string, raw: string): void {
  if (!channel.startsWith(CHANNEL_PREFIX)) return
  let envelope: Envelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    return
  }
  if (envelope.origin === getPodId()) return
  local.emit(envelope.meetingId, envelope.event)
}

async function ensureSubscriber(): Promise<Redis | null> {
  if (subscriber) return subscriber
  if (subscriberPromise) return subscriberPromise
  subscriberPromise = (async () => {
    if (publisherOverride === undefined) await whenReady().catch(() => {})
    const pub = publisher() as Redis | null
    if (!pub || typeof (pub as any).duplicate !== 'function') return null
    const sub = pub.duplicate()
    sub.on('error', (err) => console.error('[MeetingLiveBus] subscriber error:', err.message))
    sub.on('message', handleRedisMessage)
    subscriber = sub
    const ids = Array.from(refCounts.keys())
    if (ids.length) await sub.subscribe(...ids.map(channelFor))
    return sub
  })().finally(() => {
    subscriberPromise = null
  })
  return subscriberPromise
}

function retain(meetingId: string): void {
  const next = (refCounts.get(meetingId) ?? 0) + 1
  refCounts.set(meetingId, next)
  if (next !== 1) return
  if (subscriber) {
    subscriber.subscribe(channelFor(meetingId)).catch((err) => {
      console.error('[MeetingLiveBus] subscribe failed:', err.message)
    })
  } else {
    void ensureSubscriber()
  }
}

function release(meetingId: string): void {
  const next = (refCounts.get(meetingId) ?? 0) - 1
  if (next > 0) {
    refCounts.set(meetingId, next)
    return
  }
  refCounts.delete(meetingId)
  subscriber?.unsubscribe(channelFor(meetingId)).catch(() => {})
}

export function publishMeetingLive(meetingId: string, event: MeetingLiveEvent): void {
  local.emit(meetingId, event)
  const pub = publisher()
  if (!pub) return
  const envelope: Envelope = { meetingId, event, origin: getPodId() }
  pub.publish(channelFor(meetingId), JSON.stringify(envelope)).catch((err: Error) => {
    console.error('[MeetingLiveBus] publish failed:', err.message)
  })
}

export function subscribeMeetingLive(meetingId: string, listener: (event: MeetingLiveEvent) => void): () => void {
  local.on(meetingId, listener)
  retain(meetingId)
  let active = true
  return () => {
    if (!active) return
    active = false
    local.off(meetingId, listener)
    release(meetingId)
  }
}

/** Test hook: swap the Redis publisher (null forces in-process only). */
export async function _resetMeetingLiveBusForTests(pub?: Pick<Redis, 'publish'> | null): Promise<void> {
  local.removeAllListeners()
  refCounts.clear()
  try { subscriber?.disconnect() } catch {}
  subscriber = null
  subscriberPromise = null
  publisherOverride = pub
}
