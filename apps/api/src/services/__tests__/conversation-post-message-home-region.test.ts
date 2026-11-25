// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A team-chat message is inserted only in its conversation's home region
 * (SHO-585 §C).
 *
 * The guard lives at the single insert point, not in the ~40 callers: the rows
 * that split Odin's EU channel came from a system mention post and an agent
 * reply — background paths no HTTP router ever sees. A forwarding region must
 * not bump `lastSeq`, insert a row, or run mentions/wakes locally; it returns
 * the home region's message instead. An unreachable home region is a retryable
 * 503, never a local write.
 *
 *   bun test apps/api/src/services/__tests__/conversation-post-message-home-region.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// --- fakes -----------------------------------------------------------------
const CONVERSATION = { id: 'conv_1', workspaceId: 'ws_eu', provider: 'shogo', kind: 'public', lastSeq: 4 }
const localWrites = { seqBump: 0, insert: 0, publish: 0, memberTouch: 0 }

const storedRow = {
  id: 'msg_1',
  conversationId: 'conv_1',
  workspaceId: 'ws_eu',
  seq: 5,
  text: 'hi',
  authorType: 'user',
  createdTime: new Date('2026-11-25T05:00:00.000Z'),
  createdAt: new Date('2026-11-25T05:00:00.000Z'),
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    conversation: {
      findUnique: async () => CONVERSATION,
      update: async () => {
        localWrites.seqBump++
        return { lastSeq: 5 }
      },
    },
    conversationMessage: {
      findFirst: async () => null,
      findUnique: async () => storedRow,
      aggregate: async () => ({ _max: { seq: null } }),
      create: async ({ data }: any) => {
        localWrites.insert++
        return { ...storedRow, ...data }
      },
      update: async () => storedRow,
    },
    conversationMember: {
      updateMany: async () => {
        localWrites.memberTouch++
        return { count: 0 }
      },
    },
    conversationAttachment: { updateMany: async () => ({ count: 0 }) },
  },
}))

mock.module('../../lib/conversation-bus', () => ({
  publishConversationEvent: () => {
    localWrites.publish++
  },
  publishRelayed: () => {},
}))

mock.module('../../lib/region', () => ({
  RAW_REGION_ID: 'us-ashburn-1',
  PRIMARY_REGION: 'us-ashburn-1',
  REGION_PEERS: [],
  getPeer: () => undefined,
  isMultiRegionActive: () => true,
}))

type Outcome = 'local' | 'forwarded' | 'unavailable'
let outcome: Outcome = 'forwarded'
const routed: Array<{ workspaceId: string; path: string; body: any }> = []
const HOME_RESULT = {
  message: { id: 'home_msg_1', conversationId: 'conv_1', seq: 9, createdAt: '2026-11-25T05:00:00.000Z' },
  row: { id: 'home_msg_1', createdAt: '2026-11-25T05:00:00.000Z', updatedAt: '2026-11-25T05:00:00.000Z' },
  mentions: [],
  duplicate: false,
}

mock.module('../../lib/home-region-route', () => ({
  routeToHomeRegion: async (workspaceId: string, path: string, body: any) => {
    routed.push({ workspaceId, path, body })
    if (outcome === 'local') return { outcome: 'local' }
    if (outcome === 'forwarded') return { outcome: 'forwarded', data: { result: HOME_RESULT } }
    return { outcome: 'unavailable' }
  },
}))

const { postMessage, POST_MESSAGE_FORWARD_PATH } = await import('../conversation.service')

beforeEach(() => {
  outcome = 'forwarded'
  routed.length = 0
  localWrites.seqBump = 0
  localWrites.insert = 0
  localWrites.publish = 0
  localWrites.memberTouch = 0
})

describe('a message for a conversation homed elsewhere is forwarded', () => {
  test('returns the home region result and writes nothing locally', async () => {
    const result = await postMessage({ conversationId: 'conv_1', text: 'hi', authorType: 'user' })

    expect(routed).toHaveLength(1)
    expect(routed[0].workspaceId).toBe('ws_eu')
    expect(routed[0].path).toBe(POST_MESSAGE_FORWARD_PATH)
    expect(routed[0].body.input).toMatchObject({ conversationId: 'conv_1', text: 'hi', authorType: 'user' })

    // No seq bump, no insert, no publish — mentions and wakes run at home, once.
    expect(localWrites).toEqual({ seqBump: 0, insert: 0, publish: 0, memberTouch: 0 })
    expect(result.message.id).toBe('home_msg_1')
    expect(result.message.createdAt).toBeInstanceOf(Date)
    expect(result.row.createdAt).toBeInstanceOf(Date)
    // The caller keeps its own conversation row (its copy catches up by replication).
    expect(result.conversation).toEqual(CONVERSATION as any)
  })

  test('carries a createdAt across the hop as an ISO string', async () => {
    const createdAt = new Date('2026-11-25T04:59:00.000Z')
    await postMessage({ conversationId: 'conv_1', text: 'hi', authorType: 'system', createdAt })
    expect(routed[0].body.input.createdAt).toBe('2026-11-25T04:59:00.000Z')
  })

  test('an unreachable home region is a retryable 503, never a local write', async () => {
    outcome = 'unavailable'
    let error: any = null
    try {
      await postMessage({ conversationId: 'conv_1', text: 'hi', authorType: 'user' })
    } catch (err) {
      error = err
    }
    expect(error?.status).toBe(503)
    expect(error?.code).toBe('home_region_unavailable')
    expect(localWrites.insert).toBe(0)
    expect(localWrites.seqBump).toBe(0)
  })
})

describe('the region that owns the conversation inserts locally', () => {
  test('bumps seq, inserts and publishes here', async () => {
    outcome = 'local'
    const result = await postMessage({ conversationId: 'conv_1', text: 'hi', authorType: 'user' })

    expect(localWrites.seqBump).toBe(1)
    expect(localWrites.insert).toBe(1)
    expect(localWrites.publish).toBe(1)
    expect(result.message.id).toBe('msg_1')
  })

  test('postMessageInHomeRegion never routes again', async () => {
    const { postMessageInHomeRegion } = await import('../conversation.service')
    const result = await postMessageInHomeRegion({
      conversationId: 'conv_1',
      text: 'hi',
      authorType: 'user',
      createdAt: '2026-11-25T05:00:00.000Z',
    } as any)
    expect(routed).toHaveLength(0)
    expect(localWrites.insert).toBe(1)
    expect(result.message.id).toBe('msg_1')
  })
})
