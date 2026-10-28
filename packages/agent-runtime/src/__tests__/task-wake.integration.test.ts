// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end task delivery through a real AgentGateway with a scripted model
 * and a stub API server:
 *
 * - a task finishing mid-turn is injected into that turn as a [Task update]
 * - a task finishing while idle is handed to the API once (it queues the wake)
 * - the wake turn acknowledges the task, so it is not injected again
 * - Stop mutes running tasks
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Message } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { SqliteSessionPersistence } from '../sqlite-session-persistence'
import { buildTextResponse, buildToolUseResponse, createMockStreamFn } from '../pi-adapter'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

interface ApiCall { method: string; path: string; body: any }

let server: ReturnType<typeof Bun.serve>
const apiCalls: ApiCall[] = []
const savedEnv: Record<string, string | undefined> = {}
/** How many notify calls the stub refuses before it accepts them. */
let notifyFailures = 0

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'GET' ? null : await req.json().catch(() => null)
      apiCalls.push({ method: req.method, path: url.pathname, body })
      if (url.pathname === '/api/internal/tasks/notify') {
        if (notifyFailures > 0) {
          notifyFailures--
          return Response.json({ error: 'boom' }, { status: 500 })
        }
        return Response.json({ queued: true })
      }
      if (url.pathname === '/api/internal/tasks/consume') return Response.json({ ok: true })
      return Response.json({})
    },
  })
  for (const key of ['SHOGO_API_URL', 'RUNTIME_AUTH_SECRET']) savedEnv[key] = process.env[key]
  process.env.SHOGO_API_URL = `http://127.0.0.1:${server.port}`
  process.env.RUNTIME_AUTH_SECRET = 'test-secret'
})

afterAll(() => {
  server.stop(true)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearTrustForTests()
})

let testDir: string
let gateway: AgentGateway | undefined
let counter = 0

beforeEach(() => {
  apiCalls.length = 0
  notifyFailures = 0
  testDir = join(tmpdir(), `test-task-wake-${process.pid}-${++counter}`)
  rmSync(testDir, { recursive: true, force: true })
  mkdirSync(join(testDir, 'memory'), { recursive: true })
  mkdirSync(join(testDir, 'skills'), { recursive: true })
  writeFileSync(join(testDir, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800,
    heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
  }))
  writeFileSync(join(testDir, 'AGENTS.md'), '# Agent\nYou are a test agent.')
  trustWorkspaceForTests(testDir)
})

afterEach(async () => {
  if (gateway) await gateway.stop()
  gateway = undefined
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const writer = () => ({ write() {} })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(50)
  }
  throw new Error('waitUntil timed out')
}

function textOf(m: Message): string {
  if (typeof m.content === 'string') return m.content
  return (m.content as any[]).map((c) => c.text ?? '').join('')
}

function taskUpdatesIn(messages: Message[]): string[] {
  return messages.filter((m) => m.role === 'user').map(textOf).filter((t) => t.includes('[Task update]'))
}

async function startGateway(responses: ReturnType<typeof buildTextResponse>[], onCall?: (i: number, msgs: Message[]) => void) {
  gateway = new AgentGateway(testDir, 'test-project')
  gateway.setStreamFn(createMockStreamFn(responses, onCall))
  await gateway.start()
  return gateway
}

/** The task ids of the exec tool results in the conversation, in order. */
function execTaskIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const m of messages) {
    if (m.role !== 'toolResult') continue
    const match = textOf(m).match(/"task_id":\s*"(t_[^"]+)"/)
    if (match && !ids.includes(match[1]!)) ids.push(match[1]!)
  }
  return ids
}

/** The task id from the first exec tool result in the conversation. */
function execTaskId(messages: Message[]): string {
  const [id] = execTaskIds(messages)
  if (!id) throw new Error('no task_id in tool results')
  return id
}

