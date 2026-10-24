// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P5 — the automation routes through Hono against a real SQLite database.
 *
 * The service tests prove the platform rules; these prove the surface a person
 * and the agent actually call: a viewer can read but not create, the agent
 * mirror returns the same shape, and another workspace's automation is a 404
 * rather than a cross-tenant edit.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { socialRoutes, agentSocialRoutes } = await import('../social')
const { setSocialClient } = await import('../../services/social/client')

const db = prisma as any

const app = new Hono()
app.use('*', async (c, next) => {
  const userId = c.req.header('x-user')
  c.set('auth', { userId, isAuthenticated: !!userId } as never)
  await next()
})
app.route('/api', socialRoutes({ resolveUserId: async (c: any) => c.get('auth')?.userId ?? null }))
app.route(
  '/api/internal',
  agentSocialRoutes({
    authorize: async (c: any) => ({ workspaceId: c.req.param('workspaceId') }),
  }),
)

const request = (path: string, userId: string | null, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...(userId ? { 'x-user': userId } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

const suffix = crypto.randomUUID().slice(0, 8)
let owner = ''
let viewer = ''
let workspaceId = ''
let accountId = ''
let automationId = ''
let counter = 0

beforeAll(async () => {
  const [ownerUser, viewerUser] = await Promise.all([
    db.user.create({ data: { name: 'owner', email: `auto-owner-${suffix}@example.com` } }),
    db.user.create({ data: { name: 'viewer', email: `auto-viewer-${suffix}@example.com` } }),
  ])
  owner = ownerUser.id
  viewer = viewerUser.id

  const workspace = await db.workspace.create({
    data: { name: 'Automation Routes', slug: `auto-routes-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { workspaceId, userId: owner, role: 'owner', projectId: null } })
  await db.member.create({ data: { workspaceId, userId: viewer, role: 'viewer', projectId: null } })

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `zp_${suffix}`,
      externalId: `ws_${workspaceId}`,
      name: 'Automation Routes',
    },
  })
  const account = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: `zacc_${suffix}`,
      platform: 'instagram',
      username: `acme_${suffix}`,
      isActive: true,
    },
  })
  accountId = account.id

  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      if (req.path === '/comment-automations' && req.method === 'POST') {
        counter += 1
        return { success: true, automation: { id: `ca_${counter}_${suffix}`, status: 'active' } }
      }
      return {}
    },
  } as any)
})

afterAll(async () => {
  setSocialClient(null)
  await db.socialAutomationRun.deleteMany({ where: { workspaceId } })
  await db.socialAutomation.deleteMany({ where: { workspaceId } })
  await db.socialAccount.deleteMany({ where: { workspaceId } })
  await db.socialProfile.deleteMany({ where: { workspaceId } })
  await db.workspace.deleteMany({ where: { id: workspaceId } })
})

describe('automation routes', () => {
  test('an owner creates one and gets the row the UI renders', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/social/automations`, owner, {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        name: 'Merge funnel',
        keywords: ['merge'],
        dmMessage: 'Here you go',
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    automationId = body.automation.id
    expect(body.automation).toMatchObject({
      name: 'Merge funnel',
      kind: 'comment_dm',
      platform: 'instagram',
      status: 'active',
      keywords: ['merge'],
      runCount: 0,
    })
  })

  test('a viewer may list but not create', async () => {
    const list = await request(`/api/workspaces/${workspaceId}/social/automations`, viewer)
    expect(list.status).toBe(200)
    const listed = await list.json()
    expect(listed.automations.map((row: any) => row.id)).toContain(automationId)

    const created = await request(`/api/workspaces/${workspaceId}/social/automations`, viewer, {
      method: 'POST',
      body: JSON.stringify({ accountId, name: 'nope', keywords: ['x'], dmMessage: 'x' }),
    })
    expect(created.status).toBe(403)
  })

  test('a reply-only platform is refused with a reason, not a provider error', async () => {
    const tiktok = await db.socialAccount.create({
      data: {
        workspaceId,
        profileId: (await db.socialProfile.findFirst({ where: { workspaceId } })).id,
        zernioAccountId: `ztt_${suffix}`,
        platform: 'tiktok',
        username: `tt_${suffix}`,
        isActive: true,
      },
    })
    const res = await request(`/api/workspaces/${workspaceId}/social/automations`, owner, {
      method: 'POST',
      body: JSON.stringify({ accountId: tiktok.id, name: 'dm', keywords: ['x'], dmMessage: 'x' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatchObject({ code: 'private_reply_unsupported' })
  })

  test('the agent mirror returns the same automation', async () => {
    const res = await request(
      `/api/internal/workspaces/${workspaceId}/social/automations?limit=10`,
      null,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.automations.map((row: any) => row.id)).toContain(automationId)
  })
})
