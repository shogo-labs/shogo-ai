// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/routes/github.ts` — GitHub App integration endpoints.
 *
 * Covers all 12 endpoints + webhook:
 *   - GET    /github/status              — configured vs. not, error catch
 *   - GET    /github/install-url         — 400 when not configured, happy path
 *   - GET    /github/installations       — 400 when not configured, listings
 *   - GET    /github/repos               — query validation, listings
 *   - POST   /github/repos               — body validation, defaults (private:true)
 *   - GET    /projects/:id/github        — 404 project missing, connected vs. not
 *   - POST   /projects/:id/github/connect — body validation, happy path
 *   - DELETE /projects/:id/github         — 404 project missing, happy path
 *   - POST   /projects/:id/github/push    — 404, push failure, success
 *   - POST   /projects/:id/github/pull    — 404, pull failure, success
 *   - POST   /projects/:id/github/sync    — 404, sync failure, success
 *   - POST   /github/webhook              — signature verify, event routing
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── Mock github.service ──────────────────────────────────────────────

const githubSvc = {
  isConfigured: mock(() => true),
  getInstallationUrl: mock(() => 'https://github.com/apps/shogo/installations/new'),
  listInstallations: mock(async () => [] as any[]),
  listRepositories: mock(async (_id: number) => [] as any[]),
  createRepository: mock(async (_id: number, _opts: any) => ({ id: 1, full_name: 'org/r' })),
  getConnection: mock(async (_pid: string) => null as any),
  connectRepository: mock(async (_args: any) => ({
    connection: {
      id: 'c1', repoOwner: 'org', repoName: 'r', repoFullName: 'org/r',
      defaultBranch: 'main', isPrivate: true,
    },
    repo: { id: 1, name: 'r', full_name: 'org/r', html_url: 'https://github.com/org/r', private: true },
  })),
  disconnectRepository: mock(async (_pid: string) => undefined),
  pushToGitHub: mock(async (_pid: string, _ws: string) => ({ success: true, sha: 'abc123' } as any)),
  pullFromGitHub: mock(async (_pid: string, _ws: string) => ({ success: true } as any)),
  syncWithGitHub: mock(async (_pid: string, _ws: string) => ({ success: true } as any)),
  verifyWebhookSignature: mock((_p: string, _s: string) => true),
  handleInstallationWebhook: mock(async (_action: string, _inst: any) => undefined),
  handlePushWebhook: mock(async (_iid: number, _full: string, _commits: any[]) => undefined),
}
mock.module('../services/github.service', () => githubSvc)

// ─── Prisma mock ──────────────────────────────────────────────────────

const projects = new Map<string, any>()
mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where }: any) => projects.get(where.id) ?? null,
    },
  },
}))

// ─── Import after mocks ──────────────────────────────────────────────

const { githubRoutes } = await import('../routes/github')
const router = githubRoutes({ workspacesDir: '/ws' })

beforeEach(() => {
  projects.clear()
  Object.values(githubSvc).forEach((spy: any) => spy.mockClear?.())
  githubSvc.isConfigured.mockImplementation(() => true)
  githubSvc.getInstallationUrl.mockImplementation(() => 'https://github.com/apps/shogo')
  githubSvc.listInstallations.mockImplementation(async () => [])
  githubSvc.listRepositories.mockImplementation(async () => [])
  githubSvc.createRepository.mockImplementation(async () => ({ id: 1, full_name: 'org/r' }))
  githubSvc.getConnection.mockImplementation(async () => null)
  githubSvc.disconnectRepository.mockImplementation(async () => undefined)
  githubSvc.pushToGitHub.mockImplementation(async () => ({ success: true } as any))
  githubSvc.pullFromGitHub.mockImplementation(async () => ({ success: true } as any))
  githubSvc.syncWithGitHub.mockImplementation(async () => ({ success: true } as any))
  githubSvc.verifyWebhookSignature.mockImplementation(() => true)
  githubSvc.handleInstallationWebhook.mockImplementation(async () => undefined)
  githubSvc.handlePushWebhook.mockImplementation(async () => undefined)
})

