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

/**
 * The half the daily report actually runs from: a signed-in desktop reaching a
 * *cloud* workspace. Those workspaces have no rows in the desktop's SQLite, so
 * membership there cannot be read with `loadAccess` — the per-workspace device
 * key the cloud issued is the proof, and the cloud re-checks its own rows when
 * it runs the call.
 */
describe('a desktop reaching a cloud workspace', () => {
  const CLOUD_TARGET = 'cloud-target-nada'
  const CLOUD_KEY = 'shogo_sk_cloudtargetkey000000000000000000'

  const store = async (input: { user: { id: string } | null; workspaces: Array<{ id: string; key: string }> }) => {
    await db.localConfig.upsert({
      where: { key: 'SHOGO_CLOUD_WORKSPACES' },
      update: {
        value: JSON.stringify({
          enabled: true,
          user: input.user ? { id: input.user.id, name: 'owner', email: 'owner@example.com' } : null,
          workspaces: input.workspaces.map((w) => ({ id: w.id, name: 'Nada', slug: 'nada', kind: 'team', key: w.key })),
          syncedAt: new Date().toISOString(),
        }),
      },
      create: {
        key: 'SHOGO_CLOUD_WORKSPACES',
        value: JSON.stringify({
          enabled: true,
          user: input.user ? { id: input.user.id, name: 'owner', email: 'owner@example.com' } : null,
          workspaces: input.workspaces.map((w) => ({ id: w.id, name: 'Nada', slug: 'nada', kind: 'team', key: w.key })),
          syncedAt: new Date().toISOString(),
        }),
      },
    })
    const { _resetCloudWorkspacesForTests } = await import('../services/cloud-workspaces')
    _resetCloudWorkspacesForTests()
  }

  beforeAll(() => {
    process.env.SHOGO_LOCAL_MODE = 'true'
  })
  afterAll(async () => {
    delete process.env.SHOGO_LOCAL_MODE
    await db.localConfig.deleteMany({ where: { key: 'SHOGO_CLOUD_WORKSPACES' } }).catch(() => undefined)
    const { _resetCloudWorkspacesForTests } = await import('../services/cloud-workspaces')
    _resetCloudWorkspacesForTests()
  })

  test('its home is the cloud, with the key that proves membership', async () => {
    await store({ user: { id: ownerId }, workspaces: [{ id: CLOUD_TARGET, key: CLOUD_KEY }] })
    const { resolveTargetHome } = await import('../lib/cross-workspace')
    expect(await resolveTargetHome(CLOUD_TARGET)).toEqual({ kind: 'cloud', key: CLOUD_KEY })
  })

  test('a read is allowed without a local member row, so the relay can run', async () => {
    await store({ user: { id: ownerId }, workspaces: [{ id: CLOUD_TARGET, key: CLOUD_KEY }] })
    const r = await probe(crossProbe, 'GET', CLOUD_TARGET, {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
    })
    expect(r.json).toEqual({ ok: true, code: null, message: null, userId: ownerId })
  })

  test('a write there is still one approval, spent on use', async () => {
    await store({ user: { id: ownerId }, workspaces: [{ id: CLOUD_TARGET, key: CLOUD_KEY }] })
    const headers = {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
    }
    expect((await probe(crossProbe, 'POST', CLOUD_TARGET, headers)).json.code).toBe('approval_required')

    const hash = argsHash({ column: 'Done' })
    const minted = await mintCrossWorkspaceApproval({
      callerWorkspaceId: personalWorkspaceId,
      targetWorkspaceId: CLOUD_TARGET,
      tool: 'work_item_move',
      argsHash: hash,
      requesterUserId: ownerId,
    })
    const withApproval = {
      ...headers,
      'X-Cross-Workspace-Approval': minted.id,
      'X-Cross-Workspace-Tool': 'work_item_move',
      'X-Cross-Workspace-Args-Hash': hash,
    }
    expect((await probe(crossProbe, 'POST', CLOUD_TARGET, withApproval)).json.ok).toBe(true)
    expect((await probe(crossProbe, 'POST', CLOUD_TARGET, withApproval)).json.code).toBe('approval_required')
  })

  test('a workspace no key was issued for is not a member, and says so', async () => {
    await store({ user: { id: ownerId }, workspaces: [] })
    const r = await probe(crossProbe, 'GET', CLOUD_TARGET, {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
    })
    expect(r.json.code).toBe('not_a_member')
  })

  test('a signed-out desktop answers cloud_signed_out, not a misleading refusal', async () => {
    await store({ user: null, workspaces: [] })
    const r = await probe(crossProbe, 'GET', CLOUD_TARGET, {
      'x-runtime-token': personalToken,
      'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
    })
    expect(r.json.code).toBe('cloud_signed_out')
  })

  test('a relayed call is attributed to its person only from a device key', async () => {
    const { relayedCrossWorkspaceRequester } = await import('../lib/cross-workspace')
    const fake = (headers: Record<string, string>) => ({ req: { header: (n: string) => headers[n] } })
    const named = {
      'X-Cross-Workspace-From': personalWorkspaceId,
      'X-Cross-Workspace-Requester': ownerId,
    }

    expect(await relayedCrossWorkspaceRequester(fake({ ...named, Authorization: `Bearer ${CLOUD_KEY}` }))).toBe(ownerId)
    // A runtime token is readable by the agent, so it must not be able to name a person.
    expect(await relayedCrossWorkspaceRequester(fake(named))).toBeNull()
    expect(await relayedCrossWorkspaceRequester(fake({ ...named, Authorization: 'Bearer rt_v1_other' }))).toBeNull()
    // A Personal workspace that person does not own is not a claim to believe.
    expect(
      await relayedCrossWorkspaceRequester(fake({ ...named, 'X-Cross-Workspace-Requester': 'someone-else', Authorization: `Bearer ${CLOUD_KEY}` })),
    ).toBeNull()
  })
})

describe('what an approval may be minted for', () => {
  test('destructive and administrative tools are not approvable', async () => {
    const { CROSS_WORKSPACE_WRITE_TOOLS } = await import('../lib/cross-workspace')
    for (const tool of ['schedule_delete', 'trigger_delete', 'system_apply', 'project_create', 'board_delete']) {
      expect(CROSS_WORKSPACE_WRITE_TOOLS.has(tool)).toBe(false)
    }
    expect(CROSS_WORKSPACE_WRITE_TOOLS.has('work_item_move')).toBe(true)
    expect(CROSS_WORKSPACE_WRITE_TOOLS.has('team_chat_post')).toBe(true)
  })
})
