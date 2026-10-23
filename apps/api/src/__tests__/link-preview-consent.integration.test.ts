// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The sender's refusal to preview a link, stored on the message.
 *
 * What matters here is what is *not* stored: the message carries the URLs whose
 * preview was declined, and nothing at all about the conversations they point
 * into. A message in a public channel must never become a place where a private
 * channel's content waits to be read by somebody who cannot open it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const { normalizeLinkPreviewOptOuts } = await import('../services/conversation.service')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function newChannel(name: string) {
  const res = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name, kind: 'public' })
  expect(res.status).toBe(201)
  return res.json.conversation.id as string
}

async function post(channelId: string, text: string, extra: Record<string, unknown> = {}) {
  return call(seed.owner, 'POST', `/conversations/${channelId}/messages`, {
    text,
    clientMsgId: crypto.randomUUID(),
    ...extra,
  })
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('normalizeLinkPreviewOptOuts', () => {
  test('keeps http(s) URLs, in order, once each', () => {
    expect(normalizeLinkPreviewOptOuts(['https://a.example/c/1', 'https://a.example/c/1', 'http://b.example/c/2']))
      .toEqual(['https://a.example/c/1', 'http://b.example/c/2'])
  })

  test('drops anything that is not one', () => {
    expect(normalizeLinkPreviewOptOuts(['not a url', '', 'javascript:alert(1)', 42, null, {}, 'ftp://x/y']))
      .toEqual([])
  })

  test('is not an array, is nothing', () => {
    expect(normalizeLinkPreviewOptOuts(undefined)).toEqual([])
    expect(normalizeLinkPreviewOptOuts('https://a.example/c/1')).toEqual([])
    expect(normalizeLinkPreviewOptOuts(null)).toEqual([])
  })

  test('a hostile payload cannot grow the block without bound', () => {
    const many = Array.from({ length: 500 }, (_, i) => `https://a.example/c/${i}`)
    expect(normalizeLinkPreviewOptOuts(many)).toHaveLength(20)
  })

  test('an absurdly long URL is refused', () => {
    expect(normalizeLinkPreviewOptOuts([`https://a.example/${'x'.repeat(3000)}`])).toEqual([])
  })
})

describe('posting a message with a refused preview', () => {
  test('the refusal is stored on the message', async () => {
    const channelId = await newChannel('optout-store')
    const href = `https://studio.shogo.ai/c/private-1?msg=abc`
    const res = await post(channelId, `see ${href}`, { linkPreviewsOff: [href] })
    expect(res.status).toBe(201)
    expect(res.json.message.blocks.linkPreviewsOff).toEqual([href])
  })

  test('nothing about the linked conversation is stored', async () => {
    const channelId = await newChannel('optout-content')
    const href = 'https://studio.shogo.ai/c/private-1?msg=abc'
    const res = await post(channelId, `see ${href}`, { linkPreviewsOff: [href] })
    const blocks = JSON.stringify(res.json.message.blocks)
    // Only the URL — not a title, not a snippet, not an author.
    expect(blocks).not.toContain('"text"')
    expect(blocks).not.toContain('"author"')
    expect(blocks).not.toContain('"title"')
    expect(blocks).toContain('private-1')
  })

  test('junk in the field is dropped rather than stored', async () => {
    const channelId = await newChannel('optout-junk')
    const res = await post(channelId, 'nothing to see', {
      linkPreviewsOff: ['nonsense', 7, null, 'https://studio.shogo.ai/c/x'],
    })
    expect(res.json.message.blocks.linkPreviewsOff).toEqual(['https://studio.shogo.ai/c/x'])
  })

  test('no refusal means no block at all, exactly as before', async () => {
    const channelId = await newChannel('optout-none')
    const res = await post(channelId, 'an ordinary message')
    expect(res.json.message.blocks).toBeNull()
  })

  test('an empty list is treated as no refusal', async () => {
    const channelId = await newChannel('optout-empty')
    const res = await post(channelId, 'an ordinary message', { linkPreviewsOff: [] })
    expect(res.json.message.blocks).toBeNull()
  })
})
