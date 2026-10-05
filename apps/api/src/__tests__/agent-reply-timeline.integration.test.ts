// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Scenario evals for how an agent's channel reply reads: only its closing message is posted, what
 * it did sits behind "Worked for X", and the reply lands in the timeline where it was finished,
 * not where it was started. Each test scripts the agent's stream, so the outcome is exact.
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
let reviewer: string
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

/** A chat stream the test controls: send frames, then end or break it. */
function liveStream(signal?: AbortSignal) {
  const enc = new TextEncoder()
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c } })
  signal?.addEventListener('abort', () => { try { ctrl.error(new Error('aborted')) } catch {} })
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send: (frame: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`)),
    end: () => ctrl.close(),
  }
}

type Stream = ReturnType<typeof liveStream>
const streams = new Map<string, Stream>()
const events: Array<Record<string, any>> = []

/** What a project-chat turn leaves behind in the agent session, which "Worked for X" points at. */
async function recordTurn(sessionId: string, parts: unknown[], startedAt = Date.now() - 65_000) {
  return db.chatMessage.create({
    data: {
      sessionId,
      role: 'assistant',
      content: 'turn',
      parts: JSON.stringify([...parts, { type: 'data-turn-timing', data: { startedAt, completedAt: startedAt + 65_000 } }]),
    },
  })
}

const text = (id: string) => ({ type: 'text-start', id })
const delta = (id: string, d: string) => ({ type: 'text-delta', id, delta: d })
const tool = (id: string, name: string) => ({ type: 'tool-input-start', toolCallId: id, toolName: name })
const toolDone = (id: string) => ({ type: 'tool-output-available', toolCallId: id })

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  builder = (await db.project.create({ data: { name: 'Builder', workspaceId: seed.workspaceId } })).id
  reviewer = (await db.project.create({ data: { name: 'Reviewer', workspaceId: seed.workspaceId } })).id
  const { channel: ch } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name: 'eng',
    agents: [{ projectId: builder, agentTrigger: 'mention' }, { projectId: reviewer, agentTrigger: 'mention' }],
    userEmails: [],
  })
  channel = ch.id
  bus.subscribeWorkspaceEvents(seed.workspaceId, (envelope) => { events.push(envelope.event as any) })
})

beforeEach(() => {
  streams.clear()
  events.length = 0
  approvals._resetApprovalsForTests()
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      const stream = liveStream(args.signal)
      streams.set(args.projectId!, stream)
      return stream.response
    },
    respondToPermission: async () => true,
  })
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

/** Post a message that wakes an agent and wait for its stream to open. */
async function ask(agent: string, body = 'please look') {
  const posted = await call(seed.member, 'POST', `/conversations/${channel}/messages`, { text: `<@a:p:${agent}> ${body}` })
  const root = posted.json.message.id as string
  await waitFor(async () => (streams.get(agent) ? true : null))
  return { root, stream: streams.get(agent)! }
}

async function settled(root: string, agent: string) {
  return waitFor(async () => {
    const rows = await db.conversationMessage.findMany({ where: { threadRootId: root, authorType: 'agent', deletedAt: null }, orderBy: { seq: 'asc' } })
    const mine = rows.filter((r: any) => r.authorAgentRef?.projectId === agent && r.agentStatus && r.agentStatus !== 'running' && !r.blocks?.approval)
    return mine.length ? mine[mine.length - 1] : null
  })
}

/** A run: narration, tools, and a closing message. */
async function finishWith(stream: Stream, sessionParts: unknown[], frames: unknown[]) {
  for (const f of frames) stream.send(f)
  stream.send({ type: 'finish' })
  stream.end()
  void sessionParts
}

async function sessionOf(root: string, agent: string): Promise<string> {
  const row = await waitFor(async () => {
    const r = await db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'agent' }, orderBy: { seq: 'asc' } })
    return r?.agentSessionId && r.authorAgentRef?.projectId === agent ? r : null
  })
  return row.agentSessionId
}

describe('what is posted', () => {
  test('1. an answer with no tools is just text, with no work fold', async () => {
    const { root, stream } = await ask(builder)
    await finishWith(stream, [], [text('a'), delta('a', 'It is 42.')])
    const reply = await settled(root, builder)
    expect(reply.text).toBe('It is 42.')
    expect(reply.blocks?.work).toBeUndefined()
  })

  test('2. tools then an answer posts only the answer and points at the work', async () => {
    const { root, stream } = await ask(builder)
    const sessionId = await sessionOf(root, builder)
    const row = await recordTurn(sessionId, [
      { type: 'text', text: "I'll start by looking around." },
      { type: 'dynamic-tool', toolCallId: 'c1', toolName: 'exec', state: 'output-available', input: { command: 'gh pr view 3' }, output: { stdout: 'ok' } },
      { type: 'text', text: 'PR #3 is open.' },
    ])
    await finishWith(stream, [], [
      text('a'), delta('a', "I'll start by looking around."), tool('c1', 'exec'), toolDone('c1'), text('b'), delta('b', 'PR #3 is open.'),
    ])
    const reply = await settled(root, builder)
    expect(reply.text).toBe('PR #3 is open.')
    expect(reply.blocks.work).toMatchObject({ chatMessageId: row.id, toolCalls: 1 })
    expect(reply.blocks.work.completedAt - reply.blocks.work.startedAt).toBe(65_000)
  })

  test('3. narration between tool calls stays in the work log', async () => {
    const { root, stream } = await ask(builder)
    await finishWith(stream, [], [
      text('a'), delta('a', 'First I check the repo.'), tool('c1', 'exec'), toolDone('c1'),
      text('b'), delta('b', 'Now the tests.'), tool('c2', 'exec'), toolDone('c2'),
      text('c'), delta('c', 'All green.'), text('d'), delta('d', 'Ready to merge.'),
    ])
    const reply = await settled(root, builder)
    // Two text blocks in a row, with no tool between them, are one closing message.
    expect(reply.text).toBe('All green.\n\nReady to merge.')
    expect(reply.text).not.toContain('First I check')
  })

  test('4. a run that ends on a tool call leaves a fold and no empty closing text', async () => {
    const { root, stream } = await ask(builder)
    const sessionId = await sessionOf(root, builder)
    await recordTurn(sessionId, [
      { type: 'text', text: 'Posting the card.' },
      { type: 'dynamic-tool', toolCallId: 'c1', toolName: 'team_chat_post', state: 'output-available', input: { text: 'hi' }, output: { ok: true } },
    ])
    await finishWith(stream, [], [text('a'), delta('a', 'Posting the card.'), tool('c1', 'team_chat_post'), toolDone('c1')])
    const reply = await settled(root, builder)
    expect(reply.text).toBe('')
    expect(reply.agentStatus).toBe('done')
    expect(reply.blocks.work.toolCalls).toBe(1)
  })

  test('9. a failed run says so and is settled', async () => {
    const { root, stream } = await ask(builder)
    await finishWith(stream, [], [{ type: 'error', errorText: 'model unavailable' }])
    const reply = await settled(root, builder)
    expect(reply.agentStatus).toBe('error')
    expect(reply.text).toContain('model unavailable')
  })

  test('8. stopping a run keeps what it had said last and settles it', async () => {
    const { root, stream } = await ask(builder)
    stream.send(text('a'))
    stream.send(delta('a', 'Half an ans'))
    const running = await waitFor(async () => {
      const r = await db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'agent', agentStatus: 'running' } })
      return r ?? null
    })
    await call(seed.member, 'POST', `/conversation-messages/${running.id}/stop`)
    const reply = await settled(root, builder)
    expect(reply.agentStatus).toBe('stopped')
    expect(reply.text).toBe('Half an ans')
  })
})

describe('hand-offs', () => {
  test('10. a tag in the narration hands nothing off; a tag in the closing message does', async () => {
    const { root, stream } = await ask(builder)
    await finishWith(stream, [], [
      text('a'), delta('a', `Thinking about <@a:p:${reviewer}> for a moment.`), tool('c1', 'exec'), toolDone('c1'),
      text('b'), delta('b', `Done. <@a:p:${reviewer}> please review.`),
    ])
    const reply = await settled(root, builder)
    expect(reply.text).toBe(`Done. <@a:p:${reviewer}> please review.`)
    const mentions = await db.conversationMention.findMany({ where: { messageId: reply.id } })
    expect(mentions).toHaveLength(1)
  })
})

describe('timeline order', () => {
  test('5. a reply that finishes after a card it caused lands after the card', async () => {
    const { root, stream } = await ask(builder)
    stream.send(text('a'))
    stream.send({
      type: 'data-permission-request',
      data: { id: 'perm-1', toolName: 'github_merge_pr', category: 'network', params: { number: 3 }, reason: 'ask first', timeout: 900 },
    })
    const card = await waitFor(async () => {
      const rows = await db.conversationMessage.findMany({ where: { threadRootId: root, authorType: 'agent' } })
      return rows.find((r: any) => r.blocks?.type === 'approval_request') ?? null
    })
    const placeholder = await db.conversationMessage.findFirst({ where: { threadRootId: root, agentStatus: 'running' } })
    expect(placeholder.seq).toBeLessThan(card.seq)

    const approved = await call(seed.member, 'POST', `/conversation-messages/${card.id}/approval`, { decision: 'approve' })
    expect(approved.status).toBe(200)
    events.length = 0
    await finishWith(stream, [], [delta('a', 'Merged.')])
    const reply = await settled(root, builder)

    expect(reply.id).toBe(placeholder.id)
    expect(reply.seq).toBeGreaterThan(card.seq)
    // Clients are told as for a new message, so unread counts and badges follow it.
    const announced = events.filter((e) => e.message?.id === reply.id)
    expect(announced.at(-1)).toMatchObject({ type: 'message.created', moved: true, message: { seq: reply.seq } })
    const conv = await db.conversation.findUnique({ where: { id: channel } })
    expect(conv.lastSeq).toBe(reply.seq)
  })

  test('6. an approval nobody answers is closed and the reply still lands after it', async () => {
    const { root, stream } = await ask(builder)
    stream.send(text('a'))
    stream.send({ type: 'data-permission-request', data: { id: 'perm-2', toolName: 'github_merge_pr', category: 'network', params: {}, reason: 'ask first', timeout: 900 } })
    const card = await waitFor(async () => {
      const rows = await db.conversationMessage.findMany({ where: { threadRootId: root, authorType: 'agent' } })
      return rows.find((r: any) => r.blocks?.type === 'approval_request') ?? null
    })
    await finishWith(stream, [], [delta('a', 'Could not merge: no one approved.')])
    const reply = await settled(root, builder)
    const closed = await db.conversationMessage.findUnique({ where: { id: card.id } })
    expect(closed.blocks.approval.status).toBe('expired')
    expect(reply.seq).toBeGreaterThan(card.seq)
  })

  test('7. two agents that finish in the opposite order from how they started read in finishing order', async () => {
    const first = await ask(builder, 'first')
    const second = await ask(reviewer, 'second')
    // The builder started first and finishes last.
    second.stream.send(text('r')); second.stream.send(delta('r', 'Reviewed.')); second.stream.send({ type: 'finish' }); second.stream.end()
    const reviewed = await settled(second.root, reviewer)
    first.stream.send(text('b')); first.stream.send(delta('b', 'Built.')); first.stream.send({ type: 'finish' }); first.stream.end()
    const built = await settled(first.root, builder)
    expect(built.seq).toBeGreaterThan(reviewed.seq)
  })

  test('a reply nothing landed after keeps its place', async () => {
    const { root, stream } = await ask(builder)
    const placeholder = await db.conversationMessage.findFirst({ where: { threadRootId: root, agentStatus: 'running' } })
    await finishWith(stream, [], [text('a'), delta('a', 'Quick one.')])
    const reply = await settled(root, builder)
    expect(reply.seq).toBe(placeholder.seq)
  })
})

describe('the work log', () => {
  const secretToken = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'

  async function runWithSecrets() {
    const { root, stream } = await ask(builder)
    const sessionId = await sessionOf(root, builder)
    // An older turn of the same session must not be mistaken for this one.
    await db.chatMessage.create({
      data: { sessionId, role: 'assistant', content: 'old', parts: JSON.stringify([{ type: 'text', text: 'old turn' }]), createdAt: new Date(Date.now() - 3_600_000) },
    })
    const row = await recordTurn(sessionId, [
      { type: 'reasoning', text: 'my private thoughts' },
      { type: 'text', text: 'Checking the remote.' },
      {
        type: 'dynamic-tool', toolCallId: 'c1', toolName: 'exec', state: 'output-available',
        input: { command: `git push https://x:${secretToken}@github.com/o/r.git` },
        output: { stdout: `TOKEN=${secretToken}\n` + 'line\n'.repeat(200) },
      },
      { type: 'dynamic-tool', toolCallId: 'c2', toolName: 'write_file', state: 'output-available', input: { path: 'a.ts', content: 'x'.repeat(5_000) }, output: { ok: true } },
      { type: 'text', text: 'Pushed.' },
    ])
    await finishWith(stream, [], [
      text('a'), delta('a', 'Checking the remote.'), tool('c1', 'exec'), toolDone('c1'), tool('c2', 'write_file'), toolDone('c2'), text('b'), delta('b', 'Pushed.'),
    ])
    const reply = await settled(root, builder)
    return { reply, row }
  }

  test('13. it points at this turn, not an earlier one in the same session', async () => {
    const { reply, row } = await runWithSecrets()
    expect(reply.blocks.work.chatMessageId).toBe(row.id)
  })

  test('17. members get the narration and tool names, not private thinking, secrets or file bodies', async () => {
    const { reply } = await runWithSecrets()
    const res = await call(seed.member, 'GET', `/conversation-messages/${reply.id}/work`)
    expect(res.status).toBe(200)
    const body = JSON.stringify(res.json)
    expect(body).not.toContain(secretToken)
    expect(body).not.toContain('my private thoughts')
    expect(body).not.toContain('Pushed.')
    expect(body).toContain('Checking the remote.')
    expect(body).toContain('[redacted]')
    expect(body).toContain('[5000 characters]')
    const exec = res.json.parts.find((p: any) => p.toolName === 'exec')
    expect(exec.output.length).toBeLessThanOrEqual(241)
  })

  test('outsiders cannot read it', async () => {
    const { reply } = await runWithSecrets()
    expect((await call(seed.outsider, 'GET', `/conversation-messages/${reply.id}/work`)).status).toBeGreaterThanOrEqual(403)
    expect((await call(null, 'GET', `/conversation-messages/${reply.id}/work`)).status).toBe(401)
  })
})

