// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Approve and Deny buttons on a mirrored approval card: the Block Kit Slack
 * gets, and who is allowed to press them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const approvals = await import('../services/conversation-approvals')
const actions = await import('../services/chat-providers/approval-actions')
const installations = await import('../services/chat-providers/installations')
const { slackBlocks, APPROVAL_ACTION_PREFIX } = await import('../services/chat-providers/slack')
const teamChannels = await import('../services/conversation-team-channels')

const db = prisma as any
let seed: SeededWorkspace
let builder: string
let channel: string
const TEAM = 'T-ACME'
const SLACK_OWNER = 'U-OWNER'
const SLACK_VIEWER = 'U-VIEWER'
const SLACK_STRANGER = 'U-STRANGER'

let answers: string[] = []
const respond = async (i: { decision: string }) => { answers.push(i.decision); return true }

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  builder = (await db.project.create({ data: { name: 'Builder', workspaceId: seed.workspaceId } })).id
  const { channel: ch } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name: 'eng', agents: [{ projectId: builder, agentTrigger: 'mention' }], userEmails: [],
  })
  channel = ch.id
  await installations.upsertInstallation({ workspaceId: seed.workspaceId, provider: 'slack', externalTenantId: TEAM })
  await installations.linkIdentity({ provider: 'slack', externalTenantId: TEAM, externalUserId: SLACK_OWNER, userId: seed.owner })
  await installations.linkIdentity({ provider: 'slack', externalTenantId: TEAM, externalUserId: SLACK_VIEWER, userId: seed.viewer })
})

beforeEach(() => {
  answers = []
  approvals._resetApprovalsForTests()
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function card(): Promise<string> {
  const id = await approvals.postApprovalCard({
    conversationId: channel,
    workspaceId: seed.workspaceId,
    threadRootId: null,
    agent: { projectId: builder, name: 'Builder' },
    sessionId: 'sess-1',
    request: { id: `perm-${crypto.randomUUID()}`, toolName: 'github_merge_pr', params: { number: 12 }, timeout: 900 },
  })
  return id!
}

describe('Slack blocks', () => {
  test('buttons render under the text, with action ids the interactions route recognizes', () => {
    const blocks = slackBlocks('**Builder needs approval** — Merge pull request #12', approvals.approvalActions('m1'))!
    expect(blocks).toHaveLength(2)
    expect((blocks[0] as any).text.text).toContain('Merge pull request #12')
    const buttons = (blocks[1] as any).elements
    expect(buttons.map((b: any) => [b.action_id, b.value, b.style])).toEqual([
      [`${APPROVAL_ACTION_PREFIX}approve`, 'm1:approve', 'primary'],
      [`${APPROVAL_ACTION_PREFIX}deny`, 'm1:deny', 'danger'],
    ])
  })
  test('a settled card keeps its text block but drops the buttons; plain messages send no blocks', () => {
    expect(slackBlocks('Approved by Ada', [])).toHaveLength(1)
    expect(slackBlocks('hello', undefined)).toBeUndefined()
  })
})

describe('pressing a button', () => {
  test('a linked teammate approves', async () => {
    const id = await card()
    const res = await actions.handleApprovalPress({ provider: 'slack', tenantId: TEAM, externalUserId: SLACK_OWNER, value: `${id}:approve` }, respond)
    expect(res).toEqual({ ok: true, message: 'Approved.' })
    expect(answers).toEqual(['allow_once'])
    const row = await db.conversationMessage.findUnique({ where: { id } })
    expect(row.blocks.approval.status).toBe('approved')
    expect(row.blocks.approval.decidedBy.userId).toBe(seed.owner)
  })

  test('the second press is told someone already answered', async () => {
    const id = await card()
    await actions.handleApprovalPress({ provider: 'slack', tenantId: TEAM, externalUserId: SLACK_OWNER, value: `${id}:deny` }, respond)
    const again = await actions.handleApprovalPress({ provider: 'slack', tenantId: TEAM, externalUserId: SLACK_OWNER, value: `${id}:approve` }, respond)
    expect(again.ok).toBe(false)
    expect(again.message).toContain('Already denied')
    expect(answers).toEqual(['deny'])
  })

  test('someone who has not linked their account is asked to, and nothing is answered', async () => {
    const id = await card()
    const res = await actions.handleApprovalPress({ provider: 'slack', tenantId: TEAM, externalUserId: SLACK_STRANGER, value: `${id}:approve` }, respond)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('Link your Shogo account')
    expect(answers).toHaveLength(0)
  })

  test('the legacy Slack link table works as a fallback', async () => {
    const id = await card()
    const res = await actions.handleApprovalPress(
      { provider: 'slack', tenantId: TEAM, externalUserId: SLACK_STRANGER, value: `${id}:approve` },
      respond,
      async () => seed.member,
    )
    expect(res.ok).toBe(true)
  })

  test('viewers cannot approve', async () => {
    const id = await card()
    const res = await actions.handleApprovalPress({ provider: 'slack', tenantId: TEAM, externalUserId: SLACK_VIEWER, value: `${id}:approve` }, respond)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('permission')
    expect(answers).toHaveLength(0)
  })

  test('a button from another Slack workspace cannot answer this workspace\'s card', async () => {
    const id = await card()
    await installations.upsertInstallation({ workspaceId: seed.otherWorkspaceId, provider: 'slack', externalTenantId: 'T-OTHER' })
    await installations.linkIdentity({ provider: 'slack', externalTenantId: 'T-OTHER', externalUserId: 'U-X', userId: seed.owner })
    const res = await actions.handleApprovalPress({ provider: 'slack', tenantId: 'T-OTHER', externalUserId: 'U-X', value: `${id}:approve` }, respond)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('different workspace')
    expect(answers).toHaveLength(0)
  })

  test('malformed or stale values are rejected', async () => {
    const press = (value: string) => actions.handleApprovalPress({ provider: 'slack', tenantId: TEAM, externalUserId: SLACK_OWNER, value }, respond)
    expect((await press('nonsense')).ok).toBe(false)
    expect((await press('abc:maybe')).ok).toBe(false)
    expect((await press('missing-id:approve')).message).toContain('no longer exists')
    expect(actions.parseApprovalValue('a:b:approve')).toEqual({ messageId: 'a:b', decision: 'approve' })
  })
})
