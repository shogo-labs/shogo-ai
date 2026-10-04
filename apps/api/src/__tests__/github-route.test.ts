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

class NotConnected extends Error {}

const githubSvc = {
  isConfigured: mock(() => true),
  getInstallationUrl: mock((_state?: string) => 'https://github.com/apps/shogo/installations/new'),
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
    workspace: { ok: true, connect: 'adopted', branch: 'main' },
  })),
  isOAuthConfigured: mock(() => true),
  getOAuthUrl: mock((state: string, redirect: string) => `https://github.com/login/oauth/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirect)}`),
  getAuthorizeCallbackUrl: mock(() => 'https://api.test/api/github/callback'),
  exchangeOAuthCode: mock(async (_code: string) => ({ access_token: 'ghu_user', token_type: 'bearer', scope: '' })),
  findUserInstallationForRepo: mock(async (..._args: any[]) => 42 as number | null),
  disconnectRepository: mock(async (_pid: string) => undefined),
  pushToGitHub: mock(async (_pid: string, _ws: string) => ({ success: true, sha: 'abc123' } as any)),
  pullFromGitHub: mock(async (_pid: string, _ws: string) => ({ success: true } as any)),
  syncWithGitHub: mock(async (_pid: string, _ws: string) => ({ success: true } as any)),
  verifyWebhookSignature: mock((_p: string, _s: string) => true),
  handleInstallationWebhook: mock(async (_action: string, _inst: any) => undefined),
  handlePushWebhook: mock(async (_iid: number, _full: string, _commits: any[]) => undefined),
  isValidBranchName: (b: string) => /^[A-Za-z0-9._/-]+$/.test(b) && !b.includes('..'),
  GitHubNotConnectedError: NotConnected,
  listBranches: mock(async (_pid: string) => ['main', 'feature/x'] as string[]),
  switchBranch: mock(async (_pid: string, branch: string, _ws: any) => ({ repoFullName: 'org/r', branch, techStackId: 'custom' } as any)),
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

process.env.BETTER_AUTH_SECRET ??= 'test-state-secret'
process.env.APP_URL = 'https://studio.test'
const { githubRoutes } = await import('../routes/github')
const { createGitHubAuthorizeState, verifyGitHubAuthorizeState } = await import('../lib/github-oauth-state')
const workspaceFor = (projectId: string) => ({ projectId, run: async () => ({ ok: true }) }) as any
const router = githubRoutes({ workspaceFor })

beforeEach(() => {
  projects.clear()
  Object.values(githubSvc).forEach((spy: any) => spy.mockClear?.())
  githubSvc.isConfigured.mockImplementation(() => true)
  githubSvc.getInstallationUrl.mockImplementation((state?: string) =>
    state ? `https://github.com/apps/shogo/installations/new?state=${encodeURIComponent(state)}` : 'https://github.com/apps/shogo')
  githubSvc.isOAuthConfigured.mockImplementation(() => true)
  githubSvc.exchangeOAuthCode.mockImplementation(async () => ({ access_token: 'ghu_user', token_type: 'bearer', scope: '' }))
  githubSvc.findUserInstallationForRepo.mockImplementation(async () => 42)
  githubSvc.connectRepository.mockImplementation(async () => ({
    connection: {
      id: 'c1', repoOwner: 'org', repoName: 'r', repoFullName: 'org/r',
      defaultBranch: 'main', isPrivate: true,
    },
    repo: { id: 1, name: 'r', full_name: 'org/r', html_url: 'https://github.com/org/r', private: true },
    workspace: { ok: true, connect: 'adopted', branch: 'main' },
  }))
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

  test('reports a token connection by login without exposing the stored token', async () => {
    seedProject('p1')
    githubSvc.getConnection.mockImplementation(async () => ({
      id: 'c2', repoOwner: 'org', repoName: 'r', repoFullName: 'org/r',
      defaultBranch: 'main', isPrivate: true, syncEnabled: true,
      authType: 'token', tokenLogin: 'octo-user', encryptedToken: 'v1:iv:tag:ciphertext',
      lastPushAt: null, lastPullAt: null, lastSyncError: null,
    }))
    const res = await router.request('/projects/p1/github')
    const text = await res.text()
    expect(JSON.parse(text).connection).toMatchObject({ authType: 'token', tokenLogin: 'octo-user' })
    expect(text).not.toContain('v1:iv:tag:ciphertext')
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
    expect(githubSvc.connectRepository.mock.calls[0][0].workspace.projectId).toBe('p1')
    expect(body.workspace).toEqual({ ok: true, connect: 'adopted', branch: 'main' })
  })

  test('accepts a user access token instead of an installation and never echoes it', async () => {
    seedProject('p1')
    githubSvc.connectRepository.mockClear()
    const res = await connect({ token: '  ghp_secret  ', repo_owner: 'org', repo_name: 'r' })
    expect(res.status).toBe(201)
    const args = githubSvc.connectRepository.mock.calls[0][0]
    expect(args.token).toBe('ghp_secret')
    expect(args.installationId).toBeUndefined()
    expect(await res.text()).not.toContain('ghp_secret')
  })

  test('400 unless exactly one of installation_id or token is given', async () => {
    seedProject('p1')
    expect((await connect({ repo_owner: 'org', repo_name: 'r' })).status).toBe(400)
    expect((await connect({ installation_id: 1, token: 'ghp_x', repo_owner: 'org', repo_name: 'r' })).status).toBe(400)
    expect((await connect({ token: '   ', repo_owner: 'org', repo_name: 'r' })).status).toBe(400)
  })

  test('500 when service throws', async () => {
    seedProject('p1')
    githubSvc.connectRepository.mockImplementation(async () => { throw new Error('boom') })
    const res = await connect({ installation_id: 1, repo_owner: 'org', repo_name: 'r' })
    expect(res.status).toBe(500)
  })
})

