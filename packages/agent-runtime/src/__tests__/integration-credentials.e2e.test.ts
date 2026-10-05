// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Acts as the person who asked", end to end: the real API (internal runtime
 * routes, policy + consent routes, the GitHub OAuth callback) on a real
 * database behind a real HTTP server, and the real agent-runtime tools
 * (`exec`, `github_create_pr`) calling it through the credential wrapper the
 * gateway puts around every tool. Only GitHub itself is faked; it records
 * which token every call used.
 *
 *   bun test packages/agent-runtime/src/__tests__/integration-credentials.e2e.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { execSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setupChannelsTestDb, seedWorkspace, type SeededWorkspace } from '../../../../apps/api/src/__tests__/helpers/channels-test-db'

setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET = 'e2e-secret'
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.GH_APP_ID = '12345'
process.env.GH_APP_PRIVATE_KEY = 'unused-in-these-flows'
process.env.GH_APP_CLIENT_ID = 'Iv1.client'
process.env.GH_APP_CLIENT_SECRET = 'client-secret'
process.env.SHOGO_PUBLIC_API_URL = 'https://studio.test'
delete process.env.RUNTIME_AUTH_SECRET

const { prisma } = await import('../../../../apps/api/src/lib/prisma')
const { encryptSecret } = await import('../../../../apps/api/src/lib/secret-crypto')
const { signRequesterTicket } = await import('../../../../apps/api/src/lib/requester-ticket')
const { runtimeInternalRoutes } = await import('../../../../apps/api/src/routes/internal-runtime-routes')
const { integrationCredentialRoutes } = await import('../../../../apps/api/src/routes/integration-credentials')
const { githubRoutes } = await import('../../../../apps/api/src/routes/github')
const { createTools } = await import('../gateway-tools')
const { createIntegrationCredentialWrapper, clearCredentialPolicyCache } = await import(
  '../integration-credentials'
)
const { clearGitHubCliEnvCache } = await import('../github-cli-credentials')

const db = prisma as any
const loadGitHub = () => import('../../../../apps/api/src/services/github.service')

// ---------------------------------------------------------------------------
// Fake GitHub
// ---------------------------------------------------------------------------

const GITHUB_USERS: Record<string, { id: number; login: string; name: string }> = {
  ghs_shared: { id: 1, login: 'acme-shared', name: 'Acme Shared' },
  gho_bob_1: { id: 202, login: 'bob-gh', name: 'Bob' },
  gho_bob_2: { id: 202, login: 'bob-gh', name: 'Bob' },
}

interface GitHubCall { method: string; path: string; token: string | null; body: any }
let githubCalls: GitHubCall[] = []
let prNumber = 0

const realFetch = globalThis.fetch
async function fakeGitHub(url: URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  const token = headers.get('authorization')?.replace(/^(Bearer|token)\s+/i, '') ?? null
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  githubCalls.push({ method, path: `${url.host}${url.pathname}`, token, body })
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.host === 'github.com' && url.pathname === '/login/oauth/access_token') {
    if (body?.code === 'bob-code') {
      return json({ access_token: 'gho_bob_1', refresh_token: 'ghr_bob_1', expires_in: 28800, refresh_token_expires_in: 15_897_600, scope: '' })
    }
    if (body?.grant_type === 'refresh_token' && body?.refresh_token === 'ghr_bob_1') {
      return json({ access_token: 'gho_bob_2', refresh_token: 'ghr_bob_2', expires_in: 28800, refresh_token_expires_in: 15_897_600, scope: '' })
    }
    return json({ error: 'bad_verification_code' })
  }
  if (url.host === 'api.github.com' && url.pathname === '/user' && method === 'GET') {
    const user = token ? GITHUB_USERS[token] : undefined
    return user ? json(user) : json({ message: 'Bad credentials' }, 401)
  }
  if (url.host === 'api.github.com' && url.pathname === '/repos/acme/site/pulls' && method === 'POST') {
    if (!token || !GITHUB_USERS[token]) return json({ message: 'Bad credentials' }, 401)
    prNumber += 1
    return json({ number: prNumber, html_url: `https://github.com/acme/site/pull/${prNumber}`, url: `https://api.github.com/repos/acme/site/pulls/${prNumber}` }, 201)
  }
  return json({ message: `fake GitHub: no route for ${method} ${url.pathname}` }, 404)
}

globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.host === 'github.com' || url.host === 'api.github.com') return fakeGitHub(url, init)
  return realFetch(input, init)
}) as typeof fetch

// ---------------------------------------------------------------------------
// The API, served for real
// ---------------------------------------------------------------------------

const root = new Hono()
// Stands in for the session middleware: the browser's signed-in user.
root.use('/api/*', async (c, next) => {
  const userId = c.req.header('x-test-user')
  if (userId) c.set('auth' as never, { userId, via: 'session' } as never)
  await next()
})
root.route(
  '/api/internal',
  runtimeInternalRoutes({
    authenticate: async () => ({ kind: 'sa' }) as any,
    saveAgentAvatar: async () => ({}) as any,
    metalWorkspaceMember: (async () => null) as any,
    loadGitHub,
  } as any),
)
root.route('/api', integrationCredentialRoutes({ loadGitHub }))
root.route('/api', githubRoutes())

const server = Bun.serve({ port: 0, fetch: root.fetch })
const API = `http://127.0.0.1:${server.port}`
process.env.SHOGO_API_URL = API

// ---------------------------------------------------------------------------
// The runtime: the project's workspace and its tools, as one turn sees them
// ---------------------------------------------------------------------------

let seeded: SeededWorkspace
let alice: string // workspace owner; sets the policy
let bob: string // workspace member who reports issues to the agent
let workspaceDir: string

/** Writes the token and author it ran with, so the test sees exactly what `gh` got. */
function installFakeGhCli(dir: string): void {
  const bin = join(dir, '.fake-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh $1 $2 token=${GH_TOKEN:-none} author=${GIT_AUTHOR_NAME:-none}"\n')
  chmodSync(join(bin, 'gh'), 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`
}

function turnTools(requesterUserId: string | null, opts: { projectId?: string; ui?: any[] } = {}) {
  const projectId = opts.projectId ?? seeded.projectId
  const ticket = requesterUserId ? signRequesterTicket({ projectId, userId: requesterUserId }) : undefined
  const wrap = createIntegrationCredentialWrapper({
    projectId: seeded.projectId,
    requesterTicket: ticket,
    uiWriter: opts.ui ? { write: (chunk) => opts.ui!.push(chunk) } : undefined,
  })
  const tools = createTools({
    workspaceDir,
    channels: new Map(),
    config: { heartbeatInterval: 1800, heartbeatEnabled: false, quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' }, channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } },
    projectId: seeded.projectId,
    sessionId: 'chat',
    ...(ticket ? { requesterTicket: ticket } : {}),
  } as any).map(wrap)
  const get = (name: string) => tools.find((t) => t.name === name)!
  return {
    createPr: async (title: string) => (await get('github_create_pr').execute('call', { title })).details as any,
    exec: async (command: string) => {
      const res = await get('exec').execute('call', { command, timeout: 20_000 })
      return { details: res.details as any, text: res.content.map((c: any) => c.text ?? '').join('\n') }
    },
  }
}

async function browser(userId: string, path: string, init: RequestInit = {}) {
  return realFetch(`${API}${path}`, { redirect: 'manual', ...init, headers: { 'x-test-user': userId, ...(init.headers ?? {}) } })
}

async function setPolicy(by: string, body: Record<string, unknown>) {
  const res = await browser(by, `/api/projects/${seeded.projectId}/integrations/policies/github`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  clearCredentialPolicyCache()
}

/** Bob follows the connect link the agent gave him: consent page, Allow, GitHub, back to Shogo. */
async function connectThroughLink(userId: string, connectUrl: string, code: string): Promise<string> {
  const path = new URL(connectUrl).pathname
  const consent = await browser(userId, path)
  expect(consent.status).toBe(200)
  const html = await consent.text()
  expect(html).toContain('act as you on GitHub')
  const state = html.match(/name="state" value="([^"]+)"/)![1]!

  const allow = await browser(userId, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state }).toString(),
  })
  expect(allow.status).toBe(302)
  const authorize = new URL(allow.headers.get('location')!)
  expect(`${authorize.origin}${authorize.pathname}`).toBe('https://github.com/login/oauth/authorize')
  expect(authorize.searchParams.get('redirect_uri')).toBe('https://studio.test/api/github/callback')

  // GitHub redirects the browser back with a code and the same state.
  const callback = await realFetch(
    `${API}/api/github/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
    { redirect: 'manual' },
  )
  return callback.text()
}

