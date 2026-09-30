// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Search upgrades: has:/date filters, attachment text, the embedding
 * indexer, semantic search, and "ask the workspace" with citations.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SHOGO_DATA_DIR = dir

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const search = await import('../services/conversation-search')
const semantic = await import('../services/conversation-semantic')
const fileText = await import('../services/conversation-file-text')

const db = prisma as any
let seed: SeededWorkspace
let generalId: string
let privateId: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

/** Toy embedding: one dimension per concept, with synonyms sharing a dimension. */
const CONCEPTS = [
  ['revenue', 'sales', 'income', 'arr'],
  ['launch', 'ship', 'release'],
  ['bug', 'crash', 'outage', 'incident'],
  ['hiring', 'recruit', 'candidate'],
]
const toyProvider = {
  model: 'toy-1',
  calls: 0,
  async embed(texts: string[]) {
    this.calls++
    return texts.map((t) => {
      const words = t.toLowerCase().split(/[^a-z]+/)
      return CONCEPTS.map((group) => words.filter((w) => group.includes(w)).length)
    })
  },
}

async function find(user: string, q: string, extra = '') {
  const res = await app.request(`/api/workspaces/${seed.workspaceId}/conversations/search?q=${encodeURIComponent(q)}${extra}`, {
    headers: { 'x-user': user },
  })
  const json: any = await res.json()
  return { status: res.status, texts: (json.results ?? []).map((r: any) => r.message.text).sort(), json }
}

const post = (conversationId: string, authorUserId: string, text: string, extra: Record<string, unknown> = {}) =>
  service.postMessage({ conversationId, authorType: 'user', authorUserId, text, ...extra } as any)

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  for (const user of [seed.owner, seed.member, seed.viewer]) await service.listConversationsForUser(seed.workspaceId, user)
  const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
  generalId = list.find((c: any) => c.slug === 'general')!.id
  privateId = (await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: 'money', kind: 'private' })).id

  const report = await db.conversationAttachment.create({
    data: {
      conversationId: generalId, uploaderUserId: seed.owner, storageKey: 'k1', name: 'q3-notes.md', mimeType: 'text/markdown', size: 40,
      extractedText: fileText.extractAttachmentText(new TextEncoder().encode('# Q3\nChurn dropped to 2%'), 'text/markdown', 'q3-notes.md'),
    },
  })
  const photo = await db.conversationAttachment.create({
    data: { conversationId: generalId, uploaderUserId: seed.owner, storageKey: 'k2', name: 'team.png', mimeType: 'image/png', size: 10 },
  })
  await post(generalId, seed.owner, 'Here are the notes', { attachmentIds: [report.id] })
  await post(generalId, seed.owner, 'Offsite photo', { attachmentIds: [photo.id] })
  await post(generalId, seed.member, 'Docs are at https://example.com/docs')
  const pinned = await post(generalId, seed.member, 'Release checklist lives here')
  await db.conversationPin.create({ data: { conversationId: generalId, messageId: pinned.row.id, pinnedById: seed.owner } })
  await post(generalId, seed.member, 'We will ship the release on Friday')
  await post(generalId, seed.owner, 'The crash on login is fixed')
  await post(privateId, seed.owner, 'Sales numbers beat the plan this quarter')
  const old = await post(generalId, seed.member, 'Old kickoff from the summer')
  await db.conversationMessage.update({ where: { id: old.row.id }, data: { createdAt: new Date('2026-07-15T12:00:00Z') } })
})

afterAll(async () => {
  semantic._setEmbeddingProviderForTests(undefined)
  semantic._setAskRunnerForTests(null)
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('query parsing', () => {
  test('has: and date filters are pulled out; unknown values stay as words', () => {
    const q = search.parseSearchQuery('plan has:files has:link before:2026-09-01 after:yesterday during:today has:nonsense')
    expect(q.has).toEqual(['file', 'link'])
    expect(q).toMatchObject({ before: '2026-09-01', after: 'yesterday', on: 'today', text: 'plan has:nonsense' })
  })

  test('local day boundaries follow the time zone', () => {
    expect(search.localDayStart('2026-09-01', 'UTC').toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(search.localDayStart('2026-09-01', 'America/New_York').toISOString()).toBe('2026-09-01T04:00:00.000Z')
    const now = new Date('2026-09-30T02:00:00Z')
    expect(search.localDayStart('today', 'America/Los_Angeles', now).toISOString()).toBe('2026-09-29T07:00:00.000Z')
    expect(search.localDayStart('yesterday', 'UTC', now).toISOString()).toBe('2026-09-29T00:00:00.000Z')
  })
})

describe('filters and file text', () => {
  test('has:file, has:image, has:link, has:pin', async () => {
    expect((await find(seed.owner, 'has:file')).texts).toEqual(['Here are the notes', 'Offsite photo'])
    expect((await find(seed.owner, 'has:image')).texts).toEqual(['Offsite photo'])
    expect((await find(seed.owner, 'has:link')).texts).toEqual(['Docs are at https://example.com/docs'])
    expect((await find(seed.owner, 'has:pin')).texts).toEqual(['Release checklist lives here'])
    expect((await find(seed.owner, 'release has:pin')).texts).toEqual(['Release checklist lives here'])
  })

  test('before:, after:, and on: bound by day', async () => {
    expect((await find(seed.owner, 'kickoff before:2026-08-01')).texts).toEqual(['Old kickoff from the summer'])
    expect((await find(seed.owner, 'kickoff after:2026-08-01')).texts).toEqual([])
    expect((await find(seed.owner, 'on:2026-07-15')).texts).toEqual(['Old kickoff from the summer'])
    expect((await find(seed.owner, 'on:2026-07-14')).texts).toEqual([])
    expect((await find(seed.owner, 'after:2026-09-01 before:2026-08-01')).texts).toEqual([])
  })

  test('attachment names and extracted text are searchable', async () => {
    expect((await find(seed.owner, 'churn')).texts).toEqual(['Here are the notes'])
    expect((await find(seed.owner, 'q3-notes')).texts).toEqual(['Here are the notes'])
  })

  test('text extraction skips binary files and caps length', () => {
    expect(fileText.extractAttachmentText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]), 'image/png', 'a.png')).toBeNull()
    expect(fileText.extractAttachmentText(new Uint8Array([104, 0, 105]), 'text/plain', 'a.txt')).toBeNull()
    expect(fileText.extractAttachmentText(new TextEncoder().encode('<p>Hello   <b>there</b></p>'), 'text/html', 'a.html')).toBe('Hello there')
    expect(fileText.extractAttachmentText(new TextEncoder().encode('const a = 1'), 'application/octet-stream', 'x.ts')).toBe('const a = 1')
    const long = fileText.extractAttachmentText(new TextEncoder().encode('a'.repeat(200_000)), 'text/plain', 'big.txt')
    expect(long!.length).toBe(fileText.MAX_EXTRACTED_CHARS)
  })
})

