// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/routes/checkpoints.ts — project state snapshots + rollback.
 *
 * Six endpoints. We mock:
 *  - ../services/checkpoint.service (every named export the route uses)
 *  - ../lib/prisma (project.findUnique, projectCheckpoint.findUnique)
 *
 * The route wires a configurable workspacesDir, so we pass a stub path
 * and assert that downstream calls receive `<workspacesDir>/<projectId>`.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── prisma mock ──────────────────────────────────────────────────────────

const projectFindUnique = mock(async (_: any): Promise<any> => null)
const checkpointFindUnique = mock(async (_: any): Promise<any> => null)

mock.module('../lib/prisma', () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    projectCheckpoint: { findUnique: checkpointFindUnique },
  },
  SubscriptionStatus: {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'incomplete_expired',
    trialing: 'trialing',
    unpaid: 'unpaid',
    paused: 'paused',
  },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

// ─── checkpoint.service mock ──────────────────────────────────────────────

const createCheckpoint = mock(async (_: any): Promise<any> => ({
  id: 'cp-new',
  message: 'created',
}))
const listCheckpoints = mock(async (_p: string, _o: any): Promise<any[]> => [])
const getCheckpoint = mock(async (_: string): Promise<any> => null)
const rollback = mock(async (_: any): Promise<any> => ({ success: true }))
const getDiff = mock(async (..._args: any[]): Promise<any> => null)
const getProjectStatus = mock(async (_: string): Promise<any> => ({}))

mock.module('../services/checkpoint.service', () => ({
  createCheckpoint,
  listCheckpoints,
  getCheckpoint,
  rollback,
  getDiff,
  getProjectStatus,
}))

// ─── load route under test ────────────────────────────────────────────────

const { checkpointRoutes } = await import('../routes/checkpoints')

const WORKSPACES_DIR = '/tmp/test-workspaces'
const expectedWorkspacePath = (projectId: string) => `${WORKSPACES_DIR}/${projectId}`

function makeApp(auth?: { userId: string }) {
  const app = new Hono()
  if (auth) {
    app.use('*', async (c, next) => {
      c.set('auth', auth as any)
      await next()
    })
  }
  app.route('/api', checkpointRoutes({ workspacesDir: WORKSPACES_DIR }))
  return app
}

const ACTIVE_PROJECT = {
  id: 'proj-1',
  name: 'My Project',
  workspaceId: 'ws-1',
  workingMode: 'managed',
}
const EXTERNAL_PROJECT = { ...ACTIVE_PROJECT, workingMode: 'external' }

beforeEach(() => {
  projectFindUnique.mockReset()
  projectFindUnique.mockImplementation(async () => ACTIVE_PROJECT)
  checkpointFindUnique.mockReset()
  checkpointFindUnique.mockImplementation(async () => ({ projectId: 'proj-1' }))

  createCheckpoint.mockReset()
  createCheckpoint.mockImplementation(async (_: any) => ({
    id: 'cp-new',
    message: 'created',
  }))
  listCheckpoints.mockReset()
  listCheckpoints.mockImplementation(async () => [])
  getCheckpoint.mockReset()
  getCheckpoint.mockImplementation(async () => null)
  rollback.mockReset()
  rollback.mockImplementation(async () => ({ success: true, previousCheckpoint: 'cp-old' }))
  getDiff.mockReset()
  getDiff.mockImplementation(async () => null)
  getProjectStatus.mockReset()
  getProjectStatus.mockImplementation(async () => ({ branch: 'main', clean: true }))
})

// ─── POST /projects/:projectId/checkpoints ────────────────────────────────

