// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Internal route behind the agent's `github_merge_pr` tool: merges with the
 * project's GitHub App connection and says plainly when there isn't one.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { runtimeInternalRoutes } from '../routes/internal-runtime-routes'

type Merge = { installationId: number; repoOwner: string; repoName: string; number: number; method?: string; commitTitle?: string }

function app(opts: { connection?: any; merge?: (m: Merge) => Promise<any>; authorized?: boolean; github?: boolean } = {}) {
  const merges: Merge[] = []
  const routes = runtimeInternalRoutes({
    authenticate: async () => (opts.authorized === false ? null : ({ kind: 'sa' } as any)),
    saveAgentAvatar: async () => ({}) as any,
    metalWorkspaceMember: (async () => null) as any,
    ...(opts.github === false
      ? {}
      : {
          loadGitHub: async () => ({
            getConnection: async () => opts.connection ?? null,
            mergePullRequest: async (m: Merge) => {
              merges.push(m)
              return opts.merge ? opts.merge(m) : { merged: true, sha: 'abc123' }
            },
          }) as any,
        }),
  } as any)
  const root = new Hono()
  root.route('/api/internal', routes)
  const post = (path: string, body?: unknown) =>
    root.request(`/api/internal/projects/p1/github/pull-request/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { post, merges }
}

const connection = { installationId: 77, repoOwner: 'acme', repoName: 'shop', defaultBranch: 'main' }

describe('POST /projects/:id/github/pull-request/:number/merge', () => {
  test('merges with the App installation, squashing by default', async () => {
    const t = app({ connection })
    const res = await t.post('12/merge', {})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, merged: true, sha: 'abc123' })
    expect(t.merges).toEqual([{ installationId: 77, repoOwner: 'acme', repoName: 'shop', number: 12, method: 'squash', commitTitle: undefined }])
  })

  test('passes a chosen method and commit title; unknown methods fall back to squash', async () => {
    const t = app({ connection })
    await t.post('3/merge', { method: 'rebase', commitTitle: '  Fix totals  ' })
    await t.post('4/merge', { method: 'fast-forward' })
    expect(t.merges.map((m) => [m.number, m.method, m.commitTitle])).toEqual([[3, 'rebase', 'Fix totals'], [4, 'squash', undefined]])
  })

  test('without a GitHub App connection it answers 409 so the tool can fall back to a token', async () => {
    const none = await app({ connection: null }).post('12/merge', {})
    expect(none.status).toBe(409)
    expect((await none.json()).error.code).toBe('github_app_not_installed')
    const slim = await app({ github: false }).post('12/merge', {})
    expect(slim.status).toBe(409)
  })

  test('rejects bad numbers and unauthenticated callers, and surfaces GitHub refusing the merge', async () => {
    expect((await app({ connection }).post('abc/merge', {})).status).toBe(400)
    expect((await app({ connection }).post('0/merge', {})).status).toBe(400)
    expect((await app({ connection, authorized: false }).post('12/merge', {})).status).toBe(401)
    const refused = await app({ connection, merge: async () => { throw new Error('Failed to merge pull request: Pull Request is not mergeable') } }).post('12/merge', {})
    expect(refused.status).toBe(502)
    expect((await refused.json()).error).toContain('not mergeable')
  })
})
