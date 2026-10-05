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

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { execSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  setupChannelsTestDb,
  seedWorkspace,
  sseResponse,
  waitFor,
  type SeededWorkspace,
} from '../../../../apps/api/src/__tests__/helpers/channels-test-db'

setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET = 'e2e-secret'
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.GH_APP_ID = '12345'
process.env.GH_APP_PRIVATE_KEY = 'unused-in-these-flows'
process.env.GH_APP_CLIENT_ID = 'Iv1.client'
process.env.GH_APP_CLIENT_SECRET = 'client-secret'
process.env.SHOGO_PUBLIC_API_URL = 'https://studio.test'
delete process.env.RUNTIME_AUTH_SECRET

// Where `project_call` finds the callee's runtime: a fake one per project (see the hop tests).
const runtimeUrls = new Map<string, string>()
mock.module('../../../../apps/api/src/lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async (projectId: string) => {
    const url = runtimeUrls.get(projectId)
    if (!url) throw new Error(`no runtime for ${projectId}`)
    return { url }
  },
}))

const { prisma } = await import('../../../../apps/api/src/lib/prisma')
const { encryptSecret } = await import('../../../../apps/api/src/lib/secret-crypto')
const { signRequesterTicket, verifyRequesterTicket } = await import('../../../../apps/api/src/lib/requester-ticket')
const { registerCredentialProvider } = await import('../../../../apps/api/src/services/integration-credentials')
const { verifyResumeToken } = await import('../../../../apps/api/src/services/integration-credentials/resume')
const dispatcher = await import('../../../../apps/api/src/services/conversation-agent-dispatcher')
const { conversationRoutes } = await import('../../../../apps/api/src/routes/conversations')
const teamChannels = await import('../../../../apps/api/src/services/conversation-team-channels')
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
  ghs_shared_b: { id: 2, login: 'acme-b-shared', name: 'Acme B Shared' },
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
/** Who the internal routes see calling: the service account, or a project's runtime. */
let internalIdentity: any = { kind: 'sa' }
root.route(
  '/api/internal',
  runtimeInternalRoutes({
    authenticate: async () => internalIdentity,
    loadAgentCall: () => import('../../../../apps/api/src/services/agent-call.service'),
    saveAgentAvatar: async () => ({}) as any,
    metalWorkspaceMember: (async () => null) as any,
    loadGitHub,
  } as any),
)
root.route('/api', integrationCredentialRoutes({ loadGitHub }))
root.route('/api', githubRoutes())
root.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-test-user') ?? null }))

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

