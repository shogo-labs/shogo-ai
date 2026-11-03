// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-299 — a chat open in two windows has to stay in step.
 *
 * Nothing told an idle panel that a turn started somewhere else, so tab 1 sat
 * on its old transcript while tab 2 talked to the agent. The API now publishes
 * `chat-session.turn`; these are the decisions the panel makes from it.
 */

import { describe, expect, test } from 'bun:test'
import { repaintWhenReplyLands, turnSyncAction } from '../turn-sync'

const turnEvent = (state: string, chatSessionId = 'session-1') => ({
  type: 'chat-session.turn',
  chatSessionId,
  turnId: 'turn-1',
  state,
})

const idle = { currentSessionId: 'session-1', isStreaming: false, isSending: false }

describe('turnSyncAction', () => {
  test('attaches to a turn another window started', () => {
    expect(turnSyncAction(turnEvent('started'), idle)).toBe('attach')
  })

  test('repaints when a turn ended somewhere else', () => {
    expect(turnSyncAction(turnEvent('ended'), idle)).toBe('repaint')
  })

  test('ignores a turn in another chat', () => {
    expect(turnSyncAction(turnEvent('started', 'session-2'), idle)).toBe('ignore')
    expect(turnSyncAction(turnEvent('ended', 'session-2'), idle)).toBe('ignore')
  })

  test('ignores every other team-chat event', () => {
    expect(turnSyncAction({ type: 'message.created', conversationId: 'c-1' }, idle)).toBe('ignore')
    expect(turnSyncAction({ type: 'typing' }, idle)).toBe('ignore')
    expect(turnSyncAction(null, idle)).toBe('ignore')
  })

  test('ignores a turn this window is already running', () => {
    // The sender must not be disturbed: attaching again would rebuild the reply
    // it is watching, and repainting would drop the bubble it just echoed.
    expect(turnSyncAction(turnEvent('started'), { ...idle, isStreaming: true })).toBe('ignore')
    expect(turnSyncAction(turnEvent('ended'), { ...idle, isStreaming: true })).toBe('ignore')
    expect(turnSyncAction(turnEvent('started'), { ...idle, isSending: true })).toBe('ignore')
    expect(turnSyncAction(turnEvent('ended'), { ...idle, isSending: true })).toBe('ignore')
  })

  test('ignores a turn before the panel knows its chat', () => {
    expect(turnSyncAction(turnEvent('started'), { ...idle, currentSessionId: null })).toBe('ignore')
  })

  test('ignores an unknown turn state', () => {
    expect(turnSyncAction(turnEvent('paused'), idle)).toBe('ignore')
  })
})

describe('repaintWhenReplyLands', () => {
  const sleep = async () => {}

  test('waits for the reply row, then paints it', async () => {
    const tails = [
      { id: 'prompt-1', role: 'user' },
      { id: 'reply-1', role: 'assistant' },
    ]
    let reloads = 0
    await repaintWhenReplyLands({
      probe: async () => tails.shift() ?? null,
      reload: async () => {
        reloads += 1
      },
      sleep,
    })
    expect(reloads).toBe(1)
  })

  test('does not repaint on top of a reply that is already saved', async () => {
    let reloads = 0
    await repaintWhenReplyLands({
      probe: async () => ({ id: 'reply-1', role: 'assistant' }),
      reload: async () => {
        reloads += 1
      },
      sleep,
    })
    expect(reloads).toBe(1)
  })

  test('gives up after its bounded retries and never loops', async () => {
    let probes = 0
    await repaintWhenReplyLands({
      probe: async () => {
        probes += 1
        return { id: 'prompt-1', role: 'user' }
      },
      reload: async () => {
        throw new Error('must not paint a prompt with no reply as the answer')
      },
      sleep,
    })
    expect(probes).toBe(2)
  })

  test('stops when the window starts streaming or moves to another chat', async () => {
    let probes = 0
    let cancelled = false
    await repaintWhenReplyLands({
      probe: async () => {
        probes += 1
        cancelled = true
        return { id: 'prompt-1', role: 'user' }
      },
      reload: async () => {},
      isCancelled: () => cancelled,
      sleep,
    })
    expect(probes).toBe(1)
  })

  test('a failed tail read is retried, not treated as an answer', async () => {
    let probes = 0
    let reloads = 0
    await repaintWhenReplyLands({
      probe: async () => {
        probes += 1
        if (probes === 1) throw new Error('network')
        return { id: 'reply-1', role: 'assistant' }
      },
      reload: async () => {
        reloads += 1
      },
      sleep,
    })
    expect(reloads).toBe(1)
  })
})
