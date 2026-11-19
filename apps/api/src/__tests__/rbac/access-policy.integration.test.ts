// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace access policies (SHO-417) through the real middleware stack.
 *
 * Covers the three things the card promises:
 *   - a member reads their own effective access, an outsider gets nothing;
 *   - only a workspace admin can read or write another subject's policy;
 *   - a policy narrows models and abilities, and the run-model pick moves a
 *     run off a model the person cannot use (AC5) instead of failing it.
 *
 *   bun --no-env-file test src/__tests__/rbac/access-policy.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, seedRbacWorld, db } = await import('../helpers/rbac-world')
const { accessPolicyRoutes } = await import('../../routes/access-policies')
const { accessModelCatalog, __clearAccessCache, resolveRunModelFor, getEffectiveAccess, isModelAllowedFor } = await import(
  '../../services/access-policy.service'
)
const { createGroup, updateGroup } = await import('../../services/chat-customization')
const { removeMembership } = await import('../../services/membership.service')
const { answerQuestion } = await import('../../services/conversation-questions')
type World = Awaited<ReturnType<typeof seedRbacWorld>>

let w: World
const app: Hono = buildRbacApp()
app.route('/api', accessPolicyRoutes({ resolveUserId: (c: any) => c.get('auth')?.userId ?? null }))

const catalog = accessModelCatalog()
const premium = catalog.find((m) => m.tier === 'premium')!
const economy = catalog.find((m) => m.tier === 'economy')!

beforeAll(async () => {
  w = await seedRbacWorld()
})

afterAll(async () => {
  __clearAccessCache()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

function as(user: string) {
  return { user }
}

describe('GET /access/effective', () => {
  test('a member reads their own access', async () => {
    const res = await call(app, as(w.users.member), 'GET', `/api/workspaces/${w.workspaceA}/access/effective`)
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('member')
    expect(Array.isArray(res.body.abilities)).toBe(true)
    expect(res.body.abilities).toContain('agent.exec:use')
    expect(res.body.models.length).toBeGreaterThan(0)
  })

  test('an outsider gets nothing', async () => {
    const res = await call(app, as(w.users.outsider), 'GET', `/api/workspaces/${w.workspaceA}/access/effective`)
    expect(res.status).toBe(403)
  })

  test('an anonymous caller is refused', async () => {
    const res = await call(app, null, 'GET', `/api/workspaces/${w.workspaceA}/access/effective`)
    expect(res.status).toBe(401)
  })
})

describe('policy writes are admin-only', () => {
  test('a member cannot list policies', async () => {
    const res = await call(app, as(w.users.member), 'GET', `/api/workspaces/${w.workspaceA}/access/policies`)
    expect(res.status).toBe(403)
  })

  test('a member cannot write a policy', async () => {
    const res = await call(app, as(w.users.member), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'member',
      subjectId: w.users.member,
      abilities: ['agent.exec:use'],
    })
    expect(res.status).toBe(403)
  })

  test('an owner lists policies with the catalogs the editor needs', async () => {
    const res = await call(app, as(w.users.owner), 'GET', `/api/workspaces/${w.workspaceA}/access/policies`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.policies)).toBe(true)
    expect(res.body.abilities.some((a: any) => a.id === 'agent.exec:use')).toBe(true)
    expect(res.body.modelTiers).toEqual(['economy', 'standard', 'premium'])
    expect(res.body.models.length).toBeGreaterThan(0)
  })
})