describe('semantic search', () => {
  test('is unavailable without an embedding provider', async () => {
    semantic._setEmbeddingProviderForTests(null)
    expect(await semantic.indexPendingMessages()).toBe(0)
    const res = await find(seed.owner, 'revenue', '&mode=semantic')
    expect(res.json.semantic).toBe(false)
  })

  test('the indexer embeds every recent message once and re-embeds after edits', async () => {
    semantic._setEmbeddingProviderForTests(toyProvider)
    const now = new Date()
    let total = 0
    for (let n = await semantic.indexPendingMessages(now, 3); n; n = await semantic.indexPendingMessages(now, 3)) total += n
    const recent = await db.conversationMessage.count({
      where: { workspaceId: seed.workspaceId, deletedAt: null, authorType: { not: 'system' }, createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) } },
    })
    expect(total).toBe(recent)
    expect(await semantic.indexPendingMessages(now)).toBe(0)

    const crash = await db.conversationMessage.findFirst({ where: { text: 'The crash on login is fixed' } })
    await service.editMessage(crash.id, seed.owner, 'The outage on login is fixed')
    expect(await semantic.indexPendingMessages(now)).toBe(1)
  })

  test('finds messages by meaning, only where the viewer can read', async () => {
    const owner = await find(seed.owner, 'what was our revenue?', '&mode=semantic')
    expect(owner.json.semantic).toBe(true)
    expect(owner.texts).toEqual(['Sales numbers beat the plan this quarter'])
    expect((await find(seed.viewer, 'what was our revenue?', '&mode=semantic')).texts).toEqual([])
    expect((await find(seed.owner, 'was there an incident?', '&mode=semantic')).texts).toEqual(['The outage on login is fixed'])
  })
})

describe('ask the workspace', () => {
  async function ask(user: string, question: string) {
    const res = await app.request(`/api/workspaces/${seed.workspaceId}/conversations/ask`, {
      method: 'POST',
      headers: { 'x-user': user, 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    })
    return { status: res.status, json: (await res.json()) as any }
  }

  test('answers from readable sources and marks which ones were cited', async () => {
    let prompt = ''
    semantic._setAskRunnerForTests(async (args) => {
      prompt = args.prompt
      return { text: 'Sales beat the plan [1].', failed: false }
    })
    const { status, json } = await ask(seed.owner, 'How did revenue do?')
    expect(status).toBe(200)
    expect(json.answer).toBe('Sales beat the plan [1].')
    expect(json.citations[0]).toMatchObject({ n: 1, cited: true, message: { text: 'Sales numbers beat the plan this quarter' } })
    expect(json.citations[0].conversation.name).toBe('money')
    expect(prompt).toContain('[1] ')
    expect(prompt).toContain('#money')

    const viewer = await ask(seed.viewer, 'How did revenue do?')
    expect(viewer.json.citations.map((c: any) => c.message.text)).not.toContain('Sales numbers beat the plan this quarter')
  })

  test('falls back to keyword sources without embeddings', async () => {
    semantic._setEmbeddingProviderForTests(null)
    semantic._setAskRunnerForTests(async () => ({ text: 'It ships Friday [1].', failed: false }))
    const { json } = await ask(seed.owner, 'When is the release happening?')
    expect(json.semantic).toBe(false)
    expect(json.citations.map((c: any) => c.message.text)).toContain('We will ship the release on Friday')
  })

  test('rejects empty questions and reports agent failures', async () => {
    expect((await ask(seed.owner, '  ')).status).toBe(400)
    semantic._setAskRunnerForTests(async () => ({ text: '', failed: true, error: 'down' }))
    expect((await ask(seed.owner, 'When is the release happening?')).status).toBe(502)
    expect((await ask(seed.outsider, 'anything')).status).toBe(403)
  })
})
