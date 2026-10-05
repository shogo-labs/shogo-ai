// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `runtimeGitHubWorkspace`: forwards workspace git operations to the
 * project's runtime, re-resolving a stale route once when the runtime
 * rejects the request.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { runtimeGitHubWorkspace } from '../github-workspace'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function setup(statuses: number[]) {
  const calls: Array<{ url: string; token: string; body: any }> = []
  const drops: string[] = []
  let resolves = 0
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), token: init.headers['x-runtime-token'], body: JSON.parse(init.body) })
    const status = statuses.shift() ?? 500
    const body = status === 200 ? { ok: true, branch: 'main' } : { error: 'Unauthorized' }
    return new Response(JSON.stringify(body), { status })
  }) as any
  const workspace = runtimeGitHubWorkspace('p1', {
    resolveUrl: async () => `http://vm-${++resolves}`,
    runtimeToken: async () => 'wrt_v1_ws',
    dropCachedUrl: async (id) => { drops.push(id) },
  })
  return { workspace, calls, drops }
}

const input = { op: 'pull' as const, repoOwner: 'o', repoName: 'r', token: 'ghp_x' }

describe('runtimeGitHubWorkspace', () => {
  test('sends the op to the resolved runtime with the runtime token', async () => {
    const { workspace, calls, drops } = setup([200])
    expect(await workspace.run(input)).toEqual({ ok: true, branch: 'main' })
    expect(calls).toEqual([{ url: 'http://vm-1/agent/github/git', token: 'wrt_v1_ws', body: { projectId: 'p1', ...input } }])
    expect(drops).toEqual([])
  })

  test('on a 401, drops the cached route and retries once against a fresh resolve', async () => {
    const { workspace, calls, drops } = setup([401, 200])
    expect(await workspace.run(input)).toEqual({ ok: true, branch: 'main' })
    expect(drops).toEqual(['p1'])
    expect(calls.map((c) => c.url)).toEqual(['http://vm-1/agent/github/git', 'http://vm-2/agent/github/git'])
  })

  test('gives up after the retry with an error that does not blame the token', async () => {
    const { workspace, calls } = setup([401, 401])
    const result = await workspace.run(input)
    expect(calls.length).toBe(2)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP 401')
    expect(result.error).toContain('Try again shortly')
  })

  test('does not retry other failures', async () => {
    const { workspace, calls } = setup([500])
    expect((await workspace.run(input)).ok).toBe(false)
    expect(calls.length).toBe(1)
  })
})
