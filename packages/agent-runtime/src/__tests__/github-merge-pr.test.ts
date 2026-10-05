// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `github_merge_pr`: merges through the Shogo GitHub App (falling back to the
 * workspace GITHUB_TOKEN) and asks a person first by default.
 *
 *   bun test packages/agent-runtime/src/__tests__/github-merge-pr.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { createGitHubMergePullRequestTool, createTools } = await import('../gateway-tools')
const { PermissionEngine, DEFAULT_CLOUD_SECURITY_PREFERENCE } = await import('../permission-engine')

const DIR = '/tmp/test-github-merge-pr'
const realFetch = globalThis.fetch
let requests: Array<{ url: string; method: string; body: any; auth?: string }> = []
let responses: Array<{ status: number; json: any }> = []

function ctx(extra: Record<string, unknown> = {}): any {
  return {
    workspaceDir: DIR,
    channels: new Map(),
    config: { heartbeatInterval: 1800, heartbeatEnabled: false, quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' }, channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } },
    projectId: 'proj-1',
    ...extra,
  }
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  execSync('git init -q && git remote add origin https://github.com/acme/shop.git', { cwd: DIR })
  process.env.SHOGO_API_URL = 'http://api.test'
  delete process.env.GITHUB_TOKEN
  requests = []
  responses = []
  globalThis.fetch = (async (url: any, init: any = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization })
    const next = responses.shift() ?? { status: 500, json: { error: 'unexpected request' } }
    return new Response(JSON.stringify(next.json), { status: next.status, headers: { 'Content-Type': 'application/json' } })
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.SHOGO_API_URL
  rmSync(DIR, { recursive: true, force: true })
})

describe('github_merge_pr', () => {
  test('merges through the GitHub App, squashing by default', async () => {
    responses.push({ status: 200, json: { ok: true, merged: true, sha: 'abc123' } })
    const res = await createGitHubMergePullRequestTool(ctx()).execute('c1', { number: 12 })
    expect(res.details).toMatchObject({ ok: true, mode: 'github-app', merged: true, number: 12, sha: 'abc123' })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('http://api.test/api/internal/projects/proj-1/github/pull-request/12/merge')
    expect(requests[0].body.method).toBe('squash')
  })

  test('without a GitHub App it merges with the workspace token', async () => {
    writeFileSync(join(DIR, '.env'), 'GITHUB_TOKEN=ghp_test\n')
    responses.push({ status: 409, json: { error: { code: 'github_app_not_installed', message: 'no app' } } })
    responses.push({ status: 200, json: { merged: true, sha: 'def456' } })
    const res = await createGitHubMergePullRequestTool(ctx()).execute('c1', { number: 7, method: 'rebase', commitTitle: 'Fix totals' })
    expect(res.details).toMatchObject({ ok: true, mode: 'user-token', merged: true, number: 7, sha: 'def456' })
    expect(requests[1].url).toBe('https://api.github.com/repos/acme/shop/pulls/7/merge')
    expect(requests[1].method).toBe('PUT')
    expect(requests[1].auth).toBe('Bearer ghp_test')
    expect(requests[1].body).toEqual({ merge_method: 'rebase', commit_title: 'Fix totals' })
  })

  test('reports why a merge was refused instead of claiming success', async () => {
    responses.push({ status: 502, json: { error: 'Failed to merge pull request' } })
    const refused = await createGitHubMergePullRequestTool(ctx()).execute('c1', { number: 3 })
    expect((refused.details as any).error).toContain('Failed to merge')

    responses.push({ status: 409, json: { error: { code: 'github_app_not_installed', message: 'x' } } })
    responses.push({ status: 405, json: { message: 'Pull Request is not mergeable' } })
    process.env.GITHUB_TOKEN = 'ghp_env'
    const blocked = await createGitHubMergePullRequestTool(ctx()).execute('c1', { number: 3 })
    expect((blocked.details as any).error).toBe('Pull Request is not mergeable')
    delete process.env.GITHUB_TOKEN

    expect(((await createGitHubMergePullRequestTool(ctx()).execute('c1', { number: 0 })).details as any).error).toContain('number')
  })
})

describe('as registered', () => {
  test('is part of the default tool set and asks a person when an ask rule is set', async () => {
    const events: any[] = []
    const engine = new PermissionEngine({
      preference: { ...DEFAULT_CLOUD_SECURITY_PREFERENCE, overrides: { actions: { github_merge_pr: 'ask' } } },
      workspaceDir: DIR,
      actionsOnly: true,
      sendSseEvent: (e) => events.push(e),
    })
    const tool = createTools(ctx({ permissionEngine: engine })).find((t) => t.name === 'github_merge_pr')!
    expect(tool).toBeDefined()

    responses.push({ status: 200, json: { ok: true, merged: true, sha: 'abc' } })
    const run = tool.execute('c1', { number: 12 })
    await new Promise((r) => setTimeout(r, 0))
    expect(requests).toHaveLength(0)
    expect(events[0].data).toMatchObject({ toolName: 'github_merge_pr', params: { number: 12 } })
    engine.handleApprovalResponse({ id: events[0].data.id, decision: 'allow_once' })
    expect(((await run).details as any).merged).toBe(true)
    expect(requests).toHaveLength(1)
  })

  test('a block rule stops it before any request is made', async () => {
    const engine = new PermissionEngine({
      preference: { mode: 'full_autonomy', overrides: { actions: { github_merge_pr: 'block' } } },
      workspaceDir: DIR,
      actionsOnly: true,
    })
    const tool = createTools(ctx({ permissionEngine: engine })).find((t) => t.name === 'github_merge_pr')!
    const res = await tool.execute('c1', { number: 12 })
    expect((res.details as any).error).toContain('never run')
    expect(requests).toHaveLength(0)
  })
})
