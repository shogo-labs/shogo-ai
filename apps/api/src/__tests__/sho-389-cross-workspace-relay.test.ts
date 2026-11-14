// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-389, criterion 7: a signed-in desktop reaching a **cloud** workspace.
 *
 * The desktop's SQLite holds no rows for Nada / Odin AI / Samsara Game, so the
 * route cannot answer there. This mounts the real internal router over a real
 * SQLite database, stands in for the cloud with a stubbed `fetch`, and checks
 * the whole path: the cross-workspace authorizer runs first, the call leaves
 * with that workspace's own device key, the approval headers ride along, and
 * the cloud's answer comes back untouched. Signed out, it says so instead of
 * pretending the workspace is empty.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'sho-389-relay-secret'
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_CLOUD_URL = 'http://cloud.test'

const { prisma } = await import('../lib/prisma')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { deriveWorkspaceRuntimeToken, verifyWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')
const { argsHash, mintCrossWorkspaceApproval } = await import('../lib/cross-workspace')

const db = prisma as any

const CLOUD_TARGET = 'cloud-workspace-nada'
const CLOUD_KEY = 'shogo_sk_nadakey000000000000000000000000'

let personalWorkspaceId: string
let ownerId: string
let personalToken: string

const authenticate = async (c: any) => {
  const token = c.req.header('x-runtime-token')
  if (!token) return null
  const { verifyRuntimeToken } = await import('../lib/runtime-token')
  const project = verifyRuntimeToken(token)
  if (project.ok) return { kind: 'project' as const, projectId: project.projectId }
  const verified = verifyWorkspaceRuntimeToken(token)
  return verified.ok ? { kind: 'workspace' as const, workspaceId: verified.workspaceId } : null
}

const app = new Hono()
app.route('/api/internal', runtimeInternalRoutes({ authenticate }))

interface UpstreamCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}
let upstream: UpstreamCall[] = []
const realFetch = globalThis.fetch

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const owner = await db.user.create({ data: { name: 'owner', email: `relay-${suffix}@example.com` } })
  ownerId = owner.id
  const personal = await db.workspace.create({
    data: { name: 'Personal', slug: `personal-relay-${suffix}`, kind: 'personal', personalOwnerId: owner.id },
  })
  personalWorkspaceId = personal.id
  await db.member.create({ data: { userId: owner.id, workspaceId: personal.id, role: 'owner', projectId: null } })
  personalToken = deriveWorkspaceRuntimeToken(personal.id)
})

