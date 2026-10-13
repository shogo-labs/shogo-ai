// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Conversation files: who can see them (people and agents), the Files list,
 * the agent file routes (list, search, read, download), chunking and search.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const localStorage = process.env.SHOGO_LOCAL_MODE === 'true'

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const semantic = await import('../services/conversation-semantic')
const files = await import('../lib/conversation-files')
const index = await import('../services/conversation-file-index')
const access = await import('../services/conversation-file-access')
const dispatcher = await import('../services/conversation-agent-dispatcher')

const db = prisma as any
let seed: SeededWorkspace
let reviewer: string
let generalId: string
let privateId: string
let dmId: string
let agentDmId: string
let archivedId: string
let reviewId: string
const ids: Record<string, string> = {}
let agentAuth: { projectId: string | null | undefined } = { projectId: null }

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: agentAuth.projectId }),
}))

async function get(path: string, user?: string) {
  const res = await app.request(`/api${path}`, { headers: user ? { 'x-user': user } : {} })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, headers: res.headers, json: type.includes('json') ? await res.json() : null, res }
}
const agent = (path: string, workspaceId = seed.workspaceId) => get(`/internal/workspaces/${workspaceId}/agent-channels${path}`)
const names = (list: any[]) => list.map((f) => f.name).sort()

/** Toy embedding: one dimension per concept, with synonyms sharing a dimension. */
const CONCEPTS = [
  ['revenue', 'sales', 'income', 'arr'],
  ['launch', 'ship', 'release'],
  ['hiring', 'recruit', 'candidate'],
]
const toyProvider = {
  model: 'toy-1',
  async embed(texts: string[]) {
    return texts.map((t) => {
      const words = t.toLowerCase().split(/[^a-z]+/)
      return CONCEPTS.map((group) => words.filter((w) => group.includes(w)).length)
    })
  },
}

/** Uploads a file as `uploader` and sends it in a message, like the composer does. */
async function share(conversationId: string, uploader: string, name: string, body: string, opts: { mimeType?: string; text?: string; extract?: boolean } = {}) {
  const mimeType = opts.mimeType ?? 'text/plain'
  const storageKey = files.buildConversationFileKey(seed.workspaceId, conversationId, name)
  const bytes = new TextEncoder().encode(body)
  if (localStorage) await files.putConversationFile(storageKey, bytes, mimeType)
  const row = await db.conversationAttachment.create({
    data: {
      conversationId, uploaderUserId: uploader, storageKey, name, mimeType, size: bytes.byteLength,
      extractedText: opts.extract === false ? null : body,
    },
  })
  const message = await service.postMessage({ conversationId, authorType: 'user', authorUserId: uploader, text: opts.text ?? '', attachmentIds: [row.id] } as any)
  if (opts.extract !== false) await index.chunkAttachment(row.id)
  ids[name] = row.id
  return { attachmentId: row.id, messageId: message.row.id }
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  reviewer = (await db.project.create({ data: { name: 'Reviewer', workspaceId: seed.workspaceId } })).id
  for (const user of [seed.owner, seed.member, seed.viewer]) await service.listConversationsForUser(seed.workspaceId, user)
  const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
  generalId = list.find((c: any) => c.slug === 'general')!.id
  privateId = (await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: 'money', kind: 'private' })).id
  archivedId = (await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: 'old-stuff', kind: 'public' })).id
  reviewId = (await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: 'review', kind: 'private' })).id
  dmId = (await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])).id
  agentDmId = (await service.openAgentConversation(seed.workspaceId, seed.owner, { projectId: seed.projectId })).id

  await share(generalId, seed.owner, 'launch-plan.md', '# Launch\nWe ship the release on Friday after the final QA pass.', { mimeType: 'text/markdown', text: 'Plan attached' })
  await share(generalId, seed.member, 'team.png', 'not really a png', { mimeType: 'image/png', extract: false })
  await share(generalId, seed.owner, 'raw-notes.txt', 'Extract me later: the onboarding checklist.', { extract: false })
  await share(generalId, seed.owner, 'handbook.txt', `${'Handbook intro. '.repeat(200)}\nThe vacation policy is unlimited with manager approval.\n${'Closing words. '.repeat(200)}`)
  await share(privateId, seed.owner, 'q3-revenue.csv', 'quarter,sales\nQ3,120000', { mimeType: 'text/csv' })
  await share(dmId, seed.owner, 'offer-letter.txt', 'Candidate offer: start date in November.')
  await share(agentDmId, seed.owner, 'brief.txt', 'Brief for the agent: summarize the hiring pipeline.')
  await share(archivedId, seed.owner, 'archived.txt', 'Old archived notes.')
  await share(reviewId, seed.owner, 'review-diff.txt', 'Diff under review.')

  const deleted = await share(generalId, seed.owner, 'deleted.txt', 'This message was deleted.')
  await db.conversationMessage.update({ where: { id: deleted.messageId }, data: { deletedAt: new Date() } })
  const orphan = await db.conversationAttachment.create({
    data: { conversationId: generalId, uploaderUserId: seed.owner, storageKey: 'orphan', name: 'unsent.txt', mimeType: 'text/plain', size: 3, extractedText: 'unsent draft' },
  })
  ids['unsent.txt'] = orphan.id

  await db.conversation.update({ where: { id: archivedId }, data: { archivedAt: new Date() } })
  // The project agent is in #money; the reviewer reviews #review in isolation.
  await db.conversationMember.create({ data: { conversationId: privateId, memberType: 'agent', projectId: seed.projectId, agentTrigger: 'mention' } })
  await db.conversationMember.create({ data: { conversationId: reviewId, memberType: 'agent', projectId: reviewer, agentTrigger: 'mention', agentContextMode: 'isolated' } })
})

