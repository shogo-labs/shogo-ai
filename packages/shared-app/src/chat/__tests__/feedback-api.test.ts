// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the feedback-api helpers.
 *
 * Locks the client-side contract used by the turn footer's
 * thumbs up/down buttons:
 *   1. setMessageFeedback: PUTs (via `request`, since HttpClient has
 *      no `.put()` helper) to /:id/feedback with { thumbs }; throws
 *      on non-ok bodies.
 *   2. clearMessageFeedback: DELETEs /:id/feedback; resolves on ok,
 *      throws on non-ok.
 *   3. getSessionFeedback: GETs /api/chat-sessions/:id/feedback and
 *      returns the `feedback` map; throws on non-ok bodies.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  setMessageFeedback,
  clearMessageFeedback,
  getSessionFeedback,
} from '../feedback-api'

function makeFakeCollection(opts: {
  httpRequest?: ReturnType<typeof vi.fn>
  httpDelete?: ReturnType<typeof vi.fn>
  httpGet?: ReturnType<typeof vi.fn>
}) {
  const collection: any = {}
  collection.__env = {
    http: {
      request: opts.httpRequest ?? vi.fn(),
      delete: opts.httpDelete ?? vi.fn(),
      get: opts.httpGet ?? vi.fn(),
    },
  }
  return { collection }
}

vi.mock('mobx-state-tree', () => ({
  getEnv: (node: any) => node.__env,
}))

describe('setMessageFeedback', () => {
  it('PUTs to /api/chat-messages/:id/feedback via request() with method: PUT', async () => {
    const httpRequest = vi.fn(async (_path: string, _options: any) => ({
      data: {
        ok: true,
        data: {
          messageId: 'm1',
          thumbs: 'up',
          createdAt: '2026-05-17T20:00:00.000Z',
          updatedAt: '2026-05-17T20:00:00.000Z',
        },
      },
    }))
    const { collection } = makeFakeCollection({ httpRequest })

    const result = await setMessageFeedback(collection, 'm1', 'up')

    expect(httpRequest).toHaveBeenCalledTimes(1)
    expect(httpRequest).toHaveBeenCalledWith('/api/chat-messages/m1/feedback', {
      method: 'PUT',
      body: { thumbs: 'up' },
    })
    expect(result.data.thumbs).toBe('up')
    expect(result.data.messageId).toBe('m1')
  })

  it('throws when the server response is non-ok', async () => {
    const httpRequest = vi.fn(async () => ({ data: { ok: false } }))
    const { collection } = makeFakeCollection({ httpRequest })

    await expect(setMessageFeedback(collection, 'm1', 'down')).rejects.toThrow(
      'Failed to set message feedback',
    )
  })
})

describe('clearMessageFeedback', () => {
  it('DELETEs /api/chat-messages/:id/feedback', async () => {
    const httpDelete = vi.fn(async () => ({ data: { ok: true } }))
    const { collection } = makeFakeCollection({ httpDelete })

    await clearMessageFeedback(collection, 'm1')

    expect(httpDelete).toHaveBeenCalledTimes(1)
    expect(httpDelete).toHaveBeenCalledWith('/api/chat-messages/m1/feedback')
  })

  it('throws when the server response is non-ok', async () => {
    const httpDelete = vi.fn(async () => ({ data: { ok: false } }))
    const { collection } = makeFakeCollection({ httpDelete })

    await expect(clearMessageFeedback(collection, 'm1')).rejects.toThrow(
      'Failed to clear message feedback',
    )
  })
})

describe('getSessionFeedback', () => {
  it('GETs /api/chat-sessions/:id/feedback and returns the feedback map', async () => {
    const httpGet = vi.fn(async () => ({
      data: { ok: true, feedback: { m1: 'up', m2: 'down' } },
    }))
    const { collection } = makeFakeCollection({ httpGet })

    const result = await getSessionFeedback(collection, 's1')

    expect(httpGet).toHaveBeenCalledTimes(1)
    expect(httpGet).toHaveBeenCalledWith('/api/chat-sessions/s1/feedback')
    expect(result).toEqual({ m1: 'up', m2: 'down' })
  })

  it('defaults to an empty object when the feedback field is missing', async () => {
    const httpGet = vi.fn(async () => ({ data: { ok: true } }))
    const { collection } = makeFakeCollection({ httpGet })

    const result = await getSessionFeedback(collection, 's1')
    expect(result).toEqual({})
  })

  it('throws when the server response is non-ok', async () => {
    const httpGet = vi.fn(async () => ({ data: { ok: false } }))
    const { collection } = makeFakeCollection({ httpGet })

    await expect(getSessionFeedback(collection, 's1')).rejects.toThrow(
      'Failed to load session feedback',
    )
  })
})
