// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { api, type AgentTask } from '../api'
import { appendTasksPage, nextPageCursor } from '../agent-task-paging'

function task(id: string, updatedAt: string, workspaceId = 'ws-1'): AgentTask {
  return {
    id,
    userId: 'u-1',
    workspaceId,
    projectId: null,
    projectName: null,
    chatSessionId: null,
    title: `task ${id}`,
    notes: null,
    dueAt: null,
    status: 'completed',
    currentStep: null,
    resultSummary: null,
    errorMessage: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: updatedAt,
    updatedAt,
  }
}

function httpStub() {
  const calls: string[] = []
  return {
    calls,
    http: {
      get: async (path: string) => {
        calls.push(path)
        return { data: { ok: true, items: [task('a', '2026-01-02T00:00:00.000Z')], hasMore: true } }
      },
    } as any,
  }
}

describe('listAgentTasksPage', () => {
  test('forwards the paging cursor and reports hasMore', async () => {
    const { http, calls } = httpStub()
    const page = await api.listAgentTasksPage(http, {
      workspaceId: 'ws-1',
      limit: 200,
      before: '2026-01-02T00:00:00.000Z',
      beforeId: 'a',
    })
    const url = calls[0] as string
    expect(url).toContain('workspaceId=ws-1')
    expect(url).toContain('limit=200')
    expect(url).toContain(`before=${encodeURIComponent('2026-01-02T00:00:00.000Z')}`)
    expect(url).toContain('beforeId=a')
    expect(page.items.map((t) => t.id)).toEqual(['a'])
    expect(page.hasMore).toBe(true)
  })

  test('treats a missing hasMore as the last page', async () => {
    const http = { get: async () => ({ data: { ok: true, items: [] } }) } as any
    expect((await api.listAgentTasksPage(http, {})).hasMore).toBe(false)
  })

  test('listAgentTasks still returns a bare array for the polling callers', async () => {
    const { http } = httpStub()
    const tasks = await api.listAgentTasks(http, { workspaceId: 'ws-1' })
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks[0]?.id).toBe('a')
  })
})

describe('appendTasksPage', () => {
  test('appends rows from this workspace only', async () => {
    const prev = [task('a', '2026-01-02T00:00:00.000Z')]
    const next = appendTasksPage(prev, [task('b', '2026-01-01T00:00:00.000Z'), task('x', '2026-01-01T00:00:00.000Z', 'ws-2')], 'ws-1')
    expect(next.map((t) => t.id)).toEqual(['a', 'b'])
  })

  test('does not double up a task that came back on a later page', async () => {
    const prev = [task('a', '2026-01-02T00:00:00.000Z'), task('b', '2026-01-01T00:00:00.000Z')]
    const next = appendTasksPage(prev, [task('b', '2026-01-01T00:00:00.000Z')], 'ws-1')
    expect(next.map((t) => t.id)).toEqual(['a', 'b'])
  })

  test('returns the previous array untouched when the page adds nothing', async () => {
    const prev = [task('a', '2026-01-02T00:00:00.000Z')]
    expect(appendTasksPage(prev, [], 'ws-1')).toBe(prev)
    expect(appendTasksPage(prev, [task('a', '2026-01-02T00:00:00.000Z')], 'ws-1')).toBe(prev)
  })

  test('first page filters by workspace the same way', async () => {
    const items = [task('a', '2026-01-02T00:00:00.000Z'), task('x', '2026-01-02T00:00:00.000Z', 'ws-2')]
    expect(appendTasksPage([], items, 'ws-1').map((t) => t.id)).toEqual(['a'])
  })
})

describe('nextPageCursor', () => {
  test('resumes after the oldest row, with both halves of the cursor', async () => {
    const cursor = nextPageCursor([task('a', '2026-01-02T00:00:00.000Z'), task('b', '2026-01-01T00:00:00.000Z')])
    expect(cursor).toEqual({ before: '2026-01-01T00:00:00.000Z', beforeId: 'b' })
  })

  test('is null when nothing is loaded, so the button cannot fetch page two of nothing', async () => {
    expect(nextPageCursor([])).toBeNull()
  })
})
