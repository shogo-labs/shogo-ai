// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `collectMachineSnapshot` — the shape that rides on every tunnel heartbeat.
 *
 * Ids, names and counts only: this is the copy the cloud keeps, so it must
 * never carry a transcript or a project's contents. Also pins the per
 * workspace activity merge (a workspace is as recent as its newest project
 * *or* its newest chat) and the most-recent-first ordering the switcher and
 * the cloud both rely on.
 *
 *   bun test apps/api/src/__tests__/machine-snapshot.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const db: any = {
  workspace: {
    findMany: async () => [
      { id: 'lw-quiet', name: 'Quiet Team', kind: 'team' },
      { id: 'lw-recent', name: 'Personal', kind: 'personal' },
    ],
  },
  project: {
    groupBy: async () => [
      { workspaceId: 'lw-quiet', _count: { _all: 1 }, _max: { updatedAt: new Date('2026-10-01T00:00:00Z') } },
      { workspaceId: 'lw-recent', _count: { _all: 3 }, _max: { updatedAt: new Date('2026-10-19T09:00:00Z') } },
    ],
  },
  chatSession: {
    groupBy: async () => [
      { workspaceId: 'lw-quiet', _max: { lastActiveAt: new Date('2026-10-18T12:00:00Z') } },
      { workspaceId: null, _max: { lastActiveAt: new Date('2026-10-19T11:00:00Z') } },
    ],
    count: async (args?: any) => (args?.where ? 2 : 7),
  },
  backgroundTask: { count: async () => 1 },
  localConfig: {
    findUnique: async () => ({ key: 'SHOGO_KEY_INFO', value: JSON.stringify({ deviceId: 'device-1' }) }),
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: db }))

const { collectMachineSnapshot } = await import('../lib/machine-snapshot')

describe('collectMachineSnapshot', () => {
  test('summarises each workspace with counts and its newest activity', async () => {
    const snapshot = await collectMachineSnapshot()

    const quiet = snapshot.workspaces.find((w) => w.id === 'lw-quiet')!
    expect(quiet).toMatchObject({ name: 'Quiet Team', kind: 'team', projectCount: 1 })
    // Newest of its project update (10-01) and its chat activity (10-18).
    expect(quiet.lastActivityAt).toBe('2026-10-18T12:00:00.000Z')

    const recent = snapshot.workspaces.find((w) => w.id === 'lw-recent')!
    expect(recent.projectCount).toBe(3)
    // No chats yet → the project's own update is the activity.
    expect(recent.lastActivityAt).toBe('2026-10-19T09:00:00.000Z')
  })

  test('orders workspaces most recently active first', async () => {
    const snapshot = await collectMachineSnapshot()
    expect(snapshot.workspaces.map((w) => w.id)).toEqual(['lw-recent', 'lw-quiet'])
  })

  test('reports what is running, and carries no transcripts', async () => {
    const snapshot = await collectMachineSnapshot()
    expect(snapshot.activity).toMatchObject({ runningTurns: 2, runningTasks: 1, chats: 7 })
    const serialised = JSON.stringify(snapshot)
    expect(serialised).not.toContain('content')
    expect(serialised).not.toContain('messages')
  })

  test('identifies the machine by its paired device id', async () => {
    const snapshot = await collectMachineSnapshot()
    expect(snapshot.machine.id).toBe('device-1')
    expect(snapshot.machine.hostname).toBeTruthy()
  })
})
