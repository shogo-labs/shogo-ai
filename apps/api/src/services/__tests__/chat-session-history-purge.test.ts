// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A deleted chat wipes its durable transcript (SHO-137).
 *
 * `sessions.db` is S3-synced, so deleting the `ChatSession` row leaves the
 * runtime's copy behind — forever, now that idle eviction no longer deletes
 * anything. These tests pin the three things that matter: the delete reaches
 * the runtime that actually owns the chat, a runtime that cannot be reached
 * never fails the delete, and nothing is invented for a session with no scope.
 */

import { describe, expect, test } from 'bun:test'
import {
  purgeChatSessionHistory,
  type PurgeDeps,
} from '../chat-session-history-purge.service'

function recorder(response: () => Response = () => new Response('{"forgotten":true}', { status: 200 })) {
  const calls: Array<{ kind: string; target: string; path: string; method?: string }> = []
  const deps: PurgeDeps = {
    fetchFromProjectRuntime: async (projectId, path, init) => {
      calls.push({ kind: 'project', target: projectId, path, method: init?.method })
      return response()
    },
    fetchFromWorkspaceRuntime: async (workspaceId, attached, path, init) => {
      calls.push({ kind: 'workspace', target: `${workspaceId}:${attached.length}`, path, method: init?.method })
      return response()
    },
  }
  return { calls, deps }
}

describe('purgeChatSessionHistory', () => {
  test('a project chat is wiped on its project runtime', async () => {
    const { calls, deps } = recorder()
    const outcome = await purgeChatSessionHistory(
      { id: 'chat-1', contextType: 'project', contextId: 'proj-9', workspaceId: 'ws-1' },
      deps,
    )
    expect(outcome).toEqual({ purged: true })
    expect(calls).toEqual([
      { kind: 'project', target: 'proj-9', path: '/agent/sessions/chat-1', method: 'DELETE' },
    ])
  })

  test('a workspace chat is wiped on the workspace runtime, project-anchored when it had one', async () => {
    const { calls, deps } = recorder()
    const outcome = await purgeChatSessionHistory(
      { id: 'chat-2', contextType: 'workspace', contextId: 'proj-9', workspaceId: 'ws-1' },
      deps,
    )
    expect(outcome).toEqual({ purged: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: 'workspace', path: '/agent/sessions/chat-2', method: 'DELETE' })
  })

  test('an unreachable runtime is reported, never thrown', async () => {
    const { deps } = recorder(() => new Response('{"error":"Agent gateway not running"}', { status: 503 }))
    const outcome = await purgeChatSessionHistory(
      { id: 'chat-3', contextType: 'project', contextId: 'proj-9' },
      deps,
    )
    expect(outcome).toEqual({ purged: false, reason: 'runtime_503' })
  })

  test('a throwing fetch is reported, never thrown', async () => {
    const deps: PurgeDeps = {
      fetchFromProjectRuntime: async () => {
        throw new Error('ECONNREFUSED')
      },
      fetchFromWorkspaceRuntime: async () => {
        throw new Error('ECONNREFUSED')
      },
    }
    const outcome = await purgeChatSessionHistory(
      { id: 'chat-4', contextType: 'project', contextId: 'proj-9' },
      deps,
    )
    expect(outcome).toEqual({ purged: false, reason: 'error' })
  })

  test('a session with no project and no workspace wipes nothing', async () => {
    const { calls, deps } = recorder()
    const outcome = await purgeChatSessionHistory({ id: 'chat-5' }, deps)
    expect(outcome).toEqual({ purged: false, reason: 'no_runtime_scope' })
    expect(calls).toEqual([])
  })
})
