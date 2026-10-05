// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-call integration credentials: what a tool call needs, and the wrapper
 * that resolves it.
 *
 *   bun test packages/agent-runtime/src/__tests__/integration-credentials.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  classifyGitHubShellOp,
  clearCredentialPolicyCache,
  composioToolOp,
  toolCredentialMeta,
  withIntegrationCredentials,
} from '../integration-credentials'
import { currentCredentialScope } from '../credential-scope'
import { getInternalHeaders } from '../internal-api'

describe('classifyGitHubShellOp', () => {
  test.each([
    ['gh issue create --title "Broken login"', 'write'],
    ['gh pr comment 12 --body hi', 'write'],
    ['gh pr merge 12 --squash', 'write'],
    ['gh release create v1.0.0', 'write'],
    ['gh api repos/a/b/issues -X POST -f title=x', 'write'],
    ['gh api repos/a/b/issues --method PATCH', 'write'],
    ['gh api repos/a/b/issues -f title=x', 'write'],
    ['git push origin main', 'write'],
    ['npm test && git push', 'write'],
    ['curl -H "Authorization: token $GH_TOKEN" https://example.com', 'write'],
    ['curl https://api.github.com/repos/a/b/issues', 'write'],
    ['gh issue list', 'read'],
    ['gh pr view 12', 'read'],
    ['gh api repos/a/b/issues', 'read'],
    ['git fetch origin', 'read'],
    ['git pull', 'read'],
    ['ls -la', 'none'],
    ['git status', 'none'],
    ['git commit -m "gh issue create"', 'write'],
    ['bun test', 'none'],
  ])('%s -> %s', (command, op) => {
    expect(classifyGitHubShellOp(command)).toBe(op as any)
  })
})

describe('composioToolOp', () => {
  test('uses catalog hints first, then the slug verb', () => {
    expect(composioToolOp('GMAIL_SEND_EMAIL', ['readOnlyHint'])).toBe('read')
    expect(composioToolOp('GMAIL_FETCH_EMAILS', ['destructiveHint'])).toBe('write')
    expect(composioToolOp('GMAIL_FETCH_EMAILS', undefined)).toBe('read')
    expect(composioToolOp('LINEAR_LIST_ISSUES', [])).toBe('read')
    expect(composioToolOp('GITHUB_GET_A_REPOSITORY', [])).toBe('read')
    expect(composioToolOp('LINEAR_CREATE_ISSUE', [])).toBe('write')
    expect(composioToolOp('SLACK_SENDS_A_MESSAGE', [])).toBe('write')
  })
})

describe('toolCredentialMeta', () => {
  const tool = (name: string, extra: Record<string, unknown> = {}) =>
    ({ name, label: name, description: '', parameters: {}, execute: async () => ({ content: [], details: {} }), ...extra }) as any

  test('declared metadata wins; exec is classified per command; other tools need nothing', () => {
    expect(toolCredentialMeta(tool('LINEAR_CREATE_ISSUE', { credential: { provider: 'composio:linear', op: 'write' } }), {}))
      .toEqual({ provider: 'composio:linear', op: 'write' })
    expect(toolCredentialMeta(tool('exec'), { command: 'gh issue create' })).toEqual({ provider: 'github', op: 'write' })
    expect(toolCredentialMeta(tool('exec'), { command: 'gh issue list' })).toEqual({ provider: 'github', op: 'read' })
    expect(toolCredentialMeta(tool('exec'), { command: 'ls' })).toBeNull()
    expect(toolCredentialMeta(tool('read_file'), { path: 'x' })).toBeNull()
  })
})