function turnTools(
  requesterUserId: string | null,
  opts: {
    /** Project the ticket is signed for (defaults to the runtime's own). */
    projectId?: string
    /** The project whose runtime this turn runs in. */
    runtimeProjectId?: string
    /** A ticket handed over as-is, e.g. by `project_call`. */
    ticket?: string
    chatSessionId?: string
    ui?: any[]
  } = {},
) {
  const runtimeProjectId = opts.runtimeProjectId ?? seeded.projectId
  const projectId = opts.projectId ?? runtimeProjectId
  const origin = { kind: 'chat' as const, ...(opts.chatSessionId ? { chatSessionId: opts.chatSessionId } : {}) }
  const ticket = opts.ticket ?? (requesterUserId ? signRequesterTicket({ projectId, userId: requesterUserId, origin }) : undefined)
  const wrap = createIntegrationCredentialWrapper({
    projectId: runtimeProjectId,
    requesterTicket: ticket,
    uiWriter: opts.ui ? { write: (chunk) => opts.ui!.push(chunk) } : undefined,
  })
  const tools = createTools({
    workspaceDir,
    channels: new Map(),
    config: { heartbeatInterval: 1800, heartbeatEnabled: false, quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' }, channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } },
    projectId: runtimeProjectId,
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

async function putPolicy(by: string, body: Record<string, unknown>, provider = 'github', projectId = seeded.projectId) {
  const res = await browser(by, `/api/projects/${projectId}/integrations/policies/${provider}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  clearCredentialPolicyCache()
  return res
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
  const link = new URL(connectUrl)
  const path = link.pathname
  const consent = await browser(userId, `${path}${link.search}`)
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

// ---------------------------------------------------------------------------
// Phase 2: who may change it, fallback lists, hops, and picking back up
// ---------------------------------------------------------------------------

describe('only the project owner and workspace admins change what the agent acts as', () => {
  test('a member is refused and sees the setting read-only; owners and the project creator can edit', async () => {
    const before = await (await browser(alice, `/api/projects/${seeded.projectId}/integrations/policies`)).json()
    expect(before.canEdit).toBe(true)
    const asBob = await (await browser(bob, `/api/projects/${seeded.projectId}/integrations/policies`)).json()
    expect(asBob.canEdit).toBe(false)

    const refused = await putPolicy(bob, { writeChain: ['shared'], readChain: ['shared'] })
    expect(refused.status).toBe(403)
    expect((await refused.json()).error.code).toBe('forbidden')
    const viewer = await putPolicy(seeded.viewer, { writeChain: ['shared'] })
    expect(viewer.status).toBe(403)
    const outsider = await putPolicy(seeded.outsider, { writeChain: ['shared'] })
    expect(outsider.status).toBe(403)
    const unchanged = await (await browser(alice, `/api/projects/${seeded.projectId}/integrations/policies`)).json()
    expect(unchanged.policies).toEqual(before.policies)

    // The member who created the project counts as its owner.
    await db.project.update({ where: { id: seeded.projectId }, data: { createdBy: bob } })
    try {
      expect((await (await browser(bob, `/api/projects/${seeded.projectId}/integrations/policies`)).json()).canEdit).toBe(true)
      expect((await putPolicy(bob, { readChain: ['shared'] })).status).toBe(200)
    } finally {
      await db.project.update({ where: { id: seeded.projectId }, data: { createdBy: null } })
    }
  })
})

describe('fallback lists, for any integration', () => {
  /** A made-up integration, to show none of this is GitHub-specific. */
  const tracker = {
    shared: 'tracker-shared' as string | null,
    personal: new Map<string, string>(),
  }
  beforeAll(() => {
    registerCredentialProvider({
      id: 'mcp:tracker',
      label: () => 'Tracker',
      supportsPersonal: true,
      shared: async () => (tracker.shared ? { token: tracker.shared, login: 'tracker-bot' } : null),
      personalForUser: async (_ctx, userId) => {
        const token = tracker.personal.get(userId)
        return token ? { token, login: `${userId.slice(0, 4)}-tracker` } : null
      },
    })
  })

  async function resolve(userId: string | null, op: 'read' | 'write' = 'write', provider = 'mcp:tracker') {
    const res = await realFetch(`${API}/api/internal/projects/${seeded.projectId}/integrations/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userId ? { 'X-Requester-Ticket': signRequesterTicket({ projectId: seeded.projectId, userId }) } : {}),
      },
      body: JSON.stringify({ provider, op }),
    })
    return res.json()
  }

  test('steps are tried in order and each one is skipped when it does not apply', async () => {
    tracker.personal.set(bob, 'tracker-bob')
    expect((await putPolicy(alice, { writeChain: ['requester', 'ask', 'shared'], readChain: ['requester', 'shared'] }, 'mcp:tracker')).status).toBe(200)

    // A connected person acts as themselves.
    expect(await resolve(bob)).toMatchObject({ ok: true, source: 'personal', credential: { token: 'tracker-bob' } })
    // An unconnected person is asked to connect.
    const alices = await resolve(alice)
    expect(alices).toMatchObject({ ok: false, code: 'requester_auth_required' })
    expect(alices.connectUrl).toContain('/integrations/mcp%3Atracker/connect')
    // No person (schedules, webhooks): "ask" has no one to ask, so the project account is next.
    expect(await resolve(null)).toMatchObject({ ok: true, source: 'shared', credential: { token: 'tracker-shared' } })
    // Reads skip asking.
    expect(await resolve(alice, 'read')).toMatchObject({ ok: true, source: 'shared' })

    // The same list ending in "deny" refuses unattended runs instead.
    await putPolicy(alice, { writeChain: ['requester', 'ask', 'deny'] }, 'mcp:tracker')
    expect(await resolve(null)).toMatchObject({ ok: false, code: 'requester_unknown' })
    expect((await resolve(null)).connectUrl).toBeUndefined()

    // Unconnected people fall back to the project account; with no project account, say so.
    await putPolicy(alice, { writeChain: ['requester', 'shared'] }, 'mcp:tracker')
    expect(await resolve(alice)).toMatchObject({ ok: true, source: 'shared' })
    tracker.shared = null
    expect(await resolve(alice)).toMatchObject({ ok: false, code: 'not_connected' })
    expect(await resolve(bob)).toMatchObject({ ok: true, source: 'personal' })
    await putPolicy(alice, { writeChain: ['requester', 'shared', 'deny'] }, 'mcp:tracker')
    expect(await resolve(alice)).toMatchObject({ ok: false, code: 'denied' })
    tracker.shared = 'tracker-shared'
  })

  test('the stored lists come back with the older summary fields older runtimes read', async () => {
    await putPolicy(alice, { writeChain: ['requester', 'ask', 'shared'], readChain: ['shared'] }, 'mcp:tracker')
    const res = await realFetch(`${API}/api/internal/projects/${seeded.projectId}/integrations/policies`)
    const policy = (await res.json()).policies.find((p: any) => p.provider === 'mcp:tracker')
    expect(policy).toMatchObject({
      writeChain: ['requester', 'ask', 'shared'],
      readChain: ['shared'],
      writeMode: 'requester',
      readMode: 'shared',
      fallback: 'ask',
    })
    const row = await db.integrationCredentialPolicy.findUnique({
      where: { projectId_provider: { projectId: seeded.projectId, provider: 'mcp:tracker' } },
    })
    expect(JSON.parse(row.writeChain)).toEqual(['requester', 'ask', 'shared'])
  })

  test('rows saved before lists existed behave exactly as they did', async () => {
    await db.integrationCredentialPolicy.update({
      where: { projectId_provider: { projectId: seeded.projectId, provider: 'mcp:tracker' } },
      data: { writeChain: null, readChain: null, writeMode: 'requester', readMode: 'shared', fallback: 'ask' },
    })
    clearCredentialPolicyCache()
    expect(await resolve(alice)).toMatchObject({ code: 'requester_auth_required' })
    expect(await resolve(null)).toMatchObject({ code: 'requester_unknown' })
    expect(await resolve(alice, 'read')).toMatchObject({ ok: true, source: 'shared' })
    const policies = await (await browser(alice, `/api/projects/${seeded.projectId}/integrations/policies`)).json()
    expect(policies.policies.find((p: any) => p.provider === 'mcp:tracker')).toMatchObject({
      writeChain: ['requester', 'ask', 'deny'],
      readChain: ['shared'],
    })
  })

  test('invalid lists are rejected', async () => {
    for (const writeChain of [[], ['shared', 'shared'], ['bogus'], 'shared', [1]]) {
      const res = await putPolicy(alice, { writeChain }, 'mcp:tracker')
      expect(res.status).toBe(400)
    }
  })
})

