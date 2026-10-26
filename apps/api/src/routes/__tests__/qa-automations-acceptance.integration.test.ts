// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P5 acceptance — acceptance criterion 4, end to end.
 *
 * A comment→DM is created from the product surface, refused where the platform
 * cannot send one, and its executions come back as provider webhooks that the
 * analytics surface reports. Each piece is unit-tested; this file is the only
 * place the whole chain runs — create → provider id → `workflow.run.*` → the
 * count a person reads — because a broken id handoff between those steps looks
 * like three green suites.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

process.env.ZERNIO_WEBHOOK_SECRET = 'whsec_sho71_p5'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { socialRoutes, socialWebhookRoutes } = await import('../social')
const { setSocialClient } = await import('../../services/social/client')

const db = prisma as any

const app = new Hono()
app.use('*', async (c, next) => {
  const userId = c.req.header('x-user')
  c.set('auth', { userId, isAuthenticated: !!userId } as never)
  await next()
})
app.route('/api', socialRoutes({ resolveUserId: async (c: any) => c.get('auth')?.userId ?? null }))
app.route('/api', socialWebhookRoutes())

const suffix = crypto.randomUUID().slice(0, 8)
let userId = ''
let workspaceId = ''
let instagramAccount = ''
let tiktokAccount = ''
const calls: any[] = []

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api${path}`, {
    ...init,
    headers: {
      'x-user': userId,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  })

const webhook = (body: string, eventId: string) =>
  app.request('/api/webhooks/zernio', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-zernio-event-id': eventId,
      'x-zernio-signature': createHmac('sha256', process.env.ZERNIO_WEBHOOK_SECRET!).update(body).digest('hex'),
    },
  })

const runEvent = (workflowId: string, executionId: string) =>
  JSON.stringify({
    type: 'workflow.run.completed',
    profiles: [{ id: 'zp', externalId: `ws_${workspaceId}` }],
    run: { executionId, workflowId, status: 'completed' },
  })

beforeAll(async () => {
  const user = await db.user.create({ data: { name: 'qa', email: `qa-p5-${suffix}@example.com` } })
  userId = user.id
  const workspace = await db.workspace.create({
    data: { name: 'QA P5', slug: `qa-p5-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  await db.member.create({ data: { workspaceId, userId, role: 'owner', projectId: null } })

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `zp_p5_${suffix}`,
      externalId: `ws_${workspaceId}`,
      name: 'QA P5',
    },
  })
  const [ig, tt] = await Promise.all([
    db.socialAccount.create({
      data: {
        workspaceId,
        profileId: profile.id,
        zernioAccountId: `zacc_ig_${suffix}`,
        platform: 'instagram',
        username: 'qa.ig',
        isActive: true,
      },
    }),
    db.socialAccount.create({
      data: {
        workspaceId,
        profileId: profile.id,
        zernioAccountId: `zacc_tt_${suffix}`,
        platform: 'tiktok',
        username: 'qa.tt',
        isActive: true,
      },
    }),
  ])
  instagramAccount = ig.id
  tiktokAccount = tt.id
})

beforeEach(() => {
  calls.length = 0
  let seq = 0
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.method === 'POST' && req.path === '/profiles') {
        return { id: `zp_created_${suffix}`, externalId: req.body?.externalId }
      }
      if (req.method === 'POST' && req.path === '/comment-automations') {
        seq += 1
        return { id: `ca_${seq}_${suffix}`, status: 'active' }
      }
      if (req.method === 'POST' && req.path === '/workflows') {
        seq += 1
        return { id: `wf_${seq}_${suffix}`, status: 'draft' }
      }
      if (req.method === 'POST' && req.path.endsWith('/activate')) {
        return { id: req.path.split('/')[2], status: 'active' }
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
  await db.member.deleteMany({ where: { workspaceId } })
  await db.workspace.deleteMany({ where: { id: workspaceId } })
  await db.user.deleteMany({ where: { id: userId } })
})

describe('AC4 — a comment→DM a workspace can actually run', () => {
  test('Instagram creates a private-reply automation with the DM it will send', async () => {
    const response = await call(`/workspaces/${workspaceId}/social/automations`, {
      method: 'POST',
      body: JSON.stringify({
        accountId: instagramAccount,
        kind: 'comment_dm',
        name: 'Merge funnel',
        keywords: ['MERGE', 'merge'],
        dmMessage: 'Here is the link you asked for.',
        commentReply: 'Sent you a DM!',
      }),
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as any
    expect(body.automation.kind).toBe('comment_dm')
    expect(body.automation.status).toBe('active')
    // The duplicate keyword was collapsed, so one comment cannot match twice.
    expect(body.automation.keywords).toEqual(['MERGE'])

    const providerCall = calls.find((entry) => entry.path === '/comment-automations')
    expect(providerCall.body.dmMessage).toBe('Here is the link you asked for.')
    expect(providerCall.body.isActive).toBe(true)
  })

  test('TikTok refuses a comment→DM before anything is sent to the provider', async () => {
    const response = await call(`/workspaces/${workspaceId}/social/automations`, {
      method: 'POST',
      body: JSON.stringify({
        accountId: tiktokAccount,
        kind: 'comment_dm',
        name: 'No private reply here',
        keywords: ['MERGE'],
        dmMessage: 'should never be sent',
      }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as any
    expect(body.error.code).toBe('private_reply_unsupported')
    // Refused locally: a provider call would have failed anyway, with a worse message.
    expect(calls.filter((entry) => entry.path === '/comment-automations')).toHaveLength(0)
  })

  test('a sequence is activated on create and its runs are what analytics reports', async () => {
    const response = await call(`/workspaces/${workspaceId}/social/automations`, {
      method: 'POST',
      body: JSON.stringify({
        accountId: instagramAccount,
        kind: 'sequence',
        name: 'Three-step funnel',
        keywords: ['GUIDE'],
        messages: [{ text: 'Here it is' }, { text: 'Any questions?' }],
      }),
    })
    expect(response.status).toBe(201)
    const { automation } = (await response.json()) as any
    expect(automation.status).toBe('active')

    // A workflow is created as a draft, so activation has to be part of the create.
    expect(calls.some((entry) => entry.path === `/workflows/${automation.zernioResourceId}/activate`)).toBe(true)

    const run = (executionId: string) => runEvent(automation.zernioResourceId, executionId)
    await webhook(run(`exec_a_${suffix}`), `evt_a_${suffix}`)
    await webhook(run(`exec_a_${suffix}`), `evt_a_${suffix}`)
    await webhook(run(`exec_b_${suffix}`), `evt_b_${suffix}`)

    // Two executions, one redelivery: the provider id the create returned is what
    // routes a run back to this row, and a redelivery must not inflate the count.
    const stored = await call(`/workspaces/${workspaceId}/social/automations/${automation.id}`)
    expect(((await stored.json()) as any).automation.runCount).toBe(2)

    const analytics = await call(`/workspaces/${workspaceId}/social/analytics`)
    expect(analytics.status).toBe(200)
    const summary = (await analytics.json()) as any
    expect(summary.engagement.automationRuns).toBe(2)
  })
})