afterAll(() => {
  globalThis.fetch = realFetch
  delete process.env.SHOGO_LOCAL_MODE
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  upstream = []
  globalThis.fetch = (async (url: any, init: any = {}) => {
    upstream.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers ?? undefined).entries()),
      body: typeof init.body === 'string' ? init.body : null,
    })
    return new Response(JSON.stringify({ reached: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

async function storeCloudWorkspace(input: { signedIn: boolean; withKey: boolean }) {
  const value = JSON.stringify({
    enabled: true,
    user: input.signedIn ? { id: ownerId, name: 'owner', email: 'owner@example.com' } : null,
    workspaces: input.withKey
      ? [{ id: CLOUD_TARGET, name: 'Nada', slug: 'nada', kind: 'team', key: CLOUD_KEY }]
      : [],
    syncedAt: new Date().toISOString(),
  })
  await db.localConfig.upsert({ where: { key: 'SHOGO_CLOUD_WORKSPACES' }, update: { value }, create: { key: 'SHOGO_CLOUD_WORKSPACES', value } })
  const { _resetCloudWorkspacesForTests } = await import('../services/cloud-workspaces')
  _resetCloudWorkspacesForTests()
}

const baseHeaders = () => ({
  'x-runtime-token': personalToken,
  'X-Requester-Ticket': signRequesterTicket({ projectId: workspaceTicketKey(personalWorkspaceId), userId: ownerId }),
})

describe('desktop → cloud workspace', () => {
  test('a read is forwarded with that workspace’s own key', async () => {
    await storeCloudWorkspace({ signedIn: true, withKey: true })
    const res = await app.request(`http://local/api/internal/workspaces/${CLOUD_TARGET}/agent-boards`, {
      method: 'GET',
      headers: baseHeaders(),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reached: true })
    expect(upstream).toHaveLength(1)
    expect(upstream[0].url).toBe(`http://cloud.test/api/internal/workspaces/${CLOUD_TARGET}/agent-boards`)
    expect(upstream[0].headers.authorization).toBe(`Bearer ${CLOUD_KEY}`)
    // Who it is for, so the cloud can attribute the call.
    expect(upstream[0].headers['x-cross-workspace-from']).toBe(personalWorkspaceId)
    expect(upstream[0].headers['x-cross-workspace-requester']).toBe(ownerId)
  })

  test('a write carries its spent approval and the tool it was granted for', async () => {
    await storeCloudWorkspace({ signedIn: true, withKey: true })
    const hash = argsHash({ item: 'NADA-3', column: 'Done' })
    const minted = await mintCrossWorkspaceApproval({
      callerWorkspaceId: personalWorkspaceId,
      targetWorkspaceId: CLOUD_TARGET,
      tool: 'work_item_move',
      argsHash: hash,
      requesterUserId: ownerId,
    })

    const res = await app.request(`http://local/api/internal/workspaces/${CLOUD_TARGET}/agent-boards`, {
      method: 'POST',
      headers: {
        ...baseHeaders(),
        'content-type': 'application/json',
        'X-Cross-Workspace-Approval': minted.id,
        'X-Cross-Workspace-Tool': 'work_item_move',
        'X-Cross-Workspace-Args-Hash': hash,
      },
      body: JSON.stringify({ title: 'from the desk' }),
    })

    expect(res.status).toBe(200)
    expect(upstream[0].method).toBe('POST')
    expect(upstream[0].headers['x-cross-workspace-approval']).toBe(minted.id)
    expect(upstream[0].headers['x-cross-workspace-tool']).toBe('work_item_move')
    expect(JSON.parse(upstream[0].body ?? '{}')).toEqual({ title: 'from the desk' })
  })

  test('a write with no approval never reaches the cloud', async () => {
    await storeCloudWorkspace({ signedIn: true, withKey: true })
    const res = await app.request(`http://local/api/internal/workspaces/${CLOUD_TARGET}/agent-boards`, {
      method: 'POST',
      headers: { ...baseHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'nope' }),
    })

    expect(res.status).toBe(403)
    expect((await res.json<any>()).error.code).toBe('approval_required')
    expect(upstream).toHaveLength(0)
  })

  test('signed out it says so, and nothing is forwarded', async () => {
    await storeCloudWorkspace({ signedIn: false, withKey: false })
    const res = await app.request(`http://local/api/internal/workspaces/${CLOUD_TARGET}/agent-boards`, {
      method: 'GET',
      headers: baseHeaders(),
    })

    expect(res.status).toBe(401)
    expect((await res.json<any>()).error.code).toBe('cloud_signed_out')
    expect(upstream).toHaveLength(0)
  })

  test('a project agent cannot use the relay to reach another workspace', async () => {
    await storeCloudWorkspace({ signedIn: true, withKey: true })
    const { deriveRuntimeToken } = await import('../lib/runtime-token')
    const project = await db.project.create({
      data: { name: `p-${crypto.randomUUID().slice(0, 8)}`, workspaceId: personalWorkspaceId },
    })
    const res = await app.request(`http://local/api/internal/workspaces/${CLOUD_TARGET}/agent-boards`, {
      method: 'GET',
      headers: { 'x-runtime-token': deriveRuntimeToken(project.id), ...{ 'X-Requester-Ticket': baseHeaders()['X-Requester-Ticket'] } },
    })

    expect(res.status).toBe(403)
    expect((await res.json<any>()).error.code).toBe('cross_workspace_forbidden')
    expect(upstream).toHaveLength(0)
  })
})

/**
 * The other direction (criterion 8): a workspace whose compute is a paired
 * desktop. The cloud cannot serve it and must not pretend it is empty.
 */
describe('cloud → a workspace hosted on a paired desktop', () => {
  let hostedId: string

  beforeAll(async () => {
    delete process.env.SHOGO_LOCAL_MODE
    const hosted = await db.workspace.create({
      data: {
        name: 'Serendipity',
        slug: `serendipity-${crypto.randomUUID().slice(0, 8)}`,
        kind: 'team',
        hostInstanceId: `instance-${crypto.randomUUID().slice(0, 8)}`,
      },
    })
    hostedId = hosted.id
    await db.member.create({ data: { userId: ownerId, workspaceId: hostedId, role: 'owner', projectId: null } })
  })

  afterAll(() => {
    process.env.SHOGO_LOCAL_MODE = 'true'
  })

  test('it answers desktop_offline with the workspace name, and never an empty 200', async () => {
    const res = await app.request(`http://local/api/internal/workspaces/${hostedId}/agent-boards`, {
      method: 'GET',
      headers: baseHeaders(),
    })
    expect(res.status).toBe(503)
    const body = (await res.json<any>()).error
    expect(body.code).toBe('desktop_offline')
    expect(body.message).toContain('Serendipity')
    expect(upstream).toHaveLength(0)
  })
})

/**
 * `project_call` names a **project**, not a workspace (SHO-389). A cloud
 * project has no local row, so before this the route could not resolve it and
 * answered a bare 401 — the approval was burned and nothing left the machine.
 */
describe('project_call into a cloud workspace', () => {
  const CLOUD_PROJECT = 'cloud-project-nada-1'

  const call = (headers: Record<string, string>) => {
    const res = app.request(`http://local/api/internal/projects/${CLOUD_PROJECT}/agent-call`, {
      method: 'POST',
      headers: { ...baseHeaders(), 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ message: 'move SAM-12 to Done' }),
    })
    return res
  }

  beforeAll(async () => {
    await storeCloudWorkspace({ signedIn: true, withKey: true })
  })

  test('without an approval it is refused with approval_required, not a bare 401', async () => {
    const res = await call({ 'X-Cross-Workspace-Target': CLOUD_TARGET })
    expect(res.status).toBe(403)
    expect((await res.json<any>()).error.code).toBe('approval_required')
    expect(upstream).toHaveLength(0)
  })

  test('with one it relays once to the cloud, carrying the approval', async () => {
    const hash = argsHash({ message: 'move SAM-12 to Done' })
    const minted = await mintCrossWorkspaceApproval({
      callerWorkspaceId: personalWorkspaceId,
      targetWorkspaceId: CLOUD_TARGET,
      tool: 'project_call',
      argsHash: hash,
      requesterUserId: ownerId,
    })
    const res = await call({
      'X-Cross-Workspace-Target': CLOUD_TARGET,
      'X-Cross-Workspace-Approval': minted.id,
      'X-Cross-Workspace-Tool': 'project_call',
      'X-Cross-Workspace-Args-Hash': hash,
    })

    expect(res.status).toBe(200)
    expect(upstream).toHaveLength(1)
    expect(upstream[0].url).toBe(`http://cloud.test/api/internal/projects/${CLOUD_PROJECT}/agent-call`)
    expect(upstream[0].headers.authorization).toBe(`Bearer ${CLOUD_KEY}`)
    expect(upstream[0].headers['x-cross-workspace-approval']).toBe(minted.id)
    expect(upstream[0].headers['x-cross-workspace-target']).toBe(CLOUD_TARGET)

    // Single use: the same approval cannot start a second callee turn.
    const replay = await call({
      'X-Cross-Workspace-Target': CLOUD_TARGET,
      'X-Cross-Workspace-Approval': minted.id,
      'X-Cross-Workspace-Tool': 'project_call',
      'X-Cross-Workspace-Args-Hash': hash,
    })
    expect(replay.status).toBe(403)
    expect(upstream).toHaveLength(1)
  })
})

/**
 * Defect QA found in round 2: a local-target `project_call` that a person
 * refused answered a bare `401 Unauthorized`, which reads as a bad token. The
 * reason the authorizer produced now reaches the route.
 */
describe('project_call into another local workspace', () => {
  let otherProjectId: string
  let otherWorkspaceId: string

  beforeAll(async () => {
    const other = await db.workspace.create({ data: { name: 'Nada', slug: `nada-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' } })
    otherWorkspaceId = other.id
    await db.member.create({ data: { userId: ownerId, workspaceId: other.id, role: 'owner', projectId: null } })
    const project = await db.project.create({ data: { name: `nada-app-${crypto.randomUUID().slice(0, 8)}`, workspaceId: other.id } })
    otherProjectId = project.id
  })

  test('without an approval it answers 403 approval_required, not 401', async () => {
    const res = await app.request(`http://local/api/internal/projects/${otherProjectId}/agent-call`, {
      method: 'POST',
      headers: { ...baseHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json<any>()).error.code).toBe('approval_required')
  })

  test('a project agent still gets cross_workspace_forbidden', async () => {
    const { deriveRuntimeToken } = await import('../lib/runtime-token')
    const local = await db.project.create({
      data: { name: `p-${crypto.randomUUID().slice(0, 8)}`, workspaceId: personalWorkspaceId },
    })
    const res = await app.request(`http://local/api/internal/projects/${otherProjectId}/agent-call`, {
      method: 'POST',
      headers: { 'x-runtime-token': deriveRuntimeToken(local.id), 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json<any>()).error.code).toBe('cross_workspace_forbidden')
  })
})
