// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-389 e2e: the Personal workspace agent acting in the person's other
 * workspaces, through the real internal routes on a real SQLite database.
 *
 * Covers the acceptance criteria the unit tests cannot: criterion 1 (a read
 * answers for the target, a project agent is refused), 2 (a workspace the
 * person isn't in names membership; a private channel stays hidden), 4 (every
 * write asks, twice; an approved write lands, attributed to the person) and 6
 * (`project_call` starts nothing until approved, then carries the person's
 * handed-off ticket). Criteria 5, 7 and 8 are pinned by
 * `sho-389-cross-workspace.test.ts` and `sho-389-cross-workspace-relay.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'sho-389-e2e-secret'

const { prisma } = await import('../lib/prisma')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { authenticate } = await import('../routes/internal-auth')
const { deriveWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')
const { argsHash, mintCrossWorkspaceApproval } = await import('../lib/cross-workspace')

const db = prisma as any

interface AgentCall {
  projectId: string
  workspaceId: string
  opts: Record<string, any>
}
let agentCalls: AgentCall[] = []

const app = new Hono()
app.route(
  '/api/internal',
  runtimeInternalRoutes({
    authenticate,
    loadAgentCall: async () =>
      ({
        callProjectAgentAsChat: async (_c: any, projectId: string, workspaceId: string, opts: any) => {
          agentCalls.push({ projectId, workspaceId, opts })
          return { status: 200, body: { ok: true, runId: 'run-1' } }
        },
      }) as any,
  } as any),
)

let ownerId: string
let personalId: string
let personalProjectId: string
let targetId: string
let targetProjectId: string
let strangerId: string
let boardRef: string
let personalToken: string
let privateChannelId: string

const headers = (extra: Record<string, string> = {}) => ({
  'x-runtime-token': personalToken,
  'X-Requester-Ticket': signRequesterTicket({ projectId: workspaceTicketKey(personalId), userId: ownerId }),
  ...extra,
})

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await app.request(`http://local/api/internal${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers(extra) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

/** An approval for exactly this tool + args, the way the runtime mints one. */
async function approve(tool: string, args: unknown, target = targetId) {
  const hash = argsHash(args)
  const minted = await mintCrossWorkspaceApproval({
    callerWorkspaceId: personalId,
    targetWorkspaceId: target,
    tool,
    argsHash: hash,
    requesterUserId: ownerId,
  })
  return {
    'X-Cross-Workspace-Approval': minted.id,
    'X-Cross-Workspace-Tool': tool,
    'X-Cross-Workspace-Args-Hash': hash,
  }
}

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const owner = await db.user.create({ data: { name: 'Russell', email: `owner-${suffix}@example.com` } })
  ownerId = owner.id

  const personal = await db.workspace.create({
    data: { name: 'Personal', slug: `personal-${suffix}`, kind: 'personal', personalOwnerId: owner.id },
  })
  personalId = personal.id
  await db.member.create({ data: { userId: owner.id, workspaceId: personal.id, role: 'owner', projectId: null } })
  const personalProject = await db.project.create({ data: { name: 'Personal bot', workspaceId: personal.id } })
  personalProjectId = personalProject.id
  personalToken = deriveWorkspaceRuntimeToken(personal.id)

  const target = await db.workspace.create({ data: { name: 'Samsara Game', slug: `samsara-${suffix}`, kind: 'team' } })
  targetId = target.id
  await db.member.create({ data: { userId: owner.id, workspaceId: target.id, role: 'owner', projectId: null } })
  targetProjectId = (await db.project.create({ data: { name: 'Samsara bot', workspaceId: target.id } })).id

  const stranger = await db.workspace.create({ data: { name: 'Not mine', slug: `stranger-${suffix}`, kind: 'team' } })
  strangerId = stranger.id

  const general = await db.conversation.create({
    data: { workspaceId: target.id, name: 'general', slug: 'general', kind: 'public' },
  })
  privateChannelId = (
    await db.conversation.create({ data: { workspaceId: target.id, name: 'secret', slug: 'secret', kind: 'private' } })
  ).id
  expect(general.id).toBeTruthy()

  // The board the target owns, created through the agent route with an approval.
  boardRef = 'pipeline'
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('criterion 1 — the Personal agent reads another workspace', () => {
  test('a board summary answers for the target, and a project agent is refused', async () => {
    const created = await call(
      'POST',
      `/workspaces/${targetId}/agent-boards`,
      { name: 'Pipeline', slug: 'pipeline', columns: ['Todo', 'Done'] },
      await approve('board_create', { name: 'Pipeline', slug: 'pipeline', columns: ['Todo', 'Done'] }),
    )
    expect(created.status).toBe(201)
    expect(created.json.board.workspaceId).toBe(targetId)

    const summary = await call('GET', `/workspaces/${targetId}/agent-boards/health?board=${boardRef}`)
    expect(summary.status).toBe(200)

    const asProject = await app.request(`http://local/api/internal/workspaces/${targetId}/agent-boards`, {
      headers: {
        'x-runtime-token': deriveRuntimeToken(personalProjectId),
        'X-Requester-Ticket': signRequesterTicket({ projectId: personalProjectId, userId: ownerId }),
      },
    })
    expect(asProject.status).toBe(403)
    expect((await asProject.json<any>()).error.code).toBe('cross_workspace_forbidden')
  })
})