describe('POST /projects/:projectId/checkpoints — create', () => {
  test('404 when project not found', async () => {
    projectFindUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/p404/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'snap' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('project_not_found')
    expect(createCheckpoint).not.toHaveBeenCalled()
  })

  test('409 when project is external (folder-linked) — typed error code', async () => {
    projectFindUnique.mockImplementation(async () => EXTERNAL_PROJECT)
    const res = await makeApp().request('/api/projects/proj-1/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'snap' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('checkpoints_disabled_in_external_mode')
    expect(body.error.message).toContain('folder-linked')
    expect(createCheckpoint).not.toHaveBeenCalled()
  })

  test('400 when message missing', async () => {
    const res = await makeApp().request('/api/projects/proj-1/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_request')
  })

  test('happy path: 201 + forwards full body + auth userId + workspace path', async () => {
    createCheckpoint.mockImplementation(async () => ({
      id: 'cp-new',
      message: 'pre-deploy',
      name: 'v1.0',
    }))
    const res = await makeApp({ userId: 'user-7' }).request(
      '/api/projects/proj-1/checkpoints',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'pre-deploy',
          name: 'v1.0',
          description: 'before release',
          includeDatabase: true,
        }),
      },
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      ok: true,
      checkpoint: { id: 'cp-new', message: 'pre-deploy', name: 'v1.0' },
    })

    expect(createCheckpoint).toHaveBeenCalledTimes(1)
    expect(createCheckpoint).toHaveBeenCalledWith({
      projectId: 'proj-1',
      workspacePath: expectedWorkspacePath('proj-1'),
      message: 'pre-deploy',
      name: 'v1.0',
      description: 'before release',
      includeDatabase: true,
      createdBy: 'user-7',
    })
  })

  test('createdBy is undefined when no auth context', async () => {
    await makeApp().request('/api/projects/proj-1/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'm' }),
    })
    expect(createCheckpoint.mock.calls[0][0].createdBy).toBeUndefined()
  })

  test('500 checkpoint_failed when service throws', async () => {
    createCheckpoint.mockImplementation(async () => {
      throw new Error('git index locked')
    })
    const res = await makeApp().request('/api/projects/proj-1/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'm' }),
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('checkpoint_failed')
    expect(body.error.message).toBe('git index locked')
  })

  test('500 with fallback message when service throws without .message', async () => {
    createCheckpoint.mockImplementation(async () => {
      throw {} as any
    })
    const res = await makeApp().request('/api/projects/proj-1/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'm' }),
    })
    expect((await res.json()).error.message).toBe('Failed to create checkpoint')
  })
})

// ─── GET /projects/:projectId/checkpoints ─────────────────────────────────

describe('GET /projects/:projectId/checkpoints — list', () => {
  test('404 when project not found', async () => {
    projectFindUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/p404/checkpoints')
    expect(res.status).toBe(404)
  })

  test('409 when project is external', async () => {
    projectFindUnique.mockImplementation(async () => EXTERNAL_PROJECT)
    const res = await makeApp().request('/api/projects/proj-1/checkpoints')
    expect(res.status).toBe(409)
  })

  test('happy path: returns checkpoints + hasMore false when under limit', async () => {
    listCheckpoints.mockImplementation(async () => [
      { id: 'cp1', message: 'a' },
      { id: 'cp2', message: 'b' },
    ])
    const res = await makeApp().request('/api/projects/proj-1/checkpoints')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.checkpoints).toHaveLength(2)
    expect(body.hasMore).toBe(false)
    expect(listCheckpoints).toHaveBeenCalledWith('proj-1', { limit: 50, before: undefined })
  })

  test('default limit is 50 when ?limit not supplied', async () => {
    await makeApp().request('/api/projects/proj-1/checkpoints')
    expect(listCheckpoints.mock.calls[0][1].limit).toBe(50)
  })

  test('explicit ?limit is parsed as integer', async () => {
    await makeApp().request('/api/projects/proj-1/checkpoints?limit=25')
    expect(listCheckpoints.mock.calls[0][1].limit).toBe(25)
  })

  test('?limit > 100 is clamped to 100 (Math.min pin)', async () => {
    await makeApp().request('/api/projects/proj-1/checkpoints?limit=500')
    expect(listCheckpoints.mock.calls[0][1].limit).toBe(100)
  })

  test('?before is forwarded as cursor', async () => {
    await makeApp().request('/api/projects/proj-1/checkpoints?before=cp-xyz')
    expect(listCheckpoints.mock.calls[0][1].before).toBe('cp-xyz')
  })

  test('hasMore=true when returned page equals the requested limit', async () => {
    listCheckpoints.mockImplementation(async () =>
      Array.from({ length: 50 }, (_, i) => ({ id: `cp${i}`, message: 'x' })),
    )
    const res = await makeApp().request('/api/projects/proj-1/checkpoints?limit=50')
    expect((await res.json()).hasMore).toBe(true)
  })

  test('500 list_failed when service throws', async () => {
    listCheckpoints.mockImplementation(async () => {
      throw new Error('git log failed')
    })
    const res = await makeApp().request('/api/projects/proj-1/checkpoints')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('list_failed')
  })
})

// ─── GET /projects/:projectId/checkpoints/:checkpointId ───────────────────

