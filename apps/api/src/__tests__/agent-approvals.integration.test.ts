// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Approvals in chat: an "ask first" action an agent hits while running for a
 * channel becomes a decision card in its thread. Anyone who can post may
 * approve or deny, the first answer wins, and a card nobody answered is closed
 * when the run ends.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const approvals = await import('../services/conversation-approvals')
const teamChannels = await import('../services/conversation-team-channels')

const db = prisma as any
let seed: SeededWorkspace
let builder: string
let channel: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** A chat stream the test controls: send frames, then end it. */
function liveStream() {
  const enc = new TextEncoder()
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c } })
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send: (frame: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`)),
    end: () => ctrl.close(),
  }
}

let stream: ReturnType<typeof liveStream>
let answers: Array<{ projectId: string; requestId: string; decision: string }> = []
let deliver = true

const REQUEST = {
  id: 'perm-1',
  toolName: 'github_merge_pr',
  category: 'network',
  params: { number: 12, method: 'squash', commitTitle: 'Fix invoice rounding' },
  reason: 'Merging is set to ask first',
  timeout: 900,
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  builder = (await db.project.create({ data: { name: 'Builder', workspaceId: seed.workspaceId } })).id
  const { channel: ch } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name: 'eng',
    agents: [{ projectId: builder, agentTrigger: 'mention' }],
    userEmails: [],
  })
  channel = ch.id
})

beforeEach(() => {
  answers = []
  deliver = true
  stream = liveStream()
  approvals._resetApprovalsForTests()
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async () => stream.response,
    respondToPermission: async (input) => {
      answers.push(input)
      return deliver
    },
  })
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

/** Start a run that asks for approval, and return the card once it is posted. */
async function runAskingForApproval(request: Record<string, unknown> = REQUEST) {
  const posted = await call(seed.member, 'POST', `/conversations/${channel}/messages`, { text: `<@a:p:${builder}> merge PR 12` })
  const root = posted.json.message.id as string
  stream.send({ type: 'text-start', id: 't1' })
  stream.send({ type: 'data-permission-request', data: request })
  const card = await waitFor(async () => {
    const rows = await db.conversationMessage.findMany({ where: { threadRootId: root, authorType: 'agent' }, orderBy: { seq: 'asc' } })
    return rows.find((r: any) => r.blocks?.type === 'approval_request') ?? null
  })
  return { root, card }
}

async function finishRun(root: string) {
  stream.send({ type: 'text-delta', id: 't1', delta: 'All done.' })
  stream.send({ type: 'text-end', id: 't1' })
  stream.send({ type: 'finish' })
  stream.end()
  await waitFor(async () => {
    const rows = await db.conversationMessage.findMany({ where: { threadRootId: root, authorType: 'agent', agentStatus: 'running' } })
    return rows.length === 0 ? true : null
  })
}

const reread = (id: string) => db.conversationMessage.findUnique({ where: { id } })

describe('approval cards', () => {
  test('a permission request becomes a decision card in the thread', async () => {
    const { card, root } = await runAskingForApproval()
    expect(card.blocks.messageKind).toBe('decision')
    expect(card.blocks.approval).toMatchObject({
      requestId: 'perm-1',
      projectId: builder,
      toolName: 'github_merge_pr',
      status: 'pending',
      summary: 'Merge pull request #12 (squash) — Fix invoice rounding',
    })
    expect(card.authorAgentRef.projectId).toBe(builder)
    expect(card.text).toContain('needs approval')
    expect(card.text).toContain('Waiting for a decision')
    await finishRun(root)
  })

  test('approving forwards allow_once to the runtime and records who decided', async () => {
    const { card, root } = await runAskingForApproval()
    const res = await call(seed.owner, 'POST', `/conversation-messages/${card.id}/approval`, { decision: 'approve' })
    expect(res.status).toBe(200)
    expect(answers).toEqual([{ projectId: builder, requestId: 'perm-1', decision: 'allow_once' }])
    const after = await reread(card.id)
    expect(after.blocks.approval.status).toBe('approved')
    expect(after.blocks.approval.decidedBy.userId).toBe(seed.owner)
    expect(after.text).toContain('Approved by')
    await finishRun(root)
    expect((await reread(card.id)).blocks.approval.status).toBe('approved')
  })

  test('denying forwards deny', async () => {
    const { card, root } = await runAskingForApproval()
    expect((await call(seed.member, 'POST', `/conversation-messages/${card.id}/approval`, { decision: 'deny' })).status).toBe(200)
    expect(answers[0].decision).toBe('deny')
    expect((await reread(card.id)).blocks.approval.status).toBe('denied')
    await finishRun(root)
  })

  test('the first answer wins', async () => {
    const { card, root } = await runAskingForApproval()
    expect((await call(seed.owner, 'POST', `/conversation-messages/${card.id}/approval`, { decision: 'approve' })).status).toBe(200)
    const second = await call(seed.member, 'POST', `/conversation-messages/${card.id}/approval`, { decision: 'deny' })
    expect(second.status).toBe(409)
    expect(second.json.error.code).toBe('already_decided')
    expect(answers).toHaveLength(1)
    await finishRun(root)
  })

  test('viewers, outsiders, strangers and bad answers are refused', async () => {
    const { card, root } = await runAskingForApproval()
    const path = `/conversation-messages/${card.id}/approval`
    expect((await call(seed.viewer, 'POST', path, { decision: 'approve' })).status).toBe(403)
    expect((await call(seed.outsider, 'POST', path, { decision: 'approve' })).status).toBeGreaterThanOrEqual(403)
    expect((await call(null, 'POST', path, { decision: 'approve' })).status).toBe(401)
    expect((await call(seed.member, 'POST', path, { decision: 'maybe' })).status).toBe(400)
    expect(answers).toHaveLength(0)
    expect((await reread(card.id)).blocks.approval.status).toBe('pending')
    await finishRun(root)
  })

  test('an ordinary message cannot be approved', async () => {
    const { root } = await runAskingForApproval()
    const reply = await db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'agent' }, orderBy: { seq: 'asc' } })
    const plain = reply.blocks?.type === 'approval_request'
      ? await db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'agent', agentStatus: 'running' } })
      : reply
    const res = await call(seed.member, 'POST', `/conversation-messages/${plain.id}/approval`, { decision: 'approve' })
    expect(res.status).toBe(404)
    await finishRun(root)
  })

  test('when the runtime is no longer waiting the card closes instead of claiming approval', async () => {
    const { card, root } = await runAskingForApproval()
    deliver = false
    const res = await call(seed.owner, 'POST', `/conversation-messages/${card.id}/approval`, { decision: 'approve' })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('expired')
    expect((await reread(card.id)).blocks.approval.status).toBe('expired')
    await finishRun(root)
  })

  test('a card nobody answered is closed when the run ends', async () => {
    const { card, root } = await runAskingForApproval()
    await finishRun(root)
    await waitFor(async () => ((await reread(card.id)).blocks.approval.status === 'expired' ? true : null))
    const late = await call(seed.owner, 'POST', `/conversation-messages/${card.id}/approval`, { decision: 'approve' })
    expect(late.status).toBe(409)
    expect(answers).toHaveLength(0)
  })

  test('an answer after the runtime timeout is refused', async () => {
    const { card, root } = await runAskingForApproval({ ...REQUEST, id: 'perm-2', timeout: 1 })
    await new Promise((r) => setTimeout(r, 1100))
    const res = await call(seed.owner, 'POST', `/conversation-messages/${card.id}/approval`, { decision: 'approve' })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('expired')
    expect(answers).toHaveLength(0)
    await finishRun(root)
  })
})

describe('approval summaries', () => {
  test('describe the action in one line', () => {
    expect(approvals.approvalSummary({ id: 'x', toolName: 'github_merge_pr', params: { number: 5 } })).toBe('Merge pull request #5')
    expect(approvals.approvalSummary({ id: 'x', toolName: 'exec', params: { command: 'rm -rf build' } })).toBe('Run a command: rm -rf build')
    expect(approvals.approvalSummary({ id: 'x', toolName: 'custom_tool', params: {} })).toBe('custom_tool')
    expect(approvals.approvalSummary({ id: 'x', toolName: 'exec', params: { command: 'x'.repeat(500) } }).length).toBeLessThanOrEqual(240)
  })
})
