// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * RBAC enforcement (SHO-417) — the four things the policy resolver alone does
 * not prove:
 *
 *   shadow mode   the proxy lets a denied model through and audits it, and
 *                 `on` refuses it with `model_not_allowed` (AC1)
 *   two people    two people in one project resolve to two seats and two
 *                 policies, with no project-level guess (AC4)
 *   lost ability  a schedule or trigger whose owner lost the ability is
 *                 refused with a reason and never reassigned (AC6)
 *   route gates   each gated route refuses a person without the ability and
 *                 lets one with it through (AC7)
 *
 *   bun --no-env-file test src/__tests__/rbac/access-enforcement.integration.test.ts
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, seedRbacWorld, db, _setRbacModeForTests } = await import('../helpers/rbac-world')
const { workspaceAgentRoutes, sessionAuthorize } = await import('../../routes/workspace-agent')
const { accessPolicyRoutes } = await import('../../routes/access-policies')
const { scheduleOwnerDenial } = await import('../../jobs/run-agent-schedule-dispatch')
const { accessModelCatalog, canUse, checkModelAccess, getEffectiveAccess, __clearAccessCache } = await import(
  '../../services/access-policy.service'
)
type World = Awaited<ReturnType<typeof seedRbacWorld>>

let w: World
const app: Hono = buildRbacApp()
app.route('/api', accessPolicyRoutes({ resolveUserId: (c: any) => c.get('auth')?.userId ?? null }))
app.route(
  '/api',
  workspaceAgentRoutes({ authorize: sessionAuthorize(async (c: any) => c.get('auth')?.userId ?? null) }),
)

const catalog = accessModelCatalog()
const premium = catalog.find((m) => m.tier === 'premium')!
const economy = catalog.find((m) => m.tier === 'economy')!

beforeAll(async () => {
  w = await seedRbacWorld()
})

afterEach(() => _setRbacModeForTests(null))

afterAll(async () => {
  __clearAccessCache()
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

const as = (user: string) => ({ user })

/** The proxy's gate, as the decision it makes for one acting person. */
function gate(userId: string, modelId: string) {
  return checkModelAccess(w.workspaceA, userId, modelId, { projectId: w.projects.open })
}

/** Narrow the member role to one model, so a premium call is outside it. */
async function narrowMemberRoleToEconomy() {
  const res = await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
    subjectType: 'role',
    subjectId: 'member',
    modelIds: [economy.id],
  })
  expect(res.status).toBe(200)
}

async function clearMemberRolePolicy() {
  await call(app, as(w.users.owner), 'DELETE', `/api/workspaces/${w.workspaceA}/access/policies/role/member`)
}

describe('the proxy in shadow mode (AC1)', () => {
  beforeAll(async () => {
    await narrowMemberRoleToEconomy()
  })

  afterAll(async () => {
    await clearMemberRolePolicy()
  })

  test('on: a model outside the person set is refused with model_not_allowed', async () => {
    _setRbacModeForTests('on')
    const decision = await gate(w.users.member, premium.id)
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.code).toBe('model_not_allowed')
    expect(decision.message).toContain(premium.id)
  })

  test('on: a model inside the person set is allowed', async () => {
    _setRbacModeForTests('on')
    expect(await gate(w.users.member, economy.id)).toEqual({ allowed: true })
  })

  test('shadow: the same call is allowed and audited as shadow_denied', async () => {
    _setRbacModeForTests('shadow')
    expect(await gate(w.users.member, premium.id)).toEqual({ allowed: true })

    const rows = await db.accessAuditEvent.findMany({
      where: { workspaceId: w.workspaceA, kind: 'shadow_denied', modelId: premium.id },
    })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].onBehalfOfUserId).toBe(w.users.member)
  })

  test('off: the same call is allowed and writes no audit row', async () => {
    _setRbacModeForTests('off')
    const before = await db.accessAuditEvent.count({ where: { workspaceId: w.workspaceA, modelId: premium.id } })
    expect(await gate(w.users.member, premium.id)).toEqual({ allowed: true })
    const after = await db.accessAuditEvent.count({ where: { workspaceId: w.workspaceA, modelId: premium.id } })
    expect(after).toBe(before)
  })

  test('a non-member is not gated by a policy they do not have', async () => {
    _setRbacModeForTests('on')
    expect(await gate(w.users.outsider, premium.id)).toEqual({ allowed: true })
  })
})

describe('two people in one project (AC4)', () => {
  test('two people in one project get two different decisions', async () => {
    _setRbacModeForTests('on')
    await narrowMemberRoleToEconomy()
    try {
      const [memberDecision, ownerDecision] = await Promise.all([
        gate(w.users.member, premium.id),
        gate(w.users.owner, premium.id),
      ])
      // Same project, same model, same instant: the member is refused and the
      // owner is not, because the decision is per person, not per project.
      expect(memberDecision.allowed).toBe(false)
      expect(ownerDecision.allowed).toBe(true)
    } finally {
      await clearMemberRolePolicy()
    }
  })

  test('two concurrent turns each get their own policy', async () => {
    await narrowMemberRoleToEconomy()
    try {
      const [memberAccess, ownerAccess] = await Promise.all([
        getEffectiveAccess(w.workspaceA, w.users.member),
        getEffectiveAccess(w.workspaceA, w.users.owner),
      ])
      expect(memberAccess!.models.ids).toEqual(new Set([economy.id]))
      // The owner is untouched by the member role's policy.
      expect(ownerAccess!.models.ids).toBeNull()
      expect(ownerAccess!.role).toBe('owner')
    } finally {
      await clearMemberRolePolicy()
    }
  })
})

