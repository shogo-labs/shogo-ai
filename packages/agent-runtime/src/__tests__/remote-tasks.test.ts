// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `trackRemoteTask` against a stub internal API: a task the API refuses to
 * create must not be silently dropped.
 *
 * A task with no `background_tasks` row can never wake the session —
 * `enqueueTaskWake` only reads rows and the drain sweep has nothing to
 * reconcile — so a refused create is retried on the wake flush's backoff and,
 * if it never lands, is logged once and left visible in the registry.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { TaskRegistry } from '../task-registry'
import { trackRemoteTask, __setCreateRetryDelaysForTest } from '../remote-tasks'

interface ApiCall { method: string; path: string; body: any }

let server: ReturnType<typeof Bun.serve>
const apiCalls: ApiCall[] = []
/** Task rows the stub "created", keyed by id — one per accepted POST. */
const rows = new Map<string, any>()
/** How many task creates the stub refuses before accepting them. */
let createFailures = 0
const savedEnv: Record<string, string | undefined> = {}

const TASKS = '/api/internal/tasks'

const createPosts = () => apiCalls.filter((c) => c.path === TASKS && c.method === 'POST')

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'GET' ? null : await req.json().catch(() => null)
      apiCalls.push({ method: req.method, path: url.pathname, body })
      if (url.pathname === TASKS && req.method === 'POST') {
        if (createFailures > 0) {
          createFailures--
          return Response.json({ error: 'boom' }, { status: 500 })
        }
        if (body?.id && !rows.has(body.id)) rows.set(body.id, { ...body, status: 'running' })
        return Response.json({ task: rows.get(body?.id) })
      }
      if (url.pathname === `${TASKS}/consume`) return Response.json({ ok: true })
      if (url.pathname === `${TASKS}/notify`) return Response.json({ queued: true })
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
})

let testDir: string
let registry: TaskRegistry
let restoreDelays: (() => void) | undefined
let counter = 0

beforeEach(() => {
  apiCalls.length = 0
  rows.clear()
  createFailures = 0
  // Tight schedule: the attempt *count* is what matters, not the wall time.
  restoreDelays = __setCreateRetryDelaysForTest([10, 10, 10, 10, 10])
  testDir = join(tmpdir(), `test-remote-tasks-${process.pid}-${++counter}`)
  rmSync(testDir, { recursive: true, force: true })
  mkdirSync(join(testDir, 'tasks'), { recursive: true })
  registry = new TaskRegistry({ outputDir: join(testDir, 'tasks'), workspaceDir: testDir })
})

afterEach(() => {
  restoreDelays?.()
  restoreDelays = undefined
  registry.killAll()
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(10)
  }
  throw new Error('waitUntil timed out')
}

/** What the gateway's wake flush would hand the API: notes no row already covers. */
const deliverableNotes = () =>
  registry.peekNotifications().filter((n) => !registry.get(n.taskId)?.apiTracked && !registry.get(n.taskId)?.reported)

describe('trackRemoteTask', () => {
  test('a create the API refuses twice is retried and leaves exactly one row, so the finish wakes once', async () => {
    createFailures = 2

    const task = await trackRemoteTask(registry, 'chat-1', {
      source: 'work_item',
      targetRef: 'card-1',
      title: 'SHO-1 a card',
    })

    // The task is tracked even though the row is not there yet.
    expect(task).toBeDefined()
    const entry = registry.get(task!.task_id)!
    expect(entry.status).toBe('running')
    expect(entry.apiTracked).toBe(true) // the API wakes the session; the runtime does not notify

    await waitUntil(() => rows.size === 1)

    const posts = createPosts()
    expect(posts).toHaveLength(3) // refused, refused, accepted
    // Every attempt carries the same client-generated id, so the API cannot
    // end up with two rows (and the session with two wakes) for one task.
    expect(new Set(posts.map((c) => c.body.id))).toEqual(new Set([task!.task_id]))
    expect(rows.size).toBe(1)

    // When it finishes, the single row is the one wake: the runtime adds no
    // local note the gateway would also send.
    registry.applyRemoteState(entry, { id: entry.id, status: 'completed', result: { summary: 'done' } })
    expect(entry.status).toBe('completed')
    expect(deliverableNotes()).toHaveLength(0)
  }, 15_000)

  test('a create that never lands is logged once and the task stays visible locally', async () => {
    createFailures = 99
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')) }

    let task: Awaited<ReturnType<typeof trackRemoteTask>>
    try {
      task = await trackRemoteTask(registry, 'chat-2', {
        source: 'project_call',
        targetRef: 'proj-1:run-1',
        title: 'Project: do the thing',
      })
      await waitUntil(() => warnings.length > 0)
    } finally {
      console.warn = realWarn
    }

    // Still tracked: the agent sees it in the dock/list even with no API row.
    expect(task!).toBeDefined()
    const entry = registry.get(task!.task_id)!
    expect(entry.status).toBe('running')
    expect(registry.listRunning().some((t) => t.id === entry.id)).toBe(true)

    // First attempt plus one per scheduled delay.
    expect(createPosts()).toHaveLength(6)
    expect(rows.size).toBe(0)

    const giveUp = warnings.filter((w) => w.includes('Gave up creating the API row'))
    expect(giveUp).toHaveLength(1)
    expect(giveUp[0]).toContain(entry.id)
    expect(giveUp[0]).toContain('project_call:proj-1:run-1')

    // No phantom wake: nothing local is queued for the API to deliver.
    registry.applyRemoteState(entry, { id: entry.id, status: 'completed', result: { summary: 'done' } })
    expect(deliverableNotes()).toHaveLength(0)
  }, 15_000)

  test('a create the API accepts first time is not retried', async () => {
    const task = await trackRemoteTask(registry, 'chat-3', {
      source: 'work_item',
      targetRef: 'card-2',
      title: 'SHO-2 another card',
    })

    await sleep(100) // nothing should be retried behind our back
    expect(task).toBeDefined()
    expect(createPosts()).toHaveLength(1)
    expect(rows.size).toBe(1)
    expect(registry.get(task!.task_id)?.apiTracked).toBe(true)
  })

  test('without API credentials the call still returns undefined and touches nothing', async () => {
    const saved = { api: process.env.SHOGO_API_URL, secret: process.env.RUNTIME_AUTH_SECRET }
    delete process.env.SHOGO_API_URL
    delete process.env.RUNTIME_AUTH_SECRET
    try {
      const task = await trackRemoteTask(registry, 'chat-4', {
        source: 'work_item',
        targetRef: 'card-3',
        title: 'SHO-3 a card',
      })
      expect(task).toBeUndefined()
      expect(createPosts()).toHaveLength(0)
      expect(registry.size()).toBe(0)
    } finally {
      if (saved.api !== undefined) process.env.SHOGO_API_URL = saved.api
      if (saved.secret !== undefined) process.env.RUNTIME_AUTH_SECRET = saved.secret
    }
  })
})
