// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let findUniqueImpl: (args: any) => Promise<any> = async () => null
let findUniqueCalls = 0

mock.module('../../lib/prisma', () => ({
  prisma: {
    platformSetting: {
      findUnique: (args: any) => {
        findUniqueCalls += 1
        return findUniqueImpl(args)
      },
    },
  },
}))

const { requireMarketplaceFeature, isMarketplaceEnabled, _resetMarketplaceFeatureCacheForTests } =
  await import('../marketplace-feature')

interface FakeJsonResponse {
  body: any
  status: number
}

function makeContext() {
  const ctx: any = {
    json: (body: any, status?: number): FakeJsonResponse => ({
      body,
      status: status ?? 200,
    }),
  }
  return ctx
}

let nextCalled = 0
const next = async () => {
  nextCalled += 1
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_LOCAL_MODE = process.env.SHOGO_LOCAL_MODE

beforeEach(() => {
  nextCalled = 0
  findUniqueCalls = 0
  findUniqueImpl = async () => null
  _resetMarketplaceFeatureCacheForTests()
  // Force a non-test, non-local environment for the bypass-free path.
  // Each test that wants the bypasses sets them explicitly.
  process.env.NODE_ENV = 'production'
  delete process.env.SHOGO_LOCAL_MODE
})

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV
  if (ORIGINAL_LOCAL_MODE === undefined) {
    delete process.env.SHOGO_LOCAL_MODE
  } else {
    process.env.SHOGO_LOCAL_MODE = ORIGINAL_LOCAL_MODE
  }
})

describe('requireMarketplaceFeature', () => {
  it('calls next() when feature.marketplace = true', async () => {
    findUniqueImpl = async () => ({ value: 'true' })
    const c = makeContext()
    const result = await requireMarketplaceFeature(c, next)
    expect(result).toBeUndefined()
    expect(nextCalled).toBe(1)
  })

  it('returns 503 marketplace_disabled when feature.marketplace = false', async () => {
    findUniqueImpl = async () => ({ value: 'false' })
    const c = makeContext()
    const res = (await requireMarketplaceFeature(c, next)) as FakeJsonResponse
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('marketplace_disabled')
    expect(nextCalled).toBe(0)
  })

  it('returns 503 marketplace_disabled when the row is absent (default-deny)', async () => {
    findUniqueImpl = async () => null
    const c = makeContext()
    const res = (await requireMarketplaceFeature(c, next)) as FakeJsonResponse
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('marketplace_disabled')
    expect(nextCalled).toBe(0)
  })

  it('returns 503 when the value is some unexpected string (treated as not-true)', async () => {
    findUniqueImpl = async () => ({ value: 'maybe' })
    const c = makeContext()
    const res = (await requireMarketplaceFeature(c, next)) as FakeJsonResponse
    expect(res.status).toBe(503)
    expect(nextCalled).toBe(0)
  })

  it('fails closed (503) when the DB lookup throws', async () => {
    findUniqueImpl = async () => {
      throw new Error('connection refused')
    }
    const c = makeContext()
    const res = (await requireMarketplaceFeature(c, next)) as FakeJsonResponse
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('marketplace_disabled')
    expect(nextCalled).toBe(0)
  })

  it('queries by key=feature.marketplace selecting only value', async () => {
    let capturedArgs: any
    findUniqueImpl = async (args) => {
      capturedArgs = args
      return { value: 'true' }
    }
    const c = makeContext()
    await requireMarketplaceFeature(c, next)
    expect(capturedArgs.where).toEqual({ key: 'feature.marketplace' })
    expect(capturedArgs.select).toEqual({ value: true })
  })

  it('bypasses the gate entirely in NODE_ENV=test (no DB call)', async () => {
    process.env.NODE_ENV = 'test'
    findUniqueImpl = async () => ({ value: 'false' })
    const c = makeContext()
    const result = await requireMarketplaceFeature(c, next)
    expect(result).toBeUndefined()
    expect(nextCalled).toBe(1)
    expect(findUniqueCalls).toBe(0)
  })

  it('bypasses the gate when SHOGO_LOCAL_MODE=true (no DB call)', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    findUniqueImpl = async () => ({ value: 'false' })
    const c = makeContext()
    const result = await requireMarketplaceFeature(c, next)
    expect(result).toBeUndefined()
    expect(nextCalled).toBe(1)
    expect(findUniqueCalls).toBe(0)
  })

  it('caches the lookup so back-to-back calls only hit the DB once', async () => {
    findUniqueImpl = async () => ({ value: 'true' })
    await requireMarketplaceFeature(makeContext(), next)
    await requireMarketplaceFeature(makeContext(), next)
    await requireMarketplaceFeature(makeContext(), next)
    expect(findUniqueCalls).toBe(1)
    expect(nextCalled).toBe(3)
  })

  it('respects cache TTL — re-reads after the entry expires', async () => {
    findUniqueImpl = async () => ({ value: 'true' })
    const t0 = 1_700_000_000_000
    expect(await isMarketplaceEnabled(t0)).toBe(true)
    expect(findUniqueCalls).toBe(1)
    expect(await isMarketplaceEnabled(t0 + 1_000)).toBe(true)
    expect(findUniqueCalls).toBe(1)
    findUniqueImpl = async () => ({ value: 'false' })
    expect(await isMarketplaceEnabled(t0 + 30_000)).toBe(false)
    expect(findUniqueCalls).toBe(2)
  })

  it('cache is per-result, so a flip-from-true-to-false eventually takes effect', async () => {
    findUniqueImpl = async () => ({ value: 'true' })
    expect(await isMarketplaceEnabled(0)).toBe(true)
    findUniqueImpl = async () => ({ value: 'false' })
    _resetMarketplaceFeatureCacheForTests()
    expect(await isMarketplaceEnabled(0)).toBe(false)
  })
})
