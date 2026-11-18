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
const { accessModelCatalog, __clearAccessCache, resolveRunModelFor, getEffectiveAccess } = await import(
  '../../services/access-policy.service'
)
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
