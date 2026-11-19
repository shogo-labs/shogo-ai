// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-448 acceptance criteria, driven through the real routers: the settings
 * screen can write "every model under the ceiling", an untouched `null`/`null`
 * row round-trips unchanged, and a model added to the catalog later is still
 * usable by a subject that was granted everything.
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
const { accessModelCatalog, __clearAccessCache, getEffectiveAccess, isModelAllowedFor } = await import(
  '../../apps/api/src/services/access-policy.service'
)
const { createGroup } = await import('../../apps/api/src/services/chat-customization')
const { isModelAllowed } = await import('@shogo/authz')

const app = buildRbacApp()
app.route('/api', accessPolicyRoutes({ resolveUserId: (c: any) => c.get('auth')?.userId ?? null }))
const as = (id: string) => ({ user: id })

const catalog = accessModelCatalog()
const premium = catalog.find((m) => m.tier === 'premium')!
const economy = catalog.find((m) => m.tier === 'economy')!

let w: Awaited<ReturnType<typeof seedRbacWorld>>

const put = (body: Record<string, unknown>) =>
  call(app, as(w.users.owner), 'PUT', `/api/workspaces/${w.workspaceA}/access/policies`, body)

const listPolicies = () =>
  call(app, as(w.users.owner), 'GET', `/api/workspaces/${w.workspaceA}/access/policies`)

const storedRow = (subjectType: string, subjectId: string) =>
  db.accessPolicy.findUnique({
    where: { workspaceId_subjectType_subjectId: { workspaceId: w.workspaceA, subjectType, subjectId } },
  })

// SQLite hands a Json column back as text, Postgres as the parsed value.
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)

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

describe('SHO-448: "all models under the ceiling" is a state the screen can write', () => {
  test('a member row saved as "all models" stores null/null and covers a model the role excludes', async () => {
    // Narrow the role first, so "everything" can only come from the member row.
    expect((await put({ subjectType: 'role', subjectId: 'member', modelTiers: ['economy'] })).status).toBe(200)
    expect(await isModelAllowedFor(w.workspaceA, w.users.billingAdmin, premium.id)).toBe(false)

    const res = await put({ subjectType: 'member', subjectId: w.users.billingAdmin, grantsAllModels: true })
    expect(res.status).toBe(200)

    const row = await storedRow('member', w.users.billingAdmin)
    expect(json(row!.modelTiers)).toBeNull()
    expect(json(row!.modelIds)).toBeNull()
    expect(await isModelAllowedFor(w.workspaceA, w.users.billingAdmin, premium.id)).toBe(true)
  })

  test('the policy list reports the row as "all models", not as a tier list', async () => {
    const res = await listPolicies()
    expect(res.status).toBe(200)
    const row = res.body.policies.find(
      (p: any) => p.subjectType === 'member' && p.subjectId === w.users.billingAdmin,
    )
    expect(row).toBeTruthy()
    expect(row.modelTiers).toBeNull()
    expect(row.modelIds).toBeNull()
  })

  test('re-saving the untouched row — exactly what the screen sends — leaves it null/null', async () => {
    const before = (await storedRow('member', w.users.billingAdmin)) as Record<string, unknown>

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
    expect(await isModelAllowedFor(w.workspaceA, w.users.billingAdmin, premium.id)).toBe(true)
  })

  test('a model added to the catalog later is allowed for the "all models" subject', async () => {
    const access = await getEffectiveAccess(w.workspaceA, w.users.billingAdmin)
    expect(access).not.toBeNull()
    // A model the catalog snapshot does not know yet, as if it shipped tomorrow.
    const addedLater = { id: 'opus-6', tier: 'premium' as const }
    expect(isModelAllowed(access!.models, addedLater, access!.ceiling)).toBe(true)
  })

  test('narrowing the same row to tiers stores the tier list and excludes the premium model', async () => {
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

    const access = await getEffectiveAccess(w.workspaceA, w.users.billingAdmin)
    const addedLater = { id: 'opus-6', tier: 'premium' as const }
    expect(isModelAllowed(access!.models, addedLater, access!.ceiling)).toBe(false)
  })

  test('a group row saved as "all models" stores null/null', async () => {
    const group = await createGroup(w.workspaceA, w.users.owner, {
      handle: 'all-models-e2e',
      name: 'All models',
      memberIds: [],
    })

    const res = await put({ subjectType: 'group', subjectId: group.id, grantsAllModels: true })
    expect(res.status).toBe(200)

    const row = await storedRow('group', group.id)
    expect(json(row!.modelTiers)).toBeNull()
    expect(json(row!.modelIds)).toBeNull()
  })

  test('without the flag the same body is an ability-only grant — the bug the flag fixes', async () => {
    // This is what the old screen sent for an untouched `null`/`null` row: no
    // flag, and the model columns left empty. It must not read as "everything".
    const res = await put({
      subjectType: 'member',
      subjectId: w.users.billingAdmin,
      modelTiers: null,
      modelIds: null,
    })
    expect(res.status).toBe(200)

    const row = await storedRow('member', w.users.billingAdmin)
    expect(json(row!.modelTiers)).toEqual([])
    expect(json(row!.modelIds)).toEqual([])
    expect(await isModelAllowedFor(w.workspaceA, w.users.billingAdmin, premium.id)).toBe(false)
  })

  test('a contradictory write (flag plus an explicit list) is stored as null/null', async () => {
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
