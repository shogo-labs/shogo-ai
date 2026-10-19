// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A task's output view must never come back blank (SHO-27): it carries the
 * destination the dock opens (the agent's thread, a card, a project session or
 * the task's own log), refreshes an API-tracked task before reading, and falls
 * back to the settled summary when no text was written.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import type { RemoteTaskClient, RemoteTaskState, TaskLink } from '../task-registry'

const DIR = '/tmp/test-gw-task-link'

function setupWorkspace(): void {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(join(DIR, 'memory'), { recursive: true })
  mkdirSync(join(DIR, 'skills'), { recursive: true })
  writeFileSync(
    join(DIR, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    }),
  )
  writeFileSync(join(DIR, 'AGENTS.md'), '# Identity\nTask link tests\n')
  writeFileSync(join(DIR, 'MEMORY.md'), '# Memory\n')
}

beforeAll(() => setupWorkspace())
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

/** A remote client whose state the test controls. */
function scriptedClient(initial: Partial<RemoteTaskState> = {}) {
  let state: RemoteTaskState = { id: '', status: 'running', output: '', ...initial }
  const client: RemoteTaskClient = {
    async get(id) {
      return { ...state, id }
    },
    async cancel() {},
    async consume() {},
  }
  return { client, set: (next: Partial<RemoteTaskState>) => { state = { ...state, ...next } } }
}

describe('readSessionTaskOutput', () => {
  test('a tagged-agent reply task answers with the thread it will open', async () => {
    const gw = new AgentGateway(DIR, 'p-link-1')
    const reg = (gw as any).getOrCreateCommandRegistry('s-link-1')
    const link: TaskLink = { kind: 'channel_thread', conversationId: 'conv-1', threadRootId: 'msg-1' }
    const remote = scriptedClient({ status: 'completed', output: 'Refund issued.' })
    reg.registerRemote({ id: 't_link0001', source: 'agent_reply', title: '@Ops reply', link, client: remote.client })

    const out = await gw.readSessionTaskOutput('s-link-1', 't_link0001')
    expect(out).not.toBeNull()
    expect(out!.link).toEqual(link)
    expect(out!.status).toBe('completed')
    expect(out!.title).toBe('@Ops reply')
    expect(out!.output).toContain('Refund issued.')
  })

  test('a running remote task is refreshed before it is read, so the pane is not empty', async () => {
    const gw = new AgentGateway(DIR, 'p-link-2')
    const reg = (gw as any).getOrCreateCommandRegistry('s-link-2')
    const remote = scriptedClient({ status: 'running', output: '' })
    reg.registerRemote({
      id: 't_link0002',
      source: 'project_call',
      title: 'Analyst',
      link: { kind: 'project_session', projectId: 'proj-1', name: 'Analyst' },
      client: remote.client,
    })
    // The API learned the reply after the row was created.
    remote.set({ status: 'running', output: 'first line of the report' })

    const out = await gw.readSessionTaskOutput('s-link-2', 't_link0002')
    expect(out!.output).toContain('first line of the report')
  })

  test('a task with no destination and no text still answers with its summary', async () => {
    const gw = new AgentGateway(DIR, 'p-link-3')
    const reg = (gw as any).getOrCreateCommandRegistry('s-link-3')
    const task = reg.registerTask({ source: 'subagent', title: 'explore', backgrounded: true })
    task.finish('completed', { summary: 'nothing to report' })

    const out = await gw.readSessionTaskOutput('s-link-3', task.entry.id)
    expect(out).not.toBeNull()
    expect(out!.output).toBe('nothing to report')
    // With no thread to open, the pane still has a destination: its own log.
    expect(out!.link?.kind).toBe('log')
  })

  test('an API link supplied after creation is adopted by the row', async () => {
    const gw = new AgentGateway(DIR, 'p-link-4')
    const reg = (gw as any).getOrCreateCommandRegistry('s-link-4')
    const remote = scriptedClient({ status: 'running' })
    reg.registerRemote({ id: 't_link0004', source: 'work_item', title: 'SUP-9', client: remote.client })
    expect(reg.get('t_link0004')!.link).toBeUndefined()

    remote.set({
      status: 'completed',
      output: 'moved to Done',
      link: {
        kind: 'card',
        conversationId: 'conv-9',
        threadRootId: 'msg-9',
        itemId: 'item-9',
        itemKey: 'SUP-9',
        board: 'Support',
      },
    })

    const out = await gw.readSessionTaskOutput('s-link-4', 't_link0004')
    expect(out!.link).toEqual({
      kind: 'card',
      conversationId: 'conv-9',
      threadRootId: 'msg-9',
      itemId: 'item-9',
      itemKey: 'SUP-9',
      board: 'Support',
    })
  })

  test('an unknown task id is a null answer, not an empty view', async () => {
    const gw = new AgentGateway(DIR, 'p-link-5')
    expect(await gw.readSessionTaskOutput('s-link-5', 't_missing1')).toBeNull()
  })
})
