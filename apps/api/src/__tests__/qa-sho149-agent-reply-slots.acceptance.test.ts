// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-149: tagged agents wait in a line instead of starving
 * behind runs that are only `wait`ing.
 *
 * These drive the real dispatcher against a real (temporary) database with a
 * scripted agent stream, so the queue, the placeholder's "Queued" marker, the
 * run list, Stop and the 2 h cap are exercised end to end rather than mocked.
 * The one thing they cannot cover is time: the slot watcher ticks every 5 s, so
 * the parking scenarios take a few seconds each.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

// Read at module load: an open tool parks its run after a second, so a scenario
// does not sit through the 30 s production default.
process.env.SHOGO_CHANNEL_AGENT_PARK_AFTER_MS = '1000'
process.env.BETTER_AUTH_SECRET ||= 'sho149-acceptance-secret'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const slots = await import('../services/agent-reply-slots')
const capacity = await import('../services/agent-reply-capacity')
const teamChannels = await import('../services/conversation-team-channels')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')

const db = prisma as any
let seed: SeededWorkspace
let builder: string
let invoked: string[] = []
let behaviour: (args: { signal: AbortSignal; sessionId: string }) => Promise<Response> = async (args) =>
  workUntilStopped(args.signal, 'Working.')

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: c.req.header('x-project') ?? null }),
}))

const ticketFor = (userId: string) => signRequesterTicket({ projectId: workspaceTicketKey(seed.workspaceId), userId })

