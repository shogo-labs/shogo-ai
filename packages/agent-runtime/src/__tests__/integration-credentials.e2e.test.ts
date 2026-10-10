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
process.env.GH_APP_WEBHOOK_SECRET = 'gh-webhook-secret'
process.env.SHOGO_CREDENTIAL_APPROVAL_POLL_MS = '25'
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
const { workspaceAgentRoutes, sessionAuthorize } = await import('../../../../apps/api/src/routes/workspace-agent')
const { integrationRoutes, setIntegrationsComposioClient } = await import('../../../../apps/api/src/routes/integrations')
const { handleComposioWebhook, setComposioTriggersClient, composioEntityFor } = await import(
  '../../../../apps/api/src/services/composio-triggers.service'
)
const { setComposioIdentityClient, linkIdentity } = await import('../../../../apps/api/src/services/identity-links')
const { onWorkspaceMemberJoined } = await import('../../../../apps/api/src/services/workspace-events')
const { savePersonalConnection } = await import('../../../../apps/api/src/services/integration-credentials/store')
const eventWorker = await import('../../../../apps/api/src/jobs/run-event-delivery-dispatch')
const { createFakeComposio, signComposioWebhook, COMPOSIO_WEBHOOK_SECRET } = await import('../../../../e2e/events/helpers')
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
  ghs_shared_e: { id: 3, login: 'acme-events-shared', name: 'Acme Events Shared' },
  gho_carol: { id: 303, login: 'carol-gh', name: 'Carol' },
  ghs_shared_f: { id: 4, login: 'acme-approvals-shared', name: 'Acme Approvals Shared' },
  gho_frank: { id: 404, login: 'frank-gh', name: 'Frank' },
  gho_gina: { id: 505, login: 'gina-gh', name: 'Gina' },
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
  const pulls = /^\/repos\/acme\/([\w-]+)\/pulls$/.exec(url.pathname)
  if (url.host === 'api.github.com' && pulls && method === 'POST') {
    if (!token || !GITHUB_USERS[token]) return json({ message: 'Bad credentials' }, 401)
    prNumber += 1
    const repo = pulls[1]
    return json({ number: prNumber, html_url: `https://github.com/acme/${repo}/pull/${prNumber}`, url: `https://api.github.com/repos/acme/${repo}/pulls/${prNumber}` }, 201)
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
root.route('/api', workspaceAgentRoutes({ authorize: sessionAuthorize(async (c: any) => c.req.header('x-test-user') ?? null) }))
// The runtime's trigger tools: trusted as the workspace, with the user named in the body.
root.route('/api/runtime', workspaceAgentRoutes({ authorize: async (c: any) => ({ workspaceId: c.req.param('workspaceId') }) }))
root.route('/api', integrationRoutes())
root.post('/api/webhooks/composio', async (c) => {
  const result = await handleComposioWebhook({
    rawBody: await c.req.text(),
    headers: { id: c.req.header('webhook-id'), timestamp: c.req.header('webhook-timestamp'), signature: c.req.header('webhook-signature') },
  })
  return c.json(result.body, result.status)
})

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
    // GitHub told us who Bob is there, so events he triggers on GitHub can be matched to him.
    expect(await db.userIdentityLink.findMany({ where: { userId: bob }, select: { source: true, externalId: true } }))
      .toEqual([{ source: 'github', externalId: '202' }])

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
    expect(await db.userIdentityLink.count({ where: { userId: bob } })).toBe(0)
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

  test('someone outside B\'s workspace cannot call B', async () => {
    internalIdentity = { kind: 'project', projectId: seeded.projectId }
    try {
      const res = await realFetch(`${API}/api/internal/projects/${projectB}/agent-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requester-Ticket': signRequesterTicket({ projectId: seeded.projectId, userId: seeded.outsider }),
        },
        body: JSON.stringify({ message: 'File an issue for the login bug', wait: true }),
      })
      expect(res.status).toBe(404)
      expect(hopTickets).toEqual([])
    } finally {
      internalIdentity = { kind: 'sa' }
    }
  })

  test('B\'s own consent still applies: revoking it stops B, not A', async () => {
    await db.userIntegrationGrant.updateMany({ where: { userId: bob, projectId: projectB }, data: { revokedAt: new Date() } })
    const pr = await callB(seeded.projectId, signRequesterTicket({ projectId: seeded.projectId, userId: bob }))
    expect(pr.code).toBe('requester_auth_required')
    expect(pr.connectUrl).toContain(`/projects/${projectB}/integrations/github/connect`)
    expect(await turnTools(bob).createPr('Still fine on A')).toMatchObject({ ok: true, author: 'bob-gh' })
  })
})

describe('event-triggered turns act as a person', () => {
  const JIRA_TRIGGER = {
    slug: 'JIRA_NEW_ISSUE_TRIGGER',
    name: 'New issue',
    description: 'A new Jira issue was created',
    toolkit: { slug: 'jira', name: 'Jira' },
    config: { type: 'object', properties: {} },
    payload: {
      type: 'object',
      properties: {
        issue: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            fields: {
              type: 'object',
              properties: {
                summary: { type: 'string' },
                reporter: {
                  type: 'object',
                  properties: { accountId: { type: 'string' }, emailAddress: { type: 'string' }, displayName: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  }

  let projectE: string
  let carol: string
  let runtimeE: ReturnType<typeof Bun.serve>
  let fake: Awaited<ReturnType<typeof createFakeComposio>>
  let whoAmI: Record<string, { accountId: string; emailAddress?: string }>
  let turns: Array<{ ticket: string | null; message: string; result?: any }> = []

  const eventPrCalls = () => githubCalls.filter((c) => c.method === 'POST' && c.path === 'api.github.com/repos/acme/events/pulls')

  async function api(user: string | null, method: string, path: string, body?: unknown, prefix = '/api') {
    const res = await realFetch(`${API}${prefix}${path}`, {
      method,
      headers: { ...(user ? { 'x-test-user': user } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }

  async function createTrigger(by: string, body: Record<string, unknown>) {
    return api(by, 'POST', `/workspaces/${seeded.workspaceId}/triggers`, {
      name: 'File it',
      target: 'project',
      targetProjectId: projectE,
      targetMode: 'agent',
      prompt: 'Open a PR for this.',
      ...body,
    })
  }

  /** Runs the delivery worker until it goes idle, then returns the last delivery for `subscriptionId`. */
  async function deliver(subscriptionId: string) {
    await waitFor(async () => {
      await eventWorker.runEventDeliveryDispatch()
      await eventWorker.waitForEventDeliveries()
      const pending = await db.eventDelivery.count({ where: { subscriptionId, status: { in: ['pending', 'running'] } } })
      return pending === 0 ? true : null
    }, 5_000)
    return db.eventDelivery.findFirst({ where: { subscriptionId }, orderBy: { createdAt: 'desc' } })
  }

  async function join(name: string) {
    const user = await db.user.create({ data: { name, email: `${name.toLowerCase()}-${Date.now()}@example.com` } })
    const member = await db.member.create({ data: { userId: user.id, workspaceId: seeded.workspaceId, role: 'member' } })
    await onWorkspaceMemberJoined({ workspaceId: seeded.workspaceId, userId: user.id, memberId: member.id, source: 'invitation' })
    return user.id as string
  }

  async function jiraWebhook(triggerId: string, reporter: Record<string, unknown>, opts: { secret?: string } = {}) {
    const signed = signComposioWebhook({
      triggerId,
      triggerSlug: 'JIRA_NEW_ISSUE_TRIGGER',
      data: { issue: { key: `OPS-${Date.now()}`, fields: { summary: 'Login is broken', reporter } } },
      ...(opts.secret ? { secret: opts.secret } : {}),
    })
    const res = await realFetch(`${API}/api/webhooks/composio`, { method: 'POST', headers: signed.headers, body: signed.body })
    return res.status
  }

  const ticketOf = (index = 0) => verifyRequesterTicket(turns[index]?.ticket, projectE)

  beforeAll(async () => {
    const e = await db.project.create({ data: { name: 'Event Bot', workspaceId: seeded.workspaceId } })
    projectE = e.id
    await db.gitHubConnection.create({
      data: {
        projectId: projectE,
        repoOwner: 'acme',
        repoName: 'events',
        repoFullName: 'acme/events',
        authType: 'token',
        encryptedToken: encryptSecret('ghs_shared_e'),
        tokenLogin: 'acme-events-shared',
      },
    })
    // Project E's runtime runs the turn with whatever ticket the API sent, like /agent/pipeline/call.
    runtimeE = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const ticket = req.headers.get('x-requester-ticket')
        const body = (await req.json().catch(() => ({}))) as { message?: string }
        const turn: (typeof turns)[number] = { ticket, message: body.message ?? '' }
        turns.push(turn)
        const pr = await turnTools(null, { runtimeProjectId: projectE, ...(ticket ? { ticket } : {}) }).createPr('From an event')
        turn.result = pr
        return Response.json({ status: 'completed', reply: JSON.stringify(pr), sessionId: 'pipeline' })
      },
    })
    runtimeUrls.set(projectE, `http://127.0.0.1:${runtimeE.port}`)
    process.env.SHOGO_LOCAL_MODE = 'true'
    process.env.COMPOSIO_WEBHOOK_SECRET = COMPOSIO_WEBHOOK_SECRET
    await putPolicy(alice, { writeChain: ['requester', 'shared'], readChain: ['shared'] }, 'github', projectE)

    // Bob connects GitHub for project E the normal way; that records his GitHub id.
    await browser(bob, '/api/me/integrations/github', { method: 'DELETE' })
    expect(await db.userIdentityLink.count({ where: { userId: bob } })).toBe(0)
    const html = await connectThroughLink(bob, `https://studio.test/api/projects/${projectE}/integrations/github/connect`, 'bob-code')
    expect(html).toContain('GitHub connected as @bob-gh')

    // Carol isn't in the workspace yet, but already has GitHub connected and allowed for E.
    const c = await db.user.create({ data: { name: 'Carol', email: 'carol@acme.test', emailVerified: true } })
    carol = c.id
    await savePersonalConnection(carol, 'github', { externalId: '303', externalLogin: 'carol-gh', accessToken: 'gho_carol' })
    await db.userIntegrationGrant.create({ data: { userId: carol, projectId: projectE, provider: 'github' } })

    fake = await createFakeComposio()
    const types = [JIRA_TRIGGER]
    const { listTypes, getType } = fake.client.triggers
    fake.client.triggers.listTypes = async (q?: { toolkits?: string[] }) =>
      q?.toolkits?.includes('jira') ? { items: types } : listTypes(q)
    fake.client.triggers.getType = async (slug: string) => types.find((t) => t.slug === slug) ?? getType(slug)
    whoAmI = {}
    const client: any = {
      ...fake.client,
      tools: {
        getRawComposioTools: async ({ toolkits }: { toolkits: string[] }) => toolkits[0] === 'jira'
          ? [
              { slug: 'JIRA_CREATE_ISSUE', input_parameters: { required: ['summary'] } },
              { slug: 'JIRA_GET_CURRENT_USER', input_parameters: { required: [] } },
            ]
          : [],
        execute: async (slug: string, body: { userId: string }) => {
          const me = whoAmI[body.userId]
          return slug === 'JIRA_GET_CURRENT_USER' && me
            ? { successful: true, data: me }
            : { successful: false, error: 'no connection' }
        },
      },
    }
    setComposioTriggersClient(client)
    setIntegrationsComposioClient(client)
    setComposioIdentityClient(client)
    fake.connect(await composioEntityFor(seeded.workspaceId, alice, projectE), 'jira')
  })

  afterAll(() => {
    runtimeE.stop(true)
    delete process.env.SHOGO_LOCAL_MODE
    setComposioTriggersClient(undefined)
    setIntegrationsComposioClient(null)
    setComposioIdentityClient(undefined)
  })

  beforeEach(async () => {
    turns = []
    await db.eventSubscription.deleteMany({ where: { workspaceId: seeded.workspaceId } })
  })

  test('by default a trigger acts as whoever set it up', async () => {
    const created = await createTrigger(bob, { eventType: 'member.joined' })
    expect(created.status).toBe(201)
    expect(created.json.trigger.actsAs).toBe('subscriber')

    await join('Dave')
    const delivery = await deliver(created.json.trigger.id)
    expect(delivery.status).toBe('ok')
    expect(turns.at(-1)!.result).toMatchObject({ ok: true, mode: 'requester', author: 'bob-gh' })
    expect(eventPrCalls().map((c) => c.token)).toEqual(['gho_bob_1'])
    expect(ticketOf()).toMatchObject({
      userId: bob,
      origin: { kind: 'event', subscriptionId: created.json.trigger.id, source: 'shogo', match: 'subscriber' },
    })
  })

  test('only an admin can make a trigger act as the person who triggered it', async () => {
    const asBob = await createTrigger(bob, { eventType: 'member.joined', actsAs: 'actor' })
    expect(asBob.status).toBe(403)

    const mine = await createTrigger(bob, { eventType: 'member.joined' })
    expect(mine.status).toBe(201)
    const path = `/workspaces/${seeded.workspaceId}/triggers/${mine.json.trigger.id}`
    expect((await api(bob, 'PATCH', path, { actsAs: 'actor' })).status).toBe(403)
    // Narrowing is always fine.
    expect((await api(bob, 'PATCH', path, { actsAs: 'nobody' })).status).toBe(200)
    // The runtime's trigger tools can't turn it on, even naming an admin.
    expect((await api(null, 'PATCH', path, { actsAs: 'actor', userId: alice }, '/api/runtime')).status).toBe(403)
    expect((await api(null, 'POST', `/workspaces/${seeded.workspaceId}/triggers`, {
      name: 'x', eventType: 'member.joined', target: 'project', targetProjectId: projectE, targetMode: 'agent',
      prompt: 'x', actsAs: 'actor', userId: alice,
    }, '/api/runtime')).status).toBe(403)

    const byAlice = await api(alice, 'PATCH', path, { actsAs: 'actor' })
    expect(byAlice.status).toBe(200)
    expect(byAlice.json.trigger.actsAs).toBe('actor')
    // Actor fields belong to Composio triggers; Shogo events name their own actor.
    expect((await api(alice, 'PATCH', path, { actorIdPath: 'member.userId' })).status).toBe(400)
    // Only project agents act as anyone.
    expect((await createTrigger(alice, { eventType: 'member.joined', target: 'agent', actsAs: 'actor' })).status).toBe(400)
  })

  test('acting as the actor: a newcomer\'s own GitHub, or the shared account when they have none', async () => {
    const created = await createTrigger(alice, { eventType: 'member.joined', actsAs: 'actor' })
    expect(created.status).toBe(201)

    // Carol joins. She allowed E to use her GitHub before joining.
    await db.member.create({ data: { userId: carol, workspaceId: seeded.workspaceId, role: 'member' } })
    const carolMember = await db.member.findFirst({ where: { userId: carol, workspaceId: seeded.workspaceId } })
    await onWorkspaceMemberJoined({ workspaceId: seeded.workspaceId, userId: carol, memberId: carolMember.id, source: 'invitation' })
    await deliver(created.json.trigger.id)
    expect(turns.at(-1)!.result).toMatchObject({ ok: true, mode: 'requester', author: 'carol-gh' })
    expect(ticketOf()).toMatchObject({ userId: carol, origin: { kind: 'event', source: 'shogo', match: 'platform_id' } })

    // Erin has no GitHub: the chain moves on to the project account.
    turns = []
    githubCalls = []
    const erin = await join('Erin')
    await deliver(created.json.trigger.id)
    expect(ticketOf()).toMatchObject({ userId: erin })
    expect(turns.at(-1)!.result).toMatchObject({ ok: true, author: 'acme-events-shared' })
    expect(eventPrCalls().map((c) => c.token)).toEqual(['ghs_shared_e'])
  })

  test('Composio: a Jira issue is filed on GitHub as its reporter, once Shogo knows who they are on Jira', async () => {
    // The picker suggests the reporter fields from the trigger's payload schema.
    const types = await api(alice, 'GET', `/workspaces/${seeded.workspaceId}/trigger-types?toolkit=jira&projectId=${projectE}`)
    expect(types.status).toBe(200)
    const jira = types.json.composio.types.find((t: any) => t.slug === 'JIRA_NEW_ISSUE_TRIGGER')
    expect(jira.actorFields.idPaths[0]).toBe('issue.fields.reporter.accountId')
    expect(jira.actorFields.emailPaths).toEqual(['issue.fields.reporter.emailAddress'])

    expect((await createTrigger(alice, { eventType: 'composio.jira.JIRA_NEW_ISSUE_TRIGGER', actsAs: 'actor' })).status).toBe(400)
    const created = await createTrigger(alice, {
      eventType: 'composio.jira.JIRA_NEW_ISSUE_TRIGGER',
      actsAs: 'actor',
      actorIdPath: 'issue.fields.reporter.accountId',
    })
    expect(created.status).toBe(201)
    const sub = created.json.trigger

    // Before Bob's Jira account is known, his issue can't be tied to him.
    expect(await jiraWebhook(sub.composioTriggerId, { accountId: 'jira-bob' })).toBe(200)
    await deliver(sub.id)
    expect(turns[0]!.ticket).toBeNull()
    expect(turns.at(-1)!.result).toMatchObject({ ok: true, author: 'acme-events-shared' })

    // Bob connects Jira; checking its status asks Jira who he is, with his own connection.
    const bobEntity = await composioEntityFor(seeded.workspaceId, bob, projectE)
    fake.connect(bobEntity, 'jira')
    whoAmI[bobEntity] = { accountId: 'jira-bob', emailAddress: 'bob@acme.test' }
    const status = await api(bob, 'GET', `/integrations/status/jira?projectId=${projectE}`)
    expect(status.json.data.connected).toBe(true)
    await waitFor(() => db.userIdentityLink.findFirst({ where: { userId: bob, source: 'composio:jira', externalId: 'jira-bob' } }), 3_000)

    turns = []
    githubCalls = []
    expect(await jiraWebhook(sub.composioTriggerId, { accountId: 'jira-bob', displayName: 'Bob' })).toBe(200)
    await deliver(sub.id)
    expect(turns.at(-1)!.result).toMatchObject({ ok: true, mode: 'requester', author: 'bob-gh' })
    expect(eventPrCalls().map((c) => c.token)).toEqual(['gho_bob_1'])
    expect(ticketOf()).toMatchObject({ userId: bob, origin: { kind: 'event', source: 'composio:jira', match: 'platform_id' } })
    // The actor stays off the payload the agent sees.
    const event = await db.workspaceEvent.findFirst({ where: { workspaceId: seeded.workspaceId, type: 'composio.jira.JIRA_NEW_ISSUE_TRIGGER' }, orderBy: { occurredAt: 'desc' } })
    expect(event.actor).toEqual({ source: 'composio:jira', externalId: 'jira-bob', trust: 'platform' })

    // A forged webhook is rejected, and a test event can't claim to be Bob.
    turns = []
    expect(await jiraWebhook(sub.composioTriggerId, { accountId: 'jira-bob' }, { secret: 'whsec_forged' })).toBe(401)
    const tested = await api(alice, 'POST', `/workspaces/${seeded.workspaceId}/triggers/${sub.id}/test`, {
      payload: { issue: { fields: { reporter: { accountId: 'jira-bob' } } } },
    })
    expect(tested.status).toBeLessThan(300)
    await deliver(sub.id)
    expect(turns.map((t) => t.ticket)).toEqual([null])
  })

  test('an email in the payload only counts when the trigger says to trust it', async () => {
    const created = await createTrigger(alice, {
      eventType: 'composio.jira.JIRA_NEW_ISSUE_TRIGGER',
      actsAs: 'actor',
      actorIdPath: 'issue.fields.reporter.accountId',
      actorEmailPath: 'issue.fields.reporter.emailAddress',
    })
    expect(created.status).toBe(201)
    const sub = created.json.trigger

    await jiraWebhook(sub.composioTriggerId, { accountId: 'jira-carol', emailAddress: 'Carol@acme.test' })
    await deliver(sub.id)
    expect(turns[0]!.ticket).toBeNull()

    expect((await api(bob, 'PATCH', `/workspaces/${seeded.workspaceId}/triggers/${sub.id}`, { trustActorEmail: true })).status).toBe(403)
    expect((await api(alice, 'PATCH', `/workspaces/${seeded.workspaceId}/triggers/${sub.id}`, { trustActorEmail: true })).status).toBe(200)
    turns = []
    await jiraWebhook(sub.composioTriggerId, { accountId: 'jira-carol', emailAddress: 'Carol@acme.test' })
    await deliver(sub.id)
    expect(ticketOf()).toMatchObject({ userId: carol, origin: { match: 'platform_email' } })
    expect(turns.at(-1)!.result).toMatchObject({ author: 'carol-gh' })
  })

  test('an account two members both claim matches nobody', async () => {
    const created = await createTrigger(alice, {
      eventType: 'composio.jira.JIRA_NEW_ISSUE_TRIGGER',
      actsAs: 'actor',
      actorIdPath: 'issue.fields.reporter.accountId',
    })
    await linkIdentity({ userId: alice, source: 'composio:jira', externalId: 'jira-bob' })
    try {
      await jiraWebhook(created.json.trigger.composioTriggerId, { accountId: 'jira-bob' })
      await deliver(created.json.trigger.id)
      expect(turns.map((t) => t.ticket)).toEqual([null])
    } finally {
      await db.userIdentityLink.deleteMany({ where: { userId: alice, source: 'composio:jira' } })
    }
  })

  test('an event turn never stops to hand out a connect link; the chain moves on', async () => {
    await putPolicy(alice, { writeChain: ['requester', 'ask', 'deny'], readChain: ['shared'] }, 'github', projectE)
    await db.userIntegrationGrant.updateMany({ where: { userId: bob, projectId: projectE }, data: { revokedAt: new Date() } })
    try {
      const created = await createTrigger(alice, {
        eventType: 'composio.jira.JIRA_NEW_ISSUE_TRIGGER',
        actsAs: 'actor',
        actorIdPath: 'issue.fields.reporter.accountId',
      })
      await jiraWebhook(created.json.trigger.composioTriggerId, { accountId: 'jira-bob' })
      await deliver(created.json.trigger.id)
      expect(ticketOf()).toMatchObject({ userId: bob })
      const result = turns.at(-1)!.result
      expect(result.code).toBe('denied')
      expect(result.connectUrl).toBeUndefined()
      expect(eventPrCalls()).toEqual([])
    } finally {
      await putPolicy(alice, { writeChain: ['requester', 'shared'], readChain: ['shared'] }, 'github', projectE)
      await db.userIntegrationGrant.updateMany({ where: { userId: bob, projectId: projectE }, data: { revokedAt: null } })
    }
  })

  describe('GitHub webhooks act as their sender', () => {
    async function issueOpened(sender: Record<string, unknown>) {
      const body = JSON.stringify({
        action: 'opened',
        repository: { full_name: 'acme/events' },
        issue: { number: 7, title: 'Login is broken', body: 'Steps…', html_url: 'https://github.com/acme/events/issues/7' },
        sender,
      })
      const { createHmac } = await import('node:crypto')
      const signature = `sha256=${createHmac('sha256', 'gh-webhook-secret').update(body).digest('hex')}`
      const res = await realFetch(`${API}/api/github/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-github-event': 'issues', 'x-hub-signature-256': signature, 'x-github-delivery': 'dlv-1' },
        body,
      })
      expect(res.status).toBe(200)
      await waitFor(() => (turns.length ? true : null), 3_000)
    }

    test('a linked member who opens an issue is the person the turn acts as', async () => {
      await issueOpened({ id: 202, login: 'bob-gh', type: 'User' })
      expect(ticketOf()).toMatchObject({ userId: bob, origin: { kind: 'event', eventId: 'dlv-1', source: 'github', match: 'platform_id' } })
      await waitFor(() => (eventPrCalls().length ? true : null), 3_000)
      expect(eventPrCalls().map((c) => c.token)).toEqual(['gho_bob_1'])
    })

    test('bots and strangers get no person', async () => {
      // A bot carrying Bob's id still isn't Bob.
      await issueOpened({ id: 202, login: 'bob-gh', type: 'Bot' })
      expect(turns.map((t) => t.ticket)).toEqual([null])
      turns = []
      await issueOpened({ id: 999, login: 'stranger', type: 'User' })
      expect(turns.map((t) => t.ticket)).toEqual([null])
    })
  })
})

describe('someone in the conversation approves, or the project has a delegate', () => {
  let projectF: string
  let channelId: string
  let frank: string // member with GitHub connected and allowed for F
  let gina: string // member with no GitHub; asks the agent
  let agentTurn: (inv: { sessionId: string; userId: string }) => Promise<string>
  let results: any[] = []

  const fPrCalls = () => githubCalls.filter((c) => c.method === 'POST' && c.path === 'api.github.com/repos/acme/approvals/pulls')
  const fTools = (userId: string | null, opts: { chatSessionId?: string; ticket?: string; ui?: any[] } = {}) =>
    turnTools(userId, { runtimeProjectId: projectF, ...opts })

  async function api(user: string | null, method: string, path: string, body?: unknown) {
    const res = await realFetch(`${API}/api${path}`, {
      method,
      headers: { ...(user ? { 'x-test-user': user } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }

  async function ask(userId: string, text: string) {
    const res = await browser(userId, `/api/conversations/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `<@a:p:${projectF}> ${text}` }),
    })
    expect(res.status).toBeLessThan(300)
    return (await res.json()).message.id as string
  }

  /** The credential card the agent posted in `threadRootId`. */
  async function card(threadRootId: string) {
    return waitFor(async () => {
      const rows = await db.conversationMessage.findMany({ where: { conversationId: channelId, threadRootId, authorType: 'agent' } })
      return rows.find((r: any) => r.blocks?.type === 'approval_request' && r.blocks.approval.kind === 'credential') ?? null
    }, 5000)
  }

  const decide = (userId: string, messageId: string, decision: 'approve' | 'deny') =>
    api(userId, 'POST', `/conversation-messages/${messageId}/approval`, { decision })

  async function resolveF(headers: Record<string, string>, op: 'read' | 'write' = 'write') {
    const res = await realFetch(`${API}/api/internal/projects/${projectF}/integrations/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ provider: 'github', op, toolName: 'github_create_pr' }),
    })
    return res.json()
  }

  beforeAll(async () => {
    const f = await db.project.create({ data: { name: 'Approval Bot', workspaceId: seeded.workspaceId } })
    projectF = f.id
    await db.gitHubConnection.create({
      data: {
        projectId: projectF,
        repoOwner: 'acme',
        repoName: 'approvals',
        repoFullName: 'acme/approvals',
        authType: 'token',
        encryptedToken: encryptSecret('ghs_shared_f'),
        tokenLogin: 'acme-approvals-shared',
      },
    })
    const mk = async (name: string) => {
      const user = await db.user.create({ data: { name, email: `${name.toLowerCase()}-${Date.now()}@acme.test` } })
      await db.member.create({ data: { userId: user.id, workspaceId: seeded.workspaceId, role: 'member' } })
      return user.id as string
    }
    frank = await mk('Frank')
    gina = await mk('Gina')
    await savePersonalConnection(frank, 'github', { externalId: '404', externalLogin: 'frank-gh', accessToken: 'gho_frank' })
    await db.userIntegrationGrant.create({ data: { userId: frank, projectId: projectF, provider: 'github' } })

    const { channel } = await teamChannels.upsertTeamChannel(seeded.workspaceId, {
      name: 'eng-approvals',
      agents: [{ projectId: projectF, agentTrigger: 'mention' }],
      userEmails: [],
    })
    channelId = channel.id
    dispatcher._resetDispatcherForTests()
    dispatcher.configureConversationAgentDispatcher({
      invoke: async (args: any) => {
        const text = await agentTurn({ sessionId: args.sessionId, userId: args.userId })
        return sseResponse([
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: text },
          { type: 'text-end', id: 't1' },
          { type: 'finish' },
        ])
      },
    })
    agentTurn = async ({ sessionId, userId }) => {
      const pr = await fTools(userId, { chatSessionId: sessionId }).createPr('Fix the flaky test')
      results.push(pr)
      return pr.ok ? `Opened as @${pr.author}` : `Not done: ${pr.code}`
    }
  })

  beforeEach(() => {
    results = []
  })

  test('nobody to act as: a card goes up in the thread, and whoever approves opens the PR with their own account', async () => {
    expect((await putPolicy(alice, { writeChain: ['requester', 'approve', 'deny'], readChain: ['shared'] }, 'github', projectF)).status).toBe(200)

    const root = await ask(gina, 'please open a PR for the flaky test fix')
    const pending = await card(root)
    expect(pending.blocks.approval).toMatchObject({ kind: 'credential', status: 'pending', projectId: projectF, toolName: 'github_create_pr' })
    expect(pending.blocks.approval.summary).toContain('Use your own GitHub account for `github_create_pr`')
    const approval = await db.integrationCredentialApproval.findUnique({ where: { id: pending.blocks.approval.requestId } })
    expect(approval).toMatchObject({ projectId: projectF, provider: 'github', op: 'write', status: 'pending', requesterUserId: gina })
    expect(fPrCalls()).toEqual([])

    // A viewer, and someone from another workspace, can't answer it; the card keeps waiting.
    expect((await decide(seeded.viewer, pending.id, 'approve')).status).toBe(403)
    expect([403, 404]).toContain((await decide(seeded.outsider, pending.id, 'approve')).status)
    expect((await db.integrationCredentialApproval.findUnique({ where: { id: approval.id } })).status).toBe('pending')

    const approved = await decide(frank, pending.id, 'approve')
    expect(approved.status).toBe(200)
    expect(approved.json.approval).toMatchObject({ status: 'approved', decidedBy: { name: 'Frank' } })
    await waitFor(async () => (results.length ? true : null), 5000)
    expect(results[0]).toMatchObject({ ok: true, mode: 'requester', author: 'frank-gh' })
    expect(results[0].credential).toEqual({ source: 'approved', actingAs: '@frank-gh' })
    expect(fPrCalls().map((c) => c.token)).toEqual(['gho_frank'])

    // Spent: replaying it gets nothing, even from the runtime that held it.
    expect((await db.integrationCredentialApproval.findUnique({ where: { id: approval.id } })).status).toBe('used')
    const ticket = signRequesterTicket({ projectId: projectF, userId: gina, origin: { kind: 'chat' } })
    expect(await resolveF({ 'X-Requester-Ticket': ticket, 'X-Credential-Approval': approval.id })).toMatchObject({
      ok: false,
      code: 'approval_expired',
    })

    // The log says who asked and whose account did it.
    const audit = await db.integrationCredentialAudit.findFirst({ where: { projectId: projectF, approvalId: approval.id } })
    expect(audit).toMatchObject({ source: 'approved', actingAs: '@frank-gh', actingUserId: frank, requesterUserId: gina })
    expect(audit.origin).toMatchObject({ kind: 'chat' })
  })

  test('a denied card stops the call; nothing runs on anyone\'s account', async () => {
    const root = await ask(gina, 'open another PR')
    const pending = await card(root)
    expect((await decide(frank, pending.id, 'deny')).status).toBe(200)
    await waitFor(async () => (results.length ? true : null), 5000)
    expect(results[0]).toMatchObject({ code: 'approval_denied' })
    expect(fPrCalls()).toEqual([])
    expect((await db.integrationCredentialApproval.findUnique({ where: { id: pending.blocks.approval.requestId } })).status).toBe('denied')
  })

  test('an unanswered card expires: the tool gives up and the card says so', async () => {
    const root = await ask(gina, 'and one more')
    const pending = await card(root)
    await db.integrationCredentialApproval.update({
      where: { id: pending.blocks.approval.requestId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await waitFor(async () => (results.length ? true : null), 5000)
    expect(results[0]).toMatchObject({ code: 'approval_expired' })
    const settled = await db.conversationMessage.findUnique({ where: { id: pending.id } })
    expect(settled.blocks.approval.status).toBe('expired')
    expect((await decide(frank, pending.id, 'approve')).status).toBe(409)
    expect(fPrCalls()).toEqual([])
  })

  test('an approver without the account gets the connect link; the approval is not spent', async () => {
    const root = await ask(gina, 'try once more')
    const pending = await card(root)
    // Gina approves her own request, but she has no GitHub.
    expect((await decide(gina, pending.id, 'approve')).status).toBe(200)
    await waitFor(async () => (results.length ? true : null), 5000)
    expect(results[0]).toMatchObject({ code: 'requester_auth_required' })
    expect(results[0].connectUrl).toContain(`/api/projects/${projectF}/integrations/github/connect`)
    expect((await db.integrationCredentialApproval.findUnique({ where: { id: pending.blocks.approval.requestId } })).status).toBe('approved')
  })

  test('a press from a mirrored card (Slack, Teams) is answered the same way, without asking the runtime', async () => {
    const { decideApproval } = await import('../../../../apps/api/src/services/conversation-approvals')
    const root = await ask(gina, 'from slack')
    const pending = await card(root)
    await decideApproval({
      messageId: pending.id,
      decision: 'approve',
      by: { userId: frank, name: 'Frank' },
      respond: async () => {
        throw new Error('the runtime is not waiting on credential cards')
      },
    })
    await waitFor(async () => (results.length ? true : null), 5000)
    expect(results[0]).toMatchObject({ ok: true, author: 'frank-gh' })
  })

  test('with nowhere to post (an app chat, a turn without a thread), the step is skipped', async () => {
    const before = await db.integrationCredentialApproval.count()
    const pr = await fTools(gina, { chatSessionId: 'no-thread-here' }).createPr('From the app')
    expect(pr).toMatchObject({ code: 'denied' })
    expect(await db.integrationCredentialApproval.count()).toBe(before)
  })

  test('approvals belong to their project and their integration', async () => {
    const root = await ask(gina, 'scope check')
    const pending = await card(root)
    const id = pending.blocks.approval.requestId
    expect((await decide(frank, pending.id, 'approve')).status).toBe(200)
    await waitFor(async () => (results.length ? true : null), 5000)
    // Seen from another project's runtime, it doesn't exist.
    const other = await realFetch(`${API}/api/internal/projects/${seeded.projectId}/integrations/approvals/${id}`)
    expect(await other.json()).toEqual({ state: 'unknown' })
    // An approval for GitHub writes doesn't unlock GitHub reads.
    const asRead = await resolveF({ 'X-Credential-Approval': id }, 'read')
    expect(asRead).toMatchObject({ ok: false, code: 'approval_expired' })
  })

  test('any tool, not just PRs: a shell `gh` write waits on the card and runs with the approver\'s token', async () => {
    const ui: any[] = []
    let shell: { details: any; text: string } | null = null
    agentTurn = async ({ sessionId, userId }) => {
      shell = await fTools(userId, { chatSessionId: sessionId, ui }).exec('gh issue create --title flaky')
      return 'done'
    }
    const root = await ask(gina, 'file an issue for the flake')
    const pending = await card(root)
    expect(pending.blocks.approval.toolName).toBe('exec')
    expect(ui.find((c) => c.type === 'data-integration-approval-pending')?.data).toMatchObject({
      provider: 'github',
      approvalId: pending.blocks.approval.requestId,
    })
    expect((await decide(frank, pending.id, 'approve')).status).toBe(200)
    await waitFor(async () => shell, 5000)
    expect(shell!.text).toContain('token=gho_frank')
    expect(shell!.details.credential).toMatchObject({ source: 'approved', actingAs: '@frank-gh' })
    expect(shell!.text).toContain('who approved it')

    shell = null
    const second = await card(await ask(gina, 'and another issue'))
    expect((await decide(frank, second.id, 'deny')).status).toBe(200)
    await waitFor(async () => shell, 5000)
    expect(shell!.details).toMatchObject({ code: 'approval_denied' })
    expect(shell!.text).not.toContain('token=')
    agentTurn = async ({ sessionId, userId }) => {
      const pr = await fTools(userId, { chatSessionId: sessionId }).createPr('Fix the flaky test')
      results.push(pr)
      return pr.ok ? `Opened as @${pr.author}` : `Not done: ${pr.code}`
    }
  })

  test('an event turn posts its card in the channel the trigger reports to', async () => {
    const sub = await db.eventSubscription.create({
      data: {
        workspaceId: seeded.workspaceId,
        name: 'Nightly',
        eventType: 'member.joined',
        target: 'project',
        targetProjectId: projectF,
        targetMode: 'agent',
        notifyConversationId: channelId,
      },
    })
    const origin = { kind: 'event' as const, eventId: 'evt-1', subscriptionId: sub.id, source: 'shogo', match: 'subscriber' as const }
    const ticket = signRequesterTicket({ projectId: projectF, userId: gina, origin })
    const pending = await resolveF({ 'X-Requester-Ticket': ticket })
    expect(pending).toMatchObject({ ok: false, code: 'approval_pending' })
    const posted = await db.integrationCredentialApproval.findUnique({ where: { id: pending.approvalId } })
    const cardRow = await db.conversationMessage.findUnique({ where: { id: posted.messageId } })
    expect(cardRow).toMatchObject({ conversationId: channelId, agentSessionId: `event:${sub.id}` })

    // A subscription from another workspace is nowhere to post for this project.
    const foreign = await db.eventSubscription.create({
      data: { workspaceId: seeded.otherWorkspaceId, name: 'x', eventType: 'member.joined', notifyConversationId: channelId },
    })
    const elsewhere = signRequesterTicket({ projectId: projectF, userId: gina, origin: { ...origin, subscriptionId: foreign.id } })
    expect(await resolveF({ 'X-Requester-Ticket': elsewhere })).toMatchObject({ ok: false, code: 'denied' })
    await db.eventSubscription.deleteMany({ where: { id: { in: [sub.id, foreign.id] } } })
  })

  test('a chat session whose reply lives in another workspace is nowhere to post', async () => {
    const elsewhere = await db.conversation.create({ data: { workspaceId: seeded.otherWorkspaceId, kind: 'channel', name: 'theirs' } })
    await db.conversationMessage.create({
      data: { conversationId: elsewhere.id, workspaceId: seeded.otherWorkspaceId, seq: 1, text: '', authorType: 'agent', agentSessionId: 'their-session' },
    })
    const ticket = signRequesterTicket({ projectId: projectF, userId: gina, origin: { kind: 'chat', chatSessionId: 'their-session' } })
    await putPolicy(alice, { writeChain: ['requester', 'approve', 'deny'], readChain: ['shared'] }, 'github', projectF)
    const before = await db.integrationCredentialApproval.count()
    expect(await resolveF({ 'X-Requester-Ticket': ticket })).toMatchObject({ ok: false, code: 'denied' })
    expect(await db.integrationCredentialApproval.count()).toBe(before)
    expect(await db.conversationMessage.count({ where: { conversationId: elsewhere.id } })).toBe(1)
  })

  test('deciding and spending an approval: members only, once, before it expires', async () => {
    const approvals = await import('../../../../apps/api/src/services/integration-credentials/approvals')
    const make = (data: Record<string, unknown> = {}) =>
      db.integrationCredentialApproval.create({
        data: { projectId: projectF, provider: 'github', op: 'write', expiresAt: new Date(Date.now() + 60_000), ...data },
      })
    const a = await make()
    expect(await approvals.decideCredentialApproval({ approvalId: a.id, decision: 'allow_once', userId: seeded.viewer })).toBe(false)
    expect(await approvals.decideCredentialApproval({ approvalId: a.id, decision: 'allow_once', userId: seeded.outsider })).toBe(false)
    expect(await approvals.decideCredentialApproval({ approvalId: a.id, decision: 'allow_once', userId: frank })).toBe(true)
    expect(await approvals.decideCredentialApproval({ approvalId: a.id, decision: 'deny', userId: alice })).toBe(false)
    expect((await db.integrationCredentialApproval.findUnique({ where: { id: a.id } })).decidedByUserId).toBe(frank)

    const late = await make({ expiresAt: new Date(Date.now() - 1000) })
    expect(await approvals.decideCredentialApproval({ approvalId: late.id, decision: 'allow_once', userId: frank })).toBe(false)

    // An approval for GitHub writes doesn't unlock GitHub reads.
    expect(await resolveF({ 'X-Credential-Approval': a.id }, 'read')).toMatchObject({ ok: false, code: 'approval_expired' })
    expect(await approvals.markApprovalUsed(a.id)).toBe(true)
    expect(await approvals.markApprovalUsed(a.id)).toBe(false)
  })

  test('the delegate: unattended runs act as a person who opted in, until they stop', async () => {
    await putPolicy(alice, { writeChain: ['requester', 'delegate', 'deny'], readChain: ['shared'] }, 'github', projectF)
    const path = `/projects/${projectF}/integrations/policies/github/delegate`

    // Nobody opted in: an unattended run is refused.
    expect(await fTools(null).createPr('Nightly')).toMatchObject({ code: 'requester_unknown' })

    // Only you can make yourself the delegate, and only with an account connected.
    expect((await api(seeded.viewer, 'POST', path)).status).toBe(403)
    const unconnected = await api(gina, 'POST', path)
    expect(unconnected.status).toBe(409)
    expect(unconnected.json.error.connectUrl).toContain(`/api/projects/${projectF}/integrations/github/connect`)
    expect(await db.userIntegrationGrant.count({ where: { userId: gina, projectId: projectF } })).toBe(0)

    const optIn = await api(frank, 'POST', path)
    expect(optIn.status).toBe(200)
    expect(optIn.json).toMatchObject({ actingAs: '@frank-gh', policy: { delegateUserId: frank, delegateIsMe: true } })
    const listed = await api(alice, 'GET', `/projects/${projectF}/integrations/policies`)
    expect(listed.json.policies.find((p: any) => p.provider === 'github')).toMatchObject({ delegateName: 'Frank', delegateIsMe: false })

    expect(await fTools(null).createPr('Nightly')).toMatchObject({
      ok: true,
      author: 'frank-gh',
      credential: { source: 'delegate', actingAs: '@frank-gh' },
    })
    expect(fPrCalls().map((c) => c.token)).toEqual(['gho_frank'])
    // Saving the chains again keeps the delegate.
    await putPolicy(alice, { writeChain: ['requester', 'delegate', 'deny'] }, 'github', projectF)
    expect(await fTools(null).createPr('Nightly 2')).toMatchObject({ ok: true, author: 'frank-gh' })
    // The person who asked still comes first, once they've allowed the project to use their account.
    await savePersonalConnection(gina, 'github', { externalId: '505', externalLogin: 'gina-gh', accessToken: 'gho_gina' })
    expect(await fTools(gina).createPr('Mine')).toMatchObject({ ok: true, author: 'frank-gh' })
    await db.userIntegrationGrant.create({ data: { userId: gina, projectId: projectF, provider: 'github' } })
    expect(await fTools(gina).createPr('Mine')).toMatchObject({
      ok: true,
      author: 'gina-gh',
      credential: { source: 'personal', actingAs: '@gina-gh' },
    })
    await browser(gina, '/api/me/integrations/github', { method: 'DELETE' })

    // Someone else can't stop it for Frank; Frank or an admin can.
    expect((await api(gina, 'DELETE', path)).status).toBe(403)
    expect((await api(frank, 'DELETE', path)).status).toBe(200)
    expect(await fTools(null).createPr('Nightly 3')).toMatchObject({ code: 'requester_unknown' })
    expect((await api(frank, 'POST', path)).status).toBe(200)
    expect((await api(alice, 'DELETE', path)).status).toBe(200)
    expect(await fTools(null).createPr('Nightly 4')).toMatchObject({ code: 'requester_unknown' })

    // Revoking the project's access, or leaving the workspace, ends it too.
    expect((await api(frank, 'POST', path)).status).toBe(200)
    const grant = await db.userIntegrationGrant.findFirst({ where: { userId: frank, projectId: projectF, provider: 'github' } })
    expect((await browser(frank, `/api/me/integrations/grants/${grant.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await fTools(null).createPr('Nightly 5')).toMatchObject({ code: 'requester_unknown' })
    expect((await api(frank, 'POST', path)).status).toBe(200)
    await db.member.deleteMany({ where: { userId: frank, workspaceId: seeded.workspaceId } })
    expect(await fTools(null).createPr('Nightly 6')).toMatchObject({ code: 'requester_unknown' })
    await db.member.create({ data: { userId: frank, workspaceId: seeded.workspaceId, role: 'member' } })

    const audit = await db.integrationCredentialAudit.findMany({ where: { projectId: projectF, source: 'delegate' } })
    expect(audit.map((a: any) => [a.actingUserId, a.requesterUserId, a.actingAs])).toEqual([
      [frank, null, '@frank-gh'],
      [frank, null, '@frank-gh'],
      [frank, gina, '@frank-gh'],
    ])
  })

  test('on the shared account, the person who asked is credited', async () => {
    await putPolicy(alice, { writeChain: ['shared'], readChain: ['shared'] }, 'github', projectF)
    expect(await fTools(gina).createPr('Credited')).toMatchObject({
      ok: true,
      author: 'acme-approvals-shared',
      credential: { source: 'shared', actingAs: 'project account (@acme-approvals-shared)', onBehalfOf: 'Gina' },
    })
    expect(fPrCalls().at(-1)!.body.body).toContain('Requested by Gina')
    // Unattended: no credit line.
    expect((await fTools(null).createPr('Uncredited')).credential).toEqual({
      source: 'shared',
      actingAs: 'project account (@acme-approvals-shared)',
    })
    expect(fPrCalls().at(-1)!.body.body).not.toContain('Requested by')

    // Generic tools get it as a note and in the result details.
    await putPolicy(alice, { writeChain: ['requester', 'shared'], readChain: ['shared'] }, 'github', projectF)
    const { details, text } = await fTools(gina).exec('gh issue create --title x')
    expect(details.credential).toMatchObject({ source: 'shared', onBehalfOf: 'Gina' })
    expect(text).toContain('on behalf of Gina')
  })

  test('only admins read the audit log', async () => {
    expect((await api(gina, 'GET', `/projects/${projectF}/integrations/audit`)).status).toBe(403)
    const log = await api(alice, 'GET', `/projects/${projectF}/integrations/audit?provider=github`)
    expect(log.status).toBe(200)
    const sources = new Set(log.json.entries.map((e: any) => e.source))
    expect([...sources].sort()).toEqual(['approved', 'delegate', 'personal', 'shared'])
    expect(log.json.entries.find((e: any) => e.source === 'approved')).toMatchObject({
      actingUserName: 'Frank',
      requesterName: 'Gina',
      origin: 'chat',
    })
  })
})
