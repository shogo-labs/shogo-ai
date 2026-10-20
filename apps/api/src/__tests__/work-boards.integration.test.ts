// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Work boards against a real SQLite database: several boards per channel,
 * card threads with the card id as their run id, moves and their history,
 * review gates, column deletes, card-key mentions linking back to the card,
 * permissions, and the agent-facing routes the board tools call.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const { workBoardRoutes, agentBoardRoutes } = await import('../routes/work-boards')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/work-boards.service')

const db = prisma as any
let seed: SeededWorkspace
let channelId: string
let otherChannelId: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api', workBoardRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentBoardRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: c.req.header('x-project') || undefined }),
}))

async function call(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

const agent = (method: string, path: string, body?: unknown, projectId?: string) =>
  call(null, method, `/internal/workspaces/${seed.workspaceId}${path}`, body, projectId ? { 'x-project': projectId } : {})

async function createChannel(user: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call(user, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name, ...extra })
  expect(res.status).toBe(201)
  return res.json.conversation.id
}

async function createBoard(body: Record<string, unknown>, user = seed.member) {
  const res = await call(user, 'POST', `/workspaces/${seed.workspaceId}/boards`, body)
  expect(res.status).toBe(201)
  return res.json.board
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  channelId = await createChannel(seed.member, 'support')
  otherChannelId = await createChannel(seed.member, 'eng')
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('boards', () => {
  test('a channel holds several boards, each with its item type’s columns and its own key prefix', async () => {
    const tickets = await createBoard({ conversationId: channelId, name: 'Support Tickets', itemType: 'ticket' })
    const bugs = await createBoard({ conversationId: channelId, name: 'Bug Triage' })
    expect(tickets.columns.map((c: any) => c.name)).toEqual(['New', 'Open', 'Waiting on customer', 'Solved'])
    expect(tickets.keyPrefix).toBe('ST')
    expect(bugs.keyPrefix).toBe('BT')
    expect(bugs.position).toBe(1)
    const list = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/boards?conversationId=${channelId}`)
    expect(list.json.boards.map((b: any) => b.name)).toEqual(['Support Tickets', 'Bug Triage'])

    const reordered = await call(seed.member, 'PUT', `/workspaces/${seed.workspaceId}/boards/order`, { conversationId: channelId, boardIds: [bugs.id, tickets.id] })
    expect(reordered.status).toBe(200)
    const after = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/boards?conversationId=${channelId}`)
    expect(after.json.boards.map((b: any) => b.name)).toEqual(['Bug Triage', 'Support Tickets'])
  })

  test('the same name twice gets distinct slugs and prefixes', async () => {
    const a = await createBoard({ conversationId: otherChannelId, name: 'Sprint' })
    const b = await createBoard({ conversationId: otherChannelId, name: 'Sprint' })
    expect(a.slug).not.toBe(b.slug)
    expect(a.keyPrefix).not.toBe(b.keyPrefix)
  })

  test('viewers and outsiders cannot create boards', async () => {
    expect((await call(seed.viewer, 'POST', `/workspaces/${seed.workspaceId}/boards`, { conversationId: channelId, name: 'Nope' })).status).toBe(403)
    expect((await call(seed.outsider, 'POST', `/workspaces/${seed.workspaceId}/boards`, { conversationId: channelId, name: 'Nope' })).status).toBe(403)
  })

  test('the arming rule is set and cleared through the column route', async () => {
    const board = await createBoard({ conversationId: channelId, name: 'Arming' })
    const columnId = board.columns[2].id

    const on = await call(seed.member, 'PATCH', `/boards/${board.id}/columns/${columnId}`, { rules: { allowAutoMerge: true } })
    expect(on.status).toBe(200)
    expect(on.json.column.rules).toEqual({ allowAutoMerge: true })

    const off = await call(seed.member, 'PATCH', `/boards/${board.id}/columns/${columnId}`, { rules: { allowAutoMerge: false } })
    expect(off.json.column.rules).toEqual({ allowAutoMerge: false })

    // `rules: null` clears the rule rather than reading as "leave it alone".
    // The column payload always carries an object, so a cleared rule is `{}`.
    const cleared = await call(seed.member, 'PATCH', `/boards/${board.id}/columns/${columnId}`, { rules: null })
    expect(cleared.status).toBe(200)
    expect(cleared.json.column.rules).toEqual({})
    const row = await db.boardColumn.findUnique({ where: { id: columnId } })
    expect(row.rules).toBeNull()
  })

  test('columns insert after a named column and refuse to delete while cards remain', async () => {
    const board = await createBoard({ conversationId: channelId, name: 'Deals', itemType: 'deal' })
    const added = await call(seed.member, 'POST', `/boards/${board.id}/columns`, { name: 'Legal review', category: 'review', after: 'Proposal' })
    expect(added.status).toBe(201)
    expect(added.json.board.columns.map((c: any) => c.name)).toEqual(['Lead', 'Qualified', 'Proposal', 'Legal review', 'Negotiation', 'Won', 'Lost'])

    const card = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Acme renewal', column: 'Legal review' })
    expect(card.status).toBe(201)
    const legal = added.json.column.id
    const refused = await call(seed.member, 'DELETE', `/boards/${board.id}/columns/${legal}`)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('column_not_empty')
    const moved = await call(seed.member, 'DELETE', `/boards/${board.id}/columns/${legal}?moveTo=Negotiation`)
    expect(moved.status).toBe(200)
    expect(moved.json.moved).toBe(1)
    const item = await db.workItem.findUnique({ where: { id: card.json.item.id }, include: { column: true } })
    expect(item.column.name).toBe('Negotiation')
  })

  test('only the creator, channel owners and admins change board structure', async () => {
    const board = await createBoard({ conversationId: channelId, name: 'Owner only' }, seed.owner)
    const res = await call(seed.member, 'PATCH', `/boards/${board.id}`, { name: 'Renamed' })
    expect(res.status).toBe(200)
    const viewerTry = await call(seed.viewer, 'PATCH', `/boards/${board.id}`, { name: 'Viewer' })
    expect(viewerTry.status).toBe(403)
  })
})

