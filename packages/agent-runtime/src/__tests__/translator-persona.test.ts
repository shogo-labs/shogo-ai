// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import {
  TRANSLATOR_SYSTEM_PROMPT,
  TRANSLATOR_ELEVENLABS_TOOLS,
  TRANSLATOR_AI_SDK_TOOLS,
  SEND_TO_CHAT_PARAMS,
  SET_MODE_PARAMS,
} from '../voice-mode/translator-persona'

describe('translator-persona', () => {
  test('system prompt mentions both tools by name', () => {
    expect(TRANSLATOR_SYSTEM_PROMPT).toContain('send_to_chat')
    expect(TRANSLATOR_SYSTEM_PROMPT).toContain('set_mode')
  })

  test('ElevenLabs tools declare send_to_chat and set_mode as client tools', () => {
    const names = TRANSLATOR_ELEVENLABS_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual(['send_to_chat', 'set_mode'])
    for (const t of TRANSLATOR_ELEVENLABS_TOOLS) {
      expect(t.type).toBe('client')
      expect(t.expects_response).toBe(true)
      expect(t.parameters).toBeDefined()
    }
  })

  test('set_mode ElevenLabs spec restricts mode to agent | plan', () => {
    const setMode = TRANSLATOR_ELEVENLABS_TOOLS.find((t) => t.name === 'set_mode')!
    const params = setMode.parameters as { properties: { mode: { enum: string[] } } }
    expect(params.properties.mode.enum.sort()).toEqual(['agent', 'plan'])
  })

  test('AI SDK tool map mirrors ElevenLabs tool names', () => {
    expect(Object.keys(TRANSLATOR_AI_SDK_TOOLS).sort()).toEqual(['send_to_chat', 'set_mode'])
  })

  test('Zod schemas reject invalid modes and empty text', () => {
    expect(SEND_TO_CHAT_PARAMS.safeParse({ text: '' }).success).toBe(false)
    expect(SEND_TO_CHAT_PARAMS.safeParse({ text: 'hello' }).success).toBe(true)
    expect(SET_MODE_PARAMS.safeParse({ mode: 'ask' }).success).toBe(false)
    expect(SET_MODE_PARAMS.safeParse({ mode: 'agent' }).success).toBe(true)
    expect(SET_MODE_PARAMS.safeParse({ mode: 'plan' }).success).toBe(true)
  })
})
