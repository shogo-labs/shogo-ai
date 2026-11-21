// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The project page URL has to name the open chat: the mirror decides what goes
 * into `?chatSessionId=`, which arrival-only params are dropped, and whether a
 * param is a real deep link or just our own write echoed back (the selection
 * guards must only defer to the former).
 */
import { describe, expect, test } from 'bun:test'
import {
  firstChatSessionParam,
  hasChatUrlOneShotParams,
  deepLinkedChatSessionId,
  isChatSessionOfProject,
  planChatUrlWrite,
  resolveDeepLinkedChatSessionId,
  type ChatUrlMirrorInput,
} from '../project-chat-url'

function input(overrides: Partial<ChatUrlMirrorInput> = {}): ChatUrlMirrorInput {
  return {
    chatSessionId: 'chat-b',
    currentParam: undefined,
    oneShotPresent: false,
    chatScope: 'project',
    initialPropsSessionId: null,
    ...overrides,
  }
}

describe('project chat URL params', () => {
  test('reads the first value of a repeated param', () => {
    expect(firstChatSessionParam('chat-a')).toBe('chat-a')
    expect(firstChatSessionParam(['chat-a', 'chat-b'])).toBe('chat-a')
    expect(firstChatSessionParam(undefined)).toBeUndefined()
    expect(firstChatSessionParam('')).toBeUndefined()
  })

  test('spots arrival-only params', () => {
    expect(hasChatUrlOneShotParams({})).toBe(false)
    expect(hasChatUrlOneShotParams({ newChat: '1' })).toBe(true)
    expect(hasChatUrlOneShotParams({ newChatNonce: ['17'] })).toBe(true)
    expect(hasChatUrlOneShotParams({ initialMessage: 'hi', embed: 'ide' })).toBe(true)
    expect(hasChatUrlOneShotParams({ chatSessionId: 'chat-a', embed: 'ide' })).toBe(false)
  })

  test('only counts a param as a deep link when this screen did not write it', () => {
    expect(deepLinkedChatSessionId('chat-a', null)).toBe('chat-a')
    expect(deepLinkedChatSessionId('chat-a', 'chat-b')).toBe('chat-a')
    expect(deepLinkedChatSessionId('chat-b', 'chat-b')).toBeUndefined()
    expect(deepLinkedChatSessionId(undefined, 'chat-b')).toBeUndefined()
  })
})

describe('planChatUrlWrite', () => {
  test('writes the open chat when the URL names another one', () => {
    const write = planChatUrlWrite(input({ currentParam: 'chat-a' }))
    expect(write?.params.chatSessionId).toBe('chat-b')
    expect(write?.selfWrittenId).toBe('chat-b')
  })

  test('writes the open chat when the URL names none', () => {
    expect(planChatUrlWrite(input())?.params.chatSessionId).toBe('chat-b')
  })

  test('leaves a URL that already names the open chat alone', () => {
    expect(planChatUrlWrite(input({ currentParam: 'chat-b' }))).toBeNull()
  })

  test('drops arrival-only params as soon as a chat is named', () => {
    const write = planChatUrlWrite(
      input({ currentParam: 'chat-b', oneShotPresent: true })
    )
    expect(write?.params).toMatchObject({
      chatSessionId: 'chat-b',
      newChat: undefined,
      newChatNonce: undefined,
      initialMessage: undefined,
      startEzMode: undefined,
      autoStartVoice: undefined,
    })
  })

  test('keeps workspace scope only for the chat the URL handed off', () => {
    const handOff = planChatUrlWrite(
      input({
        chatSessionId: 'chat-a',
        chatScope: 'workspace',
        initialPropsSessionId: 'chat-a',
      })
    )
    expect(handOff?.params.chatScope).toBe('workspace')

    const switched = planChatUrlWrite(
      input({
        chatSessionId: 'chat-b',
        currentParam: 'chat-a',
        chatScope: 'workspace',
        initialPropsSessionId: 'chat-a',
      })
    )
    expect(switched?.params.chatScope).toBeUndefined()
  })

  test('clears the param when no chat is open', () => {
    const write = planChatUrlWrite(
      input({ chatSessionId: null, currentParam: 'chat-a' })
    )
    expect(write?.params).toEqual({
      chatSessionId: undefined,
      chatScope: undefined,
    })
    expect(write?.selfWrittenId).toBeNull()
  })

  test('does nothing when no chat is open and the URL is already bare', () => {
    expect(
      planChatUrlWrite(input({ chatSessionId: null, currentParam: undefined }))
    ).toBeNull()
  })
})