describe('cards', () => {
  let board: any

  beforeAll(async () => {
    board = await createBoard({ conversationId: channelId, name: 'Escalations', keyPrefix: 'ESC', requiresHumanReview: true })
  })

  test('a card gets a key and a thread in the channel whose chain carries the card id', async () => {
    const res = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Refund stuck', priority: 'high', description: 'Customer charged twice' })
    expect(res.status).toBe(201)
    const item = res.json.item
    expect(item.key).toBe('ESC-1')
    expect(item.threadRootMessageId).toBeTruthy()
    const root = await db.conversationMessage.findUnique({ where: { id: item.threadRootMessageId } })
    expect(root.conversationId).toBe(channelId)
    const blocks = typeof root.blocks === 'string' ? JSON.parse(root.blocks) : root.blocks
    expect(blocks.type).toBe('status_card')
    expect(blocks.workItem.key).toBe('ESC-1')
    expect(blocks.workItem).toMatchObject({
      id: item.id, boardId: board.id, boardName: 'Escalations', title: 'Refund stuck',
      column: { name: 'Backlog', category: 'backlog' }, priority: 'high', assignee: null, dueAt: null,
    })
    expect(blocks.workItem.path).toBe(`/work?card=${item.id}`)
    const chain = typeof root.agentChain === 'string' ? JSON.parse(root.agentChain) : root.agentChain
    expect(chain.runId).toBe(item.id)
  })

  test('moves are recorded, refresh the status card, and done posts back to the channel', async () => {
    const { json } = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Close me' })
    const id = json.item.id
    expect((await call(seed.member, 'POST', `/work-items/${id}/move`, { column: 'In progress' })).status).toBe(200)
    const done = await call(seed.member, 'POST', `/work-items/${id}/move`, { column: 'Done' })
    expect(done.status).toBe(200)
    expect(done.json.item.completedAt).toBeTruthy()
    const events = await db.workItemEvent.findMany({ where: { workItemId: id, type: 'moved' } })
    expect(events.length).toBe(2)
    const root = await db.conversationMessage.findUnique({ where: { id: json.item.threadRootMessageId } })
    const blocks = typeof root.blocks === 'string' ? JSON.parse(root.blocks) : root.blocks
    expect(blocks.card.status).toBe('done')
    expect(blocks.workItem.column).toEqual({ name: 'Done', category: 'done' })
    const doneLine = await db.conversationMessage.findFirst({ where: { threadRootId: json.item.threadRootMessageId, alsoSentToChannel: true } })
    expect(doneLine?.text).toContain('Done')

    const reopened = await call(seed.member, 'POST', `/work-items/${id}/move`, { column: 'Backlog' })
    expect(reopened.json.item.completedAt).toBeNull()
    expect(await db.workItemEvent.count({ where: { workItemId: id, type: 'regressed' } })).toBe(1)
  })

  test('moving a card to another board’s channel posts the same card with the destination as a note', async () => {
    const target = await createBoard({ conversationId: otherChannelId, name: 'Escalated', keyPrefix: 'ESCX' })
    const { json } = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Wrong team' })
    const moved = await call(seed.member, 'POST', `/work-items/${json.item.id}/move`, { board: target.id, column: 'Backlog' })
    expect(moved.status).toBe(200)

    const link = await waitFor(() => db.workItemLink.findFirst({ where: { workItemId: json.item.id, reason: 'escalation' } }))
    const pointer = await db.conversationMessage.findUnique({ where: { id: link.refId } })
    expect(pointer.conversationId).toBe(otherChannelId)
    const blocks = typeof pointer.blocks === 'string' ? JSON.parse(pointer.blocks) : pointer.blocks
    expect(blocks.type).toBe('status_card')
    expect(blocks.workItem).toMatchObject({
      id: json.item.id, key: json.item.key, boardId: target.id, boardName: 'Escalated', title: 'Wrong team',
      column: { name: 'Backlog', category: 'backlog' },
    })
    expect(blocks.workItem.note).toBe('Moved to Escalated from #support')

    // Its home thread's card moves with it, in place — no second root message.
    const root = await db.conversationMessage.findUnique({ where: { id: json.item.threadRootMessageId } })
    const rootBlocks = typeof root.blocks === 'string' ? JSON.parse(root.blocks) : root.blocks
    expect(rootBlocks.workItem.boardName).toBe('Escalated')
    expect(rootBlocks.workItem.column).toEqual({ name: 'Backlog', category: 'backlog' })
    expect(await db.conversationMessage.count({ where: { clientMsgId: `card:${json.item.id}` } })).toBe(1)
  })

  test('agents cannot close cards on boards that need human review, but people can', async () => {
    const { json } = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Needs a human' })
    const blocked = await agent('POST', `/agent-work-items/${json.item.key}/move`, { column: 'Done' }, seed.projectId)
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('review_required')
    expect((await agent('POST', `/agent-work-items/${json.item.key}/move`, { column: 'Review' }, seed.projectId)).status).toBe(200)
    expect((await agent('POST', `/agent-work-items/${json.item.key}/move`, { column: 'Done' }, seed.projectId)).status).toBe(200)
  })

  test('viewers read cards but cannot change them', async () => {
    const { json } = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Read only' })
    expect((await call(seed.viewer, 'GET', `/work-items/${json.item.id}`)).status).toBe(200)
    expect((await call(seed.viewer, 'PATCH', `/work-items/${json.item.id}`, { title: 'x' })).status).toBe(403)
    expect((await call(seed.outsider, 'GET', `/work-items/${json.item.id}`)).status).toBe(404)
  })

  test('a card key mentioned in another channel links that message to the card', async () => {
    const { json } = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Mentioned elsewhere' })
    const key = json.item.key
    await call(seed.member, 'POST', `/conversations/${otherChannelId}/messages`, { text: `Looks related to ${key}, can eng check?` })
    const link = await waitFor(() => db.workItemLink.findFirst({ where: { workItemId: json.item.id, kind: 'message', reason: 'mention' } }))
    expect(link.conversationId).toBe(otherChannelId)
    const history = await call(seed.member, 'GET', `/work-items/${json.item.id}/history`)
    expect(history.json.entries.some((e: any) => e.type === 'link' && e.link.reason === 'mention')).toBe(true)
  })

  test('mentions in private channels show as private to people outside them', async () => {
    const privateId = await createChannel(seed.owner, 'leadership', { kind: 'private' })
    const { json } = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Discussed privately' })
    await call(seed.owner, 'POST', `/conversations/${privateId}/messages`, { text: `Budget for ${json.item.key} is tight` })
    await waitFor(() => db.workItemLink.findFirst({ where: { workItemId: json.item.id, reason: 'mention' } }))
    const asMember = await call(seed.member, 'GET', `/work-items/${json.item.id}`)
    const link = asMember.json.links.find((l: any) => l.reason === 'mention')
    expect(link.private).toBe(true)
    expect(link.snippet).toBeNull()
    const asOwner = await call(seed.owner, 'GET', `/work-items/${json.item.id}`)
    expect(asOwner.json.links.find((l: any) => l.reason === 'mention').snippet).toContain('Budget')
  })

  test('comments land in the card thread and show in history', async () => {
    const { json } = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Chatty card' })
    const res = await call(seed.member, 'POST', `/work-items/${json.item.id}/comments`, { text: 'Called the customer' })
    expect(res.status).toBe(201)
    const reply = await db.conversationMessage.findUnique({ where: { id: res.json.messageId } })
    expect(reply.threadRootId).toBe(json.item.threadRootMessageId)
    const history = await call(seed.member, 'GET', `/work-items/${json.item.id}/history?filter=comments`)
    expect(history.json.entries.some((e: any) => e.type === 'message' && e.message.text === 'Called the customer')).toBe(true)
  })

  test('assigning an agent tags it in the card thread and makes it the thread owner', async () => {
    const { json } = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'For the bot' })
    const res = await call(seed.member, 'PATCH', `/work-items/${json.item.id}`, { assigneeAgentRef: seed.projectId })
    expect(res.status).toBe(200)
    expect(res.json.item.assigneeAgentRef).toBe(`project:${seed.projectId}`)
    const tag = await db.conversationMessage.findFirst({ where: { threadRootId: json.item.threadRootMessageId, text: { contains: `<@a:p:${seed.projectId}>` } } })
    expect(tag?.text).toContain(json.item.key)
    expect(await db.workItemEvent.count({ where: { workItemId: json.item.id, type: 'agent_woken' } })).toBe(1)
    const root = await db.conversationMessage.findUnique({ where: { id: json.item.threadRootMessageId } })
    const chain = typeof root.agentChain === 'string' ? JSON.parse(root.agentChain) : root.agentChain
    expect(chain.owner?.projectId).toBe(seed.projectId)
  })

  test('cards made from a message quote and link it as their origin', async () => {
    const posted = await call(seed.member, 'POST', `/conversations/${channelId}/messages`, { text: 'Checkout is throwing 500s for EU users' })
    const res = await call(seed.member, 'POST', `/conversation-messages/${posted.json.message.id}/card`, { boardId: board.id })
    expect(res.status).toBe(201)
    expect(res.json.item.title).toBe('Checkout is throwing 500s for EU users')
    expect(res.json.item.source).toBe('message')
    const link = await db.workItemLink.findFirst({ where: { workItemId: res.json.item.id, reason: 'origin', kind: 'message' } })
    expect(link.refId).toBe(posted.json.message.id)
  })

  test('bulk updates change each card and report per-card results', async () => {
    const a = (await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Bulk A' })).json.item
    const b = (await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Bulk B' })).json.item
    const res = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/work-items/bulk`, { ids: [a.id, b.id, 'missing'], patch: { priority: 'urgent', column: 'In progress' } })
    expect(res.json.updated).toBe(2)
    expect(res.json.results.find((r: any) => r.id === 'missing').ok).toBe(false)
    const rows = await db.workItem.findMany({ where: { id: { in: [a.id, b.id] } }, include: { column: true } })
    expect(rows.every((r: any) => r.priority === 'urgent' && r.column.name === 'In progress')).toBe(true)
  })

  test('the inbox lists my open cards across boards', async () => {
    const other = await createBoard({ conversationId: otherChannelId, name: 'Eng Problems', itemType: 'problem' })
    await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Mine 1', assigneeUserId: seed.member })
    await call(seed.member, 'POST', `/boards/${other.id}/items`, { title: 'Mine 2', assigneeUserId: seed.member, priority: 'urgent' })
    const res = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/work-items?assignee=me`)
    const titles = res.json.items.map((i: any) => i.title)
    expect(titles).toContain('Mine 1')
    expect(titles[0]).toBe('Mine 2')
  })
})

