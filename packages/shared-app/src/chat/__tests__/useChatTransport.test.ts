// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'vitest'
import {
  buildChatApiUrl,
  buildChatTasksUrl,
  buildChatTurnUrl,
  outgoingChatMessages,
  prepareChatSendBody,
} from '../useChatTransport'

describe('buildChatApiUrl', () => {
  it('returns local agent URL when provided', () => {
    expect(buildChatApiUrl('http://localhost:8002', 'proj_1', 'http://localhost:3000'))
      .toBe('http://localhost:3000/agent/chat')
  })

  it('builds project-scoped URL when projectId is provided', () => {
    expect(buildChatApiUrl('http://localhost:8002', 'proj_123'))
      .toBe('http://localhost:8002/api/projects/proj_123/chat')
  })

  it('builds generic chat URL when no projectId or localAgentUrl', () => {
    expect(buildChatApiUrl('http://localhost:8002', undefined))
      .toBe('http://localhost:8002/api/chat')
  })

  it('works with empty string base URL (same-origin)', () => {
    expect(buildChatApiUrl('', 'proj_1'))
      .toBe('/api/projects/proj_1/chat')
  })

  it('prefers localAgentUrl over projectId', () => {
    expect(buildChatApiUrl('http://api.example.com', 'proj_1', 'http://local:3000'))
      .toBe('http://local:3000/agent/chat')
  })

  it('handles null localAgentUrl same as undefined', () => {
    expect(buildChatApiUrl('http://localhost:8002', 'proj_1', null))
      .toBe('http://localhost:8002/api/projects/proj_1/chat')
  })
})

describe('buildChatTurnUrl', () => {
  it('builds turn URL for a project', () => {
    expect(buildChatTurnUrl('http://localhost:8002', 'proj_1', null, 'session_abc'))
      .toBe('http://localhost:8002/api/projects/proj_1/chat/session_abc/turn')
  })

  it('builds turn URL with local agent', () => {
    expect(buildChatTurnUrl('', undefined, 'http://local:3000', 'sess_1'))
      .toBe('http://local:3000/agent/chat/sess_1/turn')
  })

  it('encodes special characters in session ID', () => {
    expect(buildChatTurnUrl('http://api.test', 'proj_1', null, 'sess/special&id'))
      .toBe('http://api.test/api/projects/proj_1/chat/sess%2Fspecial%26id/turn')
  })

  it('strips trailing slashes from the computed chat base', () => {
    expect(buildChatTurnUrl('http://api.test', 'proj_1', null, 'sess_1'))
      .toBe('http://api.test/api/projects/proj_1/chat/sess_1/turn')
  })

  it('works without projectId or localAgentUrl', () => {
    expect(buildChatTurnUrl('http://api.test', undefined, null, 'sess_1'))
      .toBe('http://api.test/api/chat/sess_1/turn')
  })
})

describe('buildChatTasksUrl', () => {
  it('builds the tasks URL for a project chat through the agent proxy', () => {
    expect(buildChatTasksUrl('http://localhost:8002', 'proj_1', null, 'sess_1'))
      .toBe('http://localhost:8002/api/projects/proj_1/agent-proxy/agent/chat/sess_1/tasks')
  })

  it('builds the tasks URL for a workspace chat, which has no project to hang it on', () => {
    expect(buildChatTasksUrl('http://localhost:8002', undefined, null, 'sess_1', 'ws_1'))
      .toBe('http://localhost:8002/api/workspaces/ws_1/chat/sess_1/tasks')
  })

  it('prefers the local agent runtime', () => {
    expect(buildChatTasksUrl('http://api.test', 'proj_1', 'http://local:3000', 'sess_1', 'ws_1'))
      .toBe('http://local:3000/agent/chat/sess_1/tasks')
  })

  it('encodes special characters in the session ID', () => {
    expect(buildChatTasksUrl('http://api.test', undefined, null, 'sess/special&id', 'ws_1'))
      .toBe('http://api.test/api/workspaces/ws_1/chat/sess%2Fspecial%26id/tasks')
  })

  it('has nothing to poll without a chat scope', () => {
    expect(buildChatTasksUrl('http://api.test', undefined, null, 'sess_1')).toBeNull()
  })
})

// ─── SHO-402: a send carries the new message, not the whole transcript ──────

/** What a tool result looks like on the wire: a long block of file contents. */
const toolOutput = (index: number) => `tool output ${index}: ${'x'.repeat(20_000)}`

interface WireMessage {
  id: string
  role: 'user' | 'assistant'
  parts: Array<Record<string, unknown>>
}

/**
 * A transcript as the composer holds it: 25 user/assistant pairs whose assistant
 * turns carry tool output, i.e. the shape that used to make a send ~800 KB.
 */