describe('GET /projects/:projectId/checkpoints/:checkpointId', () => {
  test('404 when service returns null', async () => {
    getCheckpoint.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/proj-1/checkpoints/cp-404')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('checkpoint_not_found')
  })

  test('404 when checkpoint exists but belongs to a different project (auth bypass guard)', async () => {
    getCheckpoint.mockImplementation(async () => ({ id: 'cp-1', message: 'm' }))
    checkpointFindUnique.mockImplementation(async () => ({ projectId: 'proj-OTHER' }))
    const res = await makeApp().request('/api/projects/proj-1/checkpoints/cp-1')
    expect(res.status).toBe(404) // not 200 — cross-project leak prevented
  })

  test('404 when prisma row missing (race / orphan checkpoint)', async () => {
    getCheckpoint.mockImplementation(async () => ({ id: 'cp-1', message: 'm' }))
    checkpointFindUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/proj-1/checkpoints/cp-1')
    expect(res.status).toBe(404)
  })

  test('happy path: returns checkpoint when projectId matches', async () => {
    const checkpoint = {
      id: 'cp-1',
      message: 'pre-deploy',
      name: 'v1.0',
      files: ['a.ts', 'b.ts'],
    }
    getCheckpoint.mockImplementation(async () => checkpoint)
    checkpointFindUnique.mockImplementation(async () => ({ projectId: 'proj-1' }))
    const res = await makeApp().request('/api/projects/proj-1/checkpoints/cp-1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, checkpoint })
  })

  test('500 get_failed when service throws', async () => {
    getCheckpoint.mockImplementation(async () => {
      throw new Error('git show failed')
    })
    const res = await makeApp().request('/api/projects/proj-1/checkpoints/cp-1')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('get_failed')
  })

  test('does NOT call validateProject / isExternal (this endpoint is project-agnostic by design)', async () => {
    getCheckpoint.mockImplementation(async () => ({ id: 'cp-1' }))
    checkpointFindUnique.mockImplementation(async () => ({ projectId: 'proj-1' }))
    projectFindUnique.mockReset()
    await makeApp().request('/api/projects/proj-1/checkpoints/cp-1')
    expect(projectFindUnique).not.toHaveBeenCalled()
  })
})

// ─── POST /projects/:projectId/checkpoints/:checkpointId/rollback ─────────

describe('POST /projects/:projectId/checkpoints/:checkpointId/rollback', () => {
  test('404 when project not found', async () => {
    projectFindUnique.mockImplementation(async () => null)
    const res = await makeApp().request(
      '/api/projects/p404/checkpoints/cp-1/rollback',
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
  })

  test('409 when project is external', async () => {
    projectFindUnique.mockImplementation(async () => EXTERNAL_PROJECT)
    const res = await makeApp().request(
      '/api/projects/proj-1/checkpoints/cp-1/rollback',
      { method: 'POST' },
    )
    expect(res.status).toBe(409)
  })

  test('400 when rollback service returns success:false', async () => {
    rollback.mockImplementation(async () => ({
      success: false,
      error: 'working tree has uncommitted changes',
    }))
    const res = await makeApp().request(
      '/api/projects/proj-1/checkpoints/cp-1/rollback',
      { method: 'POST' },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('rollback_failed')
    expect(body.error.message).toBe('working tree has uncommitted changes')
  })

  test('happy path: forwards workspacePath + body + auth userId; returns previous + new checkpoint', async () => {
    rollback.mockImplementation(async () => ({
      success: true,
      previousCheckpoint: 'cp-old',
      newCheckpoint: 'cp-new-after-rollback',
    }))
    const res = await makeApp({ userId: 'user-9' }).request(
      '/api/projects/proj-1/checkpoints/cp-1/rollback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeDatabase: true }),
      },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      rolledBackTo: 'cp-old',
      newCheckpoint: 'cp-new-after-rollback',
    })
    expect(rollback).toHaveBeenCalledWith({
      projectId: 'proj-1',
      workspacePath: expectedWorkspacePath('proj-1'),
      checkpointId: 'cp-1',
      includeDatabase: true,
      createdBy: 'user-9',
    })
  })

  test('survives malformed JSON body — includeDatabase defaults to undefined', async () => {
    const res = await makeApp().request(
      '/api/projects/proj-1/checkpoints/cp-1/rollback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'totally not json',
      },
    )
    expect(res.status).toBe(200)
    expect(rollback.mock.calls[0][0].includeDatabase).toBeUndefined()
  })

  test('500 rollback_failed when service throws', async () => {
    rollback.mockImplementation(async () => {
      throw new Error('reset --hard failed')
    })
    const res = await makeApp().request(
      '/api/projects/proj-1/checkpoints/cp-1/rollback',
      { method: 'POST' },
    )
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('rollback_failed')
  })

  test('400 with default "Rollback failed" when service returns success:false without .error', async () => {
    rollback.mockImplementation(async () => ({ success: false }))
    const res = await makeApp().request(
      '/api/projects/proj-1/checkpoints/cp-1/rollback',
      { method: 'POST' },
    )
    expect((await res.json()).error.message).toBe('Rollback failed')
  })
})

