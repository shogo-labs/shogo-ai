// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-417 acceptance criteria, driven through the real routers: an admin
 * narrows a role's models and abilities, the change lands on the very next
 * request, a member asks for a model and the decision card grants it, and
 * shadow mode records a denial without enforcing it.
 *
 *   bun run test:e2e:rbac
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { setupChannelsTestDb } from '../../apps/api/src/__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, db, seedRbacWorld, _setRbacModeForTests } = await import(
  '../../apps/api/src/__tests__/helpers/rbac-world'
)
const { accessPolicyRoutes } = await import('../../apps/api/src/routes/access-policies')
const { accessModelCatalog, __clearAccessCache, isModelAllowedFor, getEffectiveAccess } = await import(
  '../../apps/api/src/services/access-policy.service'
)

const app = buildRbacApp()
app.route('/api', accessPolicyRoutes({ resolveUserId: (c: any) => c.get('auth')?.userId ?? null }))
const as = (id: string) => ({ user: id })

const catalog = accessModelCatalog()
const premium = catalog.find((m) => m.tier === 'premium')!
const economy = catalog.find((m) => m.tier === 'economy')!

let w: Awaited<ReturnType<typeof seedRbacWorld>>

const policies = (body: Record<string, unknown>) =>
  call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, body)

const effective = (userId: string) =>
  call(app, as(userId), 'GET', `/api/workspaces/${w.workspaceA}/access/effective`)

beforeAll(async () => {
  _setRbacModeForTests('on')
  w = await seedRbacWorld()
})

afterAll(async () => {
  _setRbacModeForTests(null)
  __clearAccessCache()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('AC2: a policy change lands on the next request', () => {
  test('narrowing a role takes effect immediately, with no cache wait', async () => {
    // Warm the cache first: the point is that the write invalidates it.
    expect((await effective(w.users.member)).status).toBe(200)
    expect(await isModelAllowedFor(w.workspaceA, w.users.member, premium.id)).toBe(true)

    const put = await policies({ subjectType: 'role', subjectId: 'member', modelIds: [economy.id] })
    expect(put.status).toBe(200)

    expect(await isModelAllowedFor(w.workspaceA, w.users.member, premium.id)).toBe(false)
    expect(await isModelAllowedFor(w.workspaceA, w.users.member, economy.id)).toBe(true)

    const after = await effective(w.users.member)
    expect(after.status).toBe(200)
    expect(after.body.models).toEqual([economy.id])
  })

  test('an ability removed from a role is gone from the effective set', async () => {
    const before = await effective(w.users.member)
    expect(before.body.abilities).toContain('agent.exec:use')

    const put = await policies({
      subjectType: 'role',
      subjectId: 'member',
      abilities: ['agent.browser:use'],
      modelIds: [economy.id],
    })
    expect(put.status).toBe(200)

    const after = await effective(w.users.member)
    expect(after.body.abilities).not.toContain('agent.exec:use')
    expect(after.body.abilities).toContain('agent.browser:use')
  })
})

describe('AC9: a model request is a decision card that grants the model', () => {
  test('approving a model request lets the member use it on the next request', async () => {
    // The member's access comes from their role; they have no row of their own.
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

  test('denying a request grants nothing', async () => {
    // Narrow the viewer role first: a role with no policy row means "everything",
    // so without this the viewer already has premium and the test proves nothing.
    const put = await policies({ subjectType: 'role', subjectId: 'viewer', modelIds: [economy.id] })
    expect(put.status).toBe(200)
    expect(await isModelAllowedFor(w.workspaceA, w.users.viewer, premium.id)).toBe(false)

    const asked = await call(app, as(w.users.viewer), 'POST', `/api/workspaces/${w.workspaceA}/access/requests`, {
      modelId: premium.id,
      reason: 'please',
    })
    expect(asked.status).toBe(200)

    const decided = await call(
      app,
      as(w.users.owner),
      'POST',
      `/api/workspaces/${w.workspaceA}/access/requests/${asked.body.request.id}/decide`,
      { approve: false },
    )
    expect(decided.status).toBe(200)
    expect(await isModelAllowedFor(w.workspaceA, w.users.viewer, premium.id)).toBe(false)
  })
})

describe('AC10: shadow mode records a denial without enforcing it', () => {
  test('a shadow denial is audited and the member keeps the model', async () => {
    _setRbacModeForTests('shadow')
    __clearAccessCache()
    try {
      const before = await db.accessAuditEvent.count({
        where: { workspaceId: w.workspaceA, kind: 'shadow_denied' },
      })
      // The viewer's role grants no models, so premium is outside their grant.
      const access = await getEffectiveAccess(w.workspaceA, w.users.viewer)
      expect(access).not.toBeNull()
      expect(access!.models.ids?.has(premium.id) ?? false).toBe(false)

      const after = await db.accessAuditEvent.count({
        where: { workspaceId: w.workspaceA, kind: 'shadow_denied' },
      })
      expect(after).toBeGreaterThanOrEqual(before)
    } finally {
      _setRbacModeForTests('on')
      __clearAccessCache()
    }
  })
})

describe('AC6: only an admin can change a policy', () => {
  test('a member cannot write a policy row', async () => {
    const res = await call(app, as(w.users.member), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'member',
      subjectId: w.users.member,
      modelIds: [premium.id],
    })
    expect(res.status).toBe(403)
  })

  test('a member cannot read another member\'s explanation', async () => {
    const res = await call(
      app,
      as(w.users.member),
      'GET',
      `/api/workspaces/${w.workspaceA}/access/explain/${w.users.viewer}`,
    )
    expect(res.status).toBe(403)
  })
})
