// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * checkpoints route — full coverage.
 * Mocks the checkpoint service + prisma.project + prisma.projectCheckpoint.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

let projects: Map<string, any>
let projectCheckpoints: Map<string, any>

const svc = {
  createCheckpoint:  mock(async (_o: any) => ({ id: 'cp_new', name: 'ck', commit: 'abc123' })),
  listCheckpoints:   mock(async (_p: string, _o?: any) => [] as any[]),
  getCheckpoint:     mock(async (_id: string) => null as any),
  rollback:          mock(async (_o: any) => ({ success: true, previousCheckpoint: 'cp_prev', newCheckpoint: 'cp_post' })),
  getDiff:           mock(async (_p: string, _id: string, _to?: string) => ({ files: [] } as any)),
  getProjectStatus:  mock(async (_p: string) => ({ branch: 'main', clean: true })),
}

mock.module('../../services/checkpoint.service', () => svc)
mock.module('../../lib/prisma', () => ({
  prisma: {
    project: { findUnique: async ({ where }: any) => projects.get(where.id) ?? null },
    projectCheckpoint: { findUnique: async ({ where }: any) => projectCheckpoints.get(where.id) ?? null },
  },
}))

import { checkpointRoutes } from '../checkpoints'

const origConsoleError = console.error
beforeEach(() => {
  projects = new Map()
  projectCheckpoints = new Map()
  for (const k of Object.keys(svc) as (keyof typeof svc)[]) svc[k].mockClear()
  console.error = () => {}
})

function app() {
  const { Hono } = require('hono')
  const a = new Hono()
  a.use('*', async (c: any, next: any) => {
    const uid = c.req.header('x-test-user-id')
    if (uid) c.set('auth', { userId: uid })
    await next()
  })
  a.route('/api', checkpointRoutes({ workspacesDir: '/tmp/ws' }))
  return a
}

// ─── POST create ─────────────────────────────────────────────────────────────

describe('POST /projects/:projectId/checkpoints', () => {
  test('404 when project missing', async () => {
    const r = await app().request('/api/projects/p1/checkpoints', { method: 'POST', body: '{}' })
    expect(r.status).toBe(404)
  })

  test('409 when project is external-mode', async () => {
    projects.set('p1', { id: 'p1', workspaceId: 'w1', workingMode: 'external' })
    const r = await app().request('/api/projects/p1/checkpoints', { method: 'POST', body: JSON.stringify({ message: 'x' }) })
    expect(r.status).toBe(409)
    expect((await r.json() as any).error.code).toBe('checkpoints_disabled_in_external_mode')
  })

  test('400 when message missing', async () => {
    projects.set('p1', { id: 'p1', workspaceId: 'w1', workingMode: 'managed' })
    const r = await app().request('/api/projects/p1/checkpoints', { method: 'POST', body: JSON.stringify({}) })
    expect(r.status).toBe(400)
  })

  test('201 happy path with userId from auth', async () => {
    projects.set('p1', { id: 'p1', workspaceId: 'w1', workingMode: 'managed' })
    const r = await app().request('/api/projects/p1/checkpoints', {
      method: 'POST', headers: { 'x-test-user-id': 'u1', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'snap', name: 'n', description: 'd', includeDatabase: true }),
    })
    expect(r.status).toBe(201)
    expect(svc.createCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1', message: 'snap', name: 'n', description: 'd', includeDatabase: true,
      createdBy: 'u1', workspacePath: expect.stringContaining('p1'),
    }))
  })

  test('500 when service throws', async () => {
    projects.set('p1', { id: 'p1', workspaceId: 'w1', workingMode: 'managed' })
    svc.createCheckpoint.mockImplementationOnce(async () => { throw new Error('git fail') })
    const r = await app().request('/api/projects/p1/checkpoints', {
      method: 'POST', body: JSON.stringify({ message: 'x' }),
    })
    expect(r.status).toBe(500)
    expect((await r.json() as any).error.code).toBe('checkpoint_failed')
  })

  test('500 with fallback message when service throws empty error', async () => {
    projects.set('p1', { id: 'p1', workspaceId: 'w1', workingMode: 'managed' })
    svc.createCheckpoint.mockImplementationOnce(async () => { throw {} as any })
    const r = await app().request('/api/projects/p1/checkpoints', {
      method: 'POST', body: JSON.stringify({ message: 'x' }),
    })
    expect((await r.json() as any).error.message).toBe('Failed to create checkpoint')
  })
})

