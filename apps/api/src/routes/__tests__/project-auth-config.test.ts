// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * project-auth-config route — full coverage.
 *
 * Mocks the service layer; routes just wire HTTP → service calls.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

class ProjectAuthConfigErrorStub extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

const svc = {
  getConfig:    mock(async (_p: string) => ({ mode: 'anyone', allowedEmails: [], allowedDomains: [], requireEmailVerification: false })),
  upsertConfig: mock(async (_p: string, _input: any) => ({ mode: 'custom', allowedEmails: ['a@b.com'], allowedDomains: [], requireEmailVerification: false })),
  listUsers:    mock(async (_p: string, _opts?: any) => ({ items: [], nextCursor: null })),
  revokeUser:   mock(async (_p: string, _u: string) => {}),
}

mock.module('../../services/project-auth-config.service', () => ({
  ...svc,
  ProjectAuthConfigError: ProjectAuthConfigErrorStub,
}))

import { projectAuthConfigRoutes } from '../project-auth-config'

function app() {
  const { Hono } = require('hono')
  const a = new Hono()
  a.route('/api', projectAuthConfigRoutes())
  return a
}

beforeEach(() => {
  for (const k of Object.keys(svc) as (keyof typeof svc)[]) svc[k].mockClear()
})

describe('GET /api/projects/:id/auth-config', () => {
  test('returns config from service', async () => {
    svc.getConfig.mockImplementationOnce(async () => ({
      mode: 'custom', allowedEmails: ['x@y.com'], allowedDomains: ['y.com'], requireEmailVerification: true,
    }) as any)
    const r = await app().request('/api/projects/p1/auth-config')
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.config.mode).toBe('custom')
    expect(svc.getConfig).toHaveBeenCalledWith('p1')
  })
})

describe('PUT /api/projects/:id/auth-config', () => {
  test('400 on invalid JSON', async () => {
    const r = await app().request('/api/projects/p1/auth-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{broken',
    })
    expect(r.status).toBe(400)
    expect((await r.json() as any).error.code).toBe('bad_request')
  })

  test('400 when body is not an object (null)', async () => {
    const r = await app().request('/api/projects/p1/auth-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: 'null',
    })
    expect(r.status).toBe(400)
  })

  test('400 when body is an array string (non-object)', async () => {
    const r = await app().request('/api/projects/p1/auth-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '"a string"',
    })
    expect(r.status).toBe(400)
  })

  test('200 + persisted config on valid body', async () => {
    const r = await app().request('/api/projects/p1/auth-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'custom', allowedEmails: ['a@b.com'] }),
    })
    expect(r.status).toBe(200)
    expect(svc.upsertConfig).toHaveBeenCalledWith('p1', { mode: 'custom', allowedEmails: ['a@b.com'] })
  })

  test('400 with ProjectAuthConfigError code propagated', async () => {
    svc.upsertConfig.mockImplementationOnce(async () => {
      throw new ProjectAuthConfigErrorStub('invalid_email', 'bad email')
    })
    const r = await app().request('/api/projects/p1/auth-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedEmails: ['nope'] }),
    })
    expect(r.status).toBe(400)
    expect((await r.json() as any).error.code).toBe('invalid_email')
  })

  test('500 on unexpected service throw', async () => {
    const origErr = console.error
    console.error = () => {}
    svc.upsertConfig.mockImplementationOnce(async () => { throw new Error('db down') })
    const r = await app().request('/api/projects/p1/auth-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    console.error = origErr
    expect(r.status).toBe(500)
    expect((await r.json() as any).error.code).toBe('internal')
  })
})

describe('GET /api/projects/:id/auth-users', () => {
  test('200 + items returned from service', async () => {
    svc.listUsers.mockImplementationOnce(async () => ({
      items: [{ userId: 'u1' }] as any, nextCursor: 'cur_2',
    }))
    const r = await app().request('/api/projects/p1/auth-users')
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.items.length).toBe(1)
    expect(j.nextCursor).toBe('cur_2')
    expect(svc.listUsers).toHaveBeenCalledWith('p1', { cursor: undefined, query: undefined, limit: undefined })
  })

  test('forwards ?cursor=&q=&limit= to service', async () => {
    await app().request('/api/projects/p1/auth-users?cursor=abc&q=alice&limit=25')
    expect(svc.listUsers).toHaveBeenCalledWith('p1', { cursor: 'abc', query: 'alice', limit: 25 })
  })

  test('drops non-numeric limit', async () => {
    await app().request('/api/projects/p1/auth-users?limit=notanumber')
    expect(svc.listUsers).toHaveBeenCalledWith('p1', { cursor: undefined, query: undefined, limit: undefined })
  })
})

describe('DELETE /api/projects/:projectId/auth-users/:userId', () => {
  test('200 ok + service called with both ids', async () => {
    const r = await app().request('/api/projects/p1/auth-users/u1', { method: 'DELETE' })
    expect(r.status).toBe(200)
    expect((await r.json() as any).ok).toBe(true)
    expect(svc.revokeUser).toHaveBeenCalledWith('p1', 'u1')
  })
})
