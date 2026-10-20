// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET /api/invitations/:id/info — the public context the emailed accept link
 * (`/invitations/<id>/accept`) renders before the invitee signs in.
 *
 * Guards the two things that make it safe to expose without a session
 * (SHO-83): it never returns the invited email address, and an unknown id is
 * a 404 rather than a 500 or an empty 200.
 *
 * Run: bun test apps/api/src/__tests__/invitation-info-route.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// `apps/api/src/lib/prisma` opens a client at import time; nothing in this
// file should touch a real database.
mock.module('../lib/prisma', () => withPrismaExports({ prisma: {} }))

// `middleware/auth` pulls in Better Auth, which refuses to start on the
// built-in default secret outside a test environment.
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-invitation-info'

const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
const past = new Date(Date.now() - 60_000)

const invitations: Record<string, any> = {
  'inv-workspace': {
    id: 'inv-workspace',
    email: 'invitee@example.com',
    role: 'member',
    status: 'pending',
    expiresAt: future,
    workspaceId: 'ws-1',
    projectId: null,
    workspace: { name: 'Acme' },
  },
  'inv-project': {
    id: 'inv-project',
    email: 'invitee@example.com',
    role: 'admin',
    status: 'pending',
    expiresAt: future,
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    workspace: { name: 'Acme' },
  },
  'inv-expired': {
    id: 'inv-expired',
    email: 'invitee@example.com',
    role: 'member',
    status: 'pending',
    expiresAt: past,
    workspaceId: 'ws-1',
    projectId: null,
    workspace: { name: 'Acme' },
  },
  'inv-accepted': {
    id: 'inv-accepted',
    email: 'invitee@example.com',
    role: 'member',
    status: 'accepted',
    expiresAt: future,
    workspaceId: 'ws-1',
    projectId: null,
    workspace: { name: 'Acme' },
  },
}

const db = {
  invitation: {
    findUnique: mock(async ({ where }: any) => invitations[where.id] ?? null),
  },
  project: {
    findUnique: mock(async ({ where }: any) =>
      where.id === 'proj-1' ? { name: 'Design system' } : null,
    ),
  },
}

const { invitationInfoRoutes } = await import('../routes/invitation-info')
const { isPublicPath } = await import('../middleware/auth')

function createApp() {
  const app = new Hono()
  app.route('/api/invitations', invitationInfoRoutes({ prisma: db }))
  return app
}

describe('GET /api/invitations/:id/info', () => {
  test('returns the workspace context a signed-out invitee needs', async () => {
    const res = await createApp().request('/api/invitations/inv-workspace/info')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.data).toMatchObject({
      role: 'member',
      status: 'pending',
      expired: false,
      workspaceId: 'ws-1',
      workspaceName: 'Acme',
      projectId: null,
      projectName: null,
    })
  })

  test('resolves the project name for a project-scoped invitation', async () => {
    const res = await createApp().request('/api/invitations/inv-project/info')
    const body = (await res.json()) as any
    expect(res.status).toBe(200)
    expect(body.data.role).toBe('admin')
    expect(body.data.projectId).toBe('proj-1')
    expect(body.data.projectName).toBe('Design system')
  })

  test('flags an invitation past expiresAt', async () => {
    const res = await createApp().request('/api/invitations/inv-expired/info')
    const body = (await res.json()) as any
    expect(body.data.expired).toBe(true)
  })

  test('carries the status so an already-used invitation is not offered again', async () => {
    const res = await createApp().request('/api/invitations/inv-accepted/info')
    const body = (await res.json()) as any
    expect(body.data.status).toBe('accepted')
  })

  test('never leaks the invited email address', async () => {
    for (const id of Object.keys(invitations)) {
      const res = await createApp().request(`/api/invitations/${id}/info`)
      const raw = await res.text()
      expect(raw).not.toContain('invitee@example.com')
      expect(raw).not.toContain('email')
    }
  })

  test('unknown id is a 404, not an empty 200', async () => {
    const res = await createApp().request('/api/invitations/does-not-exist/info')
    expect(res.status).toBe(404)
    const body = (await res.json()) as any
    expect(body.ok).toBeUndefined()
    expect(body.error.code).toBe('not_found')
  })

  test('only the info subpath is public — the generated CRUD surface stays gated', () => {
    expect(isPublicPath('/api/invitations/abc/info')).toBe(true)
    expect(isPublicPath('/api/invitations/abc')).toBe(false)
    expect(isPublicPath('/api/invitations')).toBe(false)
    expect(isPublicPath('/api/invitations/abc/accept')).toBe(false)
    expect(isPublicPath('/api/invitations/abc/info/extra')).toBe(false)
  })
})