describe('working agents', () => {
  test('a card lists the agent replies running in its thread until they settle', async () => {
    const board = await createBoard({ conversationId: channelId, name: 'Live status' })
    const card = (await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Agent on it' })).json.item
    const viewCard = async () => {
      const view = await call(seed.member, 'GET', `/boards/${board.id}`)
      return view.json.items.find((i: any) => i.id === card.id)
    }
    expect((await viewCard()).working).toEqual([])

    // Allocate the seq the way the service does, so later messages in the channel do not collide with it.
    const bumped = await db.conversation.update({ where: { id: channelId }, data: { lastSeq: { increment: 1 } }, select: { lastSeq: true } })
    const reply = await db.conversationMessage.create({
      data: {
        conversationId: channelId,
        workspaceId: seed.workspaceId,
        seq: bumped.lastSeq,
        threadRootId: card.threadRootMessageId,
        authorType: 'agent',
        authorAgentRef: { projectId: seed.projectId, name: 'Support bot' },
        text: '',
        agentStatus: 'running',
      },
    })
    expect((await viewCard()).working).toEqual([{ messageId: reply.id, name: 'Support bot' }])

    await db.conversationMessage.update({ where: { id: reply.id }, data: { agentStatus: 'done', text: 'Fixed' } })
    expect((await viewCard()).working).toEqual([])
  })
})

describe('agent routes', () => {
  test('an agent sets up a board in a channel by name and works a card end to end', async () => {
    const created = await agent('POST', '/agent-boards', {
      channel: '#support',
      name: 'Agent Intake',
      item_type: 'ticket',
      columns: [{ name: 'New', category: 'backlog' }, { name: 'Working', category: 'active', wip_limit: 1 }, { name: 'Solved', category: 'done' }],
    })
    expect(created.status).toBe(201)
    expect(created.json.board.conversationId).toBe(channelId)

    const card = await agent('POST', `/agent-boards/${created.json.board.slug}/items`, { title: 'Password reset loop', priority: 'high' }, seed.projectId)
    expect(card.status).toBe(201)
    expect(card.json.item.createdByAgentRef).toBe(`project:${seed.projectId}`)
    const key = card.json.item.key

    await agent('POST', `/agent-boards/${created.json.board.slug}/items`, { title: 'Second', column: 'Working' }, seed.projectId)
    const moved = await agent('POST', `/agent-work-items/${key}/move`, { column: 'Working' }, seed.projectId)
    expect(moved.json.warnings[0]).toContain('WIP')

    await agent('PATCH', `/agent-work-items/${key}`, { history_summary: 'Reset link expires instantly; escalated to eng.' }, seed.projectId)
    const detail = await agent('GET', `/agent-work-items/${key}`, undefined, seed.projectId)
    expect(detail.json.item.historySummary).toContain('escalated')
    expect(detail.json.column.name).toBe('Working')

    const health = await agent('GET', `/agent-boards/health?channel=support`)
    expect(health.json.boards.find((b: any) => b.board === 'Agent Intake').issues.some((i: any) => i.type === 'wip_exceeded')).toBe(true)

    const summary = await agent('GET', `/agent-boards/${created.json.board.slug}/summary`)
    expect(summary.json.open).toBe(2)
  })

  test('agents cannot see boards in private channels they are not in', async () => {
    const privateId = await createChannel(seed.owner, 'hr-private', { kind: 'private' })
    await createBoard({ conversationId: privateId, name: 'Comp Reviews' }, seed.owner)
    const res = await agent('GET', '/agent-boards', undefined, seed.projectId)
    expect(res.json.boards.some((b: any) => b.name === 'Comp Reviews')).toBe(false)
  })

  test('intake dedupes open cards by fingerprint', async () => {
    const board = await service.resolveBoard(seed.workspaceId, 'Agent Intake')
    const first = await service.intakeWorkItem(board, { title: 'Disk full on db-1', fingerprint: 'disk:db-1', source: 'trigger' }, {})
    const again = await service.intakeWorkItem(board, { title: 'Disk full on db-1', fingerprint: 'disk:db-1', source: 'trigger' }, {})
    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(again.item.id).toBe(first.item.id)
    expect(await db.workItemEvent.count({ where: { workItemId: first.item.id, type: 'occurrence' } })).toBe(1)
  })
})

describe('work_item triggers', () => {
  test('events become cards with mapped fields, and repeats with the same dedupe key update the open card', async () => {
    const subs = await import('../services/event-subscription.service')
    const delivery = await import('../services/event-delivery-targets')
    const { subscription } = await subs.createSubscription({
      workspaceId: seed.workspaceId,
      ownerUserId: seed.member,
      name: 'New tickets',
      eventType: 'member.joined',
      target: 'work_item',
      workItemTarget: {
        board: 'Support Tickets',
        column: 'Open',
        mapping: { title: '{{ticket.subject}} ({{ticket.requester}})', priority: 'ticket.priority', externalRef: 'ticket.id', fields: { customer: 'ticket.requester', seats: 'ticket.seats' } },
        dedupeKey: 'ticket.id',
      },
    })
    expect(subscription.target).toBe('work_item')
    const row = await db.eventSubscription.findUnique({ where: { id: subscription.id } })
    const fire = (payload: unknown) => delivery.deliverEvent({
      deliveryId: crypto.randomUUID(),
      subscription: row,
      envelope: { id: crypto.randomUUID(), type: 'member.joined', version: 1, workspaceId: seed.workspaceId, occurredAt: new Date().toISOString(), payload },
      signal: new AbortController().signal,
    })
    const payload = { ticket: { id: 'ZD-1001', subject: 'Cannot export invoices', requester: 'Acme', priority: 'HIGH', seats: 40 } }
    const first = await fire(payload)
    expect(first.summary).toMatch(/^Created ST-\d+\.$/)
    const again = await fire(payload)
    expect(again.summary).toContain('already open')

    const cards = await db.workItem.findMany({ where: { eventSubscriptionId: subscription.id }, include: { column: true } })
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card.title).toBe('Cannot export invoices (Acme)')
    expect(card.column.name).toBe('Open')
    expect(card.priority).toBe('high')
    expect(card.externalRef).toBe('ZD-1001')
    expect(card.source).toBe('trigger')
    const fields = typeof card.fields === 'string' ? JSON.parse(card.fields) : card.fields
    expect(fields).toEqual({ customer: 'Acme', seats: 40 })
  })

  test('targets are checked when the trigger is created', async () => {
    const subs = await import('../services/event-subscription.service')
    const base = { workspaceId: seed.workspaceId, ownerUserId: seed.member, name: 'x', eventType: 'member.joined', target: 'work_item' }
    await expect(subs.createSubscription({ ...base, workItemTarget: { board: 'Nope', mapping: { title: 'x' } } })).rejects.toMatchObject({ status: 404 })
    await expect(subs.createSubscription({ ...base, workItemTarget: { board: 'Support Tickets', mapping: {} } })).rejects.toMatchObject({ code: 'invalid_field' })
    await expect(subs.createSubscription({ ...base, workItemTarget: { board: 'Support Tickets', column: 'Nowhere', mapping: { title: 'x' } } })).rejects.toMatchObject({ status: 400 })
  })
})

