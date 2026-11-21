// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SEC-27: a signed-in user could read and write another tenant's chat by
 * passing its session id to their own project's `/chat`.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatSessionBelongsTo, isChatSessionBound } from '../lib/chat-session-binding'

const A_PROJECT = { kind: 'project', projectId: 'proj-a' } as const
const alice = { userId: 'user-alice', via: 'session' }

describe('chatSessionBelongsTo', () => {
  test('a session id with no row yet is a new chat and is allowed', () => {
    expect(chatSessionBelongsTo(null, A_PROJECT, alice)).toBe(true)
  })

  test("another tenant's project chat is refused on my project route", () => {
    const victims = { contextType: 'project', contextId: 'proj-b', workspaceId: null, createdByUserId: null }
    expect(chatSessionBelongsTo(victims, A_PROJECT, alice)).toBe(false)
    expect(chatSessionBelongsTo(victims, A_PROJECT, { ...alice, via: 'runtimeToken' })).toBe(false)
  })

  test('a workspace chat with no project is refused on a project route', () => {
    const ws = { contextType: 'workspace', contextId: null, workspaceId: 'ws-a', createdByUserId: 'user-alice' }
    expect(chatSessionBelongsTo(ws, A_PROJECT, alice)).toBe(false)
  })

  test("this project's own shared chat is allowed", () => {
    const own = { contextType: 'project', contextId: 'proj-a', workspaceId: null, createdByUserId: null }
    expect(chatSessionBelongsTo(own, A_PROJECT, alice)).toBe(true)
  })

  test("someone else's personal chat is refused even in scope, unless a runtime hands off", () => {
    const bobs = { contextType: 'workspace', contextId: null, workspaceId: 'ws-a', createdByUserId: 'user-bob' }
    const scope = { kind: 'workspace', workspaceId: 'ws-a' } as const
    expect(chatSessionBelongsTo(bobs, scope, alice)).toBe(false)
    expect(chatSessionBelongsTo(bobs, scope, { userId: 'user-bob', via: 'session' })).toBe(true)
    expect(chatSessionBelongsTo(bobs, scope, { userId: 'owner', via: 'runtimeToken' })).toBe(true)
  })
})

describe('isChatSessionBound', () => {
  test('loads the row by id and applies the scope', async () => {
    const seen: unknown[] = []
    const db = {
      chatSession: {
        findUnique: async (args: any) => {
          seen.push(args.where)
          return { contextType: 'project', contextId: 'proj-b', workspaceId: null, createdByUserId: null }
        },
      },
    } as any
    expect(await isChatSessionBound('sess-of-b', A_PROJECT, alice, db)).toBe(false)
    expect(seen).toEqual([{ id: 'sess-of-b' }])
  })
})

describe('project-chat routes check the binding before touching history', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'routes', 'project-chat.ts'), 'utf8')

  test('POST /chat checks before the history seed and the user-message write', () => {
    const check = src.indexOf("isChatSessionBound(incomingChatSessionId, { kind: 'project', projectId }")
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(src.indexOf('historySeedForTurn(\n          incomingChatSessionId'))
    expect(check).toBeLessThan(src.indexOf('persistUserMessageForTurn(incomingChatSessionId'))
  })

  test('stream, turn and stop check too', () => {
    expect(src.match(/isChatSessionBound\(chatSessionId, \{ kind: 'project', projectId \}/g)?.length).toBe(2)
    expect(src).toContain("isChatSessionBound(stopSessionId, { kind: 'project', projectId }")
  })
})
