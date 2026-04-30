// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Run: bun test apps/mobile/components/voice-mode/__tests__/bridgeClientTools.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { createBridgeClientTools } from '../bridgeClientTools'
import type { ChatBridgeApi } from '../ChatBridgeContext'

function makeFakeBridge() {
  const sends: string[] = []
  const modes: string[] = []
  const api: ChatBridgeApi = {
    send: (t) => sends.push(t),
    setMode: (m) => modes.push(m),
    subscribe: () => () => {},
    shogoModeActive: false,
    setShogoModeActive: () => {},
    toggleShogoMode: () => {},
    shogoPeekActive: false,
    setShogoPeekActive: () => {},
    chatSessionId: null,
    consumeAutoStartVoice: () => false,
  }
  return { api, sends, modes }
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

  test('set_mode accepts agent/plan/ask (case-insensitive) and rejects others', () => {
    const { api, modes } = makeFakeBridge()
    const tools = createBridgeClientTools(api)
    expect(tools.set_mode({ mode: 'plan' })).toBe('Switched to plan mode.')
    expect(tools.set_mode({ mode: 'AGENT' })).toBe('Switched to agent mode.')
    expect(tools.set_mode({ mode: 'ask' })).toBe('Switched to ask mode.')
    expect(tools.set_mode({})).toContain('Error')
    expect(modes).toEqual(['plan', 'agent', 'ask'])
  })
})