async function asAgent(method: string, path: string, opts: { requester?: string; body?: unknown } = {}) {
  const res = await app.request(`/api/internal/workspaces/${seed.workspaceId}/agent-channels${path}`, {
    method,
    headers: {
      ...(opts.requester ? { 'X-Requester-Ticket': ticketFor(opts.requester) } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function asUser(method: string, path: string, user: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const setLimit = (value: number | null, user = () => seed.owner) =>
  asUser('PUT', `/workspaces/${seed.workspaceId}/agent-capacity`, user(), { agentReplyConcurrency: value })

const readCapacity = (user = () => seed.owner) =>
  asUser('GET', `/workspaces/${seed.workspaceId}/agent-capacity`, user())

async function post(conversationId: string, text: string, user = () => seed.owner) {
  const res = await app.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'x-user': user(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  return (await res.json() as any).message.id as string
}

const tag = (projectId: string) => `<@a:p:${projectId}>`

async function channel(name: string) {
  const { channel: ch } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name,
    private: false,
    agents: [{ projectId: builder, agentTrigger: 'mention' }],
    userEmails: [],
  })
  return db.conversation.findUnique({ where: { id: ch.id } })
}

/** Every live agent reply in a channel, as `agent_runs_list` sees it. */
async function liveRuns(name: string) {
  const listed = await asAgent('GET', `/running-agents?channel=${name}`, { requester: seed.owner })
  expect(listed.status).toBe(200)
  return listed.json.runs as Array<{
    messageId: string
    threadRootId: string | null
    state: 'queued' | 'running' | 'waiting'
    position: number | null
    queuedAt: string | null
  }>
}

const runFor = async (name: string, root: string) => (await liveRuns(name)).find((r) => r.threadRootId === root)

async function rowOf(id: string) {
  return db.conversationMessage.findUnique({ where: { id } })
}

async function rowFor(root: string) {
  return waitFor(async () => db.conversationMessage.findFirst({
    where: { threadRootId: root, authorType: 'agent', authorAgentRef: { not: null } },
  }), 5_000)
}

const frame = (enc: TextEncoder, f: unknown) => enc.encode(`data: ${JSON.stringify(f)}\n\n`)

/** A run that says `text` and then keeps working until it is stopped. */
function workUntilStopped(signal: AbortSignal, text: string): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(frame(enc, { type: 'text-start', id: 't1' }))
      controller.enqueue(frame(enc, { type: 'text-delta', id: 't1', delta: text }))
      signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

/** A run that finishes on its own after `afterMs`, saying `text`. */
function finishesAfter(signal: AbortSignal, text: string, afterMs: number): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(frame(enc, { type: 'text-start', id: 't1' }))
      controller.enqueue(frame(enc, { type: 'text-delta', id: 't1', delta: text }))
      const timer = setTimeout(() => {
        controller.enqueue(frame(enc, { type: 'finish' }))
        controller.close()
      }, afterMs)
      signal.addEventListener('abort', () => { clearTimeout(timer); controller.error(new Error('aborted')) }, { once: true })
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

/** A run blocked on a `wait` tool: heartbeats only, then `finalText` after `finishAfterMs`. */
function waitsOnTool(signal: AbortSignal, opts: { finishAfterMs: number; finalText: string }): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      let seq = 0
      const beat = setInterval(
        () => controller.enqueue(frame(enc, { type: 'data-turn-seq', data: { turnId: 't', seq: ++seq }, transient: true })),
        20,
      )
      controller.enqueue(frame(enc, { type: 'tool-input-start', toolCallId: 'w1', toolName: 'wait' }))
      // The runtime always follows the start with the args, and every 15 s with a
      // progress frame, which is what tells the dispatcher which tool is open.
      controller.enqueue(frame(enc, { type: 'tool-input-delta', toolCallId: 'w1', inputTextDelta: '{"seconds":300}' }))
      const timer = setTimeout(() => {
        clearInterval(beat)
        controller.enqueue(frame(enc, { type: 'tool-output-available', toolCallId: 'w1' }))
        controller.enqueue(frame(enc, { type: 'text-start', id: 't2' }))
        controller.enqueue(frame(enc, { type: 'text-delta', id: 't2', delta: opts.finalText }))
        controller.enqueue(frame(enc, { type: 'finish' }))
        controller.close()
      }, opts.finishAfterMs)
      signal.addEventListener('abort', () => {
        clearInterval(beat)
        clearTimeout(timer)
        controller.error(new Error('aborted'))
      }, { once: true })
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  builder = (await db.project.create({ data: { name: 'Builder', workspaceId: seed.workspaceId } })).id
})

beforeEach(async () => {
  invoked = []
  behaviour = async (args) => workUntilStopped(args.signal, 'Working.')
  dispatcher._resetDispatcherForTests()
  slots._resetAgentReplySlotsForTests()
  capacity.invalidateAgentReplyCapacity()
  // Each scenario starts from the workspace default, not the previous test's setting.
  await db.workspace.update({ where: { id: seed.workspaceId }, data: { agentReplyConcurrency: null } })
  dispatcher.configureConversationAgentDispatcher({
    stopRuntimeTurn: async () => {},
    invoke: async (args) => {
      invoked.push(args.sessionId)
      return behaviour(args)
    },
  })
})

afterAll(async () => {
  await db.conversationMessage.updateMany({ where: { agentStatus: 'running' }, data: { agentStatus: 'stopped' } })
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('a workspace at its limit', () => {
  test('fifteen tags at once at the default limit all start, none waiting', async () => {
    const ch = await channel('burst-room')
    const roots: string[] = []
    for (let i = 1; i <= 15; i++) roots.push(await post(ch.id, `${tag(builder)} burst ${i}`))

    await waitFor(async () => invoked.length === 15, 15_000)
    const runs = await liveRuns('burst-room')
    expect(runs).toHaveLength(15)
    expect(runs.every((r) => r.state === 'running')).toBe(true)
    expect(await readCapacity()).toMatchObject({ json: { limit: 24, running: 15, queued: 0 } })

    await asAgent('POST', '/running-agents/stop', {
      requester: seed.owner,
      body: { channel: '#burst-room', scope: 'workspace' },
    })
  }, 30_000)

  test('extra tags wait with a place in line, and the line moves as runs finish', async () => {
    expect((await setLimit(2)).status).toBe(200)
    const ch = await channel('queue-room')
    const roots: string[] = []
    for (let i = 1; i <= 5; i++) roots.push(await post(ch.id, `${tag(builder)} task ${i}`))

    await waitFor(async () => invoked.length === 2, 8_000)
    await waitFor(async () => (await liveRuns('queue-room')).length === 5, 8_000)

    // Two are working; the last three hold places 1, 2 and 3 — in the order they were sent.
    const runs = await liveRuns('queue-room')
    const stateOf = (root: string) => runs.find((r) => r.threadRootId === root)
    expect(roots.map((root) => stateOf(root)?.state)).toEqual(['running', 'running', 'queued', 'queued', 'queued'])
    expect(roots.slice(2).map((root) => stateOf(root)?.position)).toEqual([1, 2, 3])
    expect(roots.slice(2).map((root) => !!stateOf(root)?.queuedAt)).toEqual([true, true, true])

    // "Queued" survives a reload because it is stored on the placeholder, and the
    // placeholder is still `running` so every existing reader keeps working.
    for (const root of roots.slice(2)) {
      const row = await rowFor(root)
      expect(row.agentStatus).toBe('running')
      expect(typeof (row.blocks as any)?.queued?.since).toBe('string')
    }

    expect(await readCapacity()).toMatchObject({ status: 200, json: { limit: 2, running: 2, queued: 3 } })

    // A run finishing frees its slot: the third tag starts and the rest move up.
    const stopped = await asAgent('POST', '/running-agents/stop', {
      requester: seed.owner,
      body: { messageId: runs.find((r) => r.threadRootId === roots[0])!.messageId },
    })
    expect(stopped.status).toBe(200)
    await waitFor(async () => invoked.length === 3, 8_000)

    const after = await liveRuns('queue-room')
    const stateAfter = (root: string) => after.find((r) => r.threadRootId === root)
    expect(stateAfter(roots[2])?.state).toBe('running')
    expect(roots.slice(3).map((root) => stateAfter(root)?.position)).toEqual([1, 2])
    // The admitted reply is no longer advertised as queued.
    expect((await rowFor(roots[2])).blocks ?? null).toBeNull()
    expect((await readCapacity()).json).toMatchObject({ running: 2, queued: 2 })
  }, 30_000)

  test('stopping a queued reply settles it as stopped and frees its place at once', async () => {
    expect((await setLimit(1)).status).toBe(200)
    const ch = await channel('stop-queued-room')
    const roots = [await post(ch.id, `${tag(builder)} first`)]
    await waitFor(async () => invoked.length === 1, 8_000)
    roots.push(await post(ch.id, `${tag(builder)} second`), await post(ch.id, `${tag(builder)} third`))
    await waitFor(async () => (await liveRuns('stop-queued-room')).length === 3, 8_000)

    const queuedThird = (await liveRuns('stop-queued-room')).find((r) => r.threadRootId === roots[2])!
    expect(queuedThird.state).toBe('queued')
    expect(queuedThird.position).toBe(2)

    const started = Date.now()
    const stopped = await asAgent('POST', '/running-agents/stop', {
      requester: seed.owner,
      body: { messageId: queuedThird.messageId },
    })
    expect(stopped.status).toBe(200)

    const settled = await waitFor(async () => {
      const row = await rowOf(queuedThird.messageId)
      return row.agentStatus === 'stopped' ? row : null
    }, 3_000)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(settled.text).toBe('_Stopped._')
    expect(settled.blocks ?? null).toBeNull()

    // The reply behind it moved up, and nothing is left holding a place for it.
    const after = await liveRuns('stop-queued-room')
    expect(after.map((r) => r.threadRootId)).not.toContain(roots[2])
    expect(after.find((r) => r.threadRootId === roots[1])?.position).toBe(1)
    expect(invoked).toHaveLength(1)
  }, 30_000)

  test('a run blocked on a long tool gives its slot to the next tag, and finishes normally', async () => {
    expect((await setLimit(1)).status).toBe(200)
    const ch = await channel('park-room')
    // The first reply admitted blocks on `wait`; the one behind it works normally.
    behaviour = async (args) =>
      invoked.length === 1
        ? waitsOnTool(args.signal, { finishAfterMs: 9_000, finalText: 'Waited, then answered.' })
        : workUntilStopped(args.signal, 'Second answer.')

    const first = await post(ch.id, `${tag(builder)} wait for CI`)
    const firstRow = await rowFor(first)
    await waitFor(async () => invoked.length === 1, 8_000)

    const second = await post(ch.id, `${tag(builder)} meanwhile`)
    await waitFor(async () => (await liveRuns('park-room')).length === 2, 8_000)
    expect((await liveRuns('park-room')).find((r) => r.threadRootId === second)?.state).toBe('queued')

    // The 5 s slot watcher parks the waiting run (after its 1 s threshold) and the
    // tag behind it starts — without the waiting run being stopped.
    await waitFor(async () => invoked.length === 2, 15_000)
    const parkedRun = await runFor('park-room', first)
    expect(parkedRun?.state).toBe('waiting')
    expect((await rowOf(firstRow.id)).agentStatus).toBe('running')

    // It still finishes on its own, and its answer is stored as usual.
    const done = await waitFor(async () => {
      const row = await rowOf(firstRow.id)
      return row.agentStatus !== 'running' ? row : null
    }, 15_000)
    expect(done.agentStatus).toBe('done')
    expect(done.text).toBe('Waited, then answered.')

    const stillRunning = (await liveRuns('park-room')).find((r) => r.threadRootId === second)!
    await asAgent('POST', '/running-agents/stop', { requester: seed.owner, body: { messageId: stillRunning.messageId } })
  }, 40_000)
})

describe('the run cap', () => {
  test('counts from when the slot was taken, not from when the tag was queued', async () => {
    expect((await setLimit(1)).status).toBe(200)
    dispatcher.configureConversationAgentDispatcher({ replyTimeoutMs: 800, idleTimeoutMs: 30_000 })
    // The first reply admitted occupies the slot briefly, then finishes on its own.
    behaviour = async (args) => finishesAfter(args.signal, invoked.length === 1 ? 'First answer.' : 'Second answer.', 600)

    const ch = await channel('cap-room')
    const first = await post(ch.id, `${tag(builder)} quick one`)
    await waitFor(async () => invoked.length === 1, 8_000)

    const second = await post(ch.id, `${tag(builder)} queued one`)
    await waitFor(async () => (await liveRuns('cap-room')).length === 2, 8_000)

    // The second reply waits in line for ~600 ms; an enqueue-armed 800 ms cap would
    // kill it just after it started. It must run and answer instead.
    const secondRow = await waitFor(async () => {
      const row = await rowFor(second)
      return row.agentStatus !== 'running' ? row : null
    }, 15_000)
    expect(secondRow.agentStatus).toBe('done')
    expect(secondRow.text).toBe('Second answer.')
    expect(invoked).toHaveLength(2)
  }, 30_000)
})

describe('the limit', () => {
  test('an admin can lower it and it applies to the next admission', async () => {
    const before = await readCapacity()
    expect(before.status).toBe(200)
    expect(before.json).toMatchObject({ limit: 24, max: 100, source: 'local', canManage: true })

    const lowered = await setLimit(2)
    expect(lowered.status).toBe(200)
    expect(lowered.json).toMatchObject({ limit: 2, configured: 2 })

    const ch = await channel('applies-room')
    for (let i = 1; i <= 3; i++) await post(ch.id, `${tag(builder)} tag ${i}`)
    await waitFor(async () => (await liveRuns('applies-room')).length === 3, 8_000)
    await waitFor(async () => invoked.length === 2, 8_000)

    const reset = await setLimit(null)
    expect(reset.json).toMatchObject({ limit: 24, configured: null })
  }, 30_000)

  test('only an admin may change it, and only to a number it allows', async () => {
    for (const user of [seed.member, seed.viewer]) {
      const refused = await setLimit(2, () => user)
      expect(refused.status).toBe(403)
      expect(refused.json.error.code).toBe('forbidden')
    }

    // A viewer can read the number, without the right to change it.
    const read = await readCapacity(() => seed.viewer)
    expect(read.status).toBe(200)
    expect(read.json.canManage).toBe(false)

    expect((await setLimit(0)).status).toBe(400)
    expect((await setLimit(101)).status).toBe(400)
    const notANumber = await asUser('PUT', `/workspaces/${seed.workspaceId}/agent-capacity`, seed.owner, {
      agentReplyConcurrency: 'lots',
    })
    expect(notANumber.status).toBe(400)
  }, 30_000)
})