// ─── GET /projects/:projectId/checkpoints/:checkpointId/diff ──────────────

describe('GET /projects/:projectId/checkpoints/:checkpointId/diff', () => {
  test('404 when project not found', async () => {
    projectFindUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/p404/checkpoints/cp-1/diff')
    expect(res.status).toBe(404)
  })

  test('409 when project is external', async () => {
    projectFindUnique.mockImplementation(async () => EXTERNAL_PROJECT)
    const res = await makeApp().request('/api/projects/proj-1/checkpoints/cp-1/diff')
    expect(res.status).toBe(409)
  })

  test('404 when service returns null (checkpoint missing)', async () => {
    getDiff.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/proj-1/checkpoints/cp-1/diff')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('checkpoint_not_found')
  })

  test('happy path: returns diff and forwards toCheckpointId from ?to=', async () => {
    const diff = { files: 3, additions: 50, deletions: 20, patch: '...' }
    getDiff.mockImplementation(async () => diff)
    const res = await makeApp().request(
      '/api/projects/proj-1/checkpoints/cp-1/diff?to=cp-2',
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, diff })
    expect(getDiff).toHaveBeenCalledWith(
      expectedWorkspacePath('proj-1'),
      'cp-1',
      'cp-2',
    )
  })

  test('without ?to=, third arg is undefined (diff vs HEAD)', async () => {
    getDiff.mockImplementation(async () => ({ files: 0 }))
    await makeApp().request('/api/projects/proj-1/checkpoints/cp-1/diff')
    expect(getDiff.mock.calls[0][2]).toBeUndefined()
  })

  test('500 diff_failed when service throws', async () => {
    getDiff.mockImplementation(async () => {
      throw new Error('git diff died')
    })
    const res = await makeApp().request('/api/projects/proj-1/checkpoints/cp-1/diff')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('diff_failed')
  })
})

// ─── GET /projects/:projectId/git/status ──────────────────────────────────

describe('GET /projects/:projectId/git/status', () => {
  test('404 when project not found', async () => {
    projectFindUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/p404/git/status')
    expect(res.status).toBe(404)
  })

  test('409 when project is external', async () => {
    projectFindUnique.mockImplementation(async () => EXTERNAL_PROJECT)
    const res = await makeApp().request('/api/projects/proj-1/git/status')
    expect(res.status).toBe(409)
  })

  test('happy path: returns service status payload', async () => {
    getProjectStatus.mockImplementation(async () => ({
      branch: 'main',
      clean: false,
      ahead: 2,
      behind: 0,
      modified: ['a.ts'],
    }))
    const res = await makeApp().request('/api/projects/proj-1/git/status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      status: { branch: 'main', clean: false, ahead: 2, behind: 0, modified: ['a.ts'] },
    })
    expect(getProjectStatus).toHaveBeenCalledWith(expectedWorkspacePath('proj-1'))
  })

  test('500 status_failed when service throws', async () => {
    getProjectStatus.mockImplementation(async () => {
      throw new Error('git status failed')
    })
    const res = await makeApp().request('/api/projects/proj-1/git/status')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('status_failed')
  })
})

// ─── workspacesDir config plumbing ────────────────────────────────────────

describe('workspacesDir config plumbing', () => {
  test('a different workspacesDir is honored end-to-end', async () => {
    const app = new Hono()
    app.route('/api', checkpointRoutes({ workspacesDir: '/srv/agents/wsroot' }))

    await app.request('/api/projects/proj-1/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'm' }),
    })
    expect(createCheckpoint.mock.calls[0][0].workspacePath).toBe(
      '/srv/agents/wsroot/proj-1',
    )
  })
})
