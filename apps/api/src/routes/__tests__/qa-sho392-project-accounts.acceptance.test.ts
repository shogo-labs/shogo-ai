// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-392 acceptance — a connected account belongs to a project.
 *
 * Walks the real agent router against a real SQLite database with two project
 * identities, because the bug this card fixes was invisible from the service
 * layer: every reader filtered on `workspaceId` alone, so one project's agent
 * could list, post to, and read the inbox of another project's account.
 *
 * The workspace agent (no project) and the Social page must still see
 * everything — that is the other half of the contract.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { agentSocialRoutes, socialRoutes } = await import('../social')
const { setSocialClient } = await import('../../services/social/client')

const db = prisma as any

const app = new Hono()
app.use('*', async (c, next) => {
  const userId = c.req.header('x-user')
  c.set('auth', { userId, isAuthenticated: !!userId } as never)
  await next()
})
// The agent surface: the project comes from the runtime identity, exactly as
// `internal-runtime-routes.ts` passes it.
app.route(
  '/api/internal',
  agentSocialRoutes({
    authorize: async (c: any) => ({
      workspaceId: c.req.param('workspaceId'),
      projectId: c.req.header('x-project') || undefined,
    }),
  }),
)
app.route('/api', socialRoutes({ resolveUserId: async (c: any) => c.get('auth')?.userId ?? null }))

const request = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

const suffix = crypto.randomUUID().slice(0, 8)
let owner = ''
let workspaceId = ''
let projectA = ''
let projectB = ''
let accountA: any
let accountB: any
let sharedAccount: any
/** What the fake Zernio profile reports. Set per test. */
let providerAccounts: any[] = []

beforeAll(async () => {
  const user = await db.user.create({ data: { name: 'owner', email: `sho392-${suffix}@example.com` } })
  owner = user.id

  const workspace = await db.workspace.create({
    data: { name: 'Acme', slug: `sho392-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { workspaceId, userId: owner, role: 'owner', projectId: null } })

  const a = await db.project.create({ data: { name: 'Engage', workspaceId } })
  const b = await db.project.create({ data: { name: 'Website', workspaceId } })
  projectA = a.id
  projectB = b.id

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `zprofile_${suffix}`,
      externalId: `ws_${suffix}`,
      name: 'Acme',
    },
  })

  const makeAccount = (username: string, projectId: string | null) =>
    db.socialAccount.create({
      data: {
        workspaceId,
        projectId,
        profileId: profile.id,
        zernioAccountId: `z_${username}_${suffix}`,
        platform: 'instagram',
        username,
        isActive: true,
      },
    })

  accountA = await makeAccount('engage', projectA)
  accountB = await makeAccount('website', projectB)
  sharedAccount = await makeAccount('brand', null)

  // One DM thread per account, so the inbox scope is observable.
  for (const account of [accountA, accountB, sharedAccount]) {
    await db.socialConversation.create({
      data: {
        workspaceId,
        accountId: account.id,
        zernioConversationId: `conv_${account.username}_${suffix}`,
        platform: 'instagram',
        participantName: `fan of ${account.username}`,
        unreadCount: 1,
        lastMessageAt: new Date(),
      },
    })
  }

  setSocialClient({
    mode: 'cloud',
    async request() {
      return { accounts: providerAccounts }
    },
  })
})

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
})

const agent = (projectId?: string) => ({
  'x-project': projectId ?? '',
})

describe('a project agent sees its own accounts plus the shared ones', () => {
  test('project A lists its own and the shared account, never project B’s', async () => {
    const res = await request(`/api/internal/workspaces/${workspaceId}/social/accounts`, {
      headers: agent(projectA),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accounts.map((row: any) => row.username).sort()).toEqual(['brand', 'engage'])
  })

  test('the workspace agent sees every account', async () => {
    const res = await request(`/api/internal/workspaces/${workspaceId}/social/accounts`)
    const body = await res.json()
    expect(body.accounts.map((row: any) => row.username).sort()).toEqual([
      'brand',
      'engage',
      'website',
    ])
  })

  test('the Social page sees every account', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/accounts`, {
      headers: { 'x-user': owner },
    })
    const body = await res.json()
    expect(body.accounts).toHaveLength(3)
  })
})

