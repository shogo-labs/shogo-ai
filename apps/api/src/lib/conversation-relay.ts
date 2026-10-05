// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-region relay for workspace chat realtime events.
 *
 * `conversation-bus` fans events out over Redis, and every region has its own
 * Redis, so a person whose socket landed in a region other than the
 * workspace's home region would otherwise never see new messages, agent
 * replies, typing or presence. This module forwards every locally published
 * envelope (plus presence refreshes) to each sibling region over the signed
 * `/api/internal/conversation-bus/relay` call, which re-delivers them to that
 * region's sockets without relaying again.
 *
 * Delivery is best effort and batched: clients already backfill missed
 * messages over REST after a reconnect, so a dropped batch costs a stale
 * typing indicator at worst, never a lost message.
 *
 * Installed once at server start; a no-op in single-region / local mode.
 */

import { RAW_REGION_ID, REGION_PEERS, isMultiRegionActive } from './region'
import { callPeerInternal } from './region-peer-proxy'
import { setConversationRelaySink, type ConversationEnvelope } from './conversation-bus'
import { setPresenceRelaySink, type RelayedPresence } from '../services/conversation-presence'

export const RELAY_PATH = '/api/internal/conversation-bus/relay'

export interface RelayBatch {
  envelopes: ConversationEnvelope[]
  presence: RelayedPresence[]
}

/** Flush cadence. Short enough that typing and streamed replies feel live. */
const FLUSH_INTERVAL_MS = 100
/** Most items sent in one call. */
const MAX_BATCH = 200
/** Most items held per peer while it is slow; beyond this, oldest typing goes first. */
const MAX_QUEUE = 2000

interface PeerQueue {
  envelopes: ConversationEnvelope[]
  presence: Map<string, RelayedPresence>
  inFlight: boolean
  lastWarnAt: number
}

const queues = new Map<string, PeerQueue>()
let timer: ReturnType<typeof setInterval> | null = null

function queueFor(peerId: string): PeerQueue {
  let q = queues.get(peerId)
  if (!q) {
    q = { envelopes: [], presence: new Map(), inFlight: false, lastWarnAt: 0 }
    queues.set(peerId, q)
  }
  return q
}

/** Drop the oldest typing events first, then the oldest of anything, until the queue fits. */
function shed(q: PeerQueue): void {
  while (q.envelopes.length + q.presence.size > MAX_QUEUE) {
    const typing = q.envelopes.findIndex((e) => e.event.type === 'typing')
    if (typing >= 0) q.envelopes.splice(typing, 1)
    else if (q.envelopes.length) q.envelopes.shift()
    else {
      const oldest = q.presence.keys().next().value
      if (oldest === undefined) return
      q.presence.delete(oldest)
    }
  }
}

function enqueueEnvelope(envelope: ConversationEnvelope): void {
  for (const peer of REGION_PEERS) {
    const q = queueFor(peer.id)
    q.envelopes.push(envelope)
    shed(q)
  }
}

function enqueuePresence(entry: RelayedPresence): void {
  for (const peer of REGION_PEERS) {
    const q = queueFor(peer.id)
    // Only the latest state per person matters.
    const k = `${entry.workspaceId}:${entry.userId}`
    q.presence.delete(k)
    q.presence.set(k, entry)
    shed(q)
  }
}

async function flushPeer(peerId: string): Promise<void> {
  const q = queues.get(peerId)
  if (!q || q.inFlight || (!q.envelopes.length && !q.presence.size)) return
  const envelopes = q.envelopes.splice(0, MAX_BATCH)
  const presence: RelayedPresence[] = []
  for (const [k, entry] of q.presence) {
    if (envelopes.length + presence.length >= MAX_BATCH) break
    presence.push(entry)
    q.presence.delete(k)
  }
  q.inFlight = true
  try {
    const res = await callPeerInternal(peerId, RELAY_PATH, { envelopes, presence } satisfies RelayBatch)
    if (!res.ok) throw new Error(`peer answered ${res.status}`)
  } catch (err) {
    // Best effort: drop the batch rather than build an unbounded backlog.
    if (Date.now() - q.lastWarnAt > 30_000) {
      q.lastWarnAt = Date.now()
      console.warn(`[ConversationRelay] dropped ${envelopes.length + presence.length} item(s) for ${peerId}:`, (err as Error).message)
    }
  } finally {
    q.inFlight = false
  }
}

/** Send whatever is queued now. Exposed for tests; the timer calls it. */
export async function flushConversationRelay(): Promise<void> {
  await Promise.all(REGION_PEERS.map((peer) => flushPeer(peer.id)))
}

/** Start forwarding to sibling regions. Returns a stop function; no-op outside multi-region mode. */
export function startConversationRelay(): () => void {
  if (!isMultiRegionActive() || !RAW_REGION_ID) return stopConversationRelay
  if (timer) return stopConversationRelay
  setConversationRelaySink(enqueueEnvelope)
  setPresenceRelaySink(enqueuePresence)
  timer = setInterval(() => void flushConversationRelay(), FLUSH_INTERVAL_MS)
  ;(timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  return stopConversationRelay
}

export function stopConversationRelay(): void {
  if (timer) clearInterval(timer)
  timer = null
  setConversationRelaySink(null)
  setPresenceRelaySink(null)
  queues.clear()
}

/** Test hook: install the sinks without the timer, so tests drive `flushConversationRelay` directly. */
export function _installConversationRelayForTests(): void {
  setConversationRelaySink(enqueueEnvelope)
  setPresenceRelaySink(enqueuePresence)
}
