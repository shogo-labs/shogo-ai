// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prisma-backed `TaskStore` for the A2A server — the shogo equivalent of
 * Odin's `A2ADatabaseTaskStore` (`services/a2a/task_store.py`) over
 * Postgres `a2a_tasks` (there: JSONB `task_json`; here: `taskJson String`,
 * see the comment on the `A2aTask` model in `prisma/schema.prisma` for why).
 *
 * Tenant scoping: `@a2a-js/sdk`'s `TaskStore` contract says implementations
 * "SHOULD use `context.tenant`... so each authenticated client only sees
 * its own tasks." Our transport layer (`hono-transport.ts` / `routes/a2a.ts`)
 * always sets `context.tenant = projectId` from the verified bearer key, so
 * every method here filters — and on `load`, double-checks — against
 * `context.tenant` rather than trusting the caller-supplied `taskId` alone.
 * `taskId`s are server-generated UUIDs (per-request, effectively globally
 * unique), so a cross-tenant collision is not a realistic concern, but the
 * check costs nothing and matches the contract's intent.
 */

import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import { TaskState, type ListTasksRequest, type ListTasksResponse, type Task } from '@a2a-js/sdk'
import { prisma } from '../prisma'

/** Default/limits for `ListTasksRequest.pageSize` — mirrors the SDK's doc comment. */
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

function taskStateName(state: TaskState): string {
  return TaskState[state] ?? String(state)
}

/**
 * Row → `Task`. Round-trips through plain `JSON.parse` rather than the
 * SDK's proto3 `Task.fromJSON` — `taskJson` is OUR OWN serialization of
 * the SDK's in-memory TS shape (written by `serialize` below with plain
 * `JSON.stringify`), not the wire-format JSON the SDK's `MessageFns`
 * expect. This is deliberately internal and lossy only for the one case
 * v1 doesn't support anyway: raw (`Buffer`) file-part bytes — see the
 * "File input must be inlined as base64" / rejected-uri-parts note in
 * the executor; A2A tasks in this codebase never carry binary parts.
 */
function deserialize(taskJson: string): Task {
  return JSON.parse(taskJson) as Task
}

function serialize(task: Task): string {
  return JSON.stringify(task)
}

function extractChatSessionId(task: Task): string | undefined {
  const meta = task.metadata as Record<string, unknown> | undefined
  const v = meta?.chatSessionId
  return typeof v === 'string' ? v : undefined
}

export class PrismaA2ATaskStore implements TaskStore {
  async save(task: Task, context: ServerCallContext): Promise<void> {
    const projectId = context.tenant
    if (!projectId) {
      throw new Error('PrismaA2ATaskStore.save: context.tenant (projectId) is required')
    }
    const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    const taskJson = serialize(task)
    const chatSessionId = extractChatSessionId(task)

    await prisma.a2aTask.upsert({
      where: { id: task.id },
      create: {
        id: task.id,
        contextId: task.contextId,
        projectId,
        state: taskStateName(state),
        taskJson,
        chatSessionId: chatSessionId ?? null,
      },
      update: {
        contextId: task.contextId,
        state: taskStateName(state),
        taskJson,
        ...(chatSessionId ? { chatSessionId } : {}),
      },
    })
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const projectId = context.tenant
    if (!projectId) return undefined

    const row = await prisma.a2aTask.findUnique({ where: { id: taskId } })
    if (!row) return undefined
    // Tenant isolation: never return a task belonging to another project,
    // even if the raw id happened to be guessed/known.
    if (row.projectId !== projectId) return undefined

    return deserialize(row.taskJson)
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const projectId = context.tenant ?? params.tenant
    if (!projectId) {
      return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 }
    }

    const where: Record<string, unknown> = { projectId }
    if (params.contextId) where.contextId = params.contextId
    // `params.status` is a numeric TaskState; TASK_STATE_UNSPECIFIED === 0 is
    // falsy, so a truthiness check alone already excludes "no filter".
    if (params.status) {
      where.state = taskStateName(params.status)
    }
    if (params.statusTimestampAfter) {
      const after = new Date(params.statusTimestampAfter)
      if (!Number.isNaN(after.getTime())) {
        where.updatedAt = { gte: after }
      }
    }

    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, params.pageSize && params.pageSize > 0 ? params.pageSize : DEFAULT_PAGE_SIZE),
    )
    const offset = decodePageToken(params.pageToken)

    const [rows, totalSize] = await Promise.all([
      prisma.a2aTask.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: offset,
        take: pageSize,
      }),
      prisma.a2aTask.count({ where }),
    ])

    const tasks = rows.map((row) => {
      const task = deserialize(row.taskJson)
      return applyResponseShaping(task, params)
    })

    const nextOffset = offset + rows.length
    const nextPageToken = nextOffset < totalSize ? encodePageToken(nextOffset) : ''

    return { tasks, nextPageToken, pageSize, totalSize }
  }
}

/** Applies `historyLength` / `includeArtifacts` trimming to a listed task. */
function applyResponseShaping(task: Task, params: ListTasksRequest): Task {
  let { history, artifacts } = task
  if (typeof params.historyLength === 'number') {
    history = params.historyLength <= 0 ? [] : history.slice(-params.historyLength)
  }
  if (!params.includeArtifacts) {
    artifacts = []
  }
  return { ...task, history, artifacts }
}

function encodePageToken(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url')
}

function decodePageToken(token: string | undefined): number {
  if (!token) return 0
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    const match = /^offset:(\d+)$/.exec(decoded)
    if (!match) return 0
    return Math.max(0, parseInt(match[1], 10) || 0)
  } catch {
    return 0
  }
}
