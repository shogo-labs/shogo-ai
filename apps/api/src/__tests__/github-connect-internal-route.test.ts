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

function app(opts: { authorized?: boolean; github?: boolean; oauth?: boolean; connect?: (args: any) => Promise<any> } = {}) {
  const connects: any[] = []
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
  return { post, connects }
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