describe('a schedule or trigger whose owner lost the ability (AC6)', () => {
  test('a schedule whose owner lost schedule:manage is skipped with a reason', async () => {
    _setRbacModeForTests('on')
    await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'role',
      subjectId: 'member',
      abilities: ['agent.exec:use'],
    })
    try {
      const reason = await scheduleOwnerDenial({
        id: 'schedule-1',
        workspaceId: w.workspaceA,
        userId: w.users.member,
      })
      expect(reason).toBeTruthy()
      expect(reason).toContain('can no longer manage schedules')
    } finally {
      await clearMemberRolePolicy()
    }
  })

  test('a schedule whose owner still has the ability runs', async () => {
    _setRbacModeForTests('on')
    expect(
      await scheduleOwnerDenial({ id: 'schedule-2', workspaceId: w.workspaceA, userId: w.users.member }),
    ).toBeNull()
  })

  test('a schedule whose owner left the workspace is skipped, not reassigned', async () => {
    _setRbacModeForTests('on')
    const reason = await scheduleOwnerDenial({
      id: 'schedule-3',
      workspaceId: w.workspaceA,
      userId: w.users.outsider,
    })
    expect(reason).toBeTruthy()
  })

  test('in shadow mode the run proceeds and the denial is audited', async () => {
    _setRbacModeForTests('shadow')
    await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'role',
      subjectId: 'member',
      abilities: ['agent.exec:use'],
    })
    try {
      expect(
        await scheduleOwnerDenial({ id: 'schedule-4', workspaceId: w.workspaceA, userId: w.users.member }),
      ).toBeNull()
      const rows = await db.accessAuditEvent.findMany({
        where: { workspaceId: w.workspaceA, kind: 'shadow_denied', permission: 'schedule:manage' },
      })
      expect(rows.length).toBeGreaterThan(0)
    } finally {
      await clearMemberRolePolicy()
    }
  })

  test('a trigger owner who lost trigger:manage is refused', async () => {
    _setRbacModeForTests('on')
    await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'role',
      subjectId: 'member',
      abilities: ['agent.exec:use'],
    })
    try {
      expect(await canUse(w.workspaceA, w.users.member, 'trigger:manage')).toBe(false)
    } finally {
      await clearMemberRolePolicy()
    }
    expect(await canUse(w.workspaceA, w.users.member, 'trigger:manage')).toBe(true)
  })
})

describe('the ability gate on the routes (AC7)', () => {
  /** Narrow a role to the given abilities, so every other ability is denied. */
  async function narrowRoleTo(role: string, abilities: string[]) {
    const res = await call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, {
      subjectType: 'role',
      subjectId: role,
      abilities,
    })
    expect(res.status).toBe(200)
  }

  const narrowMemberTo = (abilities: string[]) => narrowRoleTo('member', abilities)

  beforeEach(() => _setRbacModeForTests('on'))

  afterEach(async () => {
    await clearMemberRolePolicy()
    await call(app, as(w.users.owner), 'DELETE', `/api/workspaces/${w.workspaceA}/access/policies/role/admin`)
  })

  test('creating a trigger needs trigger:manage', async () => {
    await narrowMemberTo(['agent.exec:use'])
    const denied = await call(app, as(w.users.member), 'POST', `/api/workspaces/${w.workspaceA}/triggers`, {
      name: 'nightly',
      eventType: 'member.joined',
      prompt: 'say hi',
    })
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('ability_not_allowed')
  })

  test('creating a trigger is allowed with trigger:manage', async () => {
    await narrowMemberTo(['agent.exec:use', 'trigger:manage'])
    const res = await call(app, as(w.users.member), 'POST', `/api/workspaces/${w.workspaceA}/triggers`, {
      name: 'nightly',
      eventType: 'member.joined',
      prompt: 'say hi',
    })
    expect(res.status).not.toBe(403)
  })

  test('member activity needs members.activity:read', async () => {
    // An admin passes the pre-RBAC `workspace.analytics:read` check, so the
    // ability gate is the only thing left that can refuse them.
    await narrowRoleTo('admin', ['agent.exec:use'])
    const denied = await call(
      app,
      as(w.users.admin),
      'GET',
      `/api/workspaces/${w.workspaceA}/member-activity?user=${encodeURIComponent(w.users.viewer)}`,
    )
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('ability_not_allowed')
  })

  test('member activity is allowed with members.activity:read', async () => {
    await narrowRoleTo('admin', ['agent.exec:use', 'members.activity:read'])
    const res = await call(
      app,
      as(w.users.admin),
      'GET',
      `/api/workspaces/${w.workspaceA}/member-activity?user=${encodeURIComponent(w.users.viewer)}`,
    )
    expect(res.status).not.toBe(403)
  })

  test('a viewer cannot read member activity even with the ability', async () => {
    // The pre-RBAC permission check still runs first: an ability never widens it.
    await narrowMemberTo(['agent.exec:use', 'members.activity:read'])
    const res = await call(
      app,
      as(w.users.viewer),
      'GET',
      `/api/workspaces/${w.workspaceA}/member-activity?user=${encodeURIComponent(w.users.member)}`,
    )
    expect(res.status).toBe(403)
  })

  test('a schedule route needs schedule:manage', async () => {
    await narrowMemberTo(['agent.exec:use'])
    const denied = await call(app, as(w.users.member), 'POST', `/api/workspaces/${w.workspaceA}/schedules`, {
      name: 'daily',
      cronExpression: '0 9 * * *',
      prompt: 'check',
    })
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('ability_not_allowed')
  })
})
