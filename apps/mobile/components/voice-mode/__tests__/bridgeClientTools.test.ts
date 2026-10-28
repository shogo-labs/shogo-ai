// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Run: bun test apps/mobile/components/voice-mode/__tests__/bridgeClientTools.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { createBridgeClientTools } from '../bridgeClientTools'
import type { ChatBridgeApi } from '../ChatBridgeContext'

function makeFakeBridge() {
  const sends: string[] = []
  const api: ChatBridgeApi = {
    send: (t) => sends.push(t),
    subscribe: () => () => {},
    ezModeActive: false,
    setEzModeActive: () => {},
    toggleEzMode: () => {},
    ezPeekActive: false,
    setEzPeekActive: () => {},
    chatSessionId: null,
    agentUrl: null,
    consumeAutoStartVoice: () => false,
    subscribeSubagentCards: () => () => {},
    getSubagentCardsSnapshot: () => [],
  }
  return { api, sends }
}

describe('createBridgeClientTools', () => {
  test('send_to_chat forwards trimmed text to bridge.send and returns "Sent."', () => {
    const { api, sends } = makeFakeBridge()
    const tools = createBridgeClientTools(api)
    const result = tools.send_to_chat({ text: '  refactor the login button  ' })
    expect(result).toBe('Sent.')
    expect(sends).toEqual(['refactor the login button'])
  })

  test('send_to_chat rejects empty/non-string text', () => {
    const { api, sends } = makeFakeBridge()
    const tools = createBridgeClientTools(api)
    expect(tools.send_to_chat({})).toContain('Error')
    expect(tools.send_to_chat({ text: '   ' })).toContain('Error')
    expect(tools.send_to_chat({ text: 42 as unknown as string })).toContain('Error')
    expect(sends).toEqual([])
  })

  test('send_to_chat is the only tool the translator can call', () => {
    const { api } = makeFakeBridge()
    const tools = createBridgeClientTools(api) as unknown as Record<string, unknown>
    expect(Object.keys(tools)).toEqual(['send_to_chat'])
  })
})
