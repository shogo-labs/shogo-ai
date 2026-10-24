// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `POST /api/internal/reminders/notify` without a `userId` (SHO-180).
 *
 * A runtime knows its workspace, not its users. When the workspace sync parks
 * itself after 20 identical failures it calls this route to tell somebody —
 * and the recipient has to be resolved server-side, or the report of a dead
 * backup is a 400 nobody ever sees.
 *
 * Prisma is faked with an in-memory member row; auth and the notification
 * service are mocked so the assertion is about recipient resolution.
 */

import { beforeEach, describe, expect, test, mock } from 'bun:test'

const store = {
  podIdentity: null as null | { serviceAccountName: string; namespace: string },
  members: [] as Array<{ userId: string; workspaceId: string; projectId: string | null; role: string; createdAt: Date }>,
  created: [] as Array<Record<string, unknown>>,
  pushed: [] as Array<{ userId: string; payload: Record<string, unknown> }>,
}

mock.module('../../lib/k8s-auth', () => ({
  validatePodToken: async (_t: string) => store.podIdentity,
  verifyServiceAssignment: async () => null,
}))

const actualRuntimeToken = await import('../../lib/runtime-token')

mock.module('../../lib/runtime-token', () => ({
  ...actualRuntimeToken,
  getSigningSecret: () => 'test-runtime-secret',
  verifyRuntimeToken: (_t: string, _p?: string) => ({ ok: false, reason: 'bad' }),
  deriveRuntimeToken: (projectId: string) => `rt_v1_${projectId}_mock`,
}))

const actualWorkspaceRuntimeToken = await import('../../lib/workspace-runtime-token')

mock.module('../../lib/workspace-runtime-token', () => ({
  ...actualWorkspaceRuntimeToken,
  verifyWorkspaceRuntimeToken: (_t: string) => ({ ok: false, reason: 'malformed' }),
  deriveWorkspaceRuntimeToken: (_workspaceId: string) => 'mock-workspace-runtime-token',
}))

mock.module('../../lib/project-runtime-token', () => ({
  resolveProjectWorkspaceId: async (_projectId: string) => null,
  deriveProjectRuntimeToken: async (_projectId: string, _opts?: any) => 'mock-project-runtime-token',
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    member: {
      findFirst: async (args: {
        where: { workspaceId?: string; projectId?: string | null; role?: string }
        orderBy?: unknown
        select?: { userId?: boolean }
      }) => {
        const { workspaceId, projectId, role } = args.where
        const row = store.members.find((m) =>
          (workspaceId === undefined || m.workspaceId === workspaceId) &&
          (projectId === undefined || m.projectId === projectId) &&
          (role === undefined || m.role === role))
        return row ? { userId: row.userId } : null
      },
    },
  },
}))

const actualNotificationService = await import('../../services/notification.service')

mock.module('../../services/notification.service', () => ({
  ...actualNotificationService,
  createNotification: async (input: Record<string, unknown>) => {
    store.created.push(input)
    return { id: `note-${store.created.length}` }
  },
}))

const actualPushNotifications = await import('../../lib/push-notifications')

mock.module('../../lib/push-notifications', () => ({
  ...actualPushNotifications,
  sendPushToUser: async (userId: string, payload: Record<string, unknown>) => {
    store.pushed.push({ userId, payload })
    return { sent: 1 }
  },
}))

const app = (await import('../internal')).default

const SA = { Authorization: 'Bearer sa-token', 'content-type': 'application/json' }

beforeEach(() => {
  store.podIdentity = { serviceAccountName: 'runtime', namespace: 'shogo' }
  store.created = []
  store.pushed = []
  store.members = [
    { userId: 'user-owner', workspaceId: 'ws-1', projectId: null, role: 'owner', createdAt: new Date('2026-01-01') },
    { userId: 'user-admin', workspaceId: 'ws-1', projectId: null, role: 'admin', createdAt: new Date('2026-01-02') },
  ]
})

const body = (extra: Record<string, unknown> = {}) => JSON.stringify({
  workspaceId: 'ws-1',
  title: 'Workspace backup has failed',
  body: "Workspace backup has failed 20 times: error: unable to index file 'nul'",
  ...extra,
})

describe('POST /reminders/notify without userId', () => {
  test('delivers to the workspace owner so a runtime-originated notice lands', async () => {
    const res = await app.request('/reminders/notify', { method: 'POST', headers: SA, body: body() })
    expect(res.status).toBe(200)
    expect(store.created[0]?.userId).toBe('user-owner')
    expect(store.created[0]?.title).toBe('Workspace backup has failed')
    expect(String(store.created[0]?.message)).toContain("unable to index file 'nul'")
    expect(store.pushed[0]?.userId).toBe('user-owner')
  })

  test('an explicit userId still wins', async () => {
    const res = await app.request('/reminders/notify', {
      method: 'POST',
      headers: SA,
      body: body({ userId: 'user-admin' }),
    })
    expect(res.status).toBe(200)
    expect(store.created[0]?.userId).toBe('user-admin')
  })

  test('400 when the workspace has no owner to fall back to', async () => {
    store.members = []
    const res = await app.request('/reminders/notify', { method: 'POST', headers: SA, body: body() })
    expect(res.status).toBe(400)
    expect(store.created).toHaveLength(0)
  })
})