beforeAll(async () => {
  seeded = await seedWorkspace(db)
  alice = seeded.owner
  bob = seeded.member
  await db.gitHubConnection.create({
    data: {
      projectId: seeded.projectId,
      repoOwner: 'acme',
      repoName: 'site',
      repoFullName: 'acme/site',
      authType: 'token',
      encryptedToken: encryptSecret('ghs_shared'),
      tokenLogin: 'acme-shared',
    },
  })
  workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-acts-as-'))
  execSync('git init -q -b fix-login && git remote add origin https://github.com/acme/site.git', { cwd: workspaceDir })
  // A personal token left in the workspace must never stand in for the requester's own.
  writeFileSync(join(workspaceDir, '.env'), 'GITHUB_TOKEN=ghp_env_fallback\n')
  installFakeGhCli(workspaceDir)
})

afterAll(() => {
  server.stop(true)
  globalThis.fetch = realFetch
})

beforeEach(() => {
  githubCalls = []
  clearCredentialPolicyCache()
  clearGitHubCliEnvCache()
})

const prCalls = () => githubCalls.filter((c) => c.method === 'POST' && c.path === 'api.github.com/repos/acme/site/pulls')

// ---------------------------------------------------------------------------

describe('acts as the person who asked (GitHub)', () => {
  test('with no policy, everyone uses the shared project account (unchanged behavior)', async () => {
    const pr = await turnTools(bob).createPr('Fix login')
    expect(pr).toMatchObject({ ok: true, mode: 'user-token', author: 'acme-shared' })
    expect(prCalls().map((c) => c.token)).toEqual(['ghs_shared'])

    const { text } = await turnTools(bob).exec('gh issue create --title x')
    expect(text).toContain('token=ghs_shared')
  })

  test('an admin switches writes to the requester; unconnected people get a connect link instead of a write', async () => {
    await setPolicy(alice, { writeMode: 'requester', fallback: 'ask' })

    const ui: any[] = []
    const pr = await turnTools(bob, { ui }).createPr('Fix login')
    expect(pr.code).toBe('requester_auth_required')
    expect(pr.connectUrl).toBe(`https://studio.test/api/projects/${seeded.projectId}/integrations/github/connect`)
    expect(prCalls()).toEqual([]) // neither the shared token nor the workspace .env token was used

    const shell = await turnTools(bob, { ui }).exec('gh issue create --title "Login is broken"')
    expect(shell.details.code).toBe('requester_auth_required')
    expect(shell.text).not.toContain('token=')
    expect(ui.map((e) => e.type)).toContain('data-integration-auth-required')
    expect(ui[0].data).toMatchObject({ provider: 'github', connectUrl: pr.connectUrl })

    // Reads don't stop for a connect prompt: they keep using the project account.
    const read = await turnTools(bob).exec('gh issue list')
    expect(read.text).toContain('token=ghs_shared')
  })

  test('after connecting through the link, Bob\'s writes run as Bob', async () => {
    const pr = await turnTools(bob).createPr('Fix login')
    const html = await connectThroughLink(bob, pr.connectUrl, 'bob-code')
    expect(html).toContain('GitHub connected as @bob-gh')

    const stored = await db.userIntegrationConnection.findUnique({ where: { userId_provider: { userId: bob, provider: 'github' } } })
    expect(stored.externalLogin).toBe('bob-gh')
    expect(stored.encryptedAccessToken).not.toContain('gho_bob_1')
    expect(await db.userIntegrationGrant.count({ where: { userId: bob, projectId: seeded.projectId, revokedAt: null } })).toBe(1)

    githubCalls = []
    const retry = await turnTools(bob).createPr('Fix login')
    expect(retry).toMatchObject({ ok: true, mode: 'requester', author: 'bob-gh' })
    expect(prCalls().map((c) => c.token)).toEqual(['gho_bob_1'])

    const shell = await turnTools(bob).exec('gh issue create --title "Login is broken"')
    expect(shell.text).toContain('token=gho_bob_1 author=bob-gh')
  })

  test('the same agent, asked by Alice in the next turn, does not borrow Bob\'s account', async () => {
    const pr = await turnTools(alice).createPr('Alice change')
    expect(pr.code).toBe('requester_auth_required')
    expect(prCalls()).toEqual([])
    const shell = await turnTools(alice).exec('gh issue create --title x')
    expect(shell.text).not.toContain('gho_bob')
  })

  test('turns no person started (heartbeats, webhooks) and forged tickets are refused, without a connect link', async () => {
    const heartbeat = await turnTools(null).createPr('Scheduled')
    expect(heartbeat.code).toBe('requester_unknown')
    expect(heartbeat.connectUrl).toBeUndefined()

    // A ticket minted for another project doesn't identify anyone here.
    const forged = await turnTools(bob, { projectId: seeded.foreignProjectId }).createPr('Forged')
    expect(forged.code).toBe('requester_unknown')

    // Nor does a hand-written header claiming to be Bob.
    const res = await realFetch(`${API}/api/internal/projects/${seeded.projectId}/integrations/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requester-Ticket': `${bob}.not-a-signature`, 'X-User-Id': bob },
      body: JSON.stringify({ provider: 'github', op: 'write' }),
    })
    expect((await res.json()).code).toBe('requester_unknown')
    expect(prCalls()).toEqual([])
  })

  test('an expired personal token is refreshed and the new one is stored', async () => {
    await db.userIntegrationConnection.update({
      where: { userId_provider: { userId: bob, provider: 'github' } },
      data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) },
    })
    const pr = await turnTools(bob).createPr('After expiry')
    expect(pr).toMatchObject({ ok: true, author: 'bob-gh' })
    expect(githubCalls.some((c) => c.path === 'github.com/login/oauth/access_token' && c.body?.grant_type === 'refresh_token')).toBe(true)
    expect(prCalls().map((c) => c.token)).toEqual(['gho_bob_2'])
    const stored = await db.userIntegrationConnection.findUnique({ where: { userId_provider: { userId: bob, provider: 'github' } } })
    expect(new Date(stored.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  test('fallback "shared" lets unconnected people use the project account; "deny" refuses', async () => {
    await setPolicy(alice, { fallback: 'shared' })
    expect(await turnTools(alice).createPr('Via shared')).toMatchObject({ ok: true, author: 'acme-shared' })
    expect(await turnTools(bob).createPr('Still Bob')).toMatchObject({ ok: true, author: 'bob-gh' })

    await setPolicy(alice, { fallback: 'deny' })
    const denied = await turnTools(alice).createPr('Denied')
    expect(denied.code).toBe('denied')
    expect(denied.connectUrl).toBeUndefined()
    // With deny, even reads need the person's own account.
    await setPolicy(alice, { readMode: 'requester' })
    expect((await turnTools(alice).exec('gh issue list')).details.code).toBe('denied')
    expect((await turnTools(bob).exec('gh issue list')).text).toContain('token=gho_bob_2')
    await setPolicy(alice, { readMode: 'shared', fallback: 'ask' })
  })

  test('the settings endpoint shows the policy and the caller\'s own connections', async () => {
    const res = await browser(bob, `/api/projects/${seeded.projectId}/integrations/policies`)
    const body = await res.json()
    expect(body.policies.find((p: any) => p.provider === 'github')).toMatchObject({
      writeMode: 'requester',
      fallback: 'ask',
      label: 'GitHub',
      supportsPersonal: true,
    })
    expect(body.me.connections).toEqual([expect.objectContaining({ provider: 'github', externalLogin: 'bob-gh' })])
    expect(body.me.grants).toHaveLength(1)
    expect(JSON.stringify(body)).not.toContain('gho_bob')
  })

  test('revoking the project\'s access stops it acting as Bob; the link brings it back without a new GitHub login', async () => {
    const mine = await (await browser(bob, '/api/me/integrations')).json()
    const grant = mine.grants.find((g: any) => g.projectId === seeded.projectId)
    expect((await browser(bob, `/api/me/integrations/grants/${grant.id}`, { method: 'DELETE' })).status).toBe(200)

    const blocked = await turnTools(bob).createPr('After revoke')
    expect(blocked.code).toBe('requester_auth_required')

    // Already connected: Allow just re-grants, no trip to GitHub.
    const path = new URL(blocked.connectUrl).pathname
    const html = await (await browser(bob, path)).text()
    expect(html).toContain('>Allow<')
    const state = html.match(/name="state" value="([^"]+)"/)![1]!
    const allow = await browser(bob, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state }).toString(),
    })
    expect(allow.status).toBe(200)
    expect(await turnTools(bob).createPr('Back')).toMatchObject({ ok: true, author: 'bob-gh' })
  })

  test('the consent form only works for the person it was shown to', async () => {
    const path = `/api/projects/${seeded.projectId}/integrations/github/connect`
    const html = await (await browser(bob, path)).text()
    const state = html.match(/name="state" value="([^"]+)"/)![1]!
    const asAlice = await browser(alice, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state }).toString(),
    })
    expect(asAlice.status).toBe(400)
    expect(await db.userIntegrationGrant.count({ where: { userId: alice } })).toBe(0)
  })

  test('disconnecting removes the account and every grant for it', async () => {
    expect((await browser(bob, '/api/me/integrations/github', { method: 'DELETE' })).status).toBe(200)
    expect(await db.userIntegrationConnection.count({ where: { userId: bob } })).toBe(0)
    expect(await db.userIntegrationGrant.count({ where: { userId: bob, revokedAt: null } })).toBe(0)
    expect((await turnTools(bob).createPr('Gone')).code).toBe('requester_auth_required')
  })
})

describe('the same policy on Composio', () => {
  test('"shared" pins every requester to the account owner\'s entity; default stays per requester', async () => {
    const resolve = async (userId: string, provider: string, op: 'read' | 'write') =>
      (await realFetch(`${API}/api/internal/projects/${seeded.projectId}/integrations/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requester-Ticket': signRequesterTicket({ projectId: seeded.projectId, userId }) },
        body: JSON.stringify({ provider, op }),
      })).json()

    const res = await browser(alice, `/api/projects/${seeded.projectId}/integrations/policies/composio:gmail`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writeMode: 'shared', readMode: 'shared', sharedIsMe: true }),
    })
    expect(res.status).toBe(200)
    const shared = await resolve(bob, 'composio:gmail', 'write')
    expect(shared).toMatchObject({ ok: true, source: 'shared' })
    expect(shared.credential.entityId).toContain(alice)

    await browser(alice, `/api/projects/${seeded.projectId}/integrations/policies/composio:gmail`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writeMode: 'requester', readMode: 'requester' }),
    })
    const personal = await resolve(bob, 'composio:gmail', 'write')
    expect(personal).toMatchObject({ ok: true, source: 'personal' })
    expect(personal.credential.entityId).toContain(bob)
  })
})
