// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel docs against a real SQLite database: create/save with version
 * checks, access rules, locking, revisions, realtime events, the agent
 * endpoints, and the doc in agent prompts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const docs = await import('../services/conversation-doc.service')

const db = prisma as any
let seed: SeededWorkspace
let invocations: Array<{ projectId: string | null; prompt: string }> = []

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: seed.projectId }),
}))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function newChannel(name: string, kind: 'public' | 'private' = 'public', owner = seed.owner) {
  const res = await call(owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name, kind })
  expect(res.status).toBe(201)
  return res.json.conversation.id as string
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
})

beforeEach(() => {
  invocations = []
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      invocations.push({ projectId: args.projectId, prompt: args.prompt })
      return sseResponse([
        { type: 'start' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Noted.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ])
    },
  })
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('channel doc', () => {
  test('starts empty, is created at version 1, and saves bump the version', async () => {
    const id = await newChannel('roadmap')
    const empty = await call(seed.member, 'GET', `/conversations/${id}/doc`)
    expect(empty.status).toBe(200)
    expect(empty.json).toMatchObject({ doc: null, canEdit: true, canManage: false })

    const created = await call(seed.member, 'PUT', `/conversations/${id}/doc`, { title: 'Q4', content: '# Plan', baseVersion: 0 })
    expect(created.status).toBe(200)
    expect(created.json.doc).toMatchObject({ title: 'Q4', content: '# Plan', version: 1, locked: false })
    expect(created.json.doc.updatedBy).toMatchObject({ type: 'user', id: seed.member })

    const saved = await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { title: 'Q4', content: '# Plan\n\n- [ ] ship', baseVersion: 1 })
    expect(saved.json.doc.version).toBe(2)

    const read = await call(seed.viewer, 'GET', `/conversations/${id}/doc`)
    expect(read.json.doc.content).toBe('# Plan\n\n- [ ] ship')
    expect(read.json.canEdit).toBe(false)

    const listed = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/conversations`)
    expect(listed.json.conversations.find((c: any) => c.id === id).hasDoc).toBe(true)
    const detail = await call(seed.member, 'GET', `/conversations/${id}`)
    expect(detail.json.conversation.hasDoc).toBe(true)
  })

  test('a stale baseVersion is a 409 carrying the current doc', async () => {
    const id = await newChannel('conflicts')
    await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: 'one', baseVersion: 0 })
    await call(seed.member, 'PUT', `/conversations/${id}/doc`, { content: 'two', baseVersion: 1 })
    const stale = await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: 'mine', baseVersion: 1 })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('doc_conflict')
    expect(stale.json.error.doc).toMatchObject({ content: 'two', version: 2 })

    const doubleCreate = await call(seed.member, 'PUT', `/conversations/${id}/doc`, { content: 'again', baseVersion: 0 })
    expect(doubleCreate.status).toBe(409)
    expect((await call(seed.member, 'PUT', `/conversations/${id}/doc`, { content: 'x' })).status).toBe(400)
  })

  test('viewers, archived channels, outsiders and DMs cannot edit; private docs are hidden', async () => {
    const id = await newChannel('rules')
    expect((await call(seed.viewer, 'PUT', `/conversations/${id}/doc`, { content: 'nope', baseVersion: 0 })).status).toBe(403)
    expect((await call(seed.outsider, 'GET', `/conversations/${id}/doc`)).status).toBe(404)

    const priv = await newChannel('secret-plans', 'private')
    await call(seed.owner, 'PUT', `/conversations/${priv}/doc`, { content: 'hush', baseVersion: 0 })
    expect((await call(seed.member, 'GET', `/conversations/${priv}/doc`)).status).toBe(404)

    const dm = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/dms`, { userIds: [seed.member] })
    expect((await call(seed.owner, 'GET', `/conversations/${dm.json.conversation.id}/doc`)).status).toBe(400)

    await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: 'frozen', baseVersion: 0 })
    await call(seed.owner, 'PATCH', `/conversations/${id}`, { archived: true })
    expect((await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: 'thaw', baseVersion: 1 })).status).toBe(403)
  })

  test('locked docs are editable only by managers', async () => {
    const id = await newChannel('handbook')
    expect((await call(seed.owner, 'POST', `/conversations/${id}/doc/lock`, { locked: true })).status).toBe(404)
    await call(seed.member, 'PUT', `/conversations/${id}/doc`, { content: 'v1', baseVersion: 0 })
    expect((await call(seed.member, 'POST', `/conversations/${id}/doc/lock`, { locked: true })).status).toBe(403)
    const locked = await call(seed.owner, 'POST', `/conversations/${id}/doc/lock`, { locked: true })
    expect(locked.json.doc.locked).toBe(true)

    const blocked = await call(seed.member, 'PUT', `/conversations/${id}/doc`, { content: 'v2', baseVersion: 1 })
    expect(blocked.status).toBe(403)
    expect((await call(seed.member, 'GET', `/conversations/${id}/doc`)).json.canEdit).toBe(false)
    expect((await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: 'v2', baseVersion: 1 })).status).toBe(200)
  })

  test('revisions coalesce one author\'s rapid saves and can be restored', async () => {
    const id = await newChannel('history')
    await call(seed.member, 'PUT', `/conversations/${id}/doc`, { content: 'a', baseVersion: 0 })
    await call(seed.member, 'PUT', `/conversations/${id}/doc`, { content: 'ab', baseVersion: 1 })
    await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: 'abc', baseVersion: 2 })

    const { json } = await call(seed.member, 'GET', `/conversations/${id}/doc/revisions`)
    expect(json.revisions.map((r: any) => r.content)).toEqual(['abc', 'ab'])
    const memberRevision = json.revisions[1]

    const stale = await call(seed.member, 'POST', `/conversations/${id}/doc/revisions/${memberRevision.id}/restore`, { baseVersion: 1 })
    expect(stale.status).toBe(409)
    const restored = await call(seed.member, 'POST', `/conversations/${id}/doc/revisions/${memberRevision.id}/restore`, { baseVersion: 3 })
    expect(restored.json.doc).toMatchObject({ content: 'ab', version: 4 })

    const other = await newChannel('history-2')
    expect((await call(seed.member, 'POST', `/conversations/${other}/doc/revisions/${memberRevision.id}/restore`, { baseVersion: 0 })).status).toBe(404)
  })

  test('saves publish doc.updated to the channel audience and post one notice', async () => {
    const received: any[] = []
    const unsubscribe = bus.subscribeWorkspaceEvents(seed.workspaceId, (env) => {
      if (env.event.type === 'doc.updated') received.push(env)
    })
    try {
      const priv = await newChannel('private-doc', 'private')
      await call(seed.owner, 'PUT', `/conversations/${priv}/doc`, { title: 'Notes', content: 'x', baseVersion: 0 })
      await call(seed.owner, 'PUT', `/conversations/${priv}/doc`, { title: 'Notes', content: 'xy', baseVersion: 1 })
      await waitFor(async () => received.length >= 2)
      const [first, second] = received
      expect(first.event).toMatchObject({ conversationId: priv, version: 1, title: 'Notes' })
      expect(first.event.content).toBeUndefined()
      expect(second.event.version).toBe(2)
      expect(bus.canReceive(first, seed.owner)).toBe(true)
      expect(bus.canReceive(first, seed.member)).toBe(false)
    } finally {
      unsubscribe()
    }

    const pub = await newChannel('notice-doc')
    await call(seed.owner, 'PUT', `/conversations/${pub}/doc`, { content: 'one', baseVersion: 0 })
    await call(seed.owner, 'PUT', `/conversations/${pub}/doc`, { content: 'two', baseVersion: 1 })
    const messages = await db.conversationMessage.findMany({ where: { conversationId: pub, authorType: 'system' } })
    const notices = messages.filter((m: any) => m.text.includes('channel doc'))
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toContain('created')
  })
})