describe('problems', () => {
  const report = (body: Record<string, unknown>) => agent('POST', '/agent-boards/Errors/problems?channel=eng', body, seed.projectId)

  test('repeats group into one card; a repeat after resolving reopens it as a regression', async () => {
    await createBoard({ conversationId: otherChannelId, name: 'Errors', itemType: 'problem' })
    const error = { title: 'TypeError in CheckoutForm.submit', fingerprint: 'TypeError:CheckoutForm.submit', environment: 'production', release: '1.4.0', message: "Cannot read properties of undefined (reading 'id')", stack: 'at submit (CheckoutForm.tsx:42)' }

    const first = await report(error)
    expect(first.status).toBe(201)
    expect(first.json.outcome).toBe('new')
    expect(first.json.item.column.name).toBe('Detected')
    expect(first.json.item.fields).toMatchObject({ environment: 'production', occurrences: 1 })

    const again = await report({ ...error, environment: 'staging' })
    expect(again.status).toBe(200)
    expect(again.json.outcome).toBe('occurrence')
    expect(again.json.item.id).toBe(first.json.item.id)
    expect(again.json.occurrences).toBe(2)

    await call(seed.member, 'POST', `/work-items/${first.json.item.id}/move`, { column: 'Resolved' })
    const regressed = await report({ ...error, release: '1.4.1' })
    expect(regressed.json.outcome).toBe('regressed')
    expect(regressed.json.item.column.name).toBe('Detected')
    expect(await db.workItemEvent.count({ where: { workItemId: first.json.item.id, type: 'regressed' } })).toBe(1)

    const occ = await agent('GET', `/agent-work-items/${first.json.item.key}/occurrences`, undefined, seed.projectId)
    expect(occ.status).toBe(200)
    expect(occ.json.total).toBe(3)
    expect(occ.json.byEnvironment).toEqual({ production: 2, staging: 1 })
    expect(occ.json.releases.sort()).toEqual(['1.4.0', '1.4.1'])
    expect(occ.json.recent[0].release).toBe('1.4.1')

    const asUser = await call(seed.member, 'GET', `/work-items/${first.json.item.id}/occurrences`)
    expect(asUser.json.total).toBe(3)
  })

  test('dismissed problems stay dismissed but keep counting', async () => {
    const first = await report({ title: 'ResizeObserver loop limit exceeded', fingerprint: 'resize-observer' })
    await call(seed.member, 'POST', `/work-items/${first.json.item.id}/move`, { column: 'Dismissed' })
    const again = await report({ title: 'ResizeObserver loop limit exceeded', fingerprint: 'resize-observer' })
    expect(again.json.outcome).toBe('dismissed')
    expect(again.json.item.column.name).toBe('Dismissed')
    expect(again.json.occurrences).toBe(2)
  })

  test('a work_item trigger on a problem board reports problems', async () => {
    const subs = await import('../services/event-subscription.service')
    const delivery = await import('../services/event-delivery-targets')
    const { subscription } = await subs.createSubscription({
      workspaceId: seed.workspaceId,
      ownerUserId: seed.member,
      name: 'Errors from monitoring',
      eventType: 'member.joined',
      target: 'work_item',
      workItemTarget: { board: 'Errors', channel: 'eng', mapping: { title: '{{error.type}} in {{error.where}}', message: 'error.message', environment: 'env' }, dedupeKey: '{{error.type}}:{{error.where}}' },
    })
    const row = await db.eventSubscription.findUnique({ where: { id: subscription.id } })
    const fire = (payload: unknown) => delivery.deliverEvent({
      deliveryId: crypto.randomUUID(),
      subscription: row,
      envelope: { id: crypto.randomUUID(), type: 'member.joined', version: 1, workspaceId: seed.workspaceId, occurredAt: new Date().toISOString(), payload },
      signal: new AbortController().signal,
    })
    const payload = { error: { type: 'RangeError', where: 'Pager.render', message: 'Invalid array length' }, env: 'production' }
    const first = await fire(payload)
    const second = await fire(payload)
    expect(first.summary).toContain('new problem')
    expect(second.summary).toContain('occurrence')
    const card = await db.workItem.findFirst({ where: { eventSubscriptionId: subscription.id } })
    expect(card.title).toBe('RangeError in Pager.render')
    expect(await db.problemOccurrence.count({ where: { workItemId: card.id } })).toBe(2)
  })

  test('only problem boards take error reports', async () => {
    const res = await agent('POST', '/agent-boards/Support%20Tickets/problems', { title: 'x', fingerprint: 'x' }, seed.projectId)
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('not_problem_board')
  })
})

