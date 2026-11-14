// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-389: the Personal workspace agent may act in the person's other
 * workspaces — reads free, every write approved once and spent on use.
 *
 * The authorizer is the whole contract, so this exercises it directly against a
 * real SQLite database rather than through forty route mounts: same-workspace
 * calls unchanged, a project agent and a team workspace refused, a non-member
 * refused, and each of the four ways an approval can be unusable refused with
 * `approval_required`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'sho-389-test-secret'

const { prisma } = await import('../lib/prisma')
const { createInternalAuthorizers, scopeRequesterUserId } = await import('../routes/internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')
const { argsHash, mintCrossWorkspaceApproval, spendCrossWorkspaceApproval } = await import('../lib/cross-workspace')

const db = prisma as any

let personalWorkspaceId: string
let targetWorkspaceId: string
let strangerWorkspaceId: string
let ownerId: string
let personalToken: string
let teamToken: string

const authenticate = async (c: any) => {
  const token = c.req.header('x-runtime-token')
  if (!token) return null
  const { verifyWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
  const verified = verifyWorkspaceRuntimeToken(token)
  return verified.ok ? { kind: 'workspace' as const, workspaceId: verified.workspaceId } : null
}

const authorizers = createInternalAuthorizers(authenticate)

/** A route that does nothing but run the authorizer and report the outcome. */
function appWith(get: (a: typeof authorizers) => any) {
  const app = new Hono()
  app.all('/probe/:workspaceId', async (c) => {
    const result = await get(authorizers)(c, c.req.param('workspaceId'), undefined, { write: validateWrite(c) })
    return c.json({ ok: result.ok, code: result.ok ? null : result.code, message: result.ok ? null : result.message, userId: scopeRequesterUserId(c) })
  })
  return app
}

function validateWrite(c: any) {
  return c.req.method !== 'GET'
}

const crossProbe = appWith((a) => a.authorizeCrossWorkspace)
const scopeProbe = (() => {
  const app = new Hono()
  app.all('/probe/:workspaceId', async (c) => {
    const ok = await authorizers.authorizeWorkspaceScope(c, c.req.param('workspaceId'))
    const body = ok ? { ok: true, userId: scopeRequesterUserId(c) } : await (await import('../routes/internal-runtime-auth')).scopeDenied(c).json().then((j: any) => ({ ok: false, ...j.error }))
    return c.json(body, ok ? 200 : 403)
  })
  return app
})()

const ticketFor = (workspaceId: string, userId: string) =>
  signRequesterTicket({ projectId: workspaceTicketKey(workspaceId), userId })

async function probe(
  app: Hono,
  method: string,
  workspaceId: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await app.request(`http://local/probe/${workspaceId}`, { method, headers })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const owner = await db.user.create({ data: { name: 'owner', email: `owner-${suffix}@example.com` } })
  const stranger = await db.user.create({ data: { name: 'stranger', email: `stranger-${suffix}@example.com` } })
  ownerId = owner.id

  const personal = await db.workspace.create({
    data: { name: 'Personal', slug: `personal-${suffix}`, kind: 'personal', personalOwnerId: owner.id },
  })
  const target = await db.workspace.create({ data: { name: 'Samsara Game', slug: `samsara-${suffix}`, kind: 'team' } })
  const strangerWs = await db.workspace.create({ data: { name: 'Not mine', slug: `notmine-${suffix}`, kind: 'team' } })

  personalWorkspaceId = personal.id
  targetWorkspaceId = target.id
  strangerWorkspaceId = strangerWs.id

  await db.member.create({ data: { userId: owner.id, workspaceId: personal.id, role: 'owner', projectId: null } })
  await db.member.create({ data: { userId: owner.id, workspaceId: target.id, role: 'owner', projectId: null } })
  await db.member.create({ data: { userId: stranger.id, workspaceId: strangerWs.id, role: 'owner', projectId: null } })

  personalToken = deriveWorkspaceRuntimeToken(personal.id)
  teamToken = deriveWorkspaceRuntimeToken(target.id)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('authorizeCrossWorkspace', () => {
  test('a call in the runtime’s own workspace is unchanged', async () => {
    const r = await probe(crossProbe, 'GET', teamToken ? targetWorkspaceId : '', { 'x-runtime-token': teamToken })
    expect(r.json.ok).toBe(true)
  })

  test('the Personal workspace agent reads another workspace with its requester ticket', async () => {
    const r = await probe(crossProbe, 'GET', targetWorkspaceId, {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
    })
    expect(r.json).toEqual({ ok: true, code: null, message: null, userId: ownerId })
  })

  test('a team workspace agent cannot act in another workspace', async () => {
    const r = await probe(crossProbe, 'GET', strangerWorkspaceId, {
      'x-runtime-token': teamToken,
      'X-Requester-Ticket': ticketFor(targetWorkspaceId, ownerId),
    })
    expect(r.json.code).toBe('cross_workspace_forbidden')
  })

  test('without a requester ticket it is refused, and says so', async () => {
    const r = await probe(crossProbe, 'GET', targetWorkspaceId, { 'x-runtime-token': personalToken })
    expect(r.json.code).toBe('requester_ticket_required')
  })

  test('a ticket for someone who does not own the Personal workspace is refused', async () => {
    const r = await probe(crossProbe, 'GET', targetWorkspaceId, {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, 'someone-else'),
    })
    expect(r.json.code).toBe('not_personal_owner')
  })

  test('a workspace the person is not a member of is refused, naming membership', async () => {
    const r = await probe(crossProbe, 'GET', strangerWorkspaceId, {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
    })
    expect(r.json.code).toBe('not_a_member')
    expect(String(r.json.message)).toContain('member')
  })

  test('a write with no approval header is approval_required', async () => {
    const r = await probe(crossProbe, 'POST', targetWorkspaceId, {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
    })
    expect(r.json.code).toBe('approval_required')
  })

  test('an approved write is allowed once and never again', async () => {
    const hash = argsHash({ item: 'SAM-12', column: 'Done' })
    const minted = await mintCrossWorkspaceApproval({
      callerWorkspaceId: personalWorkspaceId,
      targetWorkspaceId,
      tool: 'work_item_move',
      argsHash: hash,
      requesterUserId: ownerId,
    })
    const headers = {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
      'X-Cross-Workspace-Approval': minted.id,
      'X-Cross-Workspace-Tool': 'work_item_move',
      'X-Cross-Workspace-Args-Hash': hash,
    }
    const first = await probe(crossProbe, 'POST', targetWorkspaceId, headers)
    expect(first.json.ok).toBe(true)
    expect(first.json.userId).toBe(ownerId)
    const second = await probe(crossProbe, 'POST', targetWorkspaceId, headers)
    expect(second.json.code).toBe('approval_required')
  })

  test('an approval for other arguments is refused', async () => {
    const minted = await mintCrossWorkspaceApproval({
      callerWorkspaceId: personalWorkspaceId,
      targetWorkspaceId,
      tool: 'work_item_move',
      argsHash: argsHash({ item: 'SAM-12', column: 'Done' }),
      requesterUserId: ownerId,
    })
    const r = await probe(crossProbe, 'POST', targetWorkspaceId, {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
      'X-Cross-Workspace-Approval': minted.id,
      'X-Cross-Workspace-Tool': 'work_item_move',
      'X-Cross-Workspace-Args-Hash': argsHash({ item: 'SAM-13', column: 'Done' }),
    })
    expect(r.json.code).toBe('approval_required')
  })

  test('an approval for another tool is refused', async () => {
    const hash = argsHash({ channel: 'general', text: 'hi' })
    const minted = await mintCrossWorkspaceApproval({
      callerWorkspaceId: personalWorkspaceId,
      targetWorkspaceId,
      tool: 'team_chat_post',
      argsHash: hash,
      requesterUserId: ownerId,
    })
    const r = await probe(crossProbe, 'POST', targetWorkspaceId, {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
      'X-Cross-Workspace-Approval': minted.id,
      'X-Cross-Workspace-Tool': 'work_item_move',
      'X-Cross-Workspace-Args-Hash': hash,
    })
    expect(r.json.code).toBe('approval_required')
  })

  test('an expired approval is refused', async () => {
    const hash = argsHash({ item: 'SAM-12' })
    const minted = await mintCrossWorkspaceApproval({
      callerWorkspaceId: personalWorkspaceId,
      targetWorkspaceId,
      tool: 'work_item_get',
      argsHash: hash,
      requesterUserId: ownerId,
      ttlMs: -1,
    })
    const spent = await spendCrossWorkspaceApproval({
      approvalId: minted.id,
      targetWorkspaceId,
      tool: 'work_item_get',
      argsHash: hash,
    })
    expect(spent.ok).toBe(false)
    expect((spent as any).code).toBe('approval_required')
  })

  test('the boolean scope authorizer carries the same refusal code', async () => {
    const r = await probe(scopeProbe, 'GET', strangerWorkspaceId, {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
    })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('not_a_member')
  })
})