describe('a policy narrows what a member may use', () => {
  test('an unknown ability is rejected', async () => {
    const res = await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'member',
      subjectId: w.users.member,
      abilities: ['agent.teleport:use'],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_abilities')
  })

  test('a model outside the catalog is rejected', async () => {
    const res = await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'member',
      subjectId: w.users.member,
      modelIds: ['not-a-real-model'],
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_models')
  })

  test('a member policy adds to the role, it does not replace it', async () => {
    const res = await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'member',
      subjectId: w.users.member,
      abilities: ['agent.social:post'],
    })
    expect(res.status).toBe(200)

    const own = await call(app, as(w.users.member), 'GET', `/api/workspaces/${w.workspaceA}/access/effective`)
    expect(own.status).toBe(200)
    expect(own.body.abilities).toContain('agent.social:post')
    // The role still grants exec; a member grant only ever adds.
    expect(own.body.abilities).toContain('agent.exec:use')

    await call(
      app,
      as(w.users.owner),
      'DELETE',
      `/api/workspaces/${w.workspaceA}/access/policies/member/${w.users.member}`,
    )
  })

  test('a role policy replaces the role default, narrowing abilities and models', async () => {
    const res = await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'role',
      subjectId: 'member',
      abilities: ['agent.browser:use'],
      modelIds: [economy.id],
    })
    expect(res.status).toBe(200)

    const own = await call(app, as(w.users.member), 'GET', `/api/workspaces/${w.workspaceA}/access/effective`)
    expect(own.status).toBe(200)
    expect(own.body.abilities).toContain('agent.browser:use')
    expect(own.body.abilities).not.toContain('agent.exec:use')
    expect(own.body.models).toEqual([economy.id])
  })

  test('the run model moves off a model the person cannot use (AC5)', async () => {
    const resolved = await resolveRunModelFor(w.workspaceA, w.users.member, premium.id)
    expect(resolved).not.toBeNull()
    expect(resolved!.model).toBe(economy.id)
    expect(resolved!.downgrade).toEqual({ from: premium.id, to: economy.id })
  })

  test('a model the person may use is left alone', async () => {
    const resolved = await resolveRunModelFor(w.workspaceA, w.users.member, economy.id)
    expect(resolved).toEqual({ model: economy.id, downgrade: null })
  })

  test('deleting the policy restores the role default', async () => {
    const del = await call(
      app,
      as(w.users.owner),
      'DELETE',
      `/api/workspaces/${w.workspaceA}/access/policies/role/member`,
    )
    expect(del.status).toBe(200)

    const access = await getEffectiveAccess(w.workspaceA, w.users.member)
    expect(access!.abilities.has('agent.exec:use')).toBe(true)
    expect(access!.models.tiers).toBeNull()
    expect(access!.models.ids).toBeNull()
  })

  test('deleting a policy that does not exist is a 404', async () => {
    const res = await call(
      app,
      as(w.users.owner),
      'DELETE',
      `/api/workspaces/${w.workspaceA}/access/policies/role/member`,
    )
    expect(res.status).toBe(404)
  })
})