describe('branches', () => {
  function switchTo(body: any, pid = 'p1') {
    return router.request(`/projects/${pid}/github/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('connect forwards a requested branch', async () => {
    seedProject('p1')
    githubSvc.connectRepository.mockClear()
    await router.request('/projects/p1/github/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_x', repo_owner: 'org', repo_name: 'r', branch: ' feature/x ' }),
    })
    expect(githubSvc.connectRepository.mock.calls[0][0].branch).toBe('feature/x')
  })

  test('GET /branches lists the repository branches and the current one', async () => {
    seedProject('p1')
    githubSvc.getConnection.mockImplementation(async () => ({ defaultBranch: 'main', branch: 'feature/x' }))
    const res = await router.request('/projects/p1/github/branches')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, branches: ['main', 'feature/x'], current: 'feature/x', defaultBranch: 'main' })
  })

  test('GET /branches is 409 not_connected without a connection', async () => {
    seedProject('p1')
    githubSvc.listBranches.mockImplementationOnce(async () => { throw new NotConnected('nope') })
    const res = await router.request('/projects/p1/github/branches')
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('not_connected')
  })

  test('POST /branch switches the workspace through the service', async () => {
    seedProject('p1')
    githubSvc.switchBranch.mockClear()
    const res = await switchTo({ branch: 'feature/x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, repoFullName: 'org/r', branch: 'feature/x', techStackId: 'custom' })
    const [pid, branch, ws] = githubSvc.switchBranch.mock.calls[0]
    expect([pid, branch, ws.projectId]).toEqual(['p1', 'feature/x', 'p1'])
  })

  test('POST /branch rejects missing or invalid branch names', async () => {
    seedProject('p1')
    expect((await switchTo({})).status).toBe(400)
    expect((await switchTo({ branch: '../etc' })).status).toBe(400)
  })

  test('POST /branch is 409 when not connected and 400 when the switch fails', async () => {
    seedProject('p1')
    githubSvc.switchBranch.mockImplementationOnce(async () => { throw new NotConnected('nope') })
    expect((await switchTo({ branch: 'x' })).status).toBe(409)
    githubSvc.switchBranch.mockImplementationOnce(async () => { throw new Error('Branch x does not exist on GitHub.') })
    const res = await switchTo({ branch: 'x' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain('does not exist')
  })

  test('404 when the project is missing', async () => {
    expect((await router.request('/projects/nope/github/branches')).status).toBe(404)
    expect((await switchTo({ branch: 'x' }, 'nope')).status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// /projects/:id/github (delete)
// ═══════════════════════════════════════════════════════════════════════

describe('POST /projects/:id/github/authorize', () => {
  function authorize(body: any, pid = 'p1') {
    return router.request(`/projects/${pid}/github/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('returns an App install link whose signed state names the project and repo', async () => {
    seedProject('p1')
    const res = await authorize({ repo_owner: 'org', repo_name: 'r' })
    expect(res.status).toBe(200)
    const { url } = await res.json()
    const state = new URL(url).searchParams.get('state')!
    expect(verifyGitHubAuthorizeState(state)).toMatchObject({ projectId: 'p1', repoOwner: 'org', repoName: 'r' })
  })

  test('400 without a repo, and 400 when the App OAuth flow is not configured', async () => {
    seedProject('p1')
    expect((await authorize({ repo_owner: 'org' })).status).toBe(400)
    githubSvc.isOAuthConfigured.mockImplementation(() => false)
    const res = await authorize({ repo_owner: 'org', repo_name: 'r' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('not_configured')
  })
})

describe('GET /projects/:id/github/authorize (the short link agents hand out)', () => {
  const open = (query: string, pid = 'p1') => router.request(`/projects/${pid}/github/authorize${query}`)

  test('redirects to GitHub with a freshly signed state for the project and repo', async () => {
    seedProject('p1')
    const res = await open('?repo=org%2Fr')
    expect(res.status).toBe(302)
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!
    expect(verifyGitHubAuthorizeState(state)).toMatchObject({ projectId: 'p1', repoOwner: 'org', repoName: 'r' })
  })

  test('explains a missing project, a malformed repo, and an unconfigured server instead of redirecting', async () => {
    expect((await open('?repo=org/r', 'nope')).status).toBe(404)
    seedProject('p1')
    expect((await open('')).status).toBe(400)
    expect((await open('?repo=org/r/extra')).status).toBe(400)
    githubSvc.isOAuthConfigured.mockImplementation(() => false)
    const res = await open('?repo=org/r')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('share an access token')
  })
})

describe('GET /github/callback', () => {
  const state = () => createGitHubAuthorizeState({ projectId: 'p1', repoOwner: 'org', repoName: 'r' })
  const callback = (params: Record<string, string>) =>
    router.request(`/github/callback?${new URLSearchParams(params)}`)

  test('without an OAuth code, bounces through GitHub OAuth carrying the installation id', async () => {
    const res = await callback({ state: state(), installation_id: '77', setup_action: 'install' })
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.pathname).toBe('/login/oauth/authorize')
    expect(verifyGitHubAuthorizeState(location.searchParams.get('state')!)?.installationId).toBe(77)
    expect(githubSvc.connectRepository).not.toHaveBeenCalled()
  })

  test('with a code, connects through an installation the user can access and returns to the project', async () => {
    const res = await callback({ state: state(), code: 'abc', installation_id: '77' })
    expect(res.status).toBe(302)
    expect(githubSvc.findUserInstallationForRepo.mock.calls[0]).toEqual(['ghu_user', 'org', 'r', 77])
    const args = githubSvc.connectRepository.mock.calls[0][0]
    expect(args).toMatchObject({ projectId: 'p1', installationId: 42, repoOwner: 'org', repoName: 'r' })
    expect(args.workspace.projectId).toBe('p1')
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('https://studio.test/projects/p1')
    expect(location.searchParams.get('github')).toBe('connected')
  })

  test('sends the user back to the install page when no accessible installation can see the repo', async () => {
    githubSvc.findUserInstallationForRepo.mockImplementation(async () => null)
    const res = await callback({ state: state(), code: 'abc' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/installations/new?state=')
    expect(githubSvc.connectRepository).not.toHaveBeenCalled()
  })

  test('rejects a forged or expired state without touching GitHub', async () => {
    const res = await callback({ state: `${state()}x`, code: 'abc' })
    expect(res.status).toBe(400)
    expect(githubSvc.exchangeOAuthCode).not.toHaveBeenCalled()
    expect(githubSvc.connectRepository).not.toHaveBeenCalled()
  })
})

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
  function webhook(event: string, payload: any, signature: string | null = 'sha256=valid') {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-github-event': event,
    }
    if (signature !== null) headers['x-hub-signature-256'] = signature
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

  test('401 when signature is missing', async () => {
    const res = await webhook('ping', { zen: 'be patient' }, null)
    expect(res.status).toBe(401)
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

// ═══════════════════════════════════════════════════════════════════════
// gap-closing: remaining catch arms + sync project_not_found
// ═══════════════════════════════════════════════════════════════════════

describe('500 catch arms on every remaining endpoint', () => {
  test('GET /github/install-url → url_error when service throws', async () => {
    githubSvc.getInstallationUrl.mockImplementation(() => { throw new Error('boom') })
    const res = await router.request('/github/install-url')
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('url_error')
  })

  test('POST /github/repos → create_error when service throws', async () => {
    githubSvc.createRepository.mockImplementation(async () => { throw new Error('boom') })
    const res = await router.request('/github/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installation_id: 1, name: 'r' }),
    })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('create_error')
  })

  test('POST /projects/:id/github/push → push_error when service throws', async () => {
    seedProject('p1')
    githubSvc.pushToGitHub.mockImplementation(async () => { throw new Error('boom') })
    const res = await router.request('/projects/p1/github/push', { method: 'POST' })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('push_error')
  })

  test('POST /projects/:id/github/pull → pull_error when service throws', async () => {
    seedProject('p1')
    githubSvc.pullFromGitHub.mockImplementation(async () => { throw new Error('boom') })
    const res = await router.request('/projects/p1/github/pull', { method: 'POST' })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('pull_error')
  })

  test('POST /projects/:id/github/sync → 404 project_not_found when project missing', async () => {
    const res = await router.request('/projects/nope/github/sync', { method: 'POST' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('project_not_found')
  })

  test('POST /projects/:id/github/sync → sync_error when service throws', async () => {
    seedProject('p1')
    githubSvc.syncWithGitHub.mockImplementation(async () => { throw new Error('boom') })
    const res = await router.request('/projects/p1/github/sync', { method: 'POST' })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('sync_error')
  })
})
