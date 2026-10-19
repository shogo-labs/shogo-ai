// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-31 — a `[Task update]` wake is a prompt whose reply this window does
 * not produce.
 *
 * When the wake row lands but its turn has not started (or has started on
 * another window), the panel has to keep probing exactly like it does for a
 * delegated task. Otherwise the row sits there unanswered and the transcript
 * looks like the agent never woke up.
 */

import { describe, expect, test } from 'bun:test'
import {
  isTaskWakePrompt,
  pendingExternalPromptIndex,
  TASK_WAKE_PENDING_WINDOW_MS,
  taskWakeHasResponse,
} from '../late-turn-attach'

const now = Date.parse('2026-10-18T12:00:00.000Z')

const wakeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'u-wake',
  role: 'user',
  content: '[Task update] start the build (t_1) completed.\n\nLast output:\ndone',
  createdAt: now - 5_000,
  ...overrides,
})

const notificationPart = {
  type: 'data-task-notification',
  data: { taskIds: ['t_1'] },
}

describe('a wake row with no reply yet', () => {
  test('is a pending external prompt, so the panel keeps probing', () => {
    const messages = [wakeRow()]
    expect(isTaskWakePrompt(messages[0], now)).toBe(true)
    expect(pendingExternalPromptIndex(messages, now)).toBe(0)
  })

  test('is recognised from the notification part when the text is trimmed', () => {
    expect(isTaskWakePrompt({ role: 'user', content: 'summary', parts: [notificationPart] }, now)).toBe(true)
  })

  test('stops being pending once the wake reply is saved', () => {
    const messages = [wakeRow(), { id: 'a1', role: 'assistant', content: 'wake-ack: build finished' }]
    expect(taskWakeHasResponse(messages)).toBe(true)
  })
})

describe('a wake row nothing will ever answer', () => {
  test('is not pending once it is older than the queue could take', () => {
    const stale = wakeRow({ createdAt: now - TASK_WAKE_PENDING_WINDOW_MS - 1 })
    expect(isTaskWakePrompt(stale, now)).toBe(false)
    expect(pendingExternalPromptIndex([stale], now)).toBe(-1)
  })

  test('still counts as answered history for the settle check', () => {
    const stale = wakeRow({ createdAt: now - TASK_WAKE_PENDING_WINDOW_MS - 1 })
    expect(taskWakeHasResponse([stale])).toBe(false)
    expect(taskWakeHasResponse([stale, { id: 'a1', role: 'assistant', content: 'done' }])).toBe(true)
  })
})

describe('an ordinary conversation', () => {
  test('is never pending', () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'how is the build going?', createdAt: now },
      { id: 'a1', role: 'assistant', content: 'Still running.', createdAt: now },
    ]
    expect(pendingExternalPromptIndex(messages, now)).toBe(-1)
    expect(taskWakeHasResponse(messages)).toBe(false)
  })

  test('mentions a task update without being one', () => {
    const messages = [{ id: 'u1', role: 'user', content: 'show me the latest Task update please', createdAt: now }]
    expect(pendingExternalPromptIndex(messages, now)).toBe(-1)
  })
})
