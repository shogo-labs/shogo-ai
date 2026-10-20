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
    expect(invocation.prompt).toContain('characters (')
    expect(invocation.prompt).toContain('per-card narratives in the card thread')
  })
})

describe('channel doc budget, doc_full and archives', () => {
  const internal = (path: string) => `/internal/workspaces/${seed.workspaceId}/agent-channels${path}`

  /** A doc of exactly `chars` characters with two sections, so patching and archiving have targets. */
  function docOfSize(chars: number) {
    const head = '# Big doc\n\n## Rules\n\n- ship on Friday\n\n## Archive candidate\n\n'
    return `${head}${'z'.repeat(Math.max(0, chars - head.length))}`
  }

  test('every read and write carries the budget, with 70% and 85% as the warn/critical edges', async () => {
    const id = await newChannel('budget-doc')
    const created = await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: 'x'.repeat(1000), baseVersion: 0 })
    expect(created.json.doc.budget).toMatchObject({ chars: 1000, limit: 200_000, level: 'ok' })

    expect(docs.docBudget(139_999).level).toBe('ok')
    expect(docs.docBudget(140_000)).toMatchObject({ level: 'warn', pct: 70 })
    expect(docs.docBudget(169_999).level).toBe('warn')
    expect(docs.docBudget(170_000)).toMatchObject({ level: 'critical', pct: 85 })
    expect(docs.docBudget(175_492)).toMatchObject({ level: 'critical', pct: 87.7 })

    const warn = await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: docOfSize(140_000), baseVersion: 1 })
    expect(warn.json.doc.budget).toMatchObject({ level: 'warn', chars: 140_000 })
    expect((await call(seed.member, 'GET', `/conversations/${id}/doc`)).json.doc.budget.level).toBe('warn')
    expect((await call(null, 'GET', internal('/budget-doc/doc'))).json.doc.budget).toMatchObject({ chars: 140_000, level: 'warn' })

    const agentWrite = await call(null, 'PUT', internal('/budget-doc/doc'), { mode: 'patch_section', section: 'Rules', content: '- ship Thursday' })
    expect(agentWrite.json.doc.budget.chars).toBe(agentWrite.json.doc.content.length)
  })

  test('a write that would cross the limit returns doc_full with over_by and writes nothing', async () => {
    const id = await newChannel('full-doc')
    const base = docOfSize(199_000)
    const created = await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: base, baseVersion: 0 })
    expect(created.status).toBe(200)
    expect(created.json.doc.budget.level).toBe('critical')

    const refused = await call(null, 'PUT', internal('/full-doc/doc'), {
      mode: 'append',
      content: `## New section\n\n${'y'.repeat(2_000)}`,
    })
    expect(refused.status).toBe(400)
    expect(refused.json.error.code).toBe('doc_full')
    expect(refused.json.error.limit).toBe(200_000)
    expect(refused.json.error.chars).toBeGreaterThan(200_000)
    expect(refused.json.error.over_by).toBe(refused.json.error.chars - 200_000)
    expect(refused.json.error.next).toContain('archive_section')

    const after = await call(seed.member, 'GET', `/conversations/${id}/doc`)
    expect(after.json.doc.version).toBe(1)
    expect(after.json.doc.content).toBe(base)

    // A person hitting the same limit gets the same way out, not a bare 400.
    const userFull = await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: `${base}${'q'.repeat(2_000)}`, baseVersion: 1 })
    expect(userFull.status).toBe(400)
    expect(userFull.json.error).toMatchObject({ code: 'doc_full', over_by: 1_000 })
  })

  test('archive_section moves exactly one section, bumps the version once and keeps the text restorable', async () => {
    const id = await newChannel('archive-doc')
    const content = '# Doc\n\nIntro line\n\n## Keep\n\nkeep me\n\n## Old card\n\nold narrative\nline two\n\n## Also keep\n\nalso\n'
    await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { title: 'Notes', content, baseVersion: 0 })

    const archived = await call(null, 'PUT', internal('/archive-doc/doc'), { mode: 'archive_section', section: 'Old card' })
    expect(archived.status).toBe(200)
    expect(archived.json.doc.version).toBe(2)
    expect(archived.json.doc.content).toContain('_Archived "Old card"')
    expect(archived.json.doc.content).not.toContain('old narrative')
    expect(archived.json.doc.content).toContain('## Keep\n\nkeep me')
    expect(archived.json.doc.content).toContain('## Also keep\n\nalso')
    expect(archived.json.doc.budget.chars).toBe(archived.json.doc.content.length)
    expect(archived.json.archive).toMatchObject({ heading: 'Old card', content: 'old narrative\nline two' })
    expect(archived.json.archive.chars).toBe('## Old card\n\nold narrative\nline two'.length)

    const rows = await db.conversationDocArchive.findMany({ where: { conversationId: id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].archivedByType).toBe('agent')

    const listed = await call(null, 'GET', internal('/archive-doc/doc?include_archive=1'))
    expect(listed.json.archives).toHaveLength(1)
    expect(listed.json.archives[0]).toMatchObject({ heading: 'Old card' })
    expect(listed.json.archives[0].content).toBeUndefined()

    const byId = await call(null, 'GET', internal(`/archive-doc/doc?archive_id=${archived.json.archive.id}`))
    expect(byId.json.archive.content).toBe('old narrative\nline two')

    const restored = await call(seed.owner, 'POST', `/conversations/${id}/doc/archives/${archived.json.archive.id}/restore`, { baseVersion: 2 })
    expect(restored.status).toBe(200)
    expect(restored.json.doc.version).toBe(3)
    expect(restored.json.doc.content).toContain('## Old card\n\nold narrative\nline two')
    expect(await db.conversationDocArchive.count({ where: { conversationId: id } })).toBe(0)
  })

  test('missing, duplicate and locked sections are reported instead of guessed', async () => {
    const id = await newChannel('archive-edges')
    await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: '# Doc\n\n## Dup\n\none\n\n## Dup\n\ntwo\n', baseVersion: 0 })

    const missing = await call(null, 'PUT', internal('/archive-edges/doc'), { mode: 'archive_section', section: 'Nope' })
    expect(missing.status).toBe(404)
    expect(missing.json.error.code).toBe('section_not_found')

    const ambiguous = await call(null, 'PUT', internal('/archive-edges/doc'), { mode: 'archive_section', section: 'Dup' })
    expect(ambiguous.status).toBe(409)
    expect(ambiguous.json.error.code).toBe('ambiguous_section')
    expect(ambiguous.json.error.matches).toHaveLength(2)
    expect(await db.conversationDocArchive.count({ where: { conversationId: id } })).toBe(0)

    const noDoc = await newChannel('archive-none')
    expect((await call(null, 'PUT', internal('/archive-none/doc'), { mode: 'archive_section', section: 'Dup' })).status).toBe(404)

    const lockedDoc = await newChannel('archive-locked')
    await call(seed.owner, 'PUT', `/conversations/${lockedDoc}/doc`, { content: '# Doc\n\n## Gone\n\nbody\n', baseVersion: 0 })
    await call(seed.owner, 'POST', `/conversations/${lockedDoc}/doc/lock`, { locked: true })
    expect((await call(null, 'PUT', internal('/archive-locked/doc'), { mode: 'archive_section', section: 'Gone' })).status).toBe(403)
  })

  test('a card-shaped heading is refused with use_card_thread, and force writes it', async () => {
    const id = await newChannel('card-log')
    await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: '# Doc\n\n## Rules\n\n- be kind\n', baseVersion: 0 })

    const refused = await call(null, 'PUT', internal('/card-log/doc'), { mode: 'append', content: '## SHO-123 QA gate\n\nlong story' })
    expect(refused.status).toBe(400)
    expect(refused.json.error.code).toBe('use_card_thread')
    expect(refused.json.error).toMatchObject({ reason: 'card_heading', card: 'SHO-123' })
    expect(refused.json.error.next).toContain('work_item_comment')
    expect((await call(seed.member, 'GET', `/conversations/${id}/doc`)).json.doc.version).toBe(1)

    // The same guard on a patch_section that would create the section.
    const patched = await call(null, 'PUT', internal('/card-log/doc'), { mode: 'patch_section', section: 'Round 2 shipped', content: 'story' })
    expect(patched.json.error).toMatchObject({ code: 'use_card_thread', reason: 'card_heading' })

    // A new section over 4,000 characters is refused too.
    const big = await call(null, 'PUT', internal('/card-log/doc'), { mode: 'append', content: `## Long lesson\n\n${'x'.repeat(4_500)}` })
    expect(big.json.error).toMatchObject({ code: 'use_card_thread', reason: 'section_size', limit: 4_000 })

    // Editing an existing section is normal use and stays allowed.
    const edit = await call(null, 'PUT', internal('/card-log/doc'), { mode: 'patch_section', section: 'Rules', content: '- be kinder' })
    expect(edit.status).toBe(200)

    const forced = await call(null, 'PUT', internal('/card-log/doc'), { mode: 'append', content: '## SHO-123 QA gate\n\nlong story', force: true })
    expect(forced.status).toBe(200)
    expect(forced.json.doc.content).toContain('## SHO-123 QA gate')
  })

  test('replaying the real 199,316-character doc accepts a patch that fits and refuses one that does not', async () => {
    const id = await newChannel('real-fixture')
    const base = docOfSize(199_316)
    expect(base.length).toBe(199_316)
    expect((await call(seed.owner, 'PUT', `/conversations/${id}/doc`, { content: base, baseVersion: 0 })).status).toBe(200)

    const patched = await call(null, 'PUT', internal('/real-fixture/doc'), { mode: 'patch_section', section: 'Rules', content: '- ship on Friday, always' })
    expect(patched.status).toBe(200)
    expect(patched.json.doc.budget.level).toBe('critical')

    const tooBig = await call(null, 'PUT', internal('/real-fixture/doc'), { mode: 'append', content: `## Notes\n\n${'n'.repeat(1_000)}` })
    expect(tooBig.json.error.code).toBe('doc_full')
    expect(tooBig.json.error.over_by).toBeGreaterThan(0)
  })
})