afterAll(() => mock.restore())

const seedProject = (id: string) => projects.set(id, { id, name: 'P', workspaceId: 'w1' })

// ═══════════════════════════════════════════════════════════════════════
// /github/status
// ═══════════════════════════════════════════════════════════════════════

describe('GET /github/status', () => {
  test('configured:true returns install url', async () => {
    const res = await router.request('/github/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.configured).toBe(true)
    expect(body.installUrl).toMatch(/github.com/)
  })

  test('configured:false returns null installUrl', async () => {
    githubSvc.isConfigured.mockImplementation(() => false)
    const body = await (await router.request('/github/status')).json()
    expect(body.configured).toBe(false)
    expect(body.installUrl).toBe(null)
  })

  test('500 when service throws', async () => {
    githubSvc.isConfigured.mockImplementation(() => { throw new Error('boom') })
    const res = await router.request('/github/status')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// /github/install-url
// ═══════════════════════════════════════════════════════════════════════

describe('GET /github/install-url', () => {
  test('400 when not configured', async () => {
    githubSvc.isConfigured.mockImplementation(() => false)
    const res = await router.request('/github/install-url')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('not_configured')
  })

  test('happy path returns url', async () => {
    const res = await router.request('/github/install-url')
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// /github/installations
// ═══════════════════════════════════════════════════════════════════════

describe('GET /github/installations', () => {
  test('400 when not configured', async () => {
    githubSvc.isConfigured.mockImplementation(() => false)
    const res = await router.request('/github/installations')
    expect(res.status).toBe(400)
  })

  test('returns installations from service', async () => {
    githubSvc.listInstallations.mockImplementation(async () => [{ id: 1 }, { id: 2 }])
    const res = await router.request('/github/installations')
    expect(res.status).toBe(200)
    expect((await res.json()).installations).toHaveLength(2)
  })

  test('500 on service throw', async () => {
    githubSvc.listInstallations.mockImplementation(async () => { throw new Error('x') })
    expect((await router.request('/github/installations')).status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// /github/repos (list + create)
// ═══════════════════════════════════════════════════════════════════════

describe('GET /github/repos', () => {
  test('400 when installation_id missing', async () => {
    const res = await router.request('/github/repos')
    expect(res.status).toBe(400)
  })

  test('400 when installation_id is not a number', async () => {
    const res = await router.request('/github/repos?installation_id=abc')
    expect(res.status).toBe(400)
  })

  test('happy path returns repos', async () => {
    githubSvc.listRepositories.mockImplementation(async (id: number) => {
      expect(id).toBe(42)
      return [{ name: 'r1' }, { name: 'r2' }]
    })
    const res = await router.request('/github/repos?installation_id=42')
    expect(res.status).toBe(200)
    expect((await res.json()).repositories).toHaveLength(2)
  })

  test('500 on service throw', async () => {
    githubSvc.listRepositories.mockImplementation(async () => { throw new Error('x') })
    expect((await router.request('/github/repos?installation_id=1')).status).toBe(500)
  })
})

describe('POST /github/repos', () => {
  function post(body: any) {
    return router.request('/github/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('400 when installation_id missing', async () => {
    const res = await post({ name: 'r' })
    expect(res.status).toBe(400)
  })

  test('400 when name missing', async () => {
    const res = await post({ installation_id: 1 })
    expect(res.status).toBe(400)
  })

  test('201 happy path with defaults (private:true)', async () => {
    const res = await post({ installation_id: 1, name: 'r' })
    expect(res.status).toBe(201)
    const call = githubSvc.createRepository.mock.calls[0]
    expect(call[1].private).toBe(true)
  })

  test('honours private:false override', async () => {
    await post({ installation_id: 1, name: 'r', private: false })
    expect(githubSvc.createRepository.mock.calls[0][1].private).toBe(false)
  })

  test('forwards org and description', async () => {
    await post({ installation_id: 1, name: 'r', org: 'my-org', description: 'd' })
    const arg = githubSvc.createRepository.mock.calls[0][1]
    expect(arg.org).toBe('my-org')
    expect(arg.description).toBe('d')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// /projects/:id/github (get)
// ═══════════════════════════════════════════════════════════════════════

describe('GET /projects/:id/github', () => {
  test('404 when project missing', async () => {
    const res = await router.request('/projects/missing/github')
    expect(res.status).toBe(404)
  })

  test('connected:false when no connection', async () => {
    seedProject('p1')
    const res = await router.request('/projects/p1/github')
    const body = await res.json()
    expect(body.connected).toBe(false)
    expect(body.connection).toBe(null)
  })

  test('returns full connection details when connected', async () => {
    seedProject('p1')
    githubSvc.getConnection.mockImplementation(async () => ({
      id: 'c1', repoOwner: 'org', repoName: 'r', repoFullName: 'org/r',
      defaultBranch: 'main', isPrivate: true, syncEnabled: true,
      lastPushAt: new Date('2026-01-01'),
      lastPullAt: null,
      lastSyncError: null,
    }))
    const body = await (await router.request('/projects/p1/github')).json()
    expect(body.connected).toBe(true)
    expect(body.connection.repoFullName).toBe('org/r')
    expect(body.connection.syncEnabled).toBe(true)
  })

  test('500 on service throw', async () => {
    seedProject('p1')
    githubSvc.getConnection.mockImplementation(async () => { throw new Error('x') })
    expect((await router.request('/projects/p1/github')).status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// /projects/:id/github/connect
// ═══════════════════════════════════════════════════════════════════════

describe('POST /projects/:id/github/connect', () => {
  function connect(body: any, pid = 'p1') {
    return router.request(`/projects/${pid}/github/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('404 when project missing', async () => {
    const res = await connect({}, 'missing')
    expect(res.status).toBe(404)
  })

  test('400 when body missing required fields', async () => {
    seedProject('p1')
    const res = await connect({ installation_id: 1, repo_owner: 'org' })
    expect(res.status).toBe(400)
  })

  test('201 on happy path', async () => {
    seedProject('p1')
    const res = await connect({ installation_id: 1, repo_owner: 'org', repo_name: 'r' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.connection.repoFullName).toBe('org/r')
    expect(body.repository.private).toBe(true)
    expect(githubSvc.connectRepository.mock.calls[0][0].workspacePath).toContain('p1')
  })

  test('500 when service throws', async () => {
    seedProject('p1')
    githubSvc.connectRepository.mockImplementation(async () => { throw new Error('boom') })
    const res = await connect({ installation_id: 1, repo_owner: 'org', repo_name: 'r' })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// /projects/:id/github (delete)
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /projects/:id/github', () => {
  test('404 when project missing', async () => {
    const res = await router.request('/projects/missing/github', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  test('200 happy path', async () => {
    seedProject('p1')
    const res = await router.request('/projects/p1/github', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(githubSvc.disconnectRepository).toHaveBeenCalledWith('p1')
  })

  test('500 on service throw', async () => {
    seedProject('p1')
    githubSvc.disconnectRepository.mockImplementation(async () => { throw new Error('x') })
    const res = await router.request('/projects/p1/github', { method: 'DELETE' })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// push / pull / sync
// ═══════════════════════════════════════════════════════════════════════

describe('POST /projects/:id/github/push', () => {
  test('404 when project missing', async () => {
    expect((await router.request('/projects/m/github/push', { method: 'POST' })).status).toBe(404)
  })
  test('400 when service returns success:false', async () => {
    seedProject('p1')
    githubSvc.pushToGitHub.mockImplementation(async () => ({ success: false, error: 'nope' } as any))
    const res = await router.request('/projects/p1/github/push', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('push_failed')
  })
  test('200 on success spreads result', async () => {
    seedProject('p1')
    githubSvc.pushToGitHub.mockImplementation(async () => ({ success: true, sha: 'abc' } as any))
    const res = await router.request('/projects/p1/github/push', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.sha).toBe('abc')
  })
})

describe('POST /projects/:id/github/pull', () => {
  test('404 when project missing', async () => {
    expect((await router.request('/projects/m/github/pull', { method: 'POST' })).status).toBe(404)
  })
  test('400 on pull_failed', async () => {
    seedProject('p1')
    githubSvc.pullFromGitHub.mockImplementation(async () => ({ success: false, error: 'conflict' } as any))
    const res = await router.request('/projects/p1/github/pull', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('pull_failed')
  })
  test('200 happy path', async () => {
    seedProject('p1')
    githubSvc.pullFromGitHub.mockImplementation(async () => ({ success: true, ff: true } as any))
    const body = await (await router.request('/projects/p1/github/pull', { method: 'POST' })).json()
    expect(body.ok).toBe(true)
    expect(body.ff).toBe(true)
  })
})

describe('POST /projects/:id/github/sync', () => {
  test('400 on sync_failed', async () => {
    seedProject('p1')
    githubSvc.syncWithGitHub.mockImplementation(async () => ({ success: false } as any))
    const res = await router.request('/projects/p1/github/sync', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('sync_failed')
  })
  test('200 happy path', async () => {
    seedProject('p1')
    githubSvc.syncWithGitHub.mockImplementation(async () => ({ success: true, pushed: 3 } as any))
    const body = await (await router.request('/projects/p1/github/sync', { method: 'POST' })).json()
    expect(body.pushed).toBe(3)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// POST /github/webhook
// ═══════════════════════════════════════════════════════════════════════

describe('POST /github/webhook', () => {
  function webhook(event: string, payload: any, signature?: string) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-github-event': event,
    }
    if (signature !== undefined) headers['x-hub-signature-256'] = signature
    return router.request('/github/webhook', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
  }

  test('401 when signature header present but invalid', async () => {
    githubSvc.verifyWebhookSignature.mockImplementation(() => false)
    const res = await webhook('push', {}, 'sha256=bad')
    expect(res.status).toBe(401)
  })

  test('200 when signature is omitted (verification skipped)', async () => {
    const res = await webhook('ping', { zen: 'be patient' })
    expect(res.status).toBe(200)
    expect(githubSvc.verifyWebhookSignature).not.toHaveBeenCalled()
  })

  test('installation event routes to handler', async () => {
    await webhook('installation', { action: 'created', installation: { id: 7 } })
    const call = githubSvc.handleInstallationWebhook.mock.calls[0]
    expect(call[0]).toBe('created')
    expect(call[1].id).toBe(7)
  })

  test('push event routes to handler with commits', async () => {
    await webhook('push', {
      installation: { id: 7 },
      repository: { full_name: 'org/r' },
      commits: [{ id: 'c1' }],
    })
    const call = githubSvc.handlePushWebhook.mock.calls[0]
    expect(call[0]).toBe(7)
    expect(call[1]).toBe('org/r')
    expect(call[2]).toHaveLength(1)
  })

  test('push event without installation.id is skipped silently', async () => {
    const res = await webhook('push', { repository: { full_name: 'org/r' } })
    expect(res.status).toBe(200)
    expect(githubSvc.handlePushWebhook).not.toHaveBeenCalled()
  })

  test('push event missing commits defaults to []', async () => {
    await webhook('push', {
      installation: { id: 1 },
      repository: { full_name: 'org/r' },
    })
    expect(githubSvc.handlePushWebhook.mock.calls[0][2]).toEqual([])
  })

  test('ping event accepted', async () => {
    const res = await webhook('ping', { zen: 'k' })
    expect(res.status).toBe(200)
  })

  test('unknown event still returns 200', async () => {
    const res = await webhook('some_unknown', {})
    expect(res.status).toBe(200)
  })

  test('500 when handler throws', async () => {
    githubSvc.handleInstallationWebhook.mockImplementation(async () => { throw new Error('x') })
    const res = await webhook('installation', { action: 'created', installation: { id: 1 } })
    expect(res.status).toBe(500)
  })
})
