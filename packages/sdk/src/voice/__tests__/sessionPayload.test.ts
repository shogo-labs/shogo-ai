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
import {
  buildSessionPayload,
  withProjectId,
  withProjectQuery,
} from '../shared/sessionPayload'

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

  test('merges consumer-supplied dynamicVariables alongside built-ins', () => {
    const out = buildSessionPayload({
      ...base,
      dynamicVariables: {
        user_display_name: 'Alex',
        relationship_stage: 'friend',
      },
    }) as { dynamicVariables: Record<string, string> }
    expect(out.dynamicVariables).toEqual({
      user_display_name: 'Alex',
      relationship_stage: 'friend',
      character_name: 'Shogo',
      user_context: 'No prior memories yet.',
    })
  })

  test('built-ins WIN on collision — consumer cannot override character_name / user_context', () => {
    const out = buildSessionPayload({
      ...base,
      dynamicVariables: {
        character_name: 'NotShogo',
        user_context: 'attempted override',
        custom: 'still kept',
      },
    }) as { dynamicVariables: Record<string, string> }
    expect(out.dynamicVariables.character_name).toBe('Shogo')
    expect(out.dynamicVariables.user_context).toBe('No prior memories yet.')
    expect(out.dynamicVariables.custom).toBe('still kept')
  })

  test('built-in conversation_id wins over consumer-supplied collision', () => {
    const out = buildSessionPayload({
      ...base,
      conversationId: 'conv_real',
      dynamicVariables: { conversation_id: 'conv_attempted' },
    }) as { dynamicVariables: Record<string, string> }
    expect(out.dynamicVariables.conversation_id).toBe('conv_real')
  })

  test('coerces non-string values and drops null/undefined', () => {
    const out = buildSessionPayload({
      ...base,
      dynamicVariables: {
        a_number: 42 as unknown as string,
        a_bool: true as unknown as string,
        a_null: null as unknown as string,
        a_undef: undefined as unknown as string,
        an_array: [1, 2] as unknown as string,
      },
    }) as { dynamicVariables: Record<string, string> }
    expect(out.dynamicVariables.a_number).toBe('42')
    expect(out.dynamicVariables.a_bool).toBe('true')
    expect('a_null' in out.dynamicVariables).toBe(false)
    expect('a_undef' in out.dynamicVariables).toBe(false)
    // Arrays land as their `String(...)` value — `'1,2'`.
    expect(out.dynamicVariables.an_array).toBe('1,2')
  })

  test('null / undefined dynamicVariables is a no-op', () => {
    const a = buildSessionPayload({ ...base, dynamicVariables: null }) as {
      dynamicVariables: Record<string, string>
    }
    const b = buildSessionPayload({
      ...base,
      dynamicVariables: undefined,
    }) as { dynamicVariables: Record<string, string> }
    expect(a.dynamicVariables).toEqual({
      character_name: 'Shogo',
      user_context: 'No prior memories yet.',
    })
    expect(b.dynamicVariables).toEqual(a.dynamicVariables)
  })
})

describe('withProjectQuery', () => {
  const base = '/api/voice/signed-url'

  test('returns the path unchanged when no params are set', () => {
    expect(withProjectQuery(base, {})).toBe(base)
    expect(withProjectQuery(base, { projectId: '', agentName: '' })).toBe(base)
  })

  test('appends projectId only', () => {
    expect(withProjectQuery(base, { projectId: 'p_1' })).toBe(
      '/api/voice/signed-url?projectId=p_1',
    )
  })

  test('appends agentName only', () => {
    expect(withProjectQuery(base, { agentName: 'architect' })).toBe(
      '/api/voice/signed-url?agentName=architect',
    )
  })

  test('appends both with & separator in stable order', () => {
    expect(
      withProjectQuery(base, { projectId: 'p_1', agentName: 'architect' }),
    ).toBe('/api/voice/signed-url?projectId=p_1&agentName=architect')
  })

  test('preserves an existing query string with & separator', () => {
    expect(
      withProjectQuery('/api/voice/signed-url?foo=bar', {
        projectId: 'p_1',
        agentName: 'architect',
      }),
    ).toBe('/api/voice/signed-url?foo=bar&projectId=p_1&agentName=architect')
  })

  test('URL-encodes both values', () => {
    expect(
      withProjectQuery(base, {
        projectId: 'p with spaces',
        agentName: 'a/b&c',
      }),
    ).toBe(
      '/api/voice/signed-url?projectId=p%20with%20spaces&agentName=a%2Fb%26c',
    )
  })
})

describe('withProjectId (legacy shim)', () => {
  test('still works as a thin wrapper around withProjectQuery', () => {
    expect(withProjectId('/api/voice/signed-url', 'p_1')).toBe(
      '/api/voice/signed-url?projectId=p_1',
    )
    expect(withProjectId('/api/voice/signed-url', undefined)).toBe(
      '/api/voice/signed-url',
    )
  })
})
