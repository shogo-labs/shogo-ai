// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

type Task = {
  id: string
  userId: string
  workspaceId: string
  projectId: string | null
  chatSessionId: string | null
  title: string
  notes: string | null
  dueAt: Date | null
  status: 'draft' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  currentStep: string | null
  resultSummary: string | null
  errorMessage: string | null
  queuedAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  project?: { id: string; name: string } | null
}

const futureDueAt = new Date(Date.now() + 60_000)
let task: Task

function resetTask() {
  const now = new Date()
  task = {
    id: 'task-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    chatSessionId: null,
    title: 'Review the project',
    notes: null,
    dueAt: futureDueAt,
    status: 'draft',
    currentStep: null,
    resultSummary: null,
    errorMessage: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    project: { id: 'project-1', name: 'Project One' },
  }
}

const prismaStub = {
  member: {
    findFirst: async () => ({ id: 'member-1' }),
  },
  project: {
    findFirst: async () => ({ id: 'project-1' }),
  },
  chatSession: {
    findFirst: async () => ({ id: 'session-1' }),
    findUnique: async () => ({ contextType: 'project', contextId: 'project-1' }),
    create: async () => ({ id: 'session-1' }),
  },
  agentTask: {
    create: async ({ data }: { data: Partial<Task> }) => {
      task = { ...task, ...data, id: 'task-1', status: 'draft' }
      return task
    },
    findMany: async () => [task],
    findFirst: async () => task,
    findUnique: async () => task,
    update: async ({ data }: { data: Partial<Task> }) => {
      task = { ...task, ...data, updatedAt: new Date() }
      return task
    },
    updateMany: async ({ data }: { data: Partial<Task> }) => {
      if (data.status === 'queued' && (task.status === 'draft' || task.status === 'failed')) {
        task = { ...task, ...data, updatedAt: new Date() }
        return { count: 1 }
      }
      if (data.status === 'cancelled' && ['draft', 'queued', 'running'].includes(task.status)) {
        task = { ...task, ...data, updatedAt: new Date() }
        return { count: 1 }
      }
      if (data.projectId || data.chatSessionId) {
        task = { ...task, ...data, updatedAt: new Date() }
        return { count: 1 }
      }
      return { count: 0 }
    },
    delete: async () => undefined,
  },
}

mock.module('../../lib/prisma', () => ({ prisma: prismaStub }))
mock.module('../../services/notification.service', () => ({ createNotification: async () => undefined }))
mock.module('../../lib/push-notifications', () => ({ sendPushToUser: async () => undefined }))
mock.module('../project-chat', () => ({
  projectChatRoutes: () => ({ fetch: async () => new Response(null, { status: 200 }) }),
}))

const { createAgentTaskRoutes } = await import('../agent-tasks')

function makeApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { userId: 'user-1', isAuthenticated: true })
    await next()
  })
  app.route('/api', createAgentTaskRoutes())
  return app
}

describe('agent task routes', () => {
  beforeEach(() => resetTask())

  test('creates and lists a task for an authenticated workspace member', async () => {
    const app = makeApp()
    const createResponse = await app.request('/api/agent-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'workspace-1', projectId: 'project-1', title: 'Review the project' }),
    })
    expect(createResponse.status).toBe(201)

    const listResponse = await app.request('/api/agent-tasks')
    expect(listResponse.status).toBe(200)
    expect((await listResponse.json()).items[0].title).toBe('Review the project')
  })

  test('honors a future dueAt and leaves the task queued without starting work', async () => {
    const app = makeApp()
    const response = await app.request('/api/agent-tasks/task-1/start', { method: 'POST' })
    expect(response.status).toBe(202)
    expect((await response.json()).data.status).toBe('queued')
    expect(task.status).toBe('queued')
    expect(task.chatSessionId).toBe('session-1')
  })

  test('allows a task to start in its selected project chat', async () => {
    const app = makeApp()
    const response = await app.request('/api/agent-tasks/task-1/start', { method: 'POST' })
    expect(response.status).toBe(202)
    expect((await response.json()).data.status).toBe('queued')
    expect(task.chatSessionId).toBe('session-1')
  })

  test('cancels queued work durably', async () => {
    task.status = 'queued'
    const app = makeApp()
    const response = await app.request('/api/agent-tasks/task-1/cancel', { method: 'POST' })
    expect(response.status).toBe(200)
    expect((await response.json()).data.status).toBe('cancelled')
  })
})
