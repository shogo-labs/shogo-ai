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
import { buildTextResponse, buildToolUseResponse, createMockStreamFn } from '../pi-adapter'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

interface ApiCall { method: string; path: string; body: any }

let server: ReturnType<typeof Bun.serve>
const apiCalls: ApiCall[] = []
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'GET' ? null : await req.json().catch(() => null)
      apiCalls.push({ method: req.method, path: url.pathname, body })
      if (url.pathname === '/api/internal/tasks/notify') return Response.json({ queued: true })
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

/** The task id from the first exec tool result in the conversation. */
function execTaskId(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== 'toolResult') continue
    const match = textOf(m).match(/"task_id":\s*"(t_[^"]+)"/)
    if (match) return match[1]!
  }
  throw new Error('no task_id in tool results')
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
})
