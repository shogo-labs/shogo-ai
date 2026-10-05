// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-pod fanout through a real Redis. Opt-in:
 *   CONVERSATION_BUS_REDIS_URL=redis://localhost:6379 bun test conversation-bus.redis
 */

import { afterAll, describe, expect, test } from 'bun:test'
import Redis from 'ioredis'
import {
  _conversationBusSubscribedWorkspaces,
  _resetConversationBusForTests,
  publishConversationEvent,
  subscribeWorkspaceEvents,
  type ConversationEnvelope,
} from '../conversation-bus'
import { getPodId } from '../tunnel-redis'

const url = process.env.CONVERSATION_BUS_REDIS_URL

describe.skipIf(!url)('conversation bus over Redis', () => {
  const pub = url ? new Redis(url) : null
  const otherPod = url ? new Redis(url) : null

  afterAll(async () => {
    await _resetConversationBusForTests(undefined)
    pub?.disconnect()
    otherPod?.disconnect()
  })

  test('delivers events published by other pods and ignores our own echo', async () => {
    await _resetConversationBusForTests(pub)
    const ws = `ws-${crypto.randomUUID()}`
    const got: ConversationEnvelope[] = []
    const unsubscribe = subscribeWorkspaceEvents(ws, (e) => got.push(e))

    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const [, count] = (await otherPod!.pubsub('NUMSUB', `conv:ws:${ws}`)) as [string, number]
      if (Number(count) > 0) break
      await new Promise((r) => setTimeout(r, 20))
    }

    publishConversationEvent(ws, { type: 'local.one' })
    const remote: ConversationEnvelope = {
      workspaceId: ws, event: { type: 'remote.one' }, audience: ['u1'], origin: `other-${getPodId()}`,
    }
    await otherPod!.publish(`conv:ws:${ws}`, JSON.stringify(remote))
    await new Promise((r) => setTimeout(r, 200))

    expect(got.map((e) => e.event.type)).toEqual(['local.one', 'remote.one'])
    expect(got[1].audience).toEqual(['u1'])

    unsubscribe()
    expect(_conversationBusSubscribedWorkspaces()).not.toContain(ws)
    await otherPod!.publish(`conv:ws:${ws}`, JSON.stringify({ ...remote, event: { type: 'late' } }))
    await new Promise((r) => setTimeout(r, 100))
    expect(got).toHaveLength(2)
  })
})
