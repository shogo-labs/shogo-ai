// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `buildSessionPayload` — the platform-agnostic helper that
 * shapes the payload passed to `@elevenlabs/react`'s `startSession`.
 *
 * Pinned here:
 *   - Consumer-supplied `conversationId` is forwarded as a
 *     `conversation_id` dynamic variable so the agent prompt can
 *     reference `{{conversation_id}}`.
 *   - When no `conversationId` is supplied, the dynamic variable is
 *     omitted entirely (so the agent's configured default applies).
 *   - `agentPromptOverride` and `suppressFirstMessage` interactions
 *     stay independent of the conversationId branch.
 */

import { describe, expect, test } from 'bun:test'
import { buildSessionPayload } from '../shared/sessionPayload'

describe('buildSessionPayload', () => {
  const base = {
    signedUrl: 'wss://example/signed',
    characterName: 'Shogo',
    userContext: 'No prior memories yet.',
  }

  test('emits character_name + user_context as dynamic variables', () => {
    const out = buildSessionPayload(base) as {
      signedUrl: string
      dynamicVariables: Record<string, string>
      overrides?: unknown
    }
    expect(out.signedUrl).toBe('wss://example/signed')
    expect(out.dynamicVariables).toEqual({
      character_name: 'Shogo',
      user_context: 'No prior memories yet.',
    })
    expect(out.overrides).toBeUndefined()
  })

  test('forwards conversationId as conversation_id dynamic variable', () => {
    const out = buildSessionPayload({
      ...base,
      conversationId: 'conv_xyz',
    }) as { dynamicVariables: Record<string, string> }
    expect(out.dynamicVariables.conversation_id).toBe('conv_xyz')
    expect(out.dynamicVariables.character_name).toBe('Shogo')
  })

  test('omits conversation_id when conversationId is undefined or empty', () => {
    const a = buildSessionPayload(base) as {
      dynamicVariables: Record<string, string>
    }
    expect('conversation_id' in a.dynamicVariables).toBe(false)
    const b = buildSessionPayload({ ...base, conversationId: '' }) as {
      dynamicVariables: Record<string, string>
    }
    expect('conversation_id' in b.dynamicVariables).toBe(false)
  })

  test('respects suppressFirstMessage and agentPromptOverride alongside conversationId', () => {
    const out = buildSessionPayload({
      ...base,
      suppressFirstMessage: true,
      agentPromptOverride: 'override prompt',
      conversationId: 'conv_xyz',
    }) as {
      dynamicVariables: Record<string, string>
      overrides: { agent: { firstMessage?: string; prompt?: { prompt: string } } }
    }
    expect(out.dynamicVariables.conversation_id).toBe('conv_xyz')
    expect(out.overrides.agent.firstMessage).toBe('')
    expect(out.overrides.agent.prompt).toEqual({ prompt: 'override prompt' })
  })
})
