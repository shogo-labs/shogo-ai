// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the message-edit-api helpers.
 *
 * Locks the client-side contract used by ChatPanel's edit / retry
 * flows:
 *   1. truncateMessagesFrom: POSTs to truncate-from + evicts local
 *      rows; throws on non-ok bodies; tolerates missing local rows.
 *   2. getPrecedingCheckpoint: GETs preceding-checkpoint via env.http
 *      so remote-routing still applies; throws on non-ok bodies;
 *      passes through soft-fail bodies (checkpoint=null + reason).
 *   3. rollbackProjectToCheckpoint: POSTs the existing rollback
 *      endpoint via env.http; dispatches SHOGO_FILES_REVERTED_EVENT
 *      on success; throws on non-ok bodies; survives environments
 *      without window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  truncateMessagesFrom,
  getPrecedingCheckpoint,
  rollbackProjectToCheckpoint,
  SHOGO_FILES_REVERTED_EVENT,
  type FilesRevertedDetail,
} from '../message-edit-api'

// Minimal in-memory stand-in for an MST `IChatMessageCollection`.
// Real collections are MST models, but `truncateMessagesFrom` only
// touches `get`, `all`, `removeItem` and the env hung off them, so
// a plain object plus an env-attached property satisfies the
// contract the helpers rely on.
function makeFakeCollection(opts: {
  items: Array<{ id: string; sessionId: string; createdAt: number }>
  httpPost?: ReturnType<typeof vi.fn>
  httpGet?: ReturnType<typeof vi.fn>
}) {
  const itemsMap = new Map(opts.items.map((m) => [m.id, m]))
  const removeItem = vi.fn((id: string) => {
    itemsMap.delete(id)
  })
  const collection: any = {
    get(id: string) {
      return itemsMap.get(id)
    },
    get all() {
      return Array.from(itemsMap.values())
    },
    removeItem,
  }
  collection.__env = {
    http: {
      post: opts.httpPost ?? vi.fn(),
      get: opts.httpGet ?? vi.fn(),
    },
  }
  return { collection, removeItem, itemsMap }
}

// Hijack `getEnv` so it returns the env we attach to each collection.
vi.mock('mobx-state-tree', () => ({
  getEnv: (node: any) => node.__env,
}))

describe('truncateMessagesFrom', () => {
  it('POSTs to /api/chat-messages/:id/truncate-from and evicts target + later same-session rows', async () => {
    const httpPost = vi.fn(async (_url: string, _body: any) => ({
      data: { ok: true, sessionId: 's1', deletedCount: 3 },
    }))
    const { collection, removeItem, itemsMap } = makeFakeCollection({
      httpPost,
      items: [
        { id: 'a', sessionId: 's1', createdAt: 1000 },
        { id: 'b', sessionId: 's1', createdAt: 2000 },
        { id: 'c', sessionId: 's1', createdAt: 3000 }, // target
        { id: 'd', sessionId: 's1', createdAt: 4000 },
        { id: 'e', sessionId: 's1', createdAt: 5000 },
        { id: 'other', sessionId: 's2', createdAt: 3500 },
      ],
    })

    const result = await truncateMessagesFrom(collection, 'c')

    expect(result).toEqual({ ok: true, sessionId: 's1', deletedCount: 3 })
    expect(httpPost).toHaveBeenCalledTimes(1)
    expect(httpPost).toHaveBeenCalledWith(
      '/api/chat-messages/c/truncate-from',
      {},
    )

    // c/d/e gone, a/b preserved, sibling-session row untouched.
    expect(itemsMap.has('a')).toBe(true)
    expect(itemsMap.has('b')).toBe(true)
    expect(itemsMap.has('c')).toBe(false)
    expect(itemsMap.has('d')).toBe(false)
    expect(itemsMap.has('e')).toBe(false)
    expect(itemsMap.has('other')).toBe(true)
    expect(removeItem).toHaveBeenCalledWith('c')
    expect(removeItem).toHaveBeenCalledWith('d')
    expect(removeItem).toHaveBeenCalledWith('e')
    expect(removeItem).not.toHaveBeenCalledWith('other')
  })

  it('throws when the server response is non-ok so callers do not silently send a doomed retry', async () => {
    const httpPost = vi.fn(async () => ({ data: { ok: false } }))
    const { collection } = makeFakeCollection({
      httpPost,
      items: [{ id: 'a', sessionId: 's1', createdAt: 1000 }],
    })

    await expect(truncateMessagesFrom(collection, 'a')).rejects.toThrow(
      'Failed to truncate messages',
    )
  })

  it('tolerates a missing local row (e.g. cache evicted by another tab) and still resolves with the server result', async () => {
    const httpPost = vi.fn(async () => ({
      data: { ok: true, sessionId: 's1', deletedCount: 0 },
    }))
    const { collection, removeItem } = makeFakeCollection({
      httpPost,
      items: [], // local cache is empty even though server has the row
    })

    const result = await truncateMessagesFrom(collection, 'ghost')
    expect(result.deletedCount).toBe(0)
    // No local rows to remove, so no removeItem calls — but the
    // function did NOT throw, which is the important behavior.
    expect(removeItem).not.toHaveBeenCalled()
  })
})

