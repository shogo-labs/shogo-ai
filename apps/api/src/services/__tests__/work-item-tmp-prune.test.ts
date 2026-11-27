// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The close hook for `.tmp` hygiene (SHO-607 §3).
 *
 * A card entering a closed column asks each project runtime that touched it to
 * prune its worktree — but only runtimes that are already running, and the
 * reasons something could not be pruned come back as one comment on the card.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

let links: any[] = []
let events: any[] = []
let projects: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    workItemLink: { findMany: async () => links },
    workItemEvent: { findMany: async () => events },
    project: { findMany: async () => projects },
  },
}))

let fetchCalls: Array<{ projectId: string; path: string; body: any }> = []
let fetchImpl: (call: { projectId: string; path: string; body: any }) => Promise<Response> = async () =>
  new Response('{}', { status: 200 })

mock.module('../../lib/chat-runtime-fetch', () => ({
  fetchFromProjectRuntime: async (projectId: string, path: string, init: any) => {
    const call = { projectId, path, body: JSON.parse(init?.body ?? '{}') }
    fetchCalls.push(call)
    return fetchImpl(call)
  },
  isRuntimeNotReady: async () => false,
}))

let running = new Set<string>()

mock.module('../../lib/runtime/manager', () => ({
  getRuntimeManager: () => ({
    status: (projectId: string) => (running.has(projectId) ? { status: 'running' } : null),
  }),
}))

let comments: Array<{ text: string }> = []

mock.module('../work-boards.service', () => ({
  commentWorkItem: async (_item: any, text: string) => {
    comments.push({ text })
  },
}))

const { pruneTmpForClosedCard } = await import('../work-item-tmp-prune.service')

const item = {
  id: 'wi-1',
  key: 'SHO-607',
  number: 607,
  workspaceId: 'ws-1',
  fields: { branch: 'sho-607-x' },
  assigneeAgentRef: 'project:p1',
  column: { agentRef: 'project:p2' },
}

beforeEach(() => {
  links = []
  events = []
  projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }]
  fetchCalls = []
  comments = []
  running = new Set<string>()
  fetchImpl = async () => new Response('{}', { status: 200 })
  delete process.env.KUBERNETES_SERVICE_HOST
})

describe('pruneTmpForClosedCard', () => {
  test('only calls runtimes that are already running', async () => {
    events = [{ actorAgentRef: 'project:p3', eventData: { columnAgentRef: 'project:p4' } }]
    running = new Set(['p1', 'p3'])

    await pruneTmpForClosedCard(item)

    expect(fetchCalls.map((call) => call.projectId)).toEqual(['p1', 'p3'])
    expect(fetchCalls.every((call) => call.path === '/agent/tmp-hygiene/prune')).toBe(true)
    expect(fetchCalls[0].body.card).toMatchObject({ key: 'SHO-607', branch: 'sho-607-x' })
  })

  test('a closed card with no branch and no PR is a no-op', async () => {
    running = new Set(['p1'])

    await pruneTmpForClosedCard({ ...item, fields: {} })

    expect(fetchCalls).toHaveLength(0)
    expect(comments).toHaveLength(0)
  })

  test('posts one comment naming every worktree it could not remove', async () => {
    running = new Set(['p1'])
    links = [{ refId: '12', metadata: { number: 12, headRef: 'sho-607-x', headSha: 'abc123', state: 'open' } }]
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          kept: [
            { path: '/ws/proj/.tmp/wt-a', reason: 'uncommitted changes (2 files)' },
            { path: '/ws/proj/.tmp/wt-b', reason: '1 unpushed commit on sho-607-x' },
          ],
        }),
        { status: 200 },
      )

    await pruneTmpForClosedCard(item)

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].body.card.prs[0]).toMatchObject({ number: 12, headSha: 'abc123' })
    expect(comments).toHaveLength(1)
    expect(comments[0].text).toContain('/ws/proj/.tmp/wt-a')
    expect(comments[0].text).toContain('uncommitted changes (2 files)')
    expect(comments[0].text).toContain('/ws/proj/.tmp/wt-b')
    expect(comments[0].text).toContain('1 unpushed commit on sho-607-x')
  })
})
