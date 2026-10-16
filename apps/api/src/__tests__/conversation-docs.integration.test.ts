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
const inbox = await import('../services/chat-inbox')
const items = await import('../services/chat-items')
const settings = await import('../services/chat-settings')
const mentions = await import('../services/conversation-mentions')
const { listMentionables } = await import('../services/conversation.service')

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

  test('finds a heading by its raw token or by the date as agents read it', () => {
    const md = '## Week of <!date:2026-10-19>\n\nold\n\n## Later\n\nkeep'
    const rendered = `Week of ${mentions.absoluteDateText('2026-10-19')}`
    expect(docs.patchSection(md, rendered, 'new')).toBe('## Week of <!date:2026-10-19>\n\nnew\n\n## Later\n\nkeep')
    expect(docs.patchSection(md, 'Week of <!date:2026-10-19>', 'raw')).toContain('raw\n\n## Later')
  })
})

describe('doc mentions, dates and references', () => {
  const internal = (path: string) => `/internal/workspaces/${seed.workspaceId}/agent-channels${path}`
  const docMentions = async (userId: string) =>
    (await inbox.listInbox(seed.workspaceId, userId)).items.filter((i: any) => i.target === 'doc')

  test('people newly mentioned in a doc get one inbox item that opens the doc', async () => {
    const id = await newChannel('oncall')
    await call(seed.owner, 'PUT', `/conversations/${id}/doc`, {
      title: 'DevOps Schedule',
      content: `- <!date:2026-10-19> <@u:${seed.member}>\n- <!date:2026-10-26> <@u:${seed.owner}>`,
      baseVersion: 0,
    })
    const first = await waitFor(async () => (await docMentions(seed.member)).find((i: any) => i.conversationId === id))
    expect(first).toMatchObject({ kind: 'mention', messageId: null, target: 'doc' })
    expect(first.title).toContain('#oncall')
    expect(first.preview).toContain('member')
    expect((await docMentions(seed.owner)).filter((i: any) => i.conversationId === id)).toHaveLength(0)

    await call(seed.owner, 'PUT', `/conversations/${id}/doc`, {
      content: `- <!date:2026-10-19> <@u:${seed.member}> (swap?)\n- <!date:2026-10-26> <@u:${seed.owner}>`,
      baseVersion: 1,
    })
    await new Promise((r) => setTimeout(r, 100))
    expect((await docMentions(seed.member)).filter((i: any) => i.conversationId === id)).toHaveLength(1)
  })

  test('outsiders and people who cannot see a private channel are not notified', async () => {
    const priv = await newChannel('leads-only', 'private')
    await call(seed.owner, 'PUT', `/conversations/${priv}/doc`, {
      content: `<@u:${seed.member}> <@u:${seed.outsider}>`,
      baseVersion: 0,
    })
    await new Promise((r) => setTimeout(r, 150))
    expect((await docMentions(seed.member)).filter((i: any) => i.conversationId === priv)).toHaveLength(0)
    expect((await docMentions(seed.outsider)).filter((i: any) => i.conversationId === priv)).toHaveLength(0)
  })

  test('agents write @Names as tokens and read back a legend of references', async () => {
    const id = await newChannel('agent-schedule')
    const res = await call(null, 'PUT', internal('/agent-schedule/doc'), {
      mode: 'replace',
      content: '## Week of <!date:2026-10-19>\n\n- @member on call',
    })
    expect(res.status).toBe(200)
    expect(res.json.doc.content).toContain(`<@u:${seed.member}> on call`)
    expect(res.json.doc.content).toContain('<!date:2026-10-19>')
    const member = await waitFor(async () => (await docMentions(seed.member)).find((i: any) => i.conversationId === id))
    expect(member.title).toContain('Billing Bot')

    const read = await call(null, 'GET', internal('/agent-schedule/doc'))
    expect(read.json.doc.references).toEqual(expect.arrayContaining([
      { token: `<@u:${seed.member}>`, text: expect.stringContaining('member') },
      { token: '<!date:2026-10-19>', text: mentions.absoluteDateText('2026-10-19') },
    ]))
  })

  test('agents woken in the channel see the token guide and the references legend', async () => {
    const id = await newChannel('legend')
    await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: `Ship <!date:2026-11-02> with <@u:${seed.member}>`, baseVersion: 0 })
    await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `<@a:p:${seed.projectId}> what's the plan?` })
    const invocation = await waitFor(async () => invocations[0])
    expect(invocation.prompt).toContain('References in the doc:')
    expect(invocation.prompt).toContain(mentions.absoluteDateText('2026-11-02'))
    expect(invocation.prompt).toContain('<!date:')
  })

  test('a reminder set from a doc date links back to the doc and fires into the inbox', async () => {
    const id = await newChannel('launch')
    const remindAt = new Date(Date.now() + 60_000).toISOString()
    const reminder = await items.createReminder({
      workspaceId: seed.workspaceId,
      userId: seed.member,
      text: 'Launch doc: Mon, Oct 19',
      remindAt,
      conversationId: id,
      target: 'doc',
    })
    expect(reminder).toMatchObject({ conversationId: id, target: 'doc' })
    await items.fireDueReminders(new Date(Date.now() + 120_000))
    const fired = (await inbox.listInbox(seed.workspaceId, seed.member)).items.find((i: any) => i.kind === 'reminder' && i.conversationId === id)
    expect(fired).toMatchObject({ target: 'doc' })

    const priv = await newChannel('hidden-launch', 'private')
    await expect(items.createReminder({
      workspaceId: seed.workspaceId, userId: seed.member, text: 'x', remindAt, conversationId: priv, target: 'doc',
    })).rejects.toThrow()
  })

  test('mentionables list visible channels and projects, and people carry title and time zone', async () => {
    await newChannel('visible-room')
    const priv = await newChannel('owner-room', 'private')
    await settings.updateChatSettings(seed.workspaceId, seed.member, { title: 'SRE lead', timezone: 'Europe/London' })
    const m = await listMentionables(seed.workspaceId, seed.member)
    expect(m.channels.some((c: any) => c.name === 'visible-room')).toBe(true)
    expect(m.channels.some((c: any) => c.id === priv)).toBe(false)
    expect(m.projects.some((p: any) => p.id === seed.projectId)).toBe(true)
    expect(m.people.find((p: any) => p.id === seed.member)).toMatchObject({ title: 'SRE lead', timezone: 'Europe/London' })
    const owner = await listMentionables(seed.workspaceId, seed.owner)
    expect(owner.channels.some((c: any) => c.id === priv)).toBe(true)
  })
})

describe('doc tokens as plain text', () => {
  test('dates read as absolute text and projects by name', () => {
    expect(mentions.absoluteDateText('2026-10-19')).toMatch(/Oct(ober)? 19, 2026/)
    expect(mentions.absoluteDateText('2026-10-19T14:30Z')).toMatch(/14:30|2:30/)
    const names = { projects: new Map([['p1', 'Billing Bot']]) } as any
    expect(mentions.renderMentionsAsText('Ship <#p:p1> by <!date:2026-10-19>', names)).toBe(
      `Ship Billing Bot by ${mentions.absoluteDateText('2026-10-19')}`,
    )
    expect(mentions.renderMentionsAsText('<#p:gone>', { projects: new Map() } as any)).toBe('a project')
    expect(mentions.collectMentionIds(['<#p:p1> <@a:p:p2>']).projectIds.sort()).toEqual(['p1', 'p2'])
  })
})