beforeEach(() => {
  agentAuth = { projectId: seed.projectId }
  semantic._setEmbeddingProviderForTests(null)
})

afterAll(async () => {
  semantic._setEmbeddingProviderForTests(undefined)
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('access policy', () => {
  test('people read public channels plus conversations they belong to', async () => {
    const owner = await access.readableConversationIds({ kind: 'user', userId: seed.owner }, seed.workspaceId)
    expect(owner).toEqual(expect.arrayContaining([generalId, privateId, dmId, agentDmId]))
    const member = await access.readableConversationIds({ kind: 'user', userId: seed.member }, seed.workspaceId)
    expect(member).toContain(generalId)
    expect(member).toContain(dmId)
    expect(member).not.toContain(privateId)
    expect(member).not.toContain(agentDmId)
    expect(await access.readableConversationIds({ kind: 'user', userId: seed.outsider }, seed.workspaceId)).toEqual([])
  })

  test('agents read public channels and their own conversations, never archived ones', async () => {
    const readable = await access.readableConversationIds({ kind: 'agent', projectId: seed.projectId }, seed.workspaceId)
    expect(readable).toEqual(expect.arrayContaining([generalId, privateId, agentDmId]))
    expect(readable).not.toContain(dmId)
    expect(readable).not.toContain(reviewId)
    expect(readable).not.toContain(archivedId)
    const workspaceAgent = await access.readableConversationIds({ kind: 'agent', projectId: null }, seed.workspaceId)
    expect(workspaceAgent).toContain(generalId)
    expect(workspaceAgent).not.toContain(privateId)
    expect(workspaceAgent).not.toContain(agentDmId)
  })

  test('an agent reviewing in isolation anywhere sees no files', async () => {
    expect(await access.readableConversationIds({ kind: 'agent', projectId: reviewer }, seed.workspaceId)).toEqual([])
  })

  test('unsent files and files on deleted messages are not visible', async () => {
    for (const name of ['unsent.txt', 'deleted.txt']) {
      await expect(access.loadVisibleFile({ kind: 'user', userId: seed.owner }, seed.workspaceId, ids[name])).rejects.toMatchObject({ status: 404 })
    }
  })
})

describe('Files list', () => {
  test('lists a channel’s files newest first, with uploader and message', async () => {
    const { status, json } = await get(`/conversations/${generalId}/files`, seed.member)
    expect(status).toBe(200)
    expect(names(json.files)).toEqual(['handbook.txt', 'launch-plan.md', 'raw-notes.txt', 'team.png'])
    expect(json.files[0].name).toBe('handbook.txt')
    const plan = json.files.find((f: any) => f.name === 'launch-plan.md')
    expect(plan).toMatchObject({ kind: 'document', uploadedBy: { id: seed.owner }, conversationId: generalId })
    expect(plan.messageId).toBeTruthy()
    expect(plan.url).toContain(plan.id)
  })

  test('filters by name and kind, and pages with a cursor', async () => {
    expect(names((await get(`/conversations/${generalId}/files?q=PLAN`, seed.owner)).json.files)).toEqual(['launch-plan.md'])
    expect(names((await get(`/conversations/${generalId}/files?kind=image`, seed.owner)).json.files)).toEqual(['team.png'])
    const first = (await get(`/conversations/${generalId}/files?limit=2`, seed.owner)).json
    expect(first.files).toHaveLength(2)
    const second = (await get(`/conversations/${generalId}/files?limit=2&cursor=${first.nextCursor}`, seed.owner)).json
    expect(second.nextCursor).toBeNull()
    expect(names([...first.files, ...second.files])).toEqual(['handbook.txt', 'launch-plan.md', 'raw-notes.txt', 'team.png'])
  })

  test('DM files are listed for participants only', async () => {
    expect(names((await get(`/conversations/${dmId}/files`, seed.member)).json.files)).toEqual(['offer-letter.txt'])
    expect((await get(`/conversations/${dmId}/files`, seed.viewer)).status).toBe(404)
    expect((await get(`/conversations/${privateId}/files`, seed.member)).status).toBe(404)
  })
})

describe('agent file routes', () => {
  test('lists every file the agent can see, with a folder per conversation', async () => {
    const { status, json } = await agent('/files')
    expect(status).toBe(200)
    expect(names(json.files)).toEqual(['brief.txt', 'handbook.txt', 'launch-plan.md', 'q3-revenue.csv', 'raw-notes.txt', 'team.png'])
    const folders = Object.fromEntries(json.conversations.map((c: any) => [c.id, c.folder]))
    expect(folders[generalId]).toBe('general')
    expect(folders[privateId]).toBe('money')
    expect(folders[agentDmId]).toMatch(/^dm-/)
    expect(json.files.find((f: any) => f.name === 'launch-plan.md')).toMatchObject({ hasText: true, folder: 'general' })
    expect(json.files.find((f: any) => f.name === 'team.png')).toMatchObject({ hasText: false })
    expect(json.files[0].url).toBeUndefined()
  })

  test('scopes to one conversation by slug, #slug, id or @person', async () => {
    expect(names((await agent('/files?conversation=%23money')).json.files)).toEqual(['q3-revenue.csv'])
    expect(names((await agent(`/files?conversation=${agentDmId}`)).json.files)).toEqual(['brief.txt'])
    const ownerEmail = (await db.user.findUnique({ where: { id: seed.owner } })).email
    expect(names((await agent(`/files?conversation=${encodeURIComponent(`@${ownerEmail}`)}`)).json.files)).toEqual(['brief.txt'])
  })

  test('conversations it can’t see are not found', async () => {
    expect((await agent(`/files?conversation=${dmId}`)).status).toBe(404)
    expect((await agent('/files?conversation=nope')).status).toBe(404)
    agentAuth = { projectId: null }
    expect((await agent('/files?conversation=money')).status).toBe(404)
  })

  test('reading or downloading a file it can’t see is a 404', async () => {
    for (const name of ['offer-letter.txt', 'review-diff.txt', 'archived.txt', 'unsent.txt', 'deleted.txt']) {
      expect((await agent(`/files/${ids[name]}/text`)).status).toBe(404)
      expect((await agent(`/files/${ids[name]}/content`)).status).toBe(404)
    }
    expect((await agent(`/files/${ids['launch-plan.md']}/text`, seed.otherWorkspaceId)).status).toBe(404)
  })

  test('the isolated reviewer gets nothing, even from public channels', async () => {
    agentAuth = { projectId: reviewer }
    expect((await agent('/files')).json.files).toEqual([])
    expect((await agent(`/files/${ids['launch-plan.md']}/text`)).status).toBe(404)
    expect((await agent('/files/search?q=release')).json.results).toEqual([])
  })

  test('reads text in pages', async () => {
    const id = ids['handbook.txt']
    const first = (await agent(`/files/${id}/text?limit=1000`)).json
    expect(first.text).toHaveLength(1000)
    expect(first.offset).toBe(0)
    expect(first.nextOffset).toBe(1000)
    const rest = (await agent(`/files/${id}/text?offset=${first.nextOffset}&limit=60000`)).json
    expect(rest.nextOffset).toBeNull()
    expect(first.text + rest.text).toHaveLength(first.totalChars)
    expect(rest.text).toContain('vacation policy')
  })

  test('files without text report null text', async () => {
    const res = (await agent(`/files/${ids['team.png']}/text`)).json
    expect(res).toMatchObject({ text: null, totalChars: 0, nextOffset: null })
  })

  test.skipIf(!localStorage)('extracts text on first read when it was never extracted', async () => {
    const id = ids['raw-notes.txt']
    expect((await db.conversationAttachment.findUnique({ where: { id } })).extractedText).toBeNull()
    const res = (await agent(`/files/${id}/text`)).json
    expect(res.text).toContain('onboarding checklist')
    expect((await db.conversationAttachment.findUnique({ where: { id } })).extractedText).toContain('onboarding checklist')
    expect(await db.conversationAttachmentChunk.count({ where: { attachmentId: id } })).toBeGreaterThan(0)
  })

  test.skipIf(!localStorage)('downloads the raw bytes with name and folder headers', async () => {
    const { status, headers, res } = await agent(`/files/${ids['q3-revenue.csv']}/content`)
    expect(status).toBe(200)
    expect(await res.text()).toBe('quarter,sales\nQ3,120000')
    expect(decodeURIComponent(headers.get('x-file-name')!)).toBe('q3-revenue.csv')
    expect(decodeURIComponent(headers.get('x-file-folder')!)).toBe('money')
    expect(headers.get('cache-control')).toContain('no-store')
  })
})

describe('agent wake-ups', () => {
  test('a message with only a file wakes the agent, and the prompt names the file', async () => {
    const prompts: string[] = []
    dispatcher._resetDispatcherForTests()
    dispatcher.configureConversationAgentDispatcher({
      invoke: async (args) => {
        prompts.push(args.prompt)
        return sseResponse([{ type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'Got it.' }, { type: 'finish' }])
      },
    })
    try {
      const upload = await db.conversationAttachment.create({
        data: { conversationId: agentDmId, uploaderUserId: seed.owner, storageKey: 'spec', name: 'spec.pdf', mimeType: 'application/pdf', size: 10 },
      })
      const res = await app.request(`/api/conversations/${agentDmId}/messages`, {
        method: 'POST',
        headers: { 'x-user': seed.owner, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '', attachmentIds: [upload.id], clientMsgId: crypto.randomUUID() }),
      })
      expect(res.status).toBe(201)
      const prompt = await waitFor(async () => prompts[0])
      expect(prompt).toContain(`[attached: spec.pdf (file id ${upload.id})]`)
      expect(prompt).toContain('fetch_chat_files')
    } finally {
      dispatcher._resetDispatcherForTests()
    }
  })
})

describe('chunking and search', () => {
  test('chunks overlap and cover the whole text', () => {
    const text = 'word '.repeat(1000)
    const chunks = index.chunkText(text, 1500, 200)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks[0].charStart).toBe(0)
    expect(chunks.at(-1)!.charEnd).toBe(text.length)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].charStart).toBeLessThan(chunks[i - 1].charEnd)
    for (const c of chunks.slice(0, -1)) expect(c.text.endsWith(' ')).toBe(true)
    expect(index.chunkText('   \n  ')).toEqual([])
  })

  test('chunkPendingAttachments picks up extracted files without chunks', async () => {
    const row = await db.conversationAttachment.create({
      data: { conversationId: generalId, uploaderUserId: seed.owner, storageKey: 'x', name: 'later.txt', mimeType: 'text/plain', size: 5, extractedText: 'chunk me' },
    })
    await service.postMessage({ conversationId: generalId, authorType: 'user', authorUserId: seed.owner, text: '', attachmentIds: [row.id] } as any)
    expect(await index.chunkPendingAttachments()).toBeGreaterThan(0)
    expect(await db.conversationAttachmentChunk.count({ where: { attachmentId: row.id } })).toBe(1)
  })

  test('keyword search finds text inside files, with a snippet', async () => {
    const { json } = await agent('/files/search?q=vacation%20policy')
    expect(json.semantic).toBe(false)
    expect(json.results[0]).toMatchObject({ fileId: ids['handbook.txt'], match: 'keyword', folder: 'general' })
    expect(json.results[0].snippet).toContain('vacation policy')
    expect(json.results[0].charStart).toBeGreaterThan(0)
  })

  test('name matches come last, and search stays inside what the agent can see', async () => {
    const { json } = await agent('/files/search?q=offer')
    expect(json.results.map((r: any) => r.fileId)).not.toContain(ids['offer-letter.txt'])
    const csv = (await agent('/files/search?q=q3-revenue')).json.results
    expect(csv[0]).toMatchObject({ fileId: ids['q3-revenue.csv'], match: 'name' })
    agentAuth = { projectId: null }
    expect((await agent('/files/search?q=q3-revenue')).json.results).toEqual([])
  })

  test('semantic search matches by meaning once chunks are embedded', async () => {
    semantic._setEmbeddingProviderForTests(toyProvider as any)
    expect(await index.embedPendingChunks()).toBeGreaterThan(0)
    const { json } = await agent('/files/search?q=income')
    expect(json.semantic).toBe(true)
    expect(json.results[0]).toMatchObject({ fileId: ids['q3-revenue.csv'], match: 'semantic' })
    const people = await index.searchFiles({ kind: 'user', userId: seed.member }, seed.workspaceId, 'income')
    expect(people.results.map((r) => r.fileId)).not.toContain(ids['q3-revenue.csv'])
  })
})
