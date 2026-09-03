// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/lib/a2a/task-store.ts (PrismaA2ATaskStore). Prisma is
// mocked with a tiny in-memory `a2aTask` table so save/load/list can be
// exercised without a real database.

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { ServerCallContext, type TaskStore } from '@a2a-js/sdk/server'
import { TaskState, type ListTasksRequest, type Task } from '@a2a-js/sdk'

interface FakeRow {
  id: string
  contextId: string
  projectId: string
  state: string
  taskJson: string
  chatSessionId: string | null
  createdAt: Date
  updatedAt: Date
}

let rows: FakeRow[] = []
let clock = 0

mock.module('../../prisma', () => ({
  prisma: {
    a2aTask: {
      upsert: async ({ where, create, update }: any) => {
        const existing = rows.find((r) => r.id === where.id)
        clock += 1
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date(clock) })
          return existing
        }
        const row: FakeRow = {
          id: create.id,
          contextId: create.contextId,
          projectId: create.projectId,
          state: create.state,
          taskJson: create.taskJson,
          chatSessionId: create.chatSessionId ?? null,
          createdAt: new Date(clock),
          updatedAt: new Date(clock),
        }
        rows.push(row)
        return row
      },
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where, orderBy, skip, take }: any) => {
        let result = rows.filter((r) => matchesWhere(r, where))
        if (orderBy?.updatedAt === 'desc') result = [...result].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        return result.slice(skip ?? 0, (skip ?? 0) + (take ?? result.length))
      },
      count: async ({ where }: any) => rows.filter((r) => matchesWhere(r, where)).length,
    },
  },
}))

function matchesWhere(row: FakeRow, where: any): boolean {
  if (where.projectId !== undefined && row.projectId !== where.projectId) return false
  if (where.contextId !== undefined && row.contextId !== where.contextId) return false
  if (where.state !== undefined && row.state !== where.state) return false
  if (where.updatedAt?.gte !== undefined && row.updatedAt.getTime() < where.updatedAt.gte.getTime()) return false
  return true
}

const { PrismaA2ATaskStore } = await import('../task-store')

function ctx(tenant: string | undefined): ServerCallContext {
  return new ServerCallContext({ tenant })
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    contextId: overrides.contextId ?? 'ctx-1',
    status: overrides.status ?? { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: '2026-01-01T00:00:00Z' },
    artifacts: overrides.artifacts ?? [],
    history: overrides.history ?? [],
    metadata: overrides.metadata,
  }
}

let store: TaskStore

beforeEach(() => {
  rows = []
  clock = 0
  store = new PrismaA2ATaskStore()
})

describe('save', () => {
  it('persists a new task scoped to context.tenant', async () => {
    const task = makeTask({ id: 't1', contextId: 'c1' })
    await store.save(task, ctx('p1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 't1', contextId: 'c1', projectId: 'p1', state: 'TASK_STATE_WORKING' })
    expect(JSON.parse(rows[0].taskJson)).toEqual(task)
  })

  it('extracts chatSessionId from task.metadata on create', async () => {
    const task = makeTask({ id: 't1', metadata: { chatSessionId: 'sess-1' } })
    await store.save(task, ctx('p1'))
    expect(rows[0].chatSessionId).toBe('sess-1')
  })

  it('upserts (overwrites) an existing task with the same id', async () => {
    await store.save(makeTask({ id: 't1', status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: 't' } }), ctx('p1'))
    await store.save(makeTask({ id: 't1', status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: 't2' } }), ctx('p1'))
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('TASK_STATE_COMPLETED')
  })

  it('does not clear chatSessionId on an update that omits metadata', async () => {
    await store.save(makeTask({ id: 't1', metadata: { chatSessionId: 'sess-1' } }), ctx('p1'))
    await store.save(makeTask({ id: 't1', metadata: undefined }), ctx('p1'))
    expect(rows[0].chatSessionId).toBe('sess-1')
  })

  it('throws when context.tenant is missing', async () => {
    await expect(store.save(makeTask(), ctx(undefined))).rejects.toThrow(/context.tenant/)
  })

  it('defaults state to TASK_STATE_UNSPECIFIED when task.status is absent', async () => {
    const task = makeTask({ id: 't1' })
    delete (task as any).status
    await store.save(task, ctx('p1'))
    expect(rows[0].state).toBe('TASK_STATE_UNSPECIFIED')
  })
})

