// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A channel agent's turn often does not exist yet when someone opens the
 * session: the run may still be waiting for a slot or for the runtime to
 * wake. The chat panel checks the turn once after loading history, so that
 * window shows a finished-looking transcript and never attaches to the
 * stream. A channel-dispatch prompt with no reply yet has to stay pending
 * the same way a delegated task does.
 */

import { describe, expect, test } from 'bun:test'
import { channelDispatchOf } from '@shogo/shared-app/chat'
import { externalPromptHasResponse, pendingExternalPromptIndex } from '../late-turn-attach'

const dispatch = {
  type: 'data-channel-dispatch',
  data: {
    conversationId: 'c1',
    conversationName: 'ops',
    threadRootId: 't1',
    agentName: 'Ops',
    trigger: { authorName: 'Russell', text: 'run the check' },
    contextMode: 'shared',
  },
}

describe('a channel dispatch opened before the turn exists', () => {
  test('the prompt is pending, so the panel keeps probing until the turn is live', () => {
    const messages = [
      {
        id: 'u1',
        role: 'user',
        content: 'Team chat context: channel id c1',
        parts: [{ type: 'text', text: 'Team chat context: channel id c1' }, dispatch],
      },
    ]
    expect(channelDispatchOf(messages[0])).not.toBeNull()
    expect(pendingExternalPromptIndex(messages)).toBe(0)
  })
})

describe('a project call opened before the callee starts', () => {
  const callPrompt = {
    id: 'u1',
    role: 'user',
    content: 'summarise the backlog',
    parts: JSON.stringify([
      { type: 'text', text: 'summarise the backlog' },
      { type: 'data-project-call', data: { runId: 'run_1', callerName: 'Planner' } },
    ]),
  }

  test('the request is pending until the reply arrives', () => {
    expect(pendingExternalPromptIndex([callPrompt])).toBe(0)
    expect(externalPromptHasResponse([callPrompt], 0)).toBe(false)
    expect(externalPromptHasResponse([callPrompt, { id: 'a1', role: 'assistant', content: 'done' }], 0)).toBe(true)
  })

  test('an ordinary user message is not', () => {
    expect(pendingExternalPromptIndex([{ id: 'u2', role: 'user', content: 'hi', parts: [{ type: 'text', text: 'hi' }] }])).toBe(-1)
  })
})