describe('a project agent cannot use another project’s account', () => {
  test('posting to it is refused as out of scope', async () => {
    const res = await request(`/api/internal/workspaces/${workspaceId}/social/posts`, {
      method: 'POST',
      headers: agent(projectA),
      body: JSON.stringify({ content: 'hello', accountIds: [accountB.id], draft: true }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('account_out_of_scope')
  })

  test('posting to its own account is allowed', async () => {
    const res = await request(`/api/internal/workspaces/${workspaceId}/social/posts`, {
      method: 'POST',
      headers: agent(projectA),
      body: JSON.stringify({ content: 'hello', accountIds: [accountA.id], draft: true }),
    })
    expect(res.status).toBe(201)
  })

  test('its inbox holds only its own and the shared threads', async () => {
    const res = await request(`/api/internal/workspaces/${workspaceId}/social/inbox`, {
      headers: agent(projectA),
    })
    const body = await res.json()
    expect(body.conversations.map((row: any) => row.participantName).sort()).toEqual([
      'fan of brand',
      'fan of engage',
    ])
  })

  test('reading another project’s thread is a 404, not a leak', async () => {
    const other = await db.socialConversation.findFirst({
      where: { workspaceId, accountId: accountB.id },
    })
    const res = await request(
      `/api/internal/workspaces/${workspaceId}/social/inbox/conversations/${other.id}`,
      { headers: agent(projectA) },
    )
    expect(res.status).toBe(404)
  })
})

describe('moving an account changes who can use it, immediately', () => {
  test('moving project B’s account to shared makes it visible to project A', async () => {
    const moved = await request(`/api/workspaces/${workspaceId}/social/accounts/${accountB.id}`, {
      method: 'PATCH',
      headers: { 'x-user': owner },
      body: JSON.stringify({ projectId: null }),
    })
    expect(moved.status).toBe(200)
    expect((await moved.json()).account.projectId).toBeNull()

    const res = await request(`/api/internal/workspaces/${workspaceId}/social/accounts`, {
      headers: agent(projectA),
    })
    const body = await res.json()
    expect(body.accounts.map((row: any) => row.username).sort()).toEqual([
      'brand',
      'engage',
      'website',
    ])
  })

  test('moving it back to project B hides it from project A again', async () => {
    await request(`/api/workspaces/${workspaceId}/social/accounts/${accountB.id}`, {
      method: 'PATCH',
      headers: { 'x-user': owner },
      body: JSON.stringify({ projectId: projectB }),
    })

    const res = await request(`/api/internal/workspaces/${workspaceId}/social/accounts`, {
      headers: agent(projectA),
    })
    const body = await res.json()
    expect(body.accounts.map((row: any) => row.username).sort()).toEqual(['brand', 'engage'])
  })

  test('deleting a project makes its accounts workspace-shared, not orphaned', async () => {
    const project = await db.project.create({ data: { name: 'Doomed', workspaceId } })
    const profile = await db.socialProfile.findFirst({ where: { workspaceId } })
    const account = await db.socialAccount.create({
      data: {
        workspaceId,
        projectId: project.id,
        profileId: profile.id,
        zernioAccountId: `z_doomed_${suffix}`,
        platform: 'instagram',
        username: 'doomed',
        isActive: true,
      },
    })

    // The framework deletes the row, then runs the hook.
    await db.project.delete({ where: { id: project.id } })
    const { projectHooks } = await import('../../generated/project.hooks')
    const previous = process.env.SHOGO_LOCAL_MODE
    process.env.SHOGO_LOCAL_MODE = 'true'
    try {
      await projectHooks.afterDelete!(project.id, {} as any)
    } finally {
      if (previous === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = previous
    }

    const row = await db.socialAccount.findUnique({ where: { id: account.id } })
    expect(row.projectId).toBeNull()
    // Still connected and still billed — the Zernio account did not go away.
    expect(row.isActive).toBe(true)
  })

  test('a project id that is not in this workspace is refused', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/accounts/${accountA.id}`, {
      method: 'PATCH',
      headers: { 'x-user': owner },
      body: JSON.stringify({ projectId: crypto.randomUUID() }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('unknown_project')
  })
})

/**
 * The connect flow does not go through `completeConnect` in production — the
 * landing page hands back to the app, which calls `POST /accounts/sync`. Both
 * paths must therefore be able to refuse a sign-in that landed on an account
 * another project already owns, and a routine refresh must not.
 */
describe('a connect that lands on another project’s account is refused', () => {
  const allThree = () => [
    { id: accountA.zernioAccountId, platform: 'instagram', username: 'engage' },
    { id: accountB.zernioAccountId, platform: 'instagram', username: 'website' },
    { id: sharedAccount.zernioAccountId, platform: 'instagram', username: 'brand' },
  ]

  test('POST /connect/complete forwards projectId, so the claim fires', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/connect/complete`, {
      method: 'POST',
      headers: { 'x-user': owner },
      body: JSON.stringify({
        platform: 'instagram',
        accountId: accountB.zernioAccountId,
        username: 'website',
        projectId: projectA,
      }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('account_owned_elsewhere')

    // The row was not reassigned.
    const row = await db.socialAccount.findUnique({ where: { id: accountB.id } })
    expect(row.projectId).toBe(projectB)
  })

  test('POST /connect/complete stamps the project on a brand-new account', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/connect/complete`, {
      method: 'POST',
      headers: { 'x-user': owner },
      body: JSON.stringify({
        platform: 'instagram',
        accountId: `z_fresh_${suffix}`,
        username: 'fresh',
        projectId: projectA,
      }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).account.projectId).toBe(projectA)
  })

  test('a claiming sync refuses an account another project owns', async () => {
    providerAccounts = allThree()
    const res = await request(`/api/workspaces/${workspaceId}/social/accounts/sync`, {
      method: 'POST',
      headers: { 'x-user': owner },
      body: JSON.stringify({ projectId: projectA, claim: true }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('account_owned_elsewhere')
  })

  test('a routine sync does not claim, so it never fails on another project’s account', async () => {
    providerAccounts = allThree()
    const res = await request(`/api/workspaces/${workspaceId}/social/accounts/sync`, {
      method: 'POST',
      headers: { 'x-user': owner },
      body: JSON.stringify({ projectId: projectA }),
    })
    expect(res.status).toBe(200)
    // Every row kept its owner — a sync reconciles the profile, it does not move accounts.
    const rows = await db.socialAccount.findMany({ where: { workspaceId } })
    const byUsername = Object.fromEntries(rows.map((row: any) => [row.username, row.projectId]))
    expect(byUsername.engage).toBe(projectA)
    expect(byUsername.website).toBe(projectB)
    expect(byUsername.brand).toBeNull()
  })
})
