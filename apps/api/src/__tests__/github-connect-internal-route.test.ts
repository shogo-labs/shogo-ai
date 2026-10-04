// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Internal routes behind the agent's `github_connect` tool: connect with a
 * token the user shared, or get a link to authorize the Shogo GitHub App.
 */

import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

mock.module('../services/github-workspace', () => ({
  runtimeGitHubWorkspace: (projectId: string) => ({ runtimeFor: projectId }),
}))
process.env.BETTER_AUTH_SECRET = 'test-secret'

const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')

function app(opts: {
  authorized?: boolean
  github?: boolean
  oauth?: boolean
  connect?: (args: any) => Promise<any>
  connection?: { repoOwner: string; repoName: string } | null
  switchBranch?: (...args: any[]) => Promise<any>
} = {}) {
  const connects: any[] = []
  const switches: any[] = []
  const routes = runtimeInternalRoutes({
    authenticate: async () => (opts.authorized === false ? null : ({ kind: 'sa' } as any)),
    saveAgentAvatar: async () => ({}) as any,
    metalWorkspaceMember: (async () => null) as any,
    ...(opts.github === false
      ? {}
      : {
          loadGitHub: async () => ({
            isOAuthConfigured: () => opts.oauth !== false,
            getAuthorizeLinkUrl: (projectId: string, owner: string, repo: string) =>
              `https://studio.test/api/projects/${projectId}/github/authorize?repo=${encodeURIComponent(`${owner}/${repo}`)}`,
            getConnection: async () => (opts.connection === undefined ? { repoOwner: 'acme', repoName: 'site' } : opts.connection),
            switchBranch: async (...args: any[]) => {
              switches.push(args)
              if (opts.switchBranch) return opts.switchBranch(...args)
              return { repoFullName: 'acme/site', branch: args[1], techStackId: 'custom' }
            },
            connectRepository: async (args: any) => {
              connects.push(args)
              if (opts.connect) return opts.connect(args)
              return {
                connection: { defaultBranch: 'main', authType: 'token', tokenLogin: 'octo-user' },
                repo: { full_name: 'acme/site', html_url: 'https://github.com/acme/site' },
                workspace: { ok: true, connect: 'adopted', branch: 'main', backupBranch: 'shogo/pre-connect-x' },
              }
            },
          }) as any,
        }),
  } as any)
  const root = new Hono()
  root.route('/api/internal', routes)
  const post = (path: string, body?: unknown) =>
    root.request(`/api/internal/projects/p1/github/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { post, connects, switches }
}

describe('POST /projects/:id/github/connect', () => {
  test('connects with the shared token, runs the workspace step in the project runtime, and never echoes the token', async () => {
    const t = app()
    const res = await t.post('connect', { repoOwner: 'acme', repoName: 'site', token: '  ghp_shared  ' })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('ghp_shared')
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      repoFullName: 'acme/site',
      login: 'octo-user',
      workspace: { ok: true, connect: 'adopted', backupBranch: 'shogo/pre-connect-x' },
    })
    expect(t.connects).toEqual([
      { projectId: 'p1', token: 'ghp_shared', repoOwner: 'acme', repoName: 'site', workspace: { runtimeFor: 'p1' } },
    ])
  })

  test('passes a requested branch through to the connect', async () => {
    const t = app()
    await t.post('connect', { repoOwner: 'acme', repoName: 'site', token: 'ghp_x', branch: 'feature/x' })
    expect(t.connects[0].branch).toBe('feature/x')
  })

  test('requires repo and token, authentication, and the cloud GitHub client', async () => {
    expect((await app().post('connect', { repoOwner: 'acme', repoName: 'site' })).status).toBe(400)
    expect((await app({ authorized: false }).post('connect', { repoOwner: 'a', repoName: 'b', token: 't' })).status).toBe(401)
    expect((await app({ github: false }).post('connect', { repoOwner: 'a', repoName: 'b', token: 't' })).status).toBe(409)
  })

  test('surfaces a rejected token as a 400 with the reason', async () => {
    const t = app({ connect: async () => { throw new Error('GitHub rejected the access token: Bad credentials') } })
    const res = await t.post('connect', { repoOwner: 'acme', repoName: 'site', token: 'ghp_bad' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Bad credentials')
  })
})

describe('POST /projects/:id/github/branch', () => {
  test('switches a project connected to that repository, in its runtime', async () => {
    const t = app()
    const res = await t.post('branch', { repoOwner: 'Acme', repoName: 'site', branch: 'feature/x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, repoFullName: 'acme/site', branch: 'feature/x', techStackId: 'custom' })
    expect(t.switches).toEqual([['p1', 'feature/x', { runtimeFor: 'p1' }]])
  })

  test('409 not_connected when the project has no connection or a different repository', async () => {
    for (const connection of [null, { repoOwner: 'acme', repoName: 'other' }]) {
      const t = app({ connection })
      const res = await t.post('branch', { repoOwner: 'acme', repoName: 'site', branch: 'x' })
      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe('not_connected')
      expect(t.switches).toEqual([])
    }
  })

  test('requires repo and branch and authentication; surfaces a failed switch as 400', async () => {
    expect((await app().post('branch', { repoOwner: 'acme', repoName: 'site' })).status).toBe(400)
    expect((await app({ authorized: false }).post('branch', { repoOwner: 'a', repoName: 'b', branch: 'x' })).status).toBe(401)
    const t = app({ switchBranch: async () => { throw new Error('Branch x does not exist on GitHub.') } })
    const res = await t.post('branch', { repoOwner: 'acme', repoName: 'site', branch: 'x' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('does not exist')
  })
})

describe('POST /projects/:id/github/authorize-url', () => {
  test('returns the short Shogo authorize link for this project and repo (no opaque state for the agent to copy)', async () => {
    const res = await app().post('authorize-url', { repoOwner: 'acme', repoName: 'site' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      available: true,
      url: 'https://studio.test/api/projects/p1/github/authorize?repo=acme%2Fsite',
    })
  })

  test('reports unavailable when the App OAuth flow is not configured, so only the token option is offered', async () => {
    expect(await (await app({ oauth: false }).post('authorize-url', { repoOwner: 'a', repoName: 'b' })).json()).toEqual({ ok: true, available: false })
    expect(await (await app({ github: false }).post('authorize-url', { repoOwner: 'a', repoName: 'b' })).json()).toEqual({ ok: true, available: false })
  })
})
