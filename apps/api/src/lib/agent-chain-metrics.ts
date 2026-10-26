// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Counting the agent-chain backstop.
 *
 * A chain pause is rare, correct, and invisible: the only trace was a system
 * note in the thread, so nobody could answer "how often does each limit fire?"
 * without reading every workspace's messages. Every pause now bumps one
 * counter (`agent_chain.paused`, labelled by which limit) and writes one
 * structured log line carrying the ids.
 *
 * Only `limit` goes on the metric: conversation/thread ids are unbounded
 * cardinality and belong in the log line, which both surfaces ship (the cloud
 * API through its stdout → OTel pipeline, the desktop through
 * `apps/desktop/src/signoz-log-exporter.ts`).
 */

import { metrics } from '@opentelemetry/api'
import type { ChainLimit } from '../services/conversation-agent-chain'

const meter = metrics.getMeter('shogo-api-chat')

const pausedCounter = meter.createCounter('agent_chain.paused', {
  description:
    'Agent @mention chains stopped by a backstop limit, labelled by which limit tripped ' +
    '(thread_turns | depth | ping_pong). A pause posts a note in the thread and waits for a human reply.',
})

export interface ChainPausedRecord {
  /** Which limit tripped. */
  limit: ChainLimit
  /** Agent turns in the thread when it paused. */
  turns: number
  /** Chain depth when it paused. */
  depth: number
  /** The configured ceiling for `limit`. */
  max: number
  workspaceId?: string | null
  conversationId?: string | null
  threadRootId?: string | null
}

/** One pause: one counter increment plus one log line. Never throws. */
export function recordChainPaused(record: ChainPausedRecord): void {
  pausedCounter.add(1, { limit: record.limit })
  console.info('[ChannelAgent] chain paused', {
    limit: record.limit,
    turns: record.turns,
    depth: record.depth,
    max: record.max,
    workspaceId: record.workspaceId,
    conversationId: record.conversationId,
    threadRootId: record.threadRootId,
  })
}