describe('load', () => {
  it('round-trips a saved task', async () => {
    const task = makeTask({ id: 't1' })
    await store.save(task, ctx('p1'))
    const loaded = await store.load('t1', ctx('p1'))
    expect(loaded).toEqual(task)
  })

  it('returns undefined for an unknown taskId', async () => {
    expect(await store.load('nope', ctx('p1'))).toBeUndefined()
  })

  it('returns undefined when context.tenant is missing', async () => {
    await store.save(makeTask({ id: 't1' }), ctx('p1'))
    expect(await store.load('t1', ctx(undefined))).toBeUndefined()
  })

  it('never returns a task belonging to a different project (tenant isolation)', async () => {
    await store.save(makeTask({ id: 't1' }), ctx('p1'))
    expect(await store.load('t1', ctx('p2'))).toBeUndefined()
  })
})

describe('list', () => {
  async function seed() {
    await store.save(makeTask({ id: 't1', contextId: 'c1', status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: 't' } }), ctx('p1'))
    await store.save(makeTask({ id: 't2', contextId: 'c1', status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: 't' } }), ctx('p1'))
    await store.save(makeTask({ id: 't3', contextId: 'c2', status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: 't' } }), ctx('p1'))
    await store.save(makeTask({ id: 't4', contextId: 'c1' }), ctx('p2'))
  }

  function req(overrides: Partial<ListTasksRequest> = {}): ListTasksRequest {
    return {
      tenant: '',
      contextId: '',
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: '',
      statusTimestampAfter: undefined,
      ...overrides,
    } as ListTasksRequest
  }

  it('scopes results to context.tenant, never leaking another project', async () => {
    await seed()
    const result = await store.list(req(), ctx('p1'))
    expect(result.totalSize).toBe(3)
    expect(result.tasks.map((t) => t.id).sort()).toEqual(['t1', 't2', 't3'])
  })

  it('filters by contextId', async () => {
    await seed()
    const result = await store.list(req({ contextId: 'c2' }), ctx('p1'))
    expect(result.tasks.map((t) => t.id)).toEqual(['t3'])
  })

  it('filters by status', async () => {
    await seed()
    const result = await store.list(req({ status: TaskState.TASK_STATE_COMPLETED }), ctx('p1'))
    expect(result.tasks.map((t) => t.id).sort()).toEqual(['t2', 't3'])
  })

  it('returns an empty page when context.tenant is missing and params.tenant is also empty', async () => {
    await seed()
    const result = await store.list(req(), ctx(undefined))
    expect(result).toEqual({ tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 })
  })

  it('paginates with pageSize and an opaque pageToken, terminating with an empty nextPageToken', async () => {
    await seed()
    const page1 = await store.list(req({ pageSize: 2 }), ctx('p1'))
    expect(page1.tasks).toHaveLength(2)
    expect(page1.pageSize).toBe(2)
    expect(page1.totalSize).toBe(3)
    expect(page1.nextPageToken).not.toBe('')

    const page2 = await store.list(req({ pageSize: 2, pageToken: page1.nextPageToken }), ctx('p1'))
    expect(page2.tasks).toHaveLength(1)
    expect(page2.nextPageToken).toBe('')

    const seenIds = new Set([...page1.tasks, ...page2.tasks].map((t) => t.id))
    expect(seenIds.size).toBe(3)
  })

  it('clamps pageSize to [1, 100] and defaults to 50 when unset/invalid', async () => {
    await seed()
    expect((await store.list(req(), ctx('p1'))).pageSize).toBe(50)
    expect((await store.list(req({ pageSize: 0 }), ctx('p1'))).pageSize).toBe(50)
    expect((await store.list(req({ pageSize: 500 }), ctx('p1'))).pageSize).toBe(100)
  })

  it('omits artifacts unless includeArtifacts is true', async () => {
    const task = makeTask({
      id: 't1',
      artifacts: [{ artifactId: 'a1', name: 'a1', description: '', parts: [], metadata: undefined, extensions: [] }],
    })
    await store.save(task, ctx('p1'))

    const withoutArtifacts = await store.list(req(), ctx('p1'))
    expect(withoutArtifacts.tasks[0].artifacts).toEqual([])

    const withArtifacts = await store.list(req({ includeArtifacts: true }), ctx('p1'))
    expect(withArtifacts.tasks[0].artifacts).toHaveLength(1)
  })

  it('applies historyLength trimming, keeping only the most recent N messages', async () => {
    const history = [1, 2, 3, 4].map((n) => ({
      messageId: `m${n}`,
      contextId: 'c1',
      taskId: 't1',
      role: 1,
      parts: [],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    })) as any
    await store.save(makeTask({ id: 't1', history }), ctx('p1'))

    const trimmed = await store.list(req({ historyLength: 2 }), ctx('p1'))
    expect(trimmed.tasks[0].history.map((m) => m.messageId)).toEqual(['m3', 'm4'])

    const zero = await store.list(req({ historyLength: 0 }), ctx('p1'))
    expect(zero.tasks[0].history).toEqual([])

    const untrimmed = await store.list(req(), ctx('p1'))
    expect(untrimmed.tasks[0].history).toHaveLength(4)
  })
})
