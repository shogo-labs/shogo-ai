// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Profile resolution against the shapes Zernio actually returns.
 *
 * The fixtures are a real capture (2026-10-25, `POST`/`GET /v1/profiles` through
 * our cloud relay, ids replaced), not the docs: the id is Mongo `_id` inside
 * `{ profile }` / `{ profiles: [] }`, never a top-level `id`, and the conflict
 * body is a bare `invalid_request_error` that names **no** `existingProfileId`
 * — so adoption has to come from the exact-`externalId` list lookup. The bug
 * this file exists for is that every reader said `.id`, so a genuine `201`
 * looked like "Zernio did not return a profile id".
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import profileCreate from './fixtures/zernio-profile-create.json'
import profileConflict from './fixtures/zernio-profile-conflict.json'
import profileList from './fixtures/zernio-profile-list.json'
import profileListEmpty from './fixtures/zernio-profile-list-empty.json'

const store = {
  profiles: [] as any[],
  workspaceName: 'Odin AI',
}

const dbMock = {
  socialProfile: {
    findUnique: async ({ where }: any) => {
      const key = where?.workspaceId_localWorkspaceId
      if (key) {
        return (
          store.profiles.find(
            (row) =>
              row.workspaceId === key.workspaceId &&
              row.localWorkspaceId === key.localWorkspaceId,
          ) ?? null
        )
      }
      return store.profiles.find((row) => row.externalId === where.externalId) ?? null
    },
    findMany: async ({ where }: any) =>
      store.profiles.filter((row) => row.workspaceId === where.workspaceId),
    create: async ({ data }: any) => {
      const row = { id: `row_${store.profiles.length + 1}`, ...data }
      store.profiles.push(row)
      return row
    },
    upsert: async ({ where, create, update }: any) => {
      const key = where.workspaceId_localWorkspaceId
      const existing = store.profiles.find(
        (row) => row.workspaceId === key.workspaceId && row.localWorkspaceId === key.localWorkspaceId,
      )
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const row = { id: `row_${store.profiles.length + 1}`, ...create }
      store.profiles.push(row)
      return row
    },
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
  },
  workspace: {
    findUnique: async () => ({ id: 'ws_1', name: store.workspaceName }),
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: dbMock }))

const { ensureProfile, pickProfileId, profileFromList } = await import('../profiles.service')
const { SocialError, setSocialClient } = await import('../client')

const workspaceId = 'ws_1'
const calls: any[] = []
let responder: (req: any) => any = () => ({})

beforeEach(() => {
  store.profiles.length = 0
  calls.length = 0
  responder = () => ({})
  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      const reply = responder(req)
      if (reply instanceof Error) throw reply
      return reply
    },
  })
})

describe('provider id shapes', () => {
  test('a create answers `{ profile: { _id } }`', () => {
    expect(pickProfileId(profileCreate)).toBe('64f0c2a1b9e4d30012ab34cd')
  })

  test('legacy and unwrapped shapes still read', () => {
    expect(pickProfileId({ _id: 'mongo_1' })).toBe('mongo_1')
    expect(pickProfileId({ id: 'legacy_1' })).toBe('legacy_1')
    expect(pickProfileId({ profile: { id: 'legacy_2' } })).toBe('legacy_2')
    expect(pickProfileId({})).toBeNull()
  })

  test('the list is matched by exact externalId, never by position', () => {
    expect(profileFromList(profileList, 'ws_ws_1')._id).toBe('64f0c2a1b9e4d30012ab34cd')
    // A populated list that does not contain ours must not hand back row 0.
    expect(profileFromList(profileList, 'ws_ws_9')).toBeNull()
    expect(profileFromList(profileListEmpty, 'ws_ws_1')).toBeNull()
  })
})

describe('ensureProfile', () => {
  test('stores the `_id` Zernio returned, keyed to the workspace scope', async () => {
    responder = (req) => {
      if (req.method === 'POST' && req.path === '/profiles') return profileCreate
      return profileListEmpty
    }

    const row = await ensureProfile(workspaceId, 'Odin AI', '')

    expect(row.zernioProfileId).toBe('64f0c2a1b9e4d30012ab34cd')
    expect(row.externalId).toBe('ws_ws_1')
    expect(row.localWorkspaceId).toBe('')
    expect(store.profiles).toHaveLength(1)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /profiles'])
  })

  test('a 409 adopts the profile the provider already owns', async () => {
    responder = (req) => {
      if (req.method === 'POST' && req.path === '/profiles') {
        return new SocialError(409, 'profile_external_id_conflict', 'already exists', {
          existingProfileId: '64f0c2a1b9e4d30012ab34cd',
        })
      }
      return profileListEmpty
    }

    const row = await ensureProfile(workspaceId, 'Odin AI', '')

    expect(row.zernioProfileId).toBe('64f0c2a1b9e4d30012ab34cd')
    // The provider named it, so no lookup was needed.
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /profiles'])
  })

  test('the live 409 adopts through the exact-externalId list, since its body names no id', async () => {
    responder = (req) => {
      if (req.method === 'POST') {
        return new SocialError(409, profileConflict.error.code, profileConflict.error.message)
      }
      return profileList
    }

    const row = await ensureProfile(workspaceId, 'Odin AI', '')

    expect(row.zernioProfileId).toBe('64f0c2a1b9e4d30012ab34cd')
    expect(calls.at(-1).query).toEqual({ externalId: 'ws_ws_1' })
  })

  test('a brand-new workspace with 0 profiles and no adoptable id is a 502, not another tenant’s profile', async () => {
    responder = (req) => {
      if (req.method === 'POST') return new SocialError(422, 'invalid_profile', 'name is required')
      return profileListEmpty
    }

    const error = await ensureProfile(workspaceId, 'Odin AI', '').catch((err) => err)

    expect(error).toBeInstanceOf(SocialError)
    expect((error as any).status).toBe(502)
    expect((error as any).code).toBe('social_profile_unresolved')
    expect(store.profiles).toHaveLength(0)
  })

  test('the 502 carries the swallowed create failure, so the next one explains itself', async () => {
    responder = (req) => {
      if (req.method === 'POST') {
        return new SocialError(422, 'invalid_request_error', 'name must be 2-64 characters', {
          field: 'name',
        })
      }
      return profileListEmpty
    }

    const error = await ensureProfile(workspaceId, 'Odin AI', '').catch((err) => err)
    const body = (error as InstanceType<typeof SocialError>).toJSON() as any

    expect(body.error.code).toBe('social_profile_unresolved')
    expect(body.error.externalId).toBe('ws_ws_1')
    expect(body.error.create).toEqual({
      status: 422,
      code: 'invalid_request_error',
      message: 'name must be 2-64 characters',
      details: { field: 'name' },
    })
  })

  test('a list holding another tenant’s profile is never adopted', async () => {
    const other = { profiles: [{ _id: 'other_tenant_profile', externalId: 'ws_someone_else' }] }
    responder = (req) => {
      if (req.method === 'POST') return new SocialError(409, 'conflict', 'already exists')
      return other
    }

    const error = await ensureProfile(workspaceId, 'Odin AI', '').catch((err) => err)

    expect((error as any).code).toBe('social_profile_unresolved')
    expect(store.profiles).toHaveLength(0)
  })
})
