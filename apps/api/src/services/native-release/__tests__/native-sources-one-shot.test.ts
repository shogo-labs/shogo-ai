// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SEC-22: `POST …/native/releases/:id/sources` took whatever `bucketKey` the
 * caller sent and could be replayed on a finished release to start new store
 * builds without a balance check. It now accepts only the key the release was
 * issued, only once, and only while the release is still queued.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { prismaProxy, useFakePrisma } from './prisma-fixture'

const releases = new Map<string, Record<string, any>>()

const fakePrisma = {
  nativeRelease: {
    async findUnique({ where }: any) {
      const r = releases.get(where.id)
      return r ? { ...r } : null
    },
    async updateMany({ where, data }: any) {
      const r = releases.get(where.id)
      if (!r) return { count: 0 }
      if (where.status !== undefined && r.status !== where.status) return { count: 0 }
      if ('sourceBucketKey' in where && r.sourceBucketKey !== where.sourceBucketKey) return { count: 0 }
      Object.assign(r, data)
      return { count: 1 }
    },
    async update({ where, data }: any) {
      const r = releases.get(where.id)
      if (r) Object.assign(r, data)
      return r
    },
  },
  nativeApp: {
    async findUnique() {
      return { projectId: 'proj_1', easAppId: 'eas-app-1', easAccountId: 'acct-1' }
    },
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: prismaProxy }))
mock.module('../credentials.service', () => ({
  readByokExpoToken: async () => 'byok-token',
  readAscKey: async () => null,
  readPlayKey: async () => null,
}))
useFakePrisma(fakePrisma)

const savedMode = process.env.NATIVE_RELEASE_MODE
process.env.NATIVE_RELEASE_MODE = 'byok'
afterAll(() => {
  if (savedMode === undefined) delete process.env.NATIVE_RELEASE_MODE
  else process.env.NATIVE_RELEASE_MODE = savedMode
})

const { sourcesUploaded, pendingSourceKey } = await import('../release.service')
const { setEasClient } = await import('../client')

let easRequests = 0
setEasClient({
  token: 'byok-token',
  async request() {
    easRequests++
    throw new Error('stop here: the claim already happened')
  },
} as any)

function seed(over: Record<string, any> = {}) {
  releases.set('rel_1', {
    id: 'rel_1',
    workspaceId: 'ws_1',
    projectId: 'proj_1',
    platforms: ['android'],
    kind: 'build',
    status: 'queued',
    step: 'uploading',
    testOutcome: null,
    createdById: null,
    sourceBucketKey: pendingSourceKey('issued-key'),
    ...over,
  })
}

beforeEach(() => {
  releases.clear()
  easRequests = 0
  useFakePrisma(fakePrisma)
})

describe('sourcesUploaded (SEC-22)', () => {
  it('refuses a key the release was not issued, before touching EAS', async () => {
    seed()
    await expect(sourcesUploaded({ releaseId: 'rel_1', bucketKey: 'attacker-key' })).rejects.toMatchObject({
      code: 'native_sources_rejected',
    })
    expect(easRequests).toBe(0)
    expect(releases.get('rel_1')!.sourceBucketKey).toBe(pendingSourceKey('issued-key'))
  })

  it("refuses another project's release", async () => {
    seed()
    await expect(
      sourcesUploaded({ releaseId: 'rel_1', bucketKey: 'issued-key', projectId: 'proj_other' }),
    ).rejects.toMatchObject({ code: 'native_release_missing' })
    expect(easRequests).toBe(0)
  })

  it('refuses a replay on a finished release', async () => {
    seed({ status: 'done', sourceBucketKey: 'issued-key' })
    await expect(sourcesUploaded({ releaseId: 'rel_1', bucketKey: 'issued-key' })).rejects.toMatchObject({
      code: 'native_sources_rejected',
    })
    expect(easRequests).toBe(0)
  })

  it('accepts the issued key once, and refuses the same call again', async () => {
    seed()
    await sourcesUploaded({ releaseId: 'rel_1', bucketKey: 'issued-key' }).catch(() => {})
    expect(releases.get('rel_1')!.sourceBucketKey).toBe('issued-key')
    expect(easRequests).toBe(1)

    await expect(sourcesUploaded({ releaseId: 'rel_1', bucketKey: 'issued-key' })).rejects.toMatchObject({
      code: 'native_sources_rejected',
    })
    expect(easRequests).toBe(1)
  })
})
