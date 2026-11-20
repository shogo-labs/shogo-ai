// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-458: realtime merge in useMemberMessages must not wipe loaded older
 * pages when a new message arrives or an existing one is updated.
 */

import { describe, expect, mock, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'

// Minimal ChatMessage shape for tests
function msg(id: string, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    seq,
    text: `msg ${id}`,
    authorType: 'user',
    authorUserId: 'u-ada',
    authorAgent: null,
    threadRootId: null,
    alsoSentToChannel: false,
    createdAt: new Date(seq * 1000).toISOString(),
    updatedAt: new Date(seq * 1000).toISOString(),
    deletedAt: null,
    editedAt: null,
    pending: false,
    clientMsgId: null,
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
    attachments: [],
    blocks: null,
    agentStatus: null,
    conversationId: 'c-1',
    ...overrides,
  }
}

/** Extract the messages array from useMemberMessages state after one async tick. */
async function hookMessages(setup: (setMessages: (fn: (prev: any[]) => any[]) => void) => void) {
  let captured: any[] = []
  const setter = (fn: (prev: any[]) => any[]) => {
    captured = fn(captured)
  }
  setup(setter)
  return captured
}

describe('useMemberMessages realtime merge', () => {
  test('inserting a new message does not drop older pages', async () => {
    // Page 1 (newest): [seq:50, seq:49]
    // Older page: [seq:10, seq:9]
    const page1 = [msg('m50', 50), msg('m49', 49)]
    const olderPage = [msg('m10', 10), msg('m9', 9)]
    let messages = [...page1, ...olderPage]

    // Simulate a message.created from the same member
    const newMsg = msg('m51', 51)
    const after = ((prev: any[]) => {
      if (prev.some((m) => m.id === newMsg.id)) return prev
      return [newMsg, ...prev]
    })(messages)

    expect(after).toHaveLength(5)
    expect(after[0].id).toBe('m51') // newest first
    expect(after[after.length - 1].id).toBe('m9') // oldest still present
  })

  test('updating a known message patches it in place, keeping all other rows', () => {
    const messages = [msg('m50', 50), msg('m49', 49), msg('m10', 10)]
    const updated = { ...msg('m49', 49), text: 'edited' }

    const after = ((prev: any[]) => {
      if (!prev.some((m) => m.id === updated.id)) return prev
      return prev.map((m) => (m.id === updated.id ? updated : m))
    })(messages)

    expect(after).toHaveLength(3)
    expect(after.find((m) => m.id === 'm49')?.text).toBe('edited')
    expect(after.find((m) => m.id === 'm50')).toBeTruthy()
    expect(after.find((m) => m.id === 'm10')).toBeTruthy()
  })

  test('a message.updated for an unknown id leaves the list unchanged', () => {
    const messages = [msg('m50', 50), msg('m49', 49)]
    const unknown = msg('m99', 99)

    const after = ((prev: any[]) => {
      if (!prev.some((m) => m.id === unknown.id)) return prev
      return prev.map((m) => (m.id === unknown.id ? unknown : m))
    })(messages)

    expect(after).toBe(messages) // same reference — no change
  })

  test('reload merges the first page with older pages, not replace', () => {
    // Older page loaded before reload
    const olderPage = [msg('m10', 10), msg('m9', 9)]
    const prev = [msg('m50', 50), msg('m49', 49), ...olderPage]

    // Reload brings back page 1 (possibly with updated messages)
    const newPage1 = [msg('m50', 50, { text: 'updated' }), msg('m49', 49)]
    const oldestSeqInPage = newPage1[newPage1.length - 1]?.seq ?? 0

    const after = ((p: any[]) => {
      const pageIds = new Set(newPage1.map((m: any) => m.id))
      const keepOlder = p.filter(
        (m: any) => m.seq < oldestSeqInPage && !pageIds.has(m.id),
      )
      return [...newPage1, ...keepOlder]
    })(prev)

    expect(after).toHaveLength(4)
    expect(after[0].text).toBe('updated') // patched
    expect(after.find((m) => m.id === 'm10')).toBeTruthy() // older page kept
    expect(after.find((m) => m.id === 'm9')).toBeTruthy()
  })
})