describe('getPrecedingCheckpoint', () => {
  it('GETs /api/chat-messages/:id/preceding-checkpoint and returns the body as-is', async () => {
    const httpGet = vi.fn(async (_url: string) => ({
      data: {
        ok: true,
        checkpoint: {
          id: 'cp-2',
          name: null,
          commitMessage: 'AI: edit_file (1 tool calls)',
          filesChanged: 2,
          additions: 7,
          deletions: 1,
          isAutomatic: true,
          includesDb: false,
          createdAt: '2026-05-17T20:00:00.000Z',
        },
        projectId: 'proj-1',
      },
    }))
    const { collection } = makeFakeCollection({
      httpGet,
      items: [{ id: 'msg-x', sessionId: 's1', createdAt: 5000 }],
    })

    const result = await getPrecedingCheckpoint(collection, 'msg-x')

    expect(httpGet).toHaveBeenCalledTimes(1)
    expect(httpGet).toHaveBeenCalledWith(
      '/api/chat-messages/msg-x/preceding-checkpoint',
    )
    expect(result.ok).toBe(true)
    expect(result.checkpoint?.id).toBe('cp-2')
    expect(result.projectId).toBe('proj-1')
  })

  it('passes through soft-fail bodies (checkpoint=null + reason) without throwing', async () => {
    // The route deliberately returns 200 + null for the "no
    // rollback available" cases — the helper must mirror that
    // so the dialog can render an inline hint instead of treating
    // the absence as a hard error.
    const httpGet = vi.fn(async () => ({
      data: {
        ok: true,
        checkpoint: null,
        reason: 'no_checkpoint',
      },
    }))
    const { collection } = makeFakeCollection({
      httpGet,
      items: [{ id: 'm', sessionId: 's1', createdAt: 5000 }],
    })

    const result = await getPrecedingCheckpoint(collection, 'm')
    expect(result.checkpoint).toBeNull()
    expect(result.reason).toBe('no_checkpoint')
  })

  it('throws on non-ok server bodies so callers can surface a real failure', async () => {
    const httpGet = vi.fn(async () => ({ data: { ok: false } }))
    const { collection } = makeFakeCollection({
      httpGet,
      items: [{ id: 'm', sessionId: 's1', createdAt: 1000 }],
    })

    await expect(getPrecedingCheckpoint(collection, 'm')).rejects.toThrow(
      'Failed to look up preceding checkpoint',
    )
  })
})