describe('patchSection', () => {
  test('replaces only the named section, up to the next heading at the same level', () => {
    const md = '# Doc\n\n## A\n\nold a\n\n### A.1\n\nnested\n\n## B\n\nkeep b'
    expect(docs.patchSection(md, 'a', 'new a')).toBe('# Doc\n\n## A\n\nnew a\n\n## B\n\nkeep b')
    expect(docs.patchSection('', 'Notes', 'hi')).toBe('## Notes\n\nhi\n')
  })
})

describe('doc section helpers', () => {
  test('extractSection cuts exactly one section and reports its size', () => {
    const md = '# Doc\n\nintro\n\n## A\n\nbody a\n\n### A.1\n\nnested\n\n## B\n\nbody b\n'
    const section = docs.extractSection(md, 'A')!
    expect(section).toMatchObject({ heading: 'A', level: 2, body: 'body a\n\n### A.1\n\nnested' })
    expect(section.chars).toBe('## A\n\nbody a\n\n### A.1\n\nnested'.length)
    expect(docs.extractSection(md, 'Missing')).toBeNull()
    expect(docs.findSectionHeadings(md, 'B')).toEqual([12])
  })

  test('card-shaped headings are recognised, durable ones are not', () => {
    expect(docs.isCardNarrativeHeading('SHO-26 QA gate')).toBe(true)
    expect(docs.isCardNarrativeHeading('One finish = one message (SHO-33)')).toBe(true)
    expect(docs.isCardNarrativeHeading('QA gate notes')).toBe(true)
    expect(docs.isCardNarrativeHeading('Round 2 findings')).toBe(true)
    expect(docs.isCardNarrativeHeading('What shipped last week')).toBe(true)
    expect(docs.isCardNarrativeHeading('Working mode flips')).toBe(false)
    expect(docs.isCardNarrativeHeading('Model catalog & media pricing')).toBe(false)
  })
})