describe('agents and the channel doc', () => {
  const internal = (path: string) => `/internal/workspaces/${seed.workspaceId}/agent-channels${path}`

  test('agents read and update public channel docs by name', async () => {
    const id = await newChannel('agent-notes')
    const none = await call(null, 'GET', internal('/agent-notes/doc'))
    expect(none.status).toBe(200)
    expect(none.json.doc).toBeNull()
    expect(none.json.url).toContain(`/c/${id}?doc=1`)

    const appended = await call(null, 'PUT', internal('/agent-notes/doc'), { mode: 'append', content: '## Decisions\n\n- Use Postgres' })
    expect(appended.status).toBe(200)
    expect(appended.json.doc.version).toBe(1)
    expect(appended.json.doc.updatedBy).toMatchObject({ type: 'agent', id: seed.projectId })

    const patched = await call(null, 'PUT', internal(`/${id}/doc`), { mode: 'patch_section', section: 'Decisions', content: '- Use SQLite locally' })
    expect(patched.json.doc.content).toBe('## Decisions\n\n- Use SQLite locally')

    const added = await call(null, 'PUT', internal('/agent-notes/doc'), { mode: 'patch_section', section: 'Open questions', content: '- Hosting?' })
    expect(added.json.doc.content).toBe('## Decisions\n\n- Use SQLite locally\n\n## Open questions\n\n- Hosting?\n')

    const stale = await call(null, 'PUT', internal('/agent-notes/doc'), { mode: 'replace', content: 'gone', baseVersion: 1 })
    expect(stale.status).toBe(409)
    const replaced = await call(null, 'PUT', internal('/agent-notes/doc'), { mode: 'replace', content: 'fresh', baseVersion: 3 })
    expect(replaced.json.doc).toMatchObject({ content: 'fresh', version: 4 })
  })

  test('agents cannot see private docs they are not in, or edit locked docs', async () => {
    await newChannel('board-only', 'private')
    expect((await call(null, 'GET', internal('/board-only/doc'))).status).toBe(404)
    expect((await call(null, 'PUT', internal('/board-only/doc'), { mode: 'append', content: 'x' })).status).toBe(404)

    const id = await newChannel('locked-notes')
    await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: 'policy', baseVersion: 0 })
    await call(seed.owner, 'POST', `/conversations/${id}/doc/lock`, { locked: true })
    expect((await call(null, 'PUT', internal('/locked-notes/doc'), { mode: 'append', content: 'x' })).status).toBe(403)
  })

  test('the doc is included in the prompt of agents woken in the channel', async () => {
    const g = (await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/conversations`)).json.conversations.find((c: any) => c.slug === 'general')
    await call(seed.owner, 'PUT', `/conversations/${g.id}/doc`, { title: 'Team charter', content: 'We ship on Fridays.', baseVersion: 0 })
    await call(seed.member, 'POST', `/conversations/${g.id}/messages`, { text: `<@a:p:${seed.projectId}> when do we ship?` })
    const invocation = await waitFor(async () => invocations[0])
    expect(invocation.prompt).toContain('<channel_doc>')
    expect(invocation.prompt).toContain('We ship on Fridays.')
    expect(invocation.prompt).toContain('"Team charter"')
  })
})

describe('patchSection', () => {
  test('replaces only the named section, up to the next heading at the same level', () => {
    const md = '# Doc\n\n## A\n\nold a\n\n### A.1\n\nnested\n\n## B\n\nkeep b'
    expect(docs.patchSection(md, 'a', 'new a')).toBe('# Doc\n\n## A\n\nnew a\n\n## B\n\nkeep b')
    expect(docs.patchSection('', 'Notes', 'hi')).toBe('## Notes\n\nhi\n')
  })
})
