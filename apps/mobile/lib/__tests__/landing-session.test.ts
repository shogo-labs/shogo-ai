// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  ensureLandingSession,
  LANDING_SESSION_NAME,
  pickReusableLandingSession,
  type LandingSessionCandidate,
} from '../landing-session'

function session(
  id: string,
  overrides: Partial<LandingSessionCandidate> = {},
): LandingSessionCandidate {
  return { id, inferredName: LANDING_SESSION_NAME, messageCount: 0, ...overrides }
}

function deps(sessions: LandingSessionCandidate[], listed: string[] = []) {
  const created: string[] = []
  return {
    created,
    list: async (workspaceId: string) => {
      listed.push(workspaceId)
      return sessions
    },
    create: async () => {
      created.push('created')
      return { id: 'fresh' }
    },
  }
}

describe('pickReusableLandingSession', () => {
  test('reuses the newest empty landing chat', () => {
    expect(pickReusableLandingSession([session('a'), session('b')])).toBe('a')
  })

  test('skips chats that already have a conversation', () => {
    expect(
      pickReusableLandingSession([
        session('used', { messageCount: 3 }),
        session('empty'),
      ]),
    ).toBe('empty')
  })

  test('ignores chats another surface created, even when empty', () => {
    expect(
      pickReusableLandingSession([
        session('sidebar', { inferredName: null }),
        session('sidebar-named', { inferredName: 'New chat' }),
        session('archived', { isArchived: true }),
      ]),
    ).toBeNull()
  })

  test('treats an unreported message count as used', () => {
    expect(
      pickReusableLandingSession([session('unknown', { messageCount: undefined })]),
    ).toBeNull()
  })
})

describe('ensureLandingSession', () => {
  test('creates one when the user has no chats', async () => {
    const d = deps([])
    await expect(ensureLandingSession('ws-1', d)).resolves.toEqual({ id: 'fresh' })
    expect(d.created).toHaveLength(1)
  })

  test('reuses the empty landing chat without creating another', async () => {
    const d = deps([session('empty')])
    await expect(ensureLandingSession('ws-1', d)).resolves.toEqual({ id: 'empty' })
    expect(d.created).toHaveLength(0)
  })

  test('creates a fresh chat once the landing chat has messages', async () => {
    const d = deps([session('used', { messageCount: 2 })])
    await expect(ensureLandingSession('ws-1', d)).resolves.toEqual({ id: 'fresh' })
    expect(d.created).toHaveLength(1)
  })

  test('lists for the workspace it was asked about', async () => {
    const listed: string[] = []
    await ensureLandingSession('ws-9', deps([session('empty')], listed))
    expect(listed).toEqual(['ws-9'])
  })

  test('falls back to creating when the list fails', async () => {
    const created: string[] = []
    const res = await ensureLandingSession('ws-1', {
      list: async () => {
        throw new Error('offline')
      },
      create: async () => {
        created.push('yes')
        return { id: 'fresh' }
      },
    })
    expect(res).toEqual({ id: 'fresh' })
    expect(created).toHaveLength(1)
  })
})