describe('Slack and Teams', () => {
  test('14. the closing message carries the same "Worked for" wording as the app', async () => {
    const { workedForLabel } = await import('../services/chat-providers/outbound')
    expect(workedForLabel({ startedAt: 0, completedAt: 8_000 })).toBe('Worked for 8s')
    expect(workedForLabel({ startedAt: 0, completedAt: 65_000 })).toBe('Worked for 1m 05s')
    expect(workedForLabel({ startedAt: 0, completedAt: 3_720_000 })).toBe('Worked for 1h 2m')
  })
})

describe('redaction', () => {
  test('credentials are masked wherever they appear', async () => {
    const { redactSecrets } = await import('../services/agent-work-log')
    const key = 'shogo_sk_' + 'abcdef0123456789abcdef'
    for (const raw of [`key ${key}`, 'Authorization: Bearer abcdefghijklmnop1234', 'https://user:hunter2pass@host/x', 'API_KEY=supersecretvalue', '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----']) {
      const out = redactSecrets(raw)
      expect(out).toContain('[redacted]')
      for (const leaked of [key, 'abcdefghijklmnop1234', 'hunter2pass', 'supersecretvalue', 'MIIB']) expect(out).not.toContain(leaked)
    }
    expect(redactSecrets('gh pr view 3 --json state')).toBe('gh pr view 3 --json state')
  })

  test('which account a tool call used survives trimming, and nothing else rides along with it', async () => {
    const { redactWorkLog } = await import('../services/agent-work-log')
    const output = {
      stdout: 'x\n'.repeat(500),
      credential: { source: 'approved', actingAs: '@frank-gh', onBehalfOf: 'Gina', token: 'gho_' + 'f'.repeat(30) },
    }
    const [shell, forged] = redactWorkLog([
      { type: 'dynamic-tool', toolCallId: 'c1', toolName: 'exec', state: 'output-available', input: {}, output },
      { type: 'dynamic-tool', toolCallId: 'c2', toolName: 'exec', state: 'output-available', input: {}, output: { credential: { source: 'root', actingAs: 'x' } } },
    ])
    expect(shell!.credential).toEqual({ source: 'approved', actingAs: '@frank-gh', onBehalfOf: 'Gina' })
    expect(JSON.stringify(shell)).not.toContain('f'.repeat(30))
    expect(forged!.credential).toBeUndefined()
  })
})
