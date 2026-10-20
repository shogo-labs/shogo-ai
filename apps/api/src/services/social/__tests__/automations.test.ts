// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Comment→DM automations (SHO-71 P5).
 *
 * The provider runs the automation, so what these tests hold are the two things
 * we own: the platform rule (a DM is only asked for where a private reply
 * exists) and the row we mirror (what the run webhooks, analytics and the relay
 * all resolve against).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { setSocialClient, SocialError } = await import('../client')
const {
  automationCapability,
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  planAutomationRequest,
  recordAutomationRun,
  setAutomationStatus,
} = await import('../automations.service')
const { socialAnalytics } = await import('../analytics.service')

const db = prisma as any

interface Call {
  method: string
  path: string
  body?: any
}

let calls: Call[] = []
let workspaceId = ''
let instagramAccountId = ''
let tiktokAccountId = ''
let xAccountId = ''
let profileCounter = 0

const suffix = crypto.randomUUID().slice(0, 8)

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { name: `automations-${suffix}`, slug: `automations-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: `zp_${suffix}`,
      externalId: `ws_${workspaceId}`,
      name: 'Automations',
    },
  })
  const mk = async (platform: string, username: string) => {
    const row = await db.socialAccount.create({
      data: {
        workspaceId,
        profileId: profile.id,
        zernioAccountId: `zacc_${platform}_${suffix}`,
        platform,
        username,
        isActive: true,
      },
    })
    return row.id as string
  }
  instagramAccountId = await mk('instagram', `ig_${suffix}`)
  tiktokAccountId = await mk('tiktok', `tt_${suffix}`)
  xAccountId = await mk('x', `x_${suffix}`)
})

beforeEach(() => {
  calls = []
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push({ method: req.method, path: req.path, body: req.body })
      if (req.path === '/comment-automations' && req.method === 'POST') {
        profileCounter += 1
        return { success: true, automation: { id: `ca_${profileCounter}_${suffix}`, status: 'active' } }
      }
      if (req.path === '/workflows' && req.method === 'POST') {
        profileCounter += 1
        return { success: true, workflow: { id: `wf_${profileCounter}_${suffix}`, status: 'draft' } }
      }
      if (req.path.endsWith('/activate')) {
        return { success: true, workflow: { status: 'active' } }
      }
      return {}
    },
  } as any)
})

afterAll(async () => {
  setSocialClient(null)
  const automations = await db.socialAutomation.findMany({ where: { workspaceId } })
  await db.socialAutomationRun.deleteMany({ where: { workspaceId } })
  await db.socialAutomation.deleteMany({ where: { workspaceId } })
  void automations
  await db.socialAccount.deleteMany({ where: { workspaceId } })
  await db.socialProfile.deleteMany({ where: { workspaceId } })
  await db.workspace.deleteMany({ where: { id: workspaceId } })
})

describe('platform rules', () => {
  test('only Instagram and Facebook can answer a comment with a DM', () => {
    expect(automationCapability('instagram').privateReply).toBe(true)
    expect(automationCapability('facebook').privateReply).toBe(true)
    expect(automationCapability('tiktok').privateReply).toBe(false)
    expect(automationCapability('tiktok').publicReply).toBe(true)
    expect(automationCapability('x').refused).toBe(true)
  })

  test('a comment→DM on a reply-only platform is refused before the provider is called', async () => {
    await expect(
      createAutomation(workspaceId, {
        accountId: tiktokAccountId,
        name: 'Merge',
        keywords: ['merge'],
        dmMessage: 'Here you go',
      }),
    ).rejects.toMatchObject({ code: 'private_reply_unsupported', status: 400 })
    expect(calls).toHaveLength(0)
  })

  test('a reply-only automation needs its public reply and never sends DM fields', async () => {
    await expect(
      createAutomation(workspaceId, {
        accountId: tiktokAccountId,
        kind: 'keyword_reply',
        name: 'Public',
        keywords: ['merge'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_body' })

    const created = await createAutomation(workspaceId, {
      accountId: tiktokAccountId,
      kind: 'keyword_reply',
      name: 'Public merge',
      keywords: ['merge'],
      commentReply: 'Sent you a DM',
    })
    const sent = calls.find((call) => call.path === '/comment-automations')!
    expect(sent.body.dmMessage).toBeUndefined()
    expect(sent.body.commentReply).toBe('Sent you a DM')
    expect(created.status).toBe('active')
  })

  test('X is refused: its comment polling is off, so nothing could ever fire', async () => {
    await expect(
      createAutomation(workspaceId, {
        accountId: xAccountId,
        name: 'X',
        keywords: ['merge'],
        dmMessage: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'platform_not_supported' })
    expect(calls).toHaveLength(0)
  })

  test('a sequence is a comment-triggered workflow that is activated on create', async () => {
    const created = await createAutomation(workspaceId, {
      accountId: instagramAccountId,
      kind: 'sequence',
      name: 'Merge funnel',
      keywords: ['merge'],
      messages: [{ text: 'Here is the link' }, { text: 'Any questions?' }],
    })

    const create = calls.find((call) => call.path === '/workflows')!
    expect(create.body.nodes[0]).toMatchObject({ type: 'trigger' })
    expect(create.body.nodes[0].config.triggerType).toBe('comment')
    expect(create.body.nodes.filter((node: any) => node.type === 'send_message')).toHaveLength(2)
    expect(calls.some((call) => call.path.endsWith('/activate'))).toBe(true)
    expect(created.kind).toBe('sequence')
    expect(created.status).toBe('active')
  })

  test('the planning step is pure: the same rules hold without a database', () => {
    expect(() =>
      planAutomationRequest({
        kind: 'comment_dm',
        platform: 'youtube',
        zernioProfileId: 'zp',
        zernioAccountId: 'za',
        name: 'n',
        keywords: [],
        matchMode: 'contains',
        dmMessage: 'hi',
        commentReply: null,
        dmDelaySeconds: 0,
        isActive: true,
      }),
    ).toThrow(SocialError)
  })
})

describe('the row we own', () => {
  let automationId = ''

  test('an automation is stored with the keywords the API will show', async () => {
    const created = await createAutomation(workspaceId, {
      accountId: instagramAccountId,
      name: 'Merge',
      keywords: ['merge', 'MERGE', ' link '],
      dmMessage: 'Here you go',
      commentReply: 'Check your DMs',
    })
    automationId = created.id
    expect(created.keywords).toEqual(['merge', 'link'])
    expect(created.runCount).toBe(0)

    const listed = await listAutomations(workspaceId, { kind: 'comment_dm' })
    expect(listed.map((row: any) => row.id)).toContain(automationId)
    const fetched = await getAutomation(workspaceId, automationId)
    expect(fetched.automation ?? fetched).toMatchObject({ id: automationId })
  })

  test('pause and resume reach the provider before the row changes', async () => {
    const paused = await setAutomationStatus(workspaceId, automationId, 'paused')
    expect(paused.status).toBe('paused')
    const patch = calls.find((call) => call.method === 'PATCH')!
    expect(patch.body).toEqual({ isActive: false })

    const active = await setAutomationStatus(workspaceId, automationId, 'active')
    expect(active.status).toBe('active')
  })

  test('a run is recorded once per provider execution, however often it is delivered', async () => {
    const row = await db.socialAutomation.findUnique({ where: { id: automationId } })
    const detail = { executionId: `exec_${suffix}`, workflowId: row.zernioResourceId, status: 'completed' }

    const first = await recordAutomationRun({ workspaceId, detail, failed: false })
    const second = await recordAutomationRun({ workspaceId, detail, failed: false })
    expect(first.recorded).toBe(true)
    expect(second.recorded).toBe(true)

    const runs = await db.socialAutomationRun.findMany({ where: { workspaceId, automationId } })
    expect(runs).toHaveLength(1)
    const after = await db.socialAutomation.findUnique({ where: { id: automationId } })
    expect(after.runCount).toBe(1)
  })

  test('analytics counts the runs in the range and the automations behind them', async () => {
    const now = new Date()
    const analytics = await socialAnalytics(workspaceId, {
      from: new Date(now.getTime() - 86_400_000),
      to: new Date(now.getTime() + 60_000),
    })
    expect(analytics.engagement.automationRuns).toBe(1)
    expect(analytics.engagement.automations.active + analytics.engagement.automations.paused).toBeGreaterThan(0)
  })

  test('delete removes it at the provider first, so nothing keeps sending DMs', async () => {
    await deleteAutomation(workspaceId, automationId)
    expect(calls.some((call) => call.method === 'DELETE' && call.path.startsWith('/comment-automations/'))).toBe(true)
    await expect(getAutomation(workspaceId, automationId)).rejects.toMatchObject({
      code: 'automation_not_found',
    })
  })

  test('another workspace cannot read or change an automation', async () => {
    const other = await db.workspace.create({
      data: { name: `other-${suffix}`, slug: `other-${suffix}`, kind: 'team' },
    })
    const created = await createAutomation(workspaceId, {
      accountId: instagramAccountId,
      name: 'Mine',
      keywords: ['mine'],
      dmMessage: 'hello',
    })
    await expect(getAutomation(other.id, created.id)).rejects.toMatchObject({
      code: 'automation_not_found',
    })
    await expect(deleteAutomation(other.id, created.id)).rejects.toMatchObject({
      code: 'automation_not_found',
    })
    await db.workspace.delete({ where: { id: other.id } })
  })
})