describe('rollbackProjectToCheckpoint', () => {
  // The helper dispatches a window event on success. Set up a fresh
  // listener per test and tear it down afterwards so cross-test
  // bleed doesn't make assertions flaky.
  let received: FilesRevertedDetail | null = null
  let listener: ((e: Event) => void) | null = null

  beforeEach(() => {
    received = null
    listener = (e: Event) => {
      received = (e as CustomEvent<FilesRevertedDetail>).detail
    }
    if (typeof window !== 'undefined') {
      window.addEventListener(SHOGO_FILES_REVERTED_EVENT, listener)
    }
  })

  afterEach(() => {
    if (typeof window !== 'undefined' && listener) {
      window.removeEventListener(SHOGO_FILES_REVERTED_EVENT, listener)
    }
  })

  it('POSTs to /api/projects/:projectId/checkpoints/:checkpointId/rollback', async () => {
    const httpPost = vi.fn(async () => ({ data: { ok: true } }))
    const { collection } = makeFakeCollection({
      httpPost,
      items: [],
    })

    const result = await rollbackProjectToCheckpoint(collection, {
      projectId: 'proj-1',
      checkpointId: 'cp-1',
      checkpointCreatedAt: '2026-05-17T20:00:00.000Z',
    })

    expect(httpPost).toHaveBeenCalledTimes(1)
    // includeDatabase defaults to false — we never want a chat-edit
    // flow to surprise the user with a DB restore. The detailed
    // "include database" affordance lives in the CheckpointsPanel.
    expect(httpPost).toHaveBeenCalledWith(
      '/api/projects/proj-1/checkpoints/cp-1/rollback',
      { includeDatabase: false },
    )
    expect(result.projectId).toBe('proj-1')
    expect(result.checkpointId).toBe('cp-1')
  })

  it('forwards includeDatabase: true when the caller asks for it', async () => {
    const httpPost = vi.fn(async () => ({ data: { ok: true } }))
    const { collection } = makeFakeCollection({ httpPost, items: [] })

    await rollbackProjectToCheckpoint(collection, {
      projectId: 'proj-1',
      checkpointId: 'cp-1',
      checkpointCreatedAt: '2026-05-17T20:00:00.000Z',
      includeDatabase: true,
    })

    expect(httpPost).toHaveBeenCalledWith(
      '/api/projects/proj-1/checkpoints/cp-1/rollback',
      { includeDatabase: true },
    )
  })

  it('dispatches SHOGO_FILES_REVERTED on window after a successful rollback', async () => {
    // jsdom (vitest default) provides `window`; the helper's `window`
    // guard is for native (Hermes) only. We assert here that the
    // event fires with the projectId/checkpointId/createdAt in the
    // detail so listeners can filter to the right project.
    if (typeof window === 'undefined') return

    const httpPost = vi.fn(async () => ({ data: { ok: true } }))
    const { collection } = makeFakeCollection({ httpPost, items: [] })

    await rollbackProjectToCheckpoint(collection, {
      projectId: 'proj-1',
      checkpointId: 'cp-99',
      checkpointCreatedAt: '2026-05-17T20:00:00.000Z',
    })

    expect(received).not.toBeNull()
    expect(received).toEqual({
      projectId: 'proj-1',
      checkpointId: 'cp-99',
      checkpointCreatedAt: '2026-05-17T20:00:00.000Z',
    })
  })

  it('throws on a non-ok body so the caller can surface the failure and skip the resend', async () => {
    const httpPost = vi.fn(async () => ({ data: { ok: false } }))
    const { collection } = makeFakeCollection({ httpPost, items: [] })

    await expect(
      rollbackProjectToCheckpoint(collection, {
        projectId: 'proj-1',
        checkpointId: 'cp-1',
        checkpointCreatedAt: '2026-05-17T20:00:00.000Z',
      }),
    ).rejects.toThrow('Rollback failed')

    // When the rollback failed we must NOT have notified the world —
    // file-tree views would refetch and find nothing changed,
    // confusing the user.
    expect(received).toBeNull()
  })
})