function loadedTranscript(turns = 25): WireMessage[] {
  const messages: WireMessage[] = []
  for (let index = 0; index < turns; index++) {
    messages.push({
      id: `u${index}`,
      role: 'user',
      parts: [{ type: 'text', text: `question ${index}` }],
    })
    messages.push({
      id: `a${index}`,
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolCallId: `call-${index}`,
          toolName: 'read_file',
          state: 'output-available',
          input: { path: `src/file-${index}.ts` },
          output: toolOutput(index),
        },
        { type: 'text', text: `Reply ${index}` },
      ],
    })
  }
  return messages
}

/** The fields a real send carries besides `messages` (ChatPanel's send body). */
const sendBody = {
  chatSessionId: 'sess-1',
  agentMode: 'auto',
  workspaceId: 'ws-1',
  references: [{ kind: 'file', path: 'src/App.tsx' }],
}

const newMessage: WireMessage = {
  id: 'msg-new',
  role: 'user',
  parts: [{ type: 'text', text: 'what did I ask you two messages ago?' }],
}

describe('outgoingChatMessages', () => {
  it('sends only the new message for a 50-message transcript', () => {
    const messages = [...loadedTranscript(), newMessage]
    const out = outgoingChatMessages(messages)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(newMessage)
  })

  it('drops the transcript instead of its size — the request body is a few KB', () => {
    const messages = [...loadedTranscript(), newMessage]
    const body = prepareChatSendBody({
      id: 'chat-1',
      messages,
      body: sendBody,
      trigger: 'submit-message',
      messageId: newMessage.id,
      directToRuntime: false,
    })

    // The transcript it replaced really is the problem the card measured.
    expect(JSON.stringify(messages).length).toBeGreaterThan(500_000)
    // AC1: the POST is under 10 KB, and carries exactly the one new message.
    expect(JSON.stringify(body).length).toBeLessThan(10_000)
    expect((body.messages as WireMessage[]).length).toBe(1)
    expect((body.messages as WireMessage[])[0].id).toBe('msg-new')
    // The turn's own fields still ride along.
    expect(body.chatSessionId).toBe('sess-1')
    expect(body.agentMode).toBe('auto')
    expect(body.references).toEqual(sendBody.references)
    expect(body.messageId).toBe('msg-new')
  })

  it('keeps the regenerate turn and nothing before it', () => {
    // A regenerate re-sends the newest user message, and the SDK hands the
    // transport the transcript without the assistant reply it dropped.
    const messages = loadedTranscript().slice(0, -1)
    expect(messages[messages.length - 1]!.id).toBe('u24')
    const body = prepareChatSendBody({
      id: 'chat-1',
      messages,
      body: sendBody,
      trigger: 'regenerate-message',
      messageId: 'u24',
      directToRuntime: false,
    })
    expect((body.messages as WireMessage[]).map((m) => m.id)).toEqual(['u24'])
  })

  it('starts the body at the newest user message', () => {
    const body = prepareChatSendBody({
      id: 'chat-1',
      messages: loadedTranscript(),
      body: sendBody,
      trigger: 'submit-message',
      messageId: 'u24',
      directToRuntime: false,
    })
    expect((body.messages as WireMessage[]).map((m) => m.id)).toEqual(['u24', 'a24'])
  })

  it('leaves earlier inline attachment bytes out of the body entirely', () => {
    const messages = loadedTranscript(2)
    messages[1].parts.push({
      type: 'file',
      mediaType: 'image/png',
      name: 'screenshot.png',
      url: `data:image/png;base64,${'A'.repeat(200_000)}`,
    })
    messages.push(newMessage)
    const body = prepareChatSendBody({
      id: 'chat-1',
      messages,
      body: sendBody,
      trigger: 'submit-message',
      messageId: 'msg-new',
      directToRuntime: false,
    })
    expect(JSON.stringify(body)).not.toContain(';base64,')
  })

  it('a new message keeps its own attachment (that is the turn being sent)', () => {
    const withFile: WireMessage = {
      ...newMessage,
      parts: [
        ...newMessage.parts,
        { type: 'file', mediaType: 'image/png', name: 'chart.png', url: 'data:image/png;base64,AAAA' },
      ],
    }
    const out = outgoingChatMessages([...loadedTranscript(2), withFile])
    expect(out).toHaveLength(1)
    expect(out[0].parts).toHaveLength(2)
  })

  it('a single-message transcript is passed through unchanged', () => {
    const messages = [newMessage]
    expect(outgoingChatMessages(messages)).toBe(messages)
  })

  it('keeps the whole transcript when the request goes straight to the runtime', () => {
    // `localAgentUrl` bypasses the API routes that attach `historySeed`, so a
    // cold session there still needs the client's history (AC5).
    const messages = [...loadedTranscript(), newMessage]
    const out = outgoingChatMessages(messages, { directToRuntime: true })
    expect(out).toHaveLength(messages.length)
    expect(out[out.length - 1]).toBe(newMessage)
  })
})