describe('withIntegrationCredentials', () => {
  const realFetch = globalThis.fetch
  let requests: Array<{ url: string; headers: Record<string, string>; body: any }> = []
  let policies: any[] = []
  let resolveResult: any = null

  beforeEach(() => {
    process.env.SHOGO_API_URL = 'http://api.test'
    requests = []
    policies = []
    resolveResult = null
    clearCredentialPolicyCache()
    globalThis.fetch = (async (url: any, init: any = {}) => {
      requests.push({ url: String(url), headers: { ...(init.headers ?? {}) }, body: init.body ? JSON.parse(init.body) : undefined })
      const json = String(url).endsWith('/integrations/policies') ? { ok: true, policies } : resolveResult
      return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    delete process.env.SHOGO_API_URL
  })

  function probe(extra: Record<string, unknown> = {}) {
    let seen: any
    let headers: Record<string, string> = {}
    const tool = {
      name: 'probe',
      label: 'probe',
      description: '',
      parameters: {},
      credential: { provider: 'github', op: 'write' },
      execute: async () => {
        seen = currentCredentialScope()
        headers = getInternalHeaders()
        return { content: [{ type: 'text', text: 'ran' }], details: { ran: true } }
      },
      ...extra,
    } as any
    return { tool, seen: () => seen, headers: () => headers }
  }

  test('without a policy, runs the tool in a scope that carries the ticket, with no lookup', async () => {
    const p = probe()
    const res = await withIntegrationCredentials(p.tool, { projectId: 'p1', requesterTicket: 'tkt' }).execute('c', {})
    expect(res.details).toEqual({ ran: true })
    expect(p.seen()).toEqual({ requesterTicket: 'tkt' })
    expect(p.headers()['X-Requester-Ticket']).toBe('tkt')
    expect(requests.map((r) => r.url)).toEqual(['http://api.test/api/internal/projects/p1/integrations/policies'])
  })

  test('requester policy: puts the resolved token in the shell env and sends the ticket to the resolver', async () => {
    policies = [{ provider: 'github', writeMode: 'requester', readMode: 'shared', fallback: 'ask', sharedUserId: null }]
    resolveResult = { ok: true, source: 'personal', actingAs: '@bob', credential: { token: 'gho_bob', name: 'bob', email: 'b@x' } }
    const p = probe()
    await withIntegrationCredentials(p.tool, { projectId: 'p1', requesterTicket: 'tkt' }).execute('c', {})
    expect(requests[1]).toMatchObject({
      url: 'http://api.test/api/internal/projects/p1/integrations/resolve',
      body: { provider: 'github', op: 'write' },
    })
    expect(requests[1]!.headers['X-Requester-Ticket']).toBe('tkt')
    expect(p.seen().githubEnv).toMatchObject({ GH_TOKEN: 'gho_bob', GIT_AUTHOR_NAME: 'bob', GIT_AUTHOR_EMAIL: 'b@x' })
    expect(p.seen().actingAs).toBe('@bob')
  })

  test('a read under a write-only requester policy is not looked up', async () => {
    policies = [{ provider: 'github', writeMode: 'requester', readMode: 'shared', fallback: 'ask', sharedUserId: null }]
    const p = probe({ credential: { provider: 'github', op: 'read' } })
    await withIntegrationCredentials(p.tool, { projectId: 'p1' }).execute('c', {})
    expect(requests).toHaveLength(1)
  })

  test('blocked: returns the connect link without running the tool, and tells the chat UI', async () => {
    policies = [{ provider: 'github', writeMode: 'requester', readMode: 'shared', fallback: 'ask', sharedUserId: null }]
    resolveResult = { ok: false, code: 'requester_auth_required', message: 'connect first', connectUrl: 'https://studio.test/c' }
    const ui: any[] = []
    const p = probe()
    const res = await withIntegrationCredentials(p.tool, { projectId: 'p1', requesterTicket: 't', uiWriter: { write: (c) => ui.push(c) } })
      .execute('c', {})
    expect(p.seen()).toBeUndefined()
    expect(res.details).toMatchObject({ code: 'requester_auth_required', connectUrl: 'https://studio.test/c', provider: 'github' })
    expect(ui).toEqual([
      { type: 'data-integration-auth-required', data: { provider: 'github', connectUrl: 'https://studio.test/c', message: 'connect first' } },
    ])
  })

  test('Composio: the default needs no lookup; a shared policy pins the entity', async () => {
    const tool = (provider: string) => probe({ credential: { provider, op: 'write' } })
    const unpinned = tool('composio:gmail')
    await withIntegrationCredentials(unpinned.tool, { projectId: 'p1' }).execute('c', {})
    expect(unpinned.seen().composioEntityId).toBeUndefined()

    clearCredentialPolicyCache()
    requests = []
    policies = [{ provider: 'composio:gmail', writeMode: 'shared', readMode: 'shared', fallback: 'ask', sharedUserId: 'alice' }]
    resolveResult = { ok: true, source: 'shared', actingAs: 'project account', credential: { entityId: 'shogo_alice_ws1' } }
    const pinned = tool('composio:gmail')
    await withIntegrationCredentials(pinned.tool, { projectId: 'p1' }).execute('c', {})
    expect(pinned.seen().composioEntityId).toBe('shogo_alice_ws1')
  })

  test('workspace (non-project) runtimes never look anything up', async () => {
    const p = probe()
    await withIntegrationCredentials(p.tool, { projectId: 'ws:abc', requesterTicket: 't' }).execute('c', {})
    expect(requests).toEqual([])
    expect(p.seen()).toEqual({ requesterTicket: 't' })
  })
})
