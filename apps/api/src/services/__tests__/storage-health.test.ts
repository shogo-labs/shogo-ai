// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bucket existence on /api/health (SHO-514).
 *
 * The bug this pins: a bucket merged but never applied answered every upload
 * with `NoSuchBucket`, while /api/health stayed 200 because the api serves pages
 * fine without storage. So the field must report a 404 bucket, must NOT report a
 * 403/timeout as missing (it fails deploys), and must never change the status
 * code.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  STORAGE_HEALTH_REFRESH_MS,
  checkConfiguredBuckets,
  configuredBuckets,
  lastStorageHealth,
  resetStorageHealthCache,
  storageHealth,
} from '../storage-health.service'
import { buildHealthPayload } from '../../lib/health-payload'

const ENV = {
  S3_PROJECT_BUCKET: 'shogo-projects-staging',
  S3_PUBLISHED_DATA_BUCKET: 'shogo-published-data-staging',
  PUBLISH_BUCKET: 'shogo-published-staging',
} as unknown as NodeJS.ProcessEnv

function notFound(): any {
  const err: any = new Error('NotFound')
  err.name = 'NotFound'
  err.$metadata = { httpStatusCode: 404 }
  return err
}

function denied(): any {
  const err: any = new Error('AccessDenied')
  err.name = 'AccessDenied'
  err.$metadata = { httpStatusCode: 403 }
  return err
}

beforeEach(() => resetStorageHealthCache())

describe('configuredBuckets', () => {
  it('lists only the buckets this deployment configures', () => {
    expect(configuredBuckets(ENV).map((t) => t.env)).toEqual([
      'S3_PROJECT_BUCKET',
      'PUBLISH_DATA_BUCKET',
      'PUBLISH_BUCKET',
    ])
    // Desktop / an unwired cluster: nothing to check is not a missing bucket.
    expect(configuredBuckets({} as NodeJS.ProcessEnv)).toEqual([])
  })
})

describe('checkConfiguredBuckets', () => {
  it('reports the env var of a bucket that returns 404', async () => {
    const result = await checkConfiguredBuckets({
      env: ENV,
      head: async (target) => {
        if (target.env === 'PUBLISH_BUCKET') throw notFound()
      },
    })
    expect(result).toEqual({ ok: false, missing: ['PUBLISH_BUCKET'] })
  })

  it('does not call a bucket missing when the check itself failed', async () => {
    const result = await checkConfiguredBuckets({
      env: ENV,
      head: async () => {
        throw denied()
      },
    })
    expect(result).toEqual({ ok: true, missing: [] })
  })

  it('checks every configured bucket, concurrently', async () => {
    const seen: string[] = []
    const health = await checkConfiguredBuckets({
      env: ENV,
      head: async (target) => {
        seen.push(target.bucket)
      },
    })
    expect(seen.sort()).toEqual(['shogo-projects-staging', 'shogo-published-data-staging', 'shogo-published-staging'])
    expect(health.ok).toBe(true)
  })
})

describe('storageHealth', () => {
  it('never blocks a probe: a stale cache answers at once and refreshes behind it', async () => {
    let calls = 0
    const head = async () => {
      calls++
      throw notFound()
    }
    // Nothing checked yet: the probe gets an answer without waiting for one.
    const first = await storageHealth({ env: ENV, head, now: 0 })
    expect(first.ok).toBe(true)
    expect(lastStorageHealth()).toEqual({ ok: true, missing: [] })

    // The background pass runs the three HeadBuckets.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(3)
    expect(lastStorageHealth()).toEqual({ ok: false, missing: ['S3_PROJECT_BUCKET', 'PUBLISH_DATA_BUCKET', 'PUBLISH_BUCKET'] })

    // Cached until the interval passes...
    await storageHealth({ env: ENV, head, now: STORAGE_HEALTH_REFRESH_MS - 1 })
    expect(calls).toBe(3)
    // ...then one more background pass.
    await storageHealth({ env: ENV, head, now: STORAGE_HEALTH_REFRESH_MS + 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(6)
  })

  it('awaits the check when the deploy gate forces it', async () => {
    const head = async () => {
      throw notFound()
    }
    const forced = await storageHealth({ env: ENV, head, now: 1_000_000, force: true })
    expect(forced).toEqual({ ok: false, missing: ['S3_PROJECT_BUCKET', 'PUBLISH_DATA_BUCKET', 'PUBLISH_BUCKET'] })
  })

  it('rate-limits a forced check so a public endpoint cannot amplify into bucket scans', async () => {
    let calls = 0
    const head = async () => {
      calls++
    }
    await storageHealth({ env: ENV, head, now: 1_000_000, force: true })
    expect(calls).toBe(3)
    await storageHealth({ env: ENV, head, now: 1_001_000, force: true })
    expect(calls).toBe(3)
  })
})

describe('buildHealthPayload', () => {
  const storage = { ok: false, missing: ['PUBLISH_BUCKET'] }

  it('keeps a missing bucket out of the status code', () => {
    const body = buildHealthPayload({
      version: '1.2.3',
      redis: { healthy: true, latencyMs: 4 },
      degraded: false,
      storage,
    })
    // A short OCI blip must not drain every api pod out of the LB.
    expect(body.ok).toBe(true)
    expect(body.storage).toEqual(storage)
  })

  it('still fails on the conditions that make THIS pod unusable', () => {
    const redisDown = buildHealthPayload({
      version: '1.2.3',
      redis: { healthy: false, latencyMs: null },
      degraded: false,
      storage,
    })
    expect(redisDown.ok).toBe(false)
    const tunnelDegraded = buildHealthPayload({
      version: '1.2.3',
      redis: { healthy: true, latencyMs: 4 },
      degraded: true,
      storage,
    })
    expect(tunnelDegraded.ok).toBe(false)
  })
})