describe('task wake', () => {
  test('a task finishing mid-turn is injected into the running turn, not sent to the API', async () => {
    const calls: Message[][] = []
    const gw = await startGateway([
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.2', background: true }, id: 'tc-1' }]),
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.8' }, id: 'tc-2' }]),
      buildTextResponse('The build finished.'),
    ], (_i, msgs) => calls.push([...msgs]))

    await gw.processChatMessageStream('run the build in the background', writer() as any, { chatSessionId: 'mid-turn' })

    expect(calls).toHaveLength(3)
    const updates = taskUpdatesIn(calls[2]!)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toContain(`(${execTaskId(calls[2]!)}) completed`)
    expect(updates[0]).toContain('Output: .shogo/tasks/mid-turn/')

    await sleep(2_500)
    expect(apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')).toHaveLength(0)
  }, 15_000)

  test('two tasks finishing mid-turn arrive as two separate messages', async () => {
    const calls: Message[][] = []
    const gw = await startGateway([
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.2', background: true }, id: 'tc-1' }]),
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.2', background: true }, id: 'tc-2' }]),
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.9' }, id: 'tc-3' }]),
      buildTextResponse('The first build finished.'),
      buildTextResponse('The second build finished too.'),
    ], (_i, msgs) => calls.push([...msgs]))

    await gw.processChatMessageStream('run both builds in the background', writer() as any, { chatSessionId: 'mid-turn-two' })

    const ids = execTaskIds(calls[2]!)
    expect(ids).toHaveLength(2)

    const notes = calls.at(-1)!.filter((m) => m.role === 'user' && textOf(m).includes('[Task update]'))
    expect(notes).toHaveLength(2)
    expect(notes.map(textOf)).toEqual([
      expect.stringContaining(`(${ids[0]}) completed`),
      expect.stringContaining(`(${ids[1]}) completed`),
    ])
    // One [Task update] per message: they are not joined into a single note.
    for (const note of notes) expect((textOf(note).match(/\[Task update\]/g) ?? []).length).toBe(1)

    await sleep(2_500)
    expect(apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')).toHaveLength(0)
  }, 20_000)

  test('a wake turn does not consume another finished task\'s note', async () => {
    const calls: Message[][] = []
    const gw = await startGateway([
      buildToolUseResponse([
        { name: 'exec', arguments: { command: 'sleep 0.1', background: true }, id: 'tc-1' },
        { name: 'exec', arguments: { command: 'sleep 0.1', background: true }, id: 'tc-2' },
      ]),
      buildTextResponse('Both builds are running.'),
      buildTextResponse('The first build is done.'),
      buildTextResponse('The second build is done.'),
    ], (_i, msgs) => calls.push([...msgs]))

    await gw.processChatMessageStream('run two builds', writer() as any, { chatSessionId: 'two-notes' })
    const ids = execTaskIds(calls[1]!)
    expect(ids).toHaveLength(2)

    // Both finish while the session is idle: one notify carrying both notes.
    await sleep(3_000)
    const notifies = apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')
    expect(notifies).toHaveLength(1)
    const notes = new Map<string, string>(notifies[0]!.body.tasks.map((t: any) => [t.id, t.text]))
    expect([...notes.keys()].sort()).toEqual([...ids].sort())

    // The API dispatches one wake row per finished task. The first task's turn
    // must leave the second task's pending note alone: it belongs to its own
    // wake, and consuming it here drops that wake as already-seen.
    const beforeWake = calls.length
    gw.acknowledgeTaskNotification('two-notes', [ids[0]!])
    await gw.processChatMessageStream(notes.get(ids[0]!)!, writer() as any, { chatSessionId: 'two-notes' })

    expect(calls.length - beforeWake).toBe(1) // one model turn: nothing was injected
    expect(taskUpdatesIn(calls.at(-1)!).filter((t) => t.includes(ids[1]!))).toHaveLength(0)

    await sleep(300) // consume is reported in the background
    const consumed = apiCalls
      .filter((c) => c.path === '/api/internal/tasks/consume')
      .flatMap((c) => c.body.ids ?? c.body.taskIds ?? [])
    expect(consumed).toContain(ids[0]!)
    expect(consumed).not.toContain(ids[1]!)

    // Its own wake turn still delivers it, exactly once.
    gw.acknowledgeTaskNotification('two-notes', [ids[1]!])
    await gw.processChatMessageStream(notes.get(ids[1]!)!, writer() as any, { chatSessionId: 'two-notes' })
    const delivered = calls.slice(beforeWake).flatMap((turn) => taskUpdatesIn(turn)).filter((t) => t.includes(ids[1]!))
    expect(delivered).toHaveLength(1)
  }, 20_000)

  test('a task finishing while idle is handed to the API once, and the wake turn does not repeat it', async () => {
    const calls: Message[][] = []
    const gw = await startGateway([
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.3', background: true }, id: 'tc-1' }]),
      buildTextResponse('Started; I will continue when it finishes.'),
      buildTextResponse('Tests passed.'),
    ], (_i, msgs) => calls.push([...msgs]))

    await gw.processChatMessageStream('run the tests', writer() as any, { chatSessionId: 'idle' })
    const taskId = execTaskId(calls[1]!)

    await sleep(3_000)
    const notifies = apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')
    expect(notifies).toHaveLength(1)
    expect(notifies[0]!.body.chatSessionId).toBe('idle')
    expect(notifies[0]!.body.tasks).toHaveLength(1)
    expect(notifies[0]!.body.tasks[0]).toMatchObject({ id: taskId, source: 'shell', status: 'completed' })
    expect(notifies[0]!.body.tasks[0].text).toContain('[Task update]')

    // The API's queued wake message arrives as the next turn (server.ts acks it first).
    const wakeText = notifies[0]!.body.tasks[0].text
    gw.acknowledgeTaskNotification('idle', [taskId])
    await gw.processChatMessageStream(wakeText, writer() as any, { chatSessionId: 'idle' })

    await sleep(200) // consume is reported in the background
    const wakeTurn = calls[2]!
    expect(taskUpdatesIn(wakeTurn)).toHaveLength(1)
    expect(apiCalls.filter((c) => c.path === '/api/internal/tasks/consume').flatMap((c) => c.body.ids ?? c.body.taskIds ?? []))
      .toContain(taskId)

    await sleep(2_500)
    expect(apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')).toHaveLength(1)
  }, 20_000)

  test('without internal API credentials a pending note is swept into the next turn, once', async () => {
    const calls: Message[][] = []
    const gw = await startGateway([
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.3', background: true }, id: 'tc-1' }]),
      buildTextResponse('Started; I will report back when it finishes.'),
      buildTextResponse('Yes, it finished.'),
      buildTextResponse('Anything else?'),
    ], (_i, msgs) => calls.push([...msgs]))

    // No credentials means notify is never sent (flushTaskWake can only retry),
    // so nothing can wake the session between turns: drop them before the task
    // settles so the flush sees a credential-less runtime.
    delete process.env.RUNTIME_AUTH_SECRET
    try {
      await gw.processChatMessageStream('run the build', writer() as any, { chatSessionId: 'no-creds' })
      const taskId = execTaskId(calls[1]!)

      await sleep(3_000)
      expect(apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')).toHaveLength(0)

      // The next turn sweeps the pending note in as its own message — this is
      // the only delivery path in a runtime that cannot queue a wake.
      await gw.processChatMessageStream('did the build finish?', writer() as any, { chatSessionId: 'no-creds' })
      const swept = calls.at(-1)!.filter((m) => m.role === 'user' && textOf(m).includes('[Task update]'))
      expect(swept).toHaveLength(1)
      expect(textOf(swept[0]!)).toContain(`(${taskId}) completed`)
      expect((textOf(swept[0]!).match(/\[Task update\]/g) ?? []).length).toBe(1)

      // Consumed, exactly once: the turn after that does not repeat it.
      await gw.processChatMessageStream('thanks', writer() as any, { chatSessionId: 'no-creds' })
      expect(taskUpdatesIn(calls.at(-1)!)).toHaveLength(0)
      expect(apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')).toHaveLength(0)
    } finally {
      process.env.RUNTIME_AUTH_SECRET = 'test-secret'
    }
  }, 20_000)

  test('a runtime started without credentials sweeps each pending note as its own message, once', async () => {
    // A genuinely credential-less runtime: the gateway starts with no internal
    // API client at all, so no task is apiTracked and no wake can ever be
    // queued. Every finished task must still reach the transcript.
    const savedSecret = process.env.RUNTIME_AUTH_SECRET
    delete process.env.RUNTIME_AUTH_SECRET
    const calls: Message[][] = []
    try {
      const gw = await startGateway([
        buildToolUseResponse([
          { name: 'exec', arguments: { command: 'sleep 0.2', background: true }, id: 'tc-1' },
          { name: 'exec', arguments: { command: 'sleep 0.2', background: true }, id: 'tc-2' },
        ]),
        buildTextResponse('Both builds are running.'),
        buildTextResponse('Both builds finished.'),
        buildTextResponse('Anything else?'),
      ], (_i, msgs) => calls.push([...msgs]))

      await gw.processChatMessageStream('run two builds', writer() as any, { chatSessionId: 'no-creds-two' })
      const ids = execTaskIds(calls[1]!)
      expect(ids).toHaveLength(2)

      await sleep(3_000)
      expect(apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')).toHaveLength(0)

      await gw.processChatMessageStream('did they finish?', writer() as any, { chatSessionId: 'no-creds-two' })
      const swept = calls.at(-1)!.filter((m) => m.role === 'user' && textOf(m).includes('[Task update]'))
      expect(swept).toHaveLength(2)
      const sweptIds = swept.map((m) => textOf(m).match(/\((t_[^)]+)\) completed/)?.[1])
      expect(new Set(sweptIds)).toEqual(new Set(ids))
      // One [Task update] per message: the two are not joined into one note.
      for (const note of swept) expect((textOf(note).match(/\[Task update\]/g) ?? []).length).toBe(1)

      // Consumed, exactly once: the turn after that repeats neither.
      await gw.processChatMessageStream('thanks', writer() as any, { chatSessionId: 'no-creds-two' })
      expect(taskUpdatesIn(calls.at(-1)!)).toHaveLength(0)
      expect(apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')).toHaveLength(0)
    } finally {
      if (savedSecret === undefined) delete process.env.RUNTIME_AUTH_SECRET
      else process.env.RUNTIME_AUTH_SECRET = savedSecret
    }
  }, 20_000)

  test('a notify the API refuses is retried and delivered exactly once', async () => {
    notifyFailures = 1
    const calls: Message[][] = []
    const gw = await startGateway([
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.3', background: true }, id: 'tc-1' }]),
      buildTextResponse('Started; I will report back when it finishes.'),
    ], (_i, msgs) => calls.push([...msgs]))

    const notifies = () => apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')
    await gw.processChatMessageStream('run the build', writer() as any, { chatSessionId: 'retry' })

    await waitUntil(() => notifies().length === 1)   // coalesced, then refused
    await waitUntil(() => notifies().length === 2)   // retried, then accepted
    await sleep(1_000)
    expect(notifies()).toHaveLength(2)
    expect(notifies()[1]!.body.chatSessionId).toBe('retry')
    expect(notifies()[1]!.body.tasks[0]).toMatchObject({ id: notifies()[0]!.body.tasks[0].id, source: 'shell' })
  }, 20_000)

  test('Stop drops a wake the API refused instead of retrying it', async () => {
    notifyFailures = 5
    const calls: Message[][] = []
    const gw = await startGateway([
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.3', background: true }, id: 'tc-1' }]),
      buildTextResponse('Started.'),
    ], (_i, msgs) => calls.push([...msgs]))

    const notifies = () => apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')
    await gw.processChatMessageStream('run the build', writer() as any, { chatSessionId: 'retry-stopped' })

    await waitUntil(() => notifies().length === 1)
    gw.muteSessionTasks('retry-stopped')
    await sleep(3_000)
    expect(notifies()).toHaveLength(1)
  }, 20_000)

  test('Stop mutes running tasks so they never wake the agent', async () => {
    const calls: Message[][] = []
    const gw = await startGateway([
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.3', background: true }, id: 'tc-1' }]),
      buildTextResponse('Started.'),
    ], (_i, msgs) => calls.push([...msgs]))

    await gw.processChatMessageStream('start the server', writer() as any, { chatSessionId: 'stopped' })
    gw.muteSessionTasks('stopped')

    await sleep(3_000)
    expect(apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')).toHaveLength(0)
    const tasks = await gw.listSessionTasks('stopped')
    expect(tasks.filter((t) => t.status === 'running')).toHaveLength(0)
  }, 15_000)

  /**
   * SHO-196: a card watch the API owns must never be handed to the API as a
   * local task. `forget()` evicts entries under memory pressure; the note it
   * used to leave behind failed every ownership guard (the entry was gone), so
   * each turn end re-POSTed it, and the API turned it back into a wake carrying
   * the old milestone text — 15+ times in one Planner session.
   */
  test('an evicted API-tracked task is never handed to the API as a local task', async () => {
    const gw = await startGateway([buildTextResponse('one'), buildTextResponse('two')])
    const reg = (gw as any).getOrCreateCommandRegistry('evicted') as import('../task-registry').TaskRegistry

    // The registry keeps at most 20 unread results. 21 settled card watches push
    // the oldest out of memory, exactly as a busy Planner session did.
    for (let i = 0; i < 21; i++) {
      reg.registerRemote({
        id: `t_evict${String(i).padStart(3, '0')}`,
        source: 'work_item',
        title: `SUP-${i}`,
        apiTracked: true,
        client: {
          async get(id) { return { id, status: 'completed', output: `moved to Done (done) #${i}` } },
          async cancel() {},
          async consume() {},
        },
      })
      await sleep(2)
      await reg.refreshRemote()
    }

    expect(reg.get('t_evict000')).toBeUndefined()
    expect(reg.peekNotifications().map((n) => n.taskId)).not.toContain('t_evict000')

    // Two turn ends, and the coalesce window after them: nothing is reported.
    await gw.processChatMessageStream('one', writer() as any, { chatSessionId: 'evicted' })
    await gw.processChatMessageStream('two', writer() as any, { chatSessionId: 'evicted' })
    await sleep(2_500)

    const notified = apiCalls.filter((c) => c.path === '/api/internal/tasks/notify')
    expect(notified).toHaveLength(0)
  }, 30_000)

  test('clearing a session\'s history stops its background tasks', async () => {
    const calls: Message[][] = []
    const gw = await startGateway([
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 30', background: true }, id: 'tc-1' }]),
      buildTextResponse('Started.'),
    ], (_i, msgs) => calls.push([...msgs]))

    await gw.processChatMessageStream('start the server', writer() as any, { chatSessionId: 'cleared' })
    const pid = Number(textOf(calls[1]!.find((m) => m.role === 'toolResult')!).match(/"pid":\s*(\d+)/)![1])
    expect(() => process.kill(pid, 0)).not.toThrow()

    gw.clearSessionHistory('cleared')
    await sleep(500)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(await gw.listSessionTasks('cleared')).toHaveLength(0)
  }, 15_000)

  test('clearing a session\'s history resets its shell directory', async () => {
    const gw = await startGateway([buildTextResponse('ok')])
    const shellCwd = (gw as any).shellCwd as Map<string, string>
    shellCwd.set('cd-session', '/tmp')
    gw.clearSessionHistory('cd-session')
    expect(shellCwd.has('cd-session')).toBe(false)
  })

  /**
   * `GET /agent/chat/:chatSessionId/tasks` is a thin wrapper over
   * `listSessionTasks`, so this is the payload the dock seeds from: a task
   * that settles while the turn runs keeps its row instead of vanishing with
   * the frame that announced it.
   */
  test('the dock payload carries a finished task next to a running one', async () => {
    const gw = await startGateway([
      buildToolUseResponse([
        { name: 'exec', arguments: { command: 'sleep 0.1', background: true }, id: 'tc-1' },
        { name: 'exec', arguments: { command: 'sleep 30', background: true }, id: 'tc-2' },
      ]),
      buildTextResponse('Both started.'),
    ], () => {})

    await gw.processChatMessageStream('run them', writer() as any, { chatSessionId: 'dock-list' })
    await sleep(600)

    const tasks = await gw.listSessionTasks('dock-list')
    expect(tasks.map((t) => t.status).sort()).toEqual(['completed', 'running'])
    const done = tasks.find((t) => t.status === 'completed')!
    expect(done.finishedAt).toBeGreaterThan(0)
    expect(done.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(done.outputFile).toContain('.shogo/tasks/dock-list/')

    // The agent's own view is unchanged: only running tasks.
    expect(gw.listSessionProcesses('dock-list').map((t) => t.status)).toEqual(['running'])
  }, 20_000)

  /**
   * AC7: after a restart the first seed request already carries the rows.
   * `sessionManager.get()` is memory-only, so the registry has to wait for the
   * session load — ChatPanel only polls this route while it has rows, so an
   * empty first answer is never retried.
   */
  test('a cold runtime answers the seed route from the persisted session', async () => {
    const warm = await startGateway([
      buildToolUseResponse([{ name: 'exec', arguments: { command: 'sleep 0.2', background: true }, id: 'tc-1' }]),
      buildTextResponse('Started.'),
    ], () => {})
    await warm.processChatMessageStream('start it', writer() as any, { chatSessionId: 'cold-seed' })
    await sleep(800)
    expect((await warm.listSessionTasks('cold-seed')).map((t) => t.status)).toEqual(['completed'])

    // What the finished run left on disk: the settled row, terminal.
    const reader = new SqliteSessionPersistence(testDir)
    const persisted = await reader.load('cold-seed')
    reader.close()
    const rows = persisted?.metadata?.runningProcesses
    expect(rows?.map((r: any) => r.status)).toEqual(['completed'])
    expect(rows?.[0]?.finishedAt).toBeGreaterThan(0)
    await warm.stop()
    gateway = undefined

    // A graceful stop kills the tasks it tracked and persists the empty list;
    // a real restart does not get that chance, so put the pre-stop record back
    // and boot a cold process over it.
    const restore = new SqliteSessionPersistence(testDir)
    await restore.save('cold-seed', persisted!)
    restore.close()

    const cold = await startGateway([buildTextResponse('ok')])
    const tasks = await cold.listSessionTasks('cold-seed')
    expect(tasks.map((t) => t.status)).toEqual(['completed'])
    expect(tasks[0]!.command).toContain('sleep 0.2')
  }, 30_000)
})
