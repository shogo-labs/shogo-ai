// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-118: `chat_handoff` rejected the argument a model actually passed.
 *
 * The prompt used to say "call `chat_handoff` with that chat id" while the
 * schema only knew `chat`, so a model that was not shown the schema guessed
 * `chat_id` and validation refused it — the first half of issue #1606. These
 * tests pin the three shapes: `{chat}`, `{chat_id}`, and neither, plus what a
 * 404 hands back so a wrong id is one correction instead of a retry loop.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const calls: Array<{ workspaceId: string; input: any }> = []
let nextResult: any = { ok: true, status: 200, data: { delivered: { id: 'chat-b', title: 'Deploy notes', started: true } } }

// Spread the real module: other importers need every other export it has.
const internalApi = await import('../internal-api')
mock.module('../internal-api', () => ({
  ...internalApi,
  deliverAgentChatHandoff: async (workspaceId: string, input: any) => {
    calls.push({ workspaceId, input })
    return nextResult
  },
}))

const runtimeMode = await import('../workspace-runtime-mode')
mock.module('../workspace-runtime-mode', () => ({
  ...runtimeMode,
  resolveRuntimeIdentity: () => ({ mode: 'workspace', workspaceId: 'ws-1', projectId: null, kind: null }),
}))

const { createChatHandoffTool, resolveChatHandoffInput } = await import('../chat-handoff-tool')

const ctx = { workspaceId: 'ws-1', sessionId: 'chat-a' } as any

function run(params: unknown) {
  const tool = createChatHandoffTool(ctx)
  return tool.execute('call-1', params as any)
}

function payload(result: any) {
  return JSON.parse(result.content?.[0]?.text ?? '{}')
}

beforeEach(() => {
  calls.length = 0
  nextResult = { ok: true, status: 200, data: { delivered: { id: 'chat-b', title: 'Deploy notes', started: true } } }
})

describe('resolveChatHandoffInput', () => {
  test('takes chat, chat_id and chatId, preferring chat', () => {
    expect(resolveChatHandoffInput({ chat: 'x', message: 'm' })).toEqual({ chat: 'x', message: 'm' })
    expect(resolveChatHandoffInput({ chat_id: 'y', message: 'm' })).toEqual({ chat: 'y', message: 'm' })
    expect(resolveChatHandoffInput({ chatId: 'z', message: 'm' })).toEqual({ chat: 'z', message: 'm' })
    expect(resolveChatHandoffInput({ chat: 'x', chat_id: 'y', message: 'm' }).chat).toBe('x')
    // Blank values are not an answer.
    expect(resolveChatHandoffInput({ chat: '  ', chat_id: 'y', message: 'm' }).chat).toBe('y')
    expect(resolveChatHandoffInput({ message: 'm' })).toEqual({ chat: '', message: 'm' })
  })
})

describe('chat_handoff tool', () => {
  test('{chat_id, message} is accepted rather than rejected', async () => {
    const result = payload(await run({ chat_id: 'chat-b', message: 'take this' }))
    expect(result).toMatchObject({ ok: true, chat: 'Deploy notes', queued: false })
    expect(calls).toEqual([
      { workspaceId: 'ws-1', input: { chat: 'chat-b', message: 'take this', sourceChatId: 'chat-a' } },
    ])
  })

  test('{chat, message} still works', async () => {
    const result = payload(await run({ chat: 'chat-b', message: 'take this' }))
    expect(result.ok).toBe(true)
    expect(calls[0].input.chat).toBe('chat-b')
  })

  test('neither argument is invalid_input, with the shape it expects', async () => {
    const result = payload(await run({ message: 'take this' }))
    expect(result).toMatchObject({ code: 'invalid_input' })
    expect(result.error).toContain('Both `chat` and `message` are required.')
    expect(result.hint).toContain('chat_handoff({ chat:')
    expect(calls).toEqual([])
  })

  test('a 404 surfaces chat_not_found plus the chats it can open, and says not to retry', async () => {
    nextResult = {
      ok: false,
      status: 404,
      error: 'No chat "591284d8" the requester can open',
      code: 'chat_not_found',
      details: { reachable: ['Billing bug', 'Deploy notes'] },
    }
    const result = payload(await run({ chat: '591284d8', message: 'stop everything' }))
    expect(result).toMatchObject({
      code: 'chat_not_found',
      reachable: ['Billing bug', 'Deploy notes'],
    })
    expect(result.hint).toContain('do not retry')
  })

  test('a queued handoff reports queued rather than started', async () => {
    nextResult = { ok: true, status: 200, data: { delivered: { id: 'chat-b', title: 'Busy', started: false } } }
    expect(payload(await run({ chat: 'chat-b', message: 'later' })).queued).toBe(true)
  })
})