describe('criterion 2 — the person’s own view', () => {
  test('a workspace he is not in says so', async () => {
    const res = await call('GET', `/workspaces/${strangerId}/agent-boards`)
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('not_a_member')
    expect(res.json.error.message.toLowerCase()).toContain('member')
  })

  test('a private channel in the target is not listed', async () => {
    const res = await call('GET', `/workspaces/${targetId}/agent-channels`)
    expect(res.status).toBe(200)
    const names: string[] = (res.json.channels ?? []).map((c: any) => c.name)
    expect(names).toContain('general')
    expect(names).not.toContain('secret')
    expect(privateChannelId).toBeTruthy()
  })
})

describe('criterion 4 — every write asks, once', () => {
  test('no approval never writes', async () => {
    const before = await db.workItem.count({ where: { workspaceId: targetId } })
    const res = await call('POST', `/workspaces/${targetId}/agent-boards/${boardRef}/items`, { title: 'no approval' })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('approval_required')
    expect(await db.workItem.count({ where: { workspaceId: targetId } })).toBe(before)
  })

  test('an approved write lands, and a second identical call asks again', async () => {
    const body = { title: 'Move NADA-3 to Done' }
    const granted = await approve('work_item_create', body)
    const first = await call('POST', `/workspaces/${targetId}/agent-boards/${boardRef}/items`, body, granted)
    expect(first.status).toBe(201)
    expect(first.json.item.workspaceId).toBe(targetId)

    const replay = await call('POST', `/workspaces/${targetId}/agent-boards/${boardRef}/items`, body, granted)
    expect(replay.status).toBe(403)
    expect(replay.json.error.code).toBe('approval_required')
  })

  test('a channel post carries the person it was made for', async () => {
    const body = { text: 'Card SAM-12 is in review', kind: 'status' }
    const res = await call('POST', `/workspaces/${targetId}/agent-channels/general/messages`, body, await approve('team_chat_post', body))
    expect(res.status).toBeLessThan(300)
    const messageId = res.json?.message?.id ?? res.json?.id
    const row = await db.conversationMessage.findUnique({ where: { id: messageId } })
    expect(row.workspaceId).toBe(targetId)
    expect(row.blocks?.onBehalfOf?.userId).toBe(ownerId)
  })

  test('an approval cannot be spent with a different tool or argument hash', async () => {
    const granted = await approve('work_item_create', { title: 'approved' })
    const otherHash = await call('POST', `/workspaces/${targetId}/agent-boards/${boardRef}/items`, { title: 'other' }, {
      ...granted,
      'X-Cross-Workspace-Args-Hash': argsHash({ title: 'other' }),
    })
    expect(otherHash.status).toBe(403)
    expect(otherHash.json.error.code).toBe('approval_required')

    const otherTool = await call('POST', `/workspaces/${targetId}/agent-boards/${boardRef}/items`, { title: 'approved' }, {
      ...granted,
      'X-Cross-Workspace-Tool': 'work_item_move',
    })
    expect(otherTool.status).toBe(403)
    expect(otherTool.json.error.code).toBe('approval_required')
  })
})

describe('criterion 6 — project_call waits for the approval', () => {
  test('without an approval the callee never runs', async () => {
    agentCalls = []
    const res = await call('POST', `/projects/${targetProjectId}/agent-call`, { message: 'triage SAM-12' })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('approval_required')
    expect(agentCalls).toHaveLength(0)
  })

  test('with one it runs, carrying the person’s handed-off ticket', async () => {
    agentCalls = []
    const body = { message: 'triage SAM-12' }
    const res = await call('POST', `/projects/${targetProjectId}/agent-call`, body, await approve('project_call', body))
    expect(res.status).toBe(200)
    expect(agentCalls).toHaveLength(1)
    expect(agentCalls[0].projectId).toBe(targetProjectId)
    expect(agentCalls[0].workspaceId).toBe(targetId)
    expect(typeof agentCalls[0].opts.requesterTicket).toBe('string')
    expect(agentCalls[0].opts.requesterTicket.length).toBeGreaterThan(20)
  })
})