describe('access requests', () => {
  const wanted = 'project.secrets:read'
  let requestId = ''

  test('a member asks for an ability they do not have', async () => {
    const before = await call(app, as(w.users.member), 'GET', `/api/workspaces/${w.workspaceA}/access/effective`)
    expect(before.body.abilities).not.toContain(wanted)

    const res = await call(app, as(w.users.member), 'POST', `/api/workspaces/${w.workspaceA}/access/requests`, {
      permission: wanted,
      reason: 'I need to rotate the deploy key',
    })
    expect(res.status).toBe(200)
    expect(res.body.request.status).toBe('open')
    expect(res.body.request.permission).toBe(wanted)
    expect(res.body.request.userId).toBe(w.users.member)
    requestId = res.body.request.id
  })

  test('asking twice returns the request they already have', async () => {
    const res = await call(app, as(w.users.member), 'POST', `/api/workspaces/${w.workspaceA}/access/requests`, {
      permission: wanted,
    })
    expect(res.status).toBe(200)
    expect(res.body.request.id).toBe(requestId)
  })

  test('asking for both an ability and a model is refused', async () => {
    const res = await call(app, as(w.users.member), 'POST', `/api/workspaces/${w.workspaceA}/access/requests`, {
      permission: wanted,
      modelId: premium.id,
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_request')
  })

  test('an unknown ability is refused', async () => {
    const res = await call(app, as(w.users.member), 'POST', `/api/workspaces/${w.workspaceA}/access/requests`, {
      permission: 'agent.teleport:use',
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_ability')
  })

  test('a member cannot read the admin queue', async () => {
    const res = await call(app, as(w.users.member), 'GET', `/api/workspaces/${w.workspaceA}/access/requests`)
    expect(res.status).toBe(403)
  })

  test('an owner sees the open request', async () => {
    const res = await call(app, as(w.users.owner), 'GET', `/api/workspaces/${w.workspaceA}/access/requests`)
    expect(res.status).toBe(200)
    const mine = res.body.requests.find((r: any) => r.id === requestId)
    expect(mine).toBeTruthy()
    expect(mine.status).toBe('open')
    expect(mine.reason).toBe('I need to rotate the deploy key')
  })

  test('a member cannot decide their own request', async () => {
    const res = await call(
      app,
      as(w.users.member),
      'POST',
      `/api/workspaces/${w.workspaceA}/access/requests/${requestId}/decide`,
      { approve: true },
    )
    expect(res.status).toBe(403)
  })

  test('approving grants the ability and closes the request', async () => {
    const res = await call(
      app,
      as(w.users.owner),
      'POST',
      `/api/workspaces/${w.workspaceA}/access/requests/${requestId}/decide`,
      { approve: true },
    )
    expect(res.status).toBe(200)
    expect(res.body.request.status).toBe('granted')
    expect(res.body.request.decidedByUserId).toBe(w.users.owner)

    const own = await call(app, as(w.users.member), 'GET', `/api/workspaces/${w.workspaceA}/access/effective`)
    expect(own.body.abilities).toContain(wanted)
    // The grant is additive: the role's own abilities survive.
    expect(own.body.abilities).toContain('agent.exec:use')
  })

  test('deciding the same request twice is a 409', async () => {
    const res = await call(
      app,
      as(w.users.owner),
      'POST',
      `/api/workspaces/${w.workspaceA}/access/requests/${requestId}/decide`,
      { approve: false },
    )
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('already_decided')
  })

  test('a denied request grants nothing', async () => {
    const ask = await call(app, as(w.users.member), 'POST', `/api/workspaces/${w.workspaceA}/access/requests`, {
      permission: 'models:use_all',
    })
    expect(ask.status).toBe(200)

    const res = await call(
      app,
      as(w.users.owner),
      'POST',
      `/api/workspaces/${w.workspaceA}/access/requests/${ask.body.request.id}/decide`,
      { approve: false },
    )
    expect(res.status).toBe(200)
    expect(res.body.request.status).toBe('denied')

    const own = await call(app, as(w.users.member), 'GET', `/api/workspaces/${w.workspaceA}/access/effective`)
    expect(own.body.abilities).not.toContain('models:use_all')
  })

  test('the audit trail records the request and the grant', async () => {
    const res = await call(app, as(w.users.owner), 'GET', `/api/workspaces/${w.workspaceA}/access/audit`)
    expect(res.status).toBe(200)
    const kinds = res.body.events.map((e: any) => e.kind)
    expect(kinds).toContain('access.requested')
    expect(kinds).toContain('access.granted')
    expect(kinds).toContain('access.denied')
  })

  test('a member cannot read the audit trail', async () => {
    const res = await call(app, as(w.users.member), 'GET', `/api/workspaces/${w.workspaceA}/access/audit`)
    expect(res.status).toBe(403)
  })
})

describe('explain', () => {
  test('an owner sees why a member has their access', async () => {
    const res = await call(
      app,
      as(w.users.owner),
      'GET',
      `/api/workspaces/${w.workspaceA}/access/explain/${w.users.member}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('member')
    expect(res.body.reasons).toContain('role member')
  })

  test('a non-member is a 404', async () => {
    const res = await call(
      app,
      as(w.users.owner),
      'GET',
      `/api/workspaces/${w.workspaceA}/access/explain/${w.users.outsider}`,
    )
    expect(res.status).toBe(404)
  })
})

describe('auto is a routing sentinel, not a model', () => {
  test('an Auto run is never downgraded and never audited as a denial', async () => {
    const resolved = await resolveRunModelFor(w.workspaceA, w.users.member, 'auto')
    expect(resolved).toEqual({ model: 'auto', downgrade: null })
  })
})

describe('a revoke takes effect on the next request (AC2)', () => {
  test('removing a member from a group drops the group grant immediately', async () => {
    // Narrow the role first, so premium can only come from the group.
    const role = await call(
      app,
      as(w.users.owner),
      'PUT',
      `/api/workspaces/${w.workspaceA}/access/policies`,
      { subjectType: 'role', subjectId: 'member', modelTiers: ['economy'] },
    )
    expect(role.status).toBe(200)
    expect(await isModelAllowedFor(w.workspaceA, w.users.member, premium.id)).toBe(false)

    const group = await createGroup(w.workspaceA, w.users.owner, {
      handle: 'ml',
      name: 'ML',
      memberIds: [w.users.member],
    })
    const put = await call(
      app,
      as(w.users.owner),
      'PUT',
      `/api/workspaces/${w.workspaceA}/access/policies`,
      { subjectType: 'group', subjectId: group.id, modelTiers: ['premium'] },
    )
    expect(put.status).toBe(200)
    expect(await isModelAllowedFor(w.workspaceA, w.users.member, premium.id)).toBe(true)

    await updateGroup(group.id, w.users.owner, { memberIds: [] })

    expect(await isModelAllowedFor(w.workspaceA, w.users.member, premium.id)).toBe(false)
  })

  test('removing a member drops their own grant immediately', async () => {
    const put = await call(
      app,
      as(w.users.owner),
      'PUT',
      `/api/workspaces/${w.workspaceA}/access/policies`,
      { subjectType: 'member', subjectId: w.users.viewer, modelTiers: ['premium'] },
    )
    expect(put.status).toBe(200)
    expect(await isModelAllowedFor(w.workspaceA, w.users.viewer, premium.id)).toBe(true)

    const row = await db.member.findFirst({
      where: { workspaceId: w.workspaceA, userId: w.users.viewer, projectId: null },
      select: { id: true },
    })
    await removeMembership(db, row!.id)

    expect(await isModelAllowedFor(w.workspaceA, w.users.viewer, premium.id)).toBe(false)
  })
})

/**
 * AC9's decision surface: the request is a card in the workspace activity
 * channel, and answering it is what grants. The card and the admin queue are
 * two views of one decision, so this drives the card and then reads the queue.
 */
describe('an access request is a decision card (AC9)', () => {
  test('answering the card grants the ability and closes the request', async () => {
    const channel = await db.conversation.create({
      data: { workspaceId: w.workspaceA, kind: 'public', name: 'Activity', slug: 'activity' } as any,
    })

    const asked = await call(app, as(w.users.member), 'POST', `/api/workspaces/${w.workspaceA}/access/requests`, {
      permission: 'boards:manage',
      reason: 'I run the support board',
    })
    expect(asked.status).toBe(200)

    const messages = await db.conversationMessage.findMany({
      where: { conversationId: channel.id },
      orderBy: { createdAt: 'desc' },
    })
    const card = messages.find((m: any) => m.blocks?.accessRequest)
    expect(card).toBeTruthy()
    const blocks = card.blocks as any
    expect(blocks?.accessRequest?.requestId).toBe(asked.body.request.id)
    expect(blocks?.questions?.[0]?.options?.map((o: any) => o.label)).toEqual(['Approve', 'Deny'])

    await answerQuestion({
      messageId: card.id,
      questionId: blocks.questions[0].id,
      answer: 'Approve',
      userId: w.users.owner,
    })

    const queue = await call(app, as(w.users.owner), 'GET', `/api/workspaces/${w.workspaceA}/access/requests`)
    const decided = (queue.body.requests as any[]).find((r) => r.id === asked.body.request.id)
    expect(decided.status).toBe('granted')

    const own = await call(app, as(w.users.member), 'GET', `/api/workspaces/${w.workspaceA}/access/effective`)
    expect(own.body.abilities).toContain('boards:manage')
  })
})

/**
 * A model request has to merge into the member's *effective* grant, not their
 * own row. QA round 2 caught the old code reading only the member's row: with
 * no row of their own it wrote `null`/`null`, which means "everything" and is
 * skipped as an ability-only grant, so the approval was a no-op.
 */
describe('a model request grants the model (AC9)', () => {
  test('approving a model request lets the member use it on the next request', async () => {
    // The member's access comes from their role, and they have no row of their own.
    const role = await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'role',
      subjectId: 'member',
      modelIds: [economy.id],
    })
    expect(role.status).toBe(200)
    expect(await isModelAllowedFor(w.workspaceA, w.users.member, premium.id)).toBe(false)

    const asked = await call(app, as(w.users.member), 'POST', `/api/workspaces/${w.workspaceA}/access/requests`, {
      modelId: premium.id,
      reason: 'I need the premium model for this project',
    })
    expect(asked.status).toBe(200)

    const decided = await call(
      app,
      as(w.users.owner),
      'POST',
      `/api/workspaces/${w.workspaceA}/access/requests/${asked.body.request.id}/decide`,
      { approve: true },
    )
    expect(decided.status).toBe(200)

    expect(await isModelAllowedFor(w.workspaceA, w.users.member, premium.id)).toBe(true)
    // The role's own model is still there: the grant adds, it does not replace.
    expect(await isModelAllowedFor(w.workspaceA, w.users.member, economy.id)).toBe(true)
  })

  test('an ability-only grant does not widen the member to every model', async () => {
    const put = await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'member',
      subjectId: w.users.viewer,
      abilities: ['boards:manage'],
    })
    expect(put.status).toBe(200)

    const row = await db.accessPolicy.findUnique({
      where: {
        workspaceId_subjectType_subjectId: {
          workspaceId: w.workspaceA,
          subjectType: 'member',
          subjectId: w.users.viewer,
        },
      },
    })
    // Stored as "no models", not as `null`/`null` ("everything"). SQLite hands
    // a Json column back as text, Postgres as the parsed value.
    const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)
    expect(json(row!.modelTiers)).toEqual([])
    expect(json(row!.modelIds)).toEqual([])
    expect(await isModelAllowedFor(w.workspaceA, w.users.viewer, premium.id)).toBe(false)
  })
})

/**
 * SHO-448: "every model under the ceiling" is a state the settings screen has
 * to be able to write, and an untouched row has to round-trip unchanged. The
 * screen sends `grantsAllModels`; the API stores `null`/`null` for it, which is
 * the one value that keeps covering models added to the catalog later.
 */
describe('grantsAllModels round-trips (SHO-448)', () => {
  const storedRow = (subjectType: string, subjectId: string) =>
    db.accessPolicy.findUnique({
      where: {
        workspaceId_subjectType_subjectId: { workspaceId: w.workspaceA, subjectType, subjectId },
      },
    })
  // SQLite hands a Json column back as text, Postgres as the parsed value.
  const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)
  const put = (body: Record<string, unknown>) =>
    call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, body)

  let groupId = ''

  afterAll(async () => {
    for (const [subjectType, subjectId] of [
      ['role', 'viewer'],
      ['role', 'member'],
      ['member', w.users.billingAdmin],
      ...(groupId ? [['group', groupId]] : []),
    ] as Array<[string, string]>) {
      await call(
        app,
        as(w.users.owner),
        'DELETE',
        `/api/workspaces/${w.workspaceA}/access/policies/${subjectType}/${subjectId}`,
      )
    }
  })

  test('a role row saved as "all models" stores null/null', async () => {
    const res = await put({
      subjectType: 'role',
      subjectId: 'viewer',
      abilities: ['agent.exec:use'],
      grantsAllModels: true,
    })
    expect(res.status).toBe(200)

    const row = await storedRow('role', 'viewer')
    expect(json(row!.modelTiers)).toBeNull()
    expect(json(row!.modelIds)).toBeNull()
  })

  test('a group row saved as "all models" stores null/null', async () => {
    // No members: the row is what this test is about, and a member here would
    // widen that person for the member-row tests below.
    const group = await createGroup(w.workspaceA, w.users.owner, {
      handle: 'all-models',
      name: 'All models',
      memberIds: [],
    })
    groupId = group.id

    const res = await put({ subjectType: 'group', subjectId: group.id, grantsAllModels: true })
    expect(res.status).toBe(200)

    const row = await storedRow('group', group.id)
    expect(json(row!.modelTiers)).toBeNull()
    expect(json(row!.modelIds)).toBeNull()
  })

  test('a member row saved as "all models" stores null/null and covers every model under the ceiling', async () => {
    // Narrow the role first, so "everything" can only come from the member row.
    // (An admin or owner is a bad subject here: `models:use_all` is one of their
    // base abilities, so the resolver hands them everything regardless.)
    expect((await put({ subjectType: 'role', subjectId: 'member', modelTiers: ['economy'] })).status).toBe(200)
    expect(await isModelAllowedFor(w.workspaceA, w.users.billingAdmin, premium.id)).toBe(false)

    const res = await put({ subjectType: 'member', subjectId: w.users.billingAdmin, grantsAllModels: true })
    expect(res.status).toBe(200)

    const row = await storedRow('member', w.users.billingAdmin)
    expect(json(row!.modelTiers)).toBeNull()
    expect(json(row!.modelIds)).toBeNull()
    expect(await isModelAllowedFor(w.workspaceA, w.users.billingAdmin, premium.id)).toBe(true)
  })

  test('saving an untouched null/null row writes the same row back', async () => {
    const before = (await storedRow('member', w.users.billingAdmin)) as Record<string, unknown>

    // Exactly what the screen sends for a row it opened and did not change.
    const res = await put({
      subjectType: 'member',
      subjectId: w.users.billingAdmin,
      abilities: json(before.abilities),
      grantsAllModels: true,
      modelTiers: null,
      modelIds: null,
      defaultModelId: null,
      spendCapUsd: null,
      spendPeriod: null,
      requestsPerHour: null,
    })
    expect(res.status).toBe(200)

    const after = (await storedRow('member', w.users.billingAdmin)) as Record<string, unknown>
    const { updatedAt: _beforeAt, ...beforeRow } = before
    const { updatedAt: _afterAt, ...afterRow } = after
    expect(afterRow).toEqual(beforeRow)
  })

  test('"these tiers" stores the tier list and excludes a model outside it', async () => {
    const res = await put({
      subjectType: 'member',
      subjectId: w.users.billingAdmin,
      modelTiers: ['economy'],
      grantsAllModels: false,
    })
    expect(res.status).toBe(200)

    const row = await storedRow('member', w.users.billingAdmin)
    expect(json(row!.modelTiers)).toEqual(['economy'])
    expect(json(row!.modelIds)).toBeNull()
    expect(await isModelAllowedFor(w.workspaceA, w.users.billingAdmin, premium.id)).toBe(false)
  })

  test('grantsAllModels wins over a contradictory explicit list', async () => {
    const res = await put({
      subjectType: 'member',
      subjectId: w.users.billingAdmin,
      grantsAllModels: true,
      modelTiers: ['economy'],
      modelIds: [economy.id],
    })
    expect(res.status).toBe(200)

    const row = await storedRow('member', w.users.billingAdmin)
    expect(json(row!.modelTiers)).toBeNull()
    expect(json(row!.modelIds)).toBeNull()
  })
})
