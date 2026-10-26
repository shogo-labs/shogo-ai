// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The task → thread link (SHO-27). A task that hands work to an agent carries
 * where that work is happening, so the chat dock can open the agent's thread
 * instead of an empty log. The API is the hop that persists it between the
 * creating runtime and the runtime that shows the row.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))

const { prisma } = await import('../lib/prisma')
const tasks = await import('../services/background-tasks.service')

const db = prisma as any
let seed: SeededWorkspace

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterEach(() => {
  tasks._testing.clearTimers()
})

afterAll(async () => {
  tasks._testing.clearTimers()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function newSession(): Promise<string> {
  const session = await db.chatSession.create({
    data: { inferredName: 'Chat', contextType: 'project', contextId: seed.projectId, createdByUserId: seed.owner },
  })
  return session.id
}

describe('task links', () => {
  test('a created task keeps its link and the view hands it back', async () => {
    const chatSessionId = await newSession()
    const link = {
      kind: 'card',
      conversationId: 'conv-1',
      threadRootId: 'msg-1',
      itemId: 'item-1',
      itemKey: 'SUP-12',
      board: 'Support',
    }
    const row = await tasks.createTask({
      id: tasks.newTaskId(),
      chatSessionId,
      source: 'work_item',
      targetRef: 'item-1',
      title: 'SUP-12',
      link,
    })

    expect(tasks.viewOf(row).link).toEqual(link)
    // Re-creating the same id does not rewrite the destination.
    const again = await tasks.createTask({
      id: row.id,
      chatSessionId,
      source: 'work_item',
      targetRef: 'item-1',
      title: 'SUP-12',
      link: { kind: 'log', path: 'other.log' },
    })
    expect(tasks.viewOf(again).link).toEqual(link)
  })

  test('a malformed link is dropped instead of stored', async () => {
    const chatSessionId = await newSession()
    const row = await tasks.createTask({
      id: tasks.newTaskId(),
      chatSessionId,
      source: 'project_call',
      targetRef: `${seed.projectId}:run-bad-link`,
      title: 'analyst',
      link: { kind: 'channel_thread', conversationId: 'conv-1' },
    })
    expect(tasks.viewOf(row).link).toBeUndefined()
    expect(tasks.normalizeTaskLink('nope')).toBeNull()
    expect(tasks.normalizeTaskLink({ kind: 'log', path: '   ' })).toEqual({ kind: 'log' })
  })

  test('a tagged-agent reply task points at the thread the tags were posted in', async () => {
    const chatSessionId = await newSession()
    const [task] = await tasks.createReplyTasks(
      chatSessionId,
      'msg-root',
      [{ projectId: seed.projectId, name: 'Billing Bot' }],
      { conversationId: 'conv-42', threadRootId: 'msg-thread', workspaceId: seed.workspaceId },
    )
    const row = await tasks.getTask(task!.task_id)
    expect(tasks.viewOf(row!).link).toEqual({
      kind: 'channel_thread',
      conversationId: 'conv-42',
      threadRootId: 'msg-thread',
      workspaceId: seed.workspaceId,
    })
  })

  test('a settled task carries its link and a summary the reader falls back to', async () => {
    const chatSessionId = await newSession()
    const row = await tasks.createTask({
      id: tasks.newTaskId(),
      chatSessionId,
      source: 'project_call',
      targetRef: `${seed.projectId}:run-linked`,
      title: 'analyst',
      link: { kind: 'project_session', projectId: seed.projectId, chatSessionId: 'sess-1', name: 'Analyst' },
    })
    await tasks.emitTaskEvent('project_call', `${seed.projectId}:run-linked`, { status: 'completed', line: 'the report' })
    const settled = await tasks.getTask(row.id)
    expect(settled!.status).toBe('completed')
    const view = tasks.viewOf(settled!)
    expect(view.link).toEqual({ kind: 'project_session', projectId: seed.projectId, chatSessionId: 'sess-1', name: 'Analyst' })
    expect(view.output).toBe('the report')
    expect(view.result?.summary).toBeTruthy()
  })
})