describe('isChatSessionOfProject', () => {
  test('rejects a chat that does not load at all', () => {
    expect(isChatSessionOfProject(null, { projectId: 'proj-1' })).toBe(false)
    expect(isChatSessionOfProject(undefined, { projectId: 'proj-1' })).toBe(false)
  })

  test('accepts a chat anchored to this project', () => {
    expect(
      isChatSessionOfProject({ contextId: 'proj-1' }, { projectId: 'proj-1' })
    ).toBe(true)
  })

  test('accepts an unanchored workspace chat (the home hand-off)', () => {
    expect(
      isChatSessionOfProject({ contextId: null }, { projectId: 'proj-1' })
    ).toBe(true)
  })

  test("rejects another project's chat unless the link asked for workspace scope", () => {
    expect(
      isChatSessionOfProject({ contextId: 'proj-2' }, { projectId: 'proj-1' })
    ).toBe(false)
    // An attached-project file open keeps the workspace chat it came from.
    expect(
      isChatSessionOfProject(
        { contextId: 'proj-2' },
        { projectId: 'proj-1', allowCrossProject: true }
      )
    ).toBe(true)
  })
})

describe('cold-load restored keys (SHO-174)', () => {
  // The URL is serialised from the router state, so a restore the mirror does
  // not carry is dropped again by its next write. `preserved` is how the
  // project layout hands the restored keys to this one writer.

  test('keeps a restored tab on the write it makes anyway', () => {
    const write = planChatUrlWrite(
      input({ chatSessionId: 'chat-a', currentParam: undefined, preserved: { tab: 'settings' } })
    )
    expect(write?.params).toEqual({ tab: 'settings', chatSessionId: 'chat-a', chatScope: undefined })
  })

  test('writes restored keys even when the chat param is already right', () => {
    const write = planChatUrlWrite(
      input({
        chatSessionId: 'chat-a',
        currentParam: 'chat-a',
        preserved: { tab: 'settings' },
        // The reader sees the restored tab; the address bar does not have it.
        urlQuery: { id: 'proj-1', chatSessionId: 'chat-a' },
      })
    )
    expect(write?.params).toEqual({ tab: 'settings', chatSessionId: 'chat-a', chatScope: undefined })
  })

  test('does nothing when the URL already carries the restored keys', () => {
    const write = planChatUrlWrite(
      input({
        chatSessionId: 'chat-a',
        currentParam: 'chat-a',
        preserved: { tab: 'settings' },
        urlQuery: { id: 'proj-1', chatSessionId: 'chat-a', tab: 'settings' },
      })
    )
    expect(write).toBeNull()
  })

  test('never takes the chat keys from preserved', () => {
    const write = planChatUrlWrite(
      input({
        chatSessionId: 'chat-b',
        currentParam: 'chat-b',
        preserved: { chatSessionId: 'chat-arrival', chatScope: 'workspace', tab: 'settings' },
        urlQuery: { chatSessionId: 'chat-b' },
      })
    )
    expect(write?.params.chatSessionId).toBe('chat-b')
    expect(write?.params.chatScope).toBeUndefined()
    expect(write?.params.tab).toBe('settings')
  })

  test('a restored chat id stays the deep link even though this hook wrote it', () => {
    expect(
      resolveDeepLinkedChatSessionId({
        currentParam: 'chat-bravo',
        selfWrittenId: 'chat-bravo',
        preservedChatSessionId: 'chat-bravo',
      })
    ).toBe('chat-bravo')
  })

  test('an id this hook wrote itself is not a deep link', () => {
    expect(
      resolveDeepLinkedChatSessionId({ currentParam: 'chat-a', selfWrittenId: 'chat-a' })
    ).toBeUndefined()
  })
})