describe('picking the conversation back up after connecting', () => {
  let channelId: string
  let invocations: Array<{ projectId: string | null; sessionId: string; userId: string; prompt: string }> = []
  let agentTurn: (inv: { sessionId: string; userId: string }) => Promise<string>

  beforeAll(async () => {
    await putPolicy(alice, { writeChain: ['requester', 'ask', 'deny'], readChain: ['shared'] })
    const { channel } = await teamChannels.upsertTeamChannel(seeded.workspaceId, {
      name: 'eng-resume',
      agents: [{ projectId: seeded.projectId, agentTrigger: 'mention' }],
      userEmails: [],
    })
    channelId = channel.id
    dispatcher._resetDispatcherForTests()
    dispatcher.configureConversationAgentDispatcher({
      // The agent's turn: the project chat route would sign a ticket for this
      // person and chat session; the turn's tools then run with it.
      invoke: async (args: any) => {
        invocations.push({ projectId: args.projectId, sessionId: args.sessionId, userId: args.userId, prompt: args.prompt })
        const text = await agentTurn({ sessionId: args.sessionId, userId: args.userId })
        return sseResponse([
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: text },
          { type: 'text-end', id: 't1' },
          { type: 'finish' },
        ])
      },
    })
  })

  async function post(userId: string, text: string, threadRootId?: string) {
    const res = await browser(userId, `/api/conversations/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(threadRootId ? { threadRootId } : {}) }),
    })
    expect(res.status).toBeLessThan(300)
    return (await res.json()).message.id as string
  }

  test('Bob asks in a channel, connects through the link, and the agent carries on as Bob in the same thread', async () => {
    let connectUrl = ''
    agentTurn = async ({ sessionId, userId }) => {
      const pr = await turnTools(userId, { chatSessionId: sessionId }).createPr('Fix login')
      if (pr.code === 'requester_auth_required') {
        connectUrl = pr.connectUrl
        return `I need you to connect GitHub first: ${pr.connectUrl}`
      }
      return pr.ok ? `Opened ${pr.html_url ?? 'the PR'} as @${pr.author}` : `Failed: ${pr.code}`
    }

    const root = await post(bob, `<@a:p:${seeded.projectId}> please open a PR for the login fix`)
    await waitFor(async () => (connectUrl ? true : null), 5000)
    const firstSession = invocations.at(-1)!.sessionId
    expect(invocations.at(-1)!.userId).toBe(bob)

    // The link names the conversation to come back to, for Bob only.
    const resume = new URL(connectUrl).searchParams.get('resume')
    expect(verifyResumeToken(resume)).toMatchObject({ userId: bob, chatSessionId: firstSession })
    await waitFor(async () =>
      (await db.conversationMessage.findFirst({ where: { agentSessionId: firstSession, authorType: 'agent', agentStatus: 'done' } })) ?? null,
    5000)
    expect(prCalls()).toEqual([])

    // Alice opening Bob's link doesn't get to resume his conversation.
    const asAlice = await (await browser(alice, `${new URL(connectUrl).pathname}${new URL(connectUrl).search}`)).text()
    const aliceState = asAlice.match(/name="state" value="([^"]+)"/)![1]!
    const { verifyPersonalConnectState } = await import('../../../../apps/api/src/services/integration-credentials/connect-state')
    expect(verifyPersonalConnectState(aliceState)?.resume).toBeUndefined()

    const before = invocations.length
    const html = await connectThroughLink(bob, connectUrl, 'bob-code')
    expect(html).toContain('GitHub connected as @bob-gh')
    expect(html).toContain('picking up where it left off in eng-resume')

    const note = await db.conversationMessage.findFirst({
      where: { conversationId: channelId, authorUserId: bob, threadRootId: root, text: { contains: 'I connected GitHub as @bob-gh' } },
    })
    expect(note).toBeTruthy()
    expect(note.text).toContain(`<@a:p:${seeded.projectId}>`)

    // The note wakes the agent in the same thread and session, and this time the PR is Bob's.
    await waitFor(async () => (invocations.length > before ? true : null), 5000)
    expect(invocations.at(-1)).toMatchObject({ userId: bob, sessionId: firstSession })
    const done = await waitFor(async () => {
      const rows = await db.conversationMessage.findMany({
        where: { conversationId: channelId, threadRootId: root, authorType: 'agent', agentStatus: 'done' },
        orderBy: { seq: 'asc' },
      })
      return rows.length >= 2 ? rows : null
    }, 5000)
    expect(done.at(-1).text).toContain('as @bob-gh')
    expect(prCalls().map((c) => c.token)).toEqual(['gho_bob_1'])

    // Finishing the same link twice (a refresh, a double click) posts nothing new.
    const { resumeAfterConnect } = await import('../../../../apps/api/src/services/integration-credentials/resume')
    expect(await resumeAfterConnect({ userId: bob, resume, label: 'GitHub', login: 'bob-gh' })).toMatchObject({ resumed: true })
    expect(await resumeAfterConnect({ userId: alice, resume, label: 'GitHub', login: 'x' })).toEqual({ resumed: false })
    expect(await db.conversationMessage.count({ where: { conversationId: channelId, authorUserId: bob, text: { contains: 'I connected GitHub' } } })).toBe(1)
  })

  test('a link from an app chat (no thread behind it) still connects, without posting anywhere', async () => {
    await browser(bob, '/api/me/integrations/github', { method: 'DELETE' })
    const pr = await turnTools(bob, { chatSessionId: 'app-session-without-thread' }).createPr('From the app')
    expect(new URL(pr.connectUrl).searchParams.get('resume')).toBeTruthy()
    const messagesBefore = await db.conversationMessage.count()
    const html = await connectThroughLink(bob, pr.connectUrl, 'bob-code')
    expect(html).toContain('GitHub connected as @bob-gh')
    expect(html).toContain('Ask the agent to try again')
    expect(await db.conversationMessage.count()).toBe(messagesBefore)
  })
})

describe('project_call carries the person to the next project', () => {
  let projectB: string
  let hopTickets: Array<string | null> = []
  let runtimeB: ReturnType<typeof Bun.serve>

  beforeAll(async () => {
    const b = await db.project.create({ data: { name: 'Issue Filer', workspaceId: seeded.workspaceId } })
    projectB = b.id
    await db.gitHubConnection.create({
      data: {
        projectId: projectB,
        repoOwner: 'acme',
        repoName: 'site',
        repoFullName: 'acme/site',
        authType: 'token',
        encryptedToken: encryptSecret('ghs_shared_b'),
        tokenLogin: 'acme-b-shared',
      },
    })
    // Project B's runtime: runs the turn with whatever ticket the API forwarded, like /agent/pipeline/call.
    runtimeB = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const ticket = req.headers.get('x-requester-ticket')
        hopTickets.push(ticket)
        const pr = await turnTools(null, { runtimeProjectId: projectB, ...(ticket ? { ticket } : {}) }).createPr('Filed via A')
        return Response.json({ status: 'completed', reply: JSON.stringify(pr), sessionId: 'pipeline' })
      },
    })
    runtimeUrls.set(projectB, `http://127.0.0.1:${runtimeB.port}`)
    process.env.SHOGO_LOCAL_MODE = 'true'
    await putPolicy(alice, { writeChain: ['requester', 'ask', 'deny'], readChain: ['shared'] }, 'github', projectB)
    // Bob already allowed project A; B is a different agent and needs its own consent.
    await db.userIntegrationGrant.create({ data: { userId: bob, projectId: projectB, provider: 'github' } })
  })

  afterAll(() => {
    runtimeB.stop(true)
    delete process.env.SHOGO_LOCAL_MODE
    internalIdentity = { kind: 'sa' }
  })

  beforeEach(() => {
    hopTickets = []
  })

  async function callB(fromProject: string, ticket: string | null) {
    internalIdentity = { kind: 'project', projectId: fromProject }
    try {
      const res = await realFetch(`${API}/api/internal/projects/${projectB}/agent-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(ticket ? { 'X-Requester-Ticket': ticket } : {}) },
        body: JSON.stringify({ message: 'File an issue for the login bug', wait: true }),
      })
      expect(res.status).toBe(200)
      return JSON.parse((await res.json()).reply)
    } finally {
      internalIdentity = { kind: 'sa' }
    }
  }

  test('Bob talks to A, A calls B, and B files the PR as Bob', async () => {
    const ticketForA = signRequesterTicket({ projectId: seeded.projectId, userId: bob, origin: { kind: 'chat', chatSessionId: 'cs-a' } })
    const pr = await callB(seeded.projectId, ticketForA)
    expect(pr).toMatchObject({ ok: true, mode: 'requester', author: 'bob-gh' })
    expect(prCalls().map((c) => c.token)).toEqual(['gho_bob_1'])

    // B got a ticket of its own (A's would not verify there), naming Bob and the path.
    expect(hopTickets[0]).not.toBe(ticketForA)
    expect(verifyRequesterTicket(hopTickets[0], seeded.projectId)).toBeNull()
    expect(verifyRequesterTicket(hopTickets[0], projectB)).toMatchObject({
      userId: bob,
      via: [seeded.projectId],
      origin: { kind: 'chat', chatSessionId: 'cs-a' },
    })
  })

  test('without a person behind A\'s turn, B has no one to act as', async () => {
    const pr = await callB(seeded.projectId, null)
    expect(hopTickets).toEqual([null])
    expect(pr.code).toBe('requester_unknown')
    expect(prCalls()).toEqual([])
  })

  test('a ticket that was not issued to the calling project is dropped', async () => {
    // A's runtime presenting a ticket minted for some other project.
    const pr = await callB(seeded.projectId, signRequesterTicket({ projectId: seeded.foreignProjectId, userId: bob }))
    expect(hopTickets).toEqual([null])
    expect(pr.code).toBe('requester_unknown')
  })

  test('someone outside B\'s workspace is not carried over', async () => {
    const pr = await callB(seeded.projectId, signRequesterTicket({ projectId: seeded.projectId, userId: seeded.outsider }))
    expect(hopTickets).toEqual([null])
    expect(pr.code).toBe('requester_unknown')
  })

  test('B\'s own consent still applies: revoking it stops B, not A', async () => {
    await db.userIntegrationGrant.updateMany({ where: { userId: bob, projectId: projectB }, data: { revokedAt: new Date() } })
    const pr = await callB(seeded.projectId, signRequesterTicket({ projectId: seeded.projectId, userId: bob }))
    expect(pr.code).toBe('requester_auth_required')
    expect(pr.connectUrl).toContain(`/projects/${projectB}/integrations/github/connect`)
    expect(await turnTools(bob).createPr('Still fine on A')).toMatchObject({ ok: true, author: 'bob-gh' })
  })
})
