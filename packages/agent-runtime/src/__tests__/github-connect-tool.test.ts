// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `github_connect`: offers both ways to connect (authorize the Shogo GitHub
 * App, or share a token) and connects through the API with a shared token.
 *
 *   bun test packages/agent-runtime/src/__tests__/github-connect-tool.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const { createGitHubConnectTool, createTools, parseGitHubRepoRef } = await import('../gateway-tools')

const realFetch = globalThis.fetch
let requests: Array<{ url: string; body: any }> = []
let responses: Array<{ status: number; json: any }> = []

function ctx(extra: Record<string, unknown> = {}): any {
  return {
    workspaceDir: '/tmp/test-github-connect-tool',
    channels: new Map(),
    config: { heartbeatInterval: 1800, heartbeatEnabled: false, quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' }, channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } },
    projectId: 'proj-1',
    ...extra,
  }
}

beforeEach(() => {
  process.env.SHOGO_API_URL = 'http://api.test'
  requests = []
  responses = []
  globalThis.fetch = (async (url: any, init: any = {}) => {
    requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined })
    const next = responses.shift() ?? { status: 500, json: { error: 'unexpected request' } }
    return new Response(JSON.stringify(next.json), { status: next.status, headers: { 'Content-Type': 'application/json' } })
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.SHOGO_API_URL
})

describe('parseGitHubRepoRef', () => {
  test('accepts owner/name, github.com URLs, and SSH remotes', () => {
    expect(parseGitHubRepoRef('CodeGlo/shogo-website')).toEqual({ owner: 'CodeGlo', repo: 'shogo-website' })
    expect(parseGitHubRepoRef('https://github.com/CodeGlo/shogo-website.git')).toEqual({ owner: 'CodeGlo', repo: 'shogo-website' })
    expect(parseGitHubRepoRef('github.com/CodeGlo/shogo-website/tree/main')).toEqual({ owner: 'CodeGlo', repo: 'shogo-website' })
    expect(parseGitHubRepoRef('git@github.com:CodeGlo/shogo-website.git')).toEqual({ owner: 'CodeGlo', repo: 'shogo-website' })
    expect(parseGitHubRepoRef('https://gitlab.com/a/b')).toBeNull()
  })
})

describe('github_connect', () => {
  test('without a token, offers both the App authorization link and the token option', async () => {
    responses.push({ status: 200, json: { ok: true, available: true, url: 'https://github.com/apps/shogo/installations/new?state=s' } })
    const res = await createGitHubConnectTool(ctx()).execute('c1', { repo: 'CodeGlo/shogo-website' })
    const details = res.details as any
    expect(details.connected).toBe(false)
    expect(details.options.map((o: any) => o.option)).toEqual(['authorize_app', 'share_token'])
    expect(details.options[0].url).toBe('https://github.com/apps/shogo/installations/new?state=s')
    expect(requests[0].url).toBe('http://api.test/api/internal/projects/proj-1/github/authorize-url')
    expect(requests[0].body).toEqual({ repoOwner: 'CodeGlo', repoName: 'shogo-website' })
  })

  test('offers only the token option when the server cannot run the App flow', async () => {
    responses.push({ status: 200, json: { ok: true, available: false } })
    const res = await createGitHubConnectTool(ctx()).execute('c1', { repo: 'CodeGlo/shogo-website' })
    expect((res.details as any).options.map((o: any) => o.option)).toEqual(['share_token'])
  })

  test('with a shared token, connects through the API and reports what happened to the files', async () => {
    responses.push({
      status: 200,
      json: {
        ok: true,
        repoFullName: 'CodeGlo/shogo-website',
        defaultBranch: 'main',
        authType: 'token',
        login: 'russell',
        workspace: { ok: true, connect: 'adopted', branch: 'main', backupBranch: 'shogo/pre-connect-20261004T0900' },
      },
    })
    const res = await createGitHubConnectTool(ctx()).execute('c1', {
      repo: 'https://github.com/CodeGlo/shogo-website',
      token: ' gho_shared ',
      projectId: 'c6905dbb',
    })
    expect(requests[0].url).toBe('http://api.test/api/internal/projects/c6905dbb/github/connect')
    expect(requests[0].body).toEqual({ repoOwner: 'CodeGlo', repoName: 'shogo-website', token: 'gho_shared' })
    const details = res.details as any
    expect(details).toMatchObject({ ok: true, connected: 'CodeGlo/shogo-website', as: 'russell' })
    expect(details.files).toContain('checked out main')
    expect(details.files).toContain('shogo/pre-connect-20261004T0900')
    expect(JSON.stringify(details)).not.toContain('gho_shared')
  })

  test('surfaces a rejected token, and needs a project outside a project runtime', async () => {
    responses.push({ status: 400, json: { error: 'GitHub rejected the access token: Bad credentials' } })
    const bad = await createGitHubConnectTool(ctx()).execute('c1', { repo: 'a/b', token: 'nope' })
    expect((bad.details as any).error).toContain('Bad credentials')

    const noProject = await createGitHubConnectTool(ctx({ projectId: 'ws:abc' })).execute('c1', { repo: 'a/b' })
    expect((noProject.details as any).error).toContain('projectId')
    expect(((await createGitHubConnectTool(ctx()).execute('c1', { repo: 'not a repo' })).details as any).error).toContain('owner/name')
  })

  test('connecting with a token and a branch checks the branch out in the same call', async () => {
    responses.push({
      status: 200,
      json: {
        ok: true,
        repoFullName: 'CodeGlo/shogo-website',
        defaultBranch: 'main',
        authType: 'token',
        workspace: { ok: true, connect: 'adopted', branch: 'fix-404', techStackId: 'custom' },
      },
    })
    const res = await createGitHubConnectTool(ctx()).execute('c1', { repo: 'CodeGlo/shogo-website', token: 'gho_x', branch: ' fix-404 ' })
    expect(requests.map((r) => r.url)).toEqual(['http://api.test/api/internal/projects/proj-1/github/connect'])
    expect(requests[0].body).toEqual({ repoOwner: 'CodeGlo', repoName: 'shogo-website', token: 'gho_x', branch: 'fix-404' })
    expect(res.details).toMatchObject({ ok: true, branch: 'fix-404', techStack: 'custom', files: expect.stringContaining('checked out fix-404') })
  })

  test('with a branch and no token, switches an already-connected project without asking for credentials', async () => {
    responses.push({ status: 200, json: { ok: true, repoFullName: 'CodeGlo/shogo-website', branch: 'fix-404', techStackId: 'custom' } })
    const res = await createGitHubConnectTool(ctx()).execute('c1', { repo: 'CodeGlo/shogo-website', branch: 'fix-404' })
    expect(requests.map((r) => r.url)).toEqual(['http://api.test/api/internal/projects/proj-1/github/branch'])
    expect(requests[0].body).toEqual({ repoOwner: 'CodeGlo', repoName: 'shogo-website', branch: 'fix-404' })
    expect(res.details).toMatchObject({ ok: true, connected: 'CodeGlo/shogo-website', branch: 'fix-404', techStack: 'custom' })
  })

  test('with a branch on a project that is not connected, offers the ways to connect', async () => {
    responses.push({ status: 409, json: { error: { code: 'not_connected', message: 'not connected' } } })
    responses.push({ status: 200, json: { ok: true, available: true, url: 'https://studio.test/authorize' } })
    const res = await createGitHubConnectTool(ctx()).execute('c1', { repo: 'CodeGlo/shogo-website', branch: 'fix-404' })
    const details = res.details as any
    expect(details.connected).toBe(false)
    expect(details.options.map((o: any) => o.option)).toEqual(['authorize_app', 'share_token'])
    expect(details.next).toContain('branch "fix-404"')
  })

  test('reports a failed branch switch instead of asking to connect again', async () => {
    responses.push({ status: 400, json: { error: 'Branch nope does not exist on GitHub.' } })
    const res = await createGitHubConnectTool(ctx()).execute('c1', { repo: 'CodeGlo/shogo-website', branch: 'nope' })
    expect((res.details as any).error).toContain('does not exist')
    expect(requests.length).toBe(1)
  })

  test('when only the file checkout fails, says the token is fine and to retry', async () => {
    responses.push({
      status: 200,
      json: { ok: true, repoFullName: 'a/b', defaultBranch: 'main', workspace: { ok: false, error: 'runtime HTTP 401' } },
    })
    const res = await createGitHubConnectTool(ctx()).execute('c1', { repo: 'a/b', token: 'gho_x' })
    const details = res.details as any
    expect(details.files).toContain('not updated')
    expect(details.next).toContain('not a token problem')
  })

  test('in a workspace runtime, defaults to the project the runtime was opened for', async () => {
    process.env.WORKSPACE_ANCHOR_PROJECT_ID = 'proj-anchor'
    try {
      responses.push({ status: 200, json: { ok: true, repoFullName: 'a/b', branch: 'x' } })
      await createGitHubConnectTool(ctx({ projectId: 'ws:abc' })).execute('c1', { repo: 'a/b', branch: 'x' })
      expect(requests[0].url).toBe('http://api.test/api/internal/projects/proj-anchor/github/branch')
    } finally {
      delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    }
  })

  test('is registered in the default tool set', () => {
    expect(createTools(ctx()).some((t) => t.name === 'github_connect')).toBe(true)
  })
})
