// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Regression: the project-attachments router must not gate every
 * `/api/projects/*` request (SHO-380).
 *
 * `projectAttachmentRoutes()` is mounted at `/api/projects` in server.ts. A
 * bare `router.use('*', requireAuth)` on a sub-app registers as
 * `/api/projects/*`, so it ran on every later route under that prefix —
 * including the anonymous webchat agent-proxy — and 401'd the embeddable
 * widget. This mounts the router exactly like server.ts does, ahead of a
 * catch-all agent-proxy handler, and asserts the scoping.
 */

import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// The real middleware needs a DB-backed session lookup; the gate logic under
// test is the path matching, so a minimal stand-in is enough.
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { isAuthenticated: false })
    await next()
  },
  requireAuth: async (c: any, next: any) => {
    const auth = c.get('auth')
    if (!auth?.isAuthenticated) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    await next()
  },
  PUBLIC_PREFIXES: [],
  isPublicPath: () => false,
}))

mock.module('../lib/prisma', () => ({ prisma: {} }))
mock.module('../lib/authz', () => ({
  accessibleProjectsWhere: async () => null,
  authorize: async () => ({ ok: false, status: 404, code: 'not_found', message: 'Project not found' }),
  denialResponse: (c: any, d: any) => c.json({ error: d.code }, d.status),
  principalOf: () => ({ userId: 'user-1' }),
}))
mock.module('../lib/project-attachment-runtime', () => ({
  attachmentsMount: () => false,
  restartAnchorRuntimeBackground: () => {},
}))
mock.module('../services/project-attachment.service', () => ({
  ProjectAttachmentError: class ProjectAttachmentError extends Error {},
  listAttachments: async () => [],
  attachProjectToProject: async () => ({}),
  detachProjectFromProject: async () => true,
}))
mock.module('../services/project-attachment.authz', () => ({
  authorizeAttachmentAction: async () => null,
  filterReadableAttachments: async (rows: unknown) => rows,
}))

const { projectAttachmentRoutes } = await import('../routes/project-attachments')
const { apiAuthGate } = await import('../middleware/api-auth-gate')
const { authMiddleware } = await import('../middleware/auth')

/** Mirrors server.ts: global gate, then the attachments router, then the proxy. */
function app() {
  const a = new Hono()
  a.use('/api/*', authMiddleware)
  a.use('/api/*', apiAuthGate)
  a.route('/api/projects', projectAttachmentRoutes())
  a.all('/api/projects/:projectId/agent-proxy/*', (c) => c.text('proxied'))
  return a
}

const get = (path: string) => app().request(path)

describe('project attachments router scoping (SHO-380)', () => {
  test('anonymous webchat widget.js reaches the agent-proxy handler', async () => {
    const res = await get('/api/projects/abc/agent-proxy/agent/channels/webchat/widget.js')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('proxied')
  })

  test('anonymous webchat health/config/session/message/events reach the handler', async () => {
    for (const path of [
      'health',
      'config',
      'session',
      'message',
      'events/abc',
    ]) {
      const res = await get(`/api/projects/abc/agent-proxy/agent/channels/webchat/${path}`)
      expect(res.status).toBe(200)
    }
  })

  test('anonymous attachments requests are still 401', async () => {
    const list = await get('/api/projects/abc/attachments')
    expect(list.status).toBe(401)

    const attach = await app().request('/api/projects/abc/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachedProjectId: 'def' }),
    })
    expect(attach.status).toBe(401)

    const detach = await app().request('/api/projects/abc/attachments/def', { method: 'DELETE' })
    expect(detach.status).toBe(401)
  })

  test('a non-webchat agent-proxy path is still 401 without a session', async () => {
    const res = await get('/api/projects/abc/agent-proxy/agent/status')
    expect(res.status).toBe(401)
  })
})