describe('#activity', () => {
  async function workLines(itemId: string) {
    const activity = await db.conversation.findFirst({ where: { workspaceId: seed.workspaceId, kind: 'activity' } })
    if (!activity) return []
    const rows = await db.conversationMessage.findMany({ where: { conversationId: activity.id }, orderBy: { seq: 'asc' } })
    return rows
      .map((r: any) => (typeof r.blocks === 'string' ? JSON.parse(r.blocks) : r.blocks))
      .filter((b: any) => b?.type === 'activity' && b.workItemId === itemId)
  }

  test('opening, finishing and reopening a card in a public channel post work lines', async () => {
    const board = await createBoard({ conversationId: channelId, name: 'Escalations' })
    const created = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'VIP refund stuck' })
    const id = created.json.item.id
    const done = board.columns.find((c: any) => c.category === 'done')
    expect((await call(seed.member, 'POST', `/work-items/${id}/move`, { column: done.id })).status).toBe(200)
    expect((await call(seed.member, 'POST', `/work-items/${id}/move`, { column: board.columns[0].id })).status).toBe(200)
    const lines = await waitFor(async () => {
      const found = await workLines(id)
      return found.length >= 3 ? found : null
    })
    expect(lines.map((l: any) => l.kind)).toEqual(['work.created', 'work.done', 'work.regressed'])
    expect(lines[0]).toMatchObject({ conversationId: channelId, boardId: board.id })
    expect(lines[0].link).toContain(`card=${id}`)
  })

  test('cards in private channels stay out of #activity', async () => {
    const secret = await createChannel(seed.member, 'exec', { kind: 'private' })
    const board = await createBoard({ conversationId: secret, name: 'Board prep' })
    const created = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Comp review' })
    expect(await workLines(created.json.item.id)).toEqual([])
  })

  test('card detail carries the board columns for the column picker', async () => {
    const board = await createBoard({ conversationId: channelId, name: 'Picker' })
    const created = await call(seed.member, 'POST', `/boards/${board.id}/items`, { title: 'Pick me' })
    const detail = await call(seed.member, 'GET', `/work-items/${created.json.item.id}`)
    expect(detail.json.board.columns.map((c: any) => c.name)).toEqual(board.columns.map((c: any) => c.name))
  })
})