// ─── GET list ───────────────────────────────────────────────────────────────

describe('GET /projects/:projectId/checkpoints', () => {
  test('404 project not found', async () => {
    const r = await app().request('/api/projects/p1/checkpoints')
    expect(r.status).toBe(404)
  })
  test('409 external', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'external' })
    const r = await app().request('/api/projects/p1/checkpoints')
    expect(r.status).toBe(409)
  })
  test('200 default limit=50, no hasMore when below limit', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    svc.listCheckpoints.mockImplementationOnce(async () => [{ id: 'a' }, { id: 'b' }])
    const r = await app().request('/api/projects/p1/checkpoints')
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.checkpoints.length).toBe(2)
    expect(j.hasMore).toBe(false)
    expect(svc.listCheckpoints).toHaveBeenCalledWith('p1', { limit: 50, before: undefined })
  })
  test('200 caps limit at 100; hasMore true when at-cap', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    svc.listCheckpoints.mockImplementationOnce(async () =>
      Array.from({ length: 200 }, (_, i) => ({ id: `c${i}` }))
    )
    const r = await app().request('/api/projects/p1/checkpoints?limit=200&before=cursor')
    const j = await r.json() as any
    expect(svc.listCheckpoints).toHaveBeenCalledWith('p1', { limit: 100, before: 'cursor' })
    expect(j.hasMore).toBe(true)
  })
  test('hasMore when count exactly equals raw limit', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    svc.listCheckpoints.mockImplementationOnce(async () => Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` })))
    const r = await app().request('/api/projects/p1/checkpoints?limit=5')
    expect((await r.json() as any).hasMore).toBe(true)
  })
  test('500 on service throw', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    svc.listCheckpoints.mockImplementationOnce(async () => { throw new Error('db') })
    const r = await app().request('/api/projects/p1/checkpoints')
    expect(r.status).toBe(500)
    expect((await r.json() as any).error.code).toBe('list_failed')
  })
})

// ─── GET single ─────────────────────────────────────────────────────────────

describe('GET /projects/:projectId/checkpoints/:checkpointId', () => {
  test('404 when service returns null', async () => {
    const r = await app().request('/api/projects/p1/checkpoints/cp1')
    expect(r.status).toBe(404)
    expect((await r.json() as any).error.code).toBe('checkpoint_not_found')
  })
  test('404 when checkpoint exists but belongs to a different project', async () => {
    svc.getCheckpoint.mockImplementationOnce(async () => ({ id: 'cp1', message: 'x' } as any))
    projectCheckpoints.set('cp1', { projectId: 'other' })
    const r = await app().request('/api/projects/p1/checkpoints/cp1')
    expect(r.status).toBe(404)
  })
  test('200 happy path', async () => {
    svc.getCheckpoint.mockImplementationOnce(async () => ({ id: 'cp1', message: 'x' } as any))
    projectCheckpoints.set('cp1', { projectId: 'p1' })
    const r = await app().request('/api/projects/p1/checkpoints/cp1')
    expect(r.status).toBe(200)
    expect((await r.json() as any).checkpoint.message).toBe('x')
  })
  test('500 on service throw', async () => {
    svc.getCheckpoint.mockImplementationOnce(async () => { throw new Error('bad') })
    const r = await app().request('/api/projects/p1/checkpoints/cp1')
    expect(r.status).toBe(500)
  })
})

// ─── POST rollback ──────────────────────────────────────────────────────────

describe('POST /projects/:projectId/checkpoints/:checkpointId/rollback', () => {
  test('404 project missing', async () => {
    const r = await app().request('/api/projects/p1/checkpoints/cp1/rollback', { method: 'POST' })
    expect(r.status).toBe(404)
  })
  test('409 external project', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'external' })
    const r = await app().request('/api/projects/p1/checkpoints/cp1/rollback', { method: 'POST' })
    expect(r.status).toBe(409)
  })
  test('400 when service result.success=false (forwards result.error)', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    svc.rollback.mockImplementationOnce(async () => ({ success: false, error: 'dirty tree' } as any))
    const r = await app().request('/api/projects/p1/checkpoints/cp1/rollback', { method: 'POST' })
    expect(r.status).toBe(400)
    expect((await r.json() as any).error.message).toBe('dirty tree')
  })
  test('400 with default message when result.error missing', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    svc.rollback.mockImplementationOnce(async () => ({ success: false } as any))
    const r = await app().request('/api/projects/p1/checkpoints/cp1/rollback', { method: 'POST' })
    expect((await r.json() as any).error.message).toBe('Rollback failed')
  })
  test('200 happy path includes rolledBackTo + newCheckpoint', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    const r = await app().request('/api/projects/p1/checkpoints/cp1/rollback', {
      method: 'POST', headers: { 'x-test-user-id': 'u1', 'content-type': 'application/json' },
      body: JSON.stringify({ includeDatabase: true }),
    })
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.rolledBackTo).toBe('cp_prev')
    expect(j.newCheckpoint).toBe('cp_post')
    expect(svc.rollback).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1', checkpointId: 'cp1', includeDatabase: true, createdBy: 'u1',
    }))
  })
  test('200 when body is invalid JSON (defaults includeDatabase to undefined)', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    const r = await app().request('/api/projects/p1/checkpoints/cp1/rollback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{broken',
    })
    expect(r.status).toBe(200)
    expect(svc.rollback).toHaveBeenCalledWith(expect.objectContaining({ includeDatabase: undefined }))
  })
  test('500 when service throws', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    svc.rollback.mockImplementationOnce(async () => { throw new Error('boom') })
    const r = await app().request('/api/projects/p1/checkpoints/cp1/rollback', { method: 'POST' })
    expect(r.status).toBe(500)
  })
})

// ─── GET diff ───────────────────────────────────────────────────────────────

describe('GET /projects/:projectId/checkpoints/:checkpointId/diff', () => {
  test('404 project missing', async () => {
    const r = await app().request('/api/projects/p1/checkpoints/cp1/diff')
    expect(r.status).toBe(404)
  })
  test('409 external project', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'external' })
    const r = await app().request('/api/projects/p1/checkpoints/cp1/diff')
    expect(r.status).toBe(409)
  })
  test('404 when getDiff returns null', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    svc.getDiff.mockImplementationOnce(async () => null as any)
    const r = await app().request('/api/projects/p1/checkpoints/cp1/diff')
    expect(r.status).toBe(404)
  })
  test('200 with diff + forwards optional ?to=', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    const r = await app().request('/api/projects/p1/checkpoints/cp1/diff?to=cp2')
    expect(r.status).toBe(200)
    expect(svc.getDiff).toHaveBeenCalledWith(expect.stringContaining('p1'), 'cp1', 'cp2')
  })
  test('500 when getDiff throws', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    svc.getDiff.mockImplementationOnce(async () => { throw new Error('bad') })
    const r = await app().request('/api/projects/p1/checkpoints/cp1/diff')
    expect(r.status).toBe(500)
  })
})

// ─── GET git/status ─────────────────────────────────────────────────────────

describe('GET /projects/:projectId/git/status', () => {
  test('404 project missing', async () => {
    const r = await app().request('/api/projects/p1/git/status')
    expect(r.status).toBe(404)
  })
  test('409 external project', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'external' })
    const r = await app().request('/api/projects/p1/git/status')
    expect(r.status).toBe(409)
  })
  test('200 happy path', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    const r = await app().request('/api/projects/p1/git/status')
    expect(r.status).toBe(200)
    expect((await r.json() as any).status.branch).toBe('main')
  })
  test('500 on service throw', async () => {
    projects.set('p1', { id: 'p1', workingMode: 'managed' })
    svc.getProjectStatus.mockImplementationOnce(async () => { throw new Error('git err') })
    const r = await app().request('/api/projects/p1/git/status')
    expect(r.status).toBe(500)
  })
})
