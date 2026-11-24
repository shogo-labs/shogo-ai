// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Do the configured object-storage buckets actually exist (SHO-514)?
 *
 * The 2026-11 incident this exists for: a bucket that had been merged but never
 * applied made every upload fail with `NoSuchBucket` — for hours, at users, long
 * after a green deploy. The deploy's health gate only asked whether the API
 * answered 200, which it did; the API does not need a bucket to serve a page.
 *
 * So the API checks its own buckets at boot and on a slow interval, and reports
 * the answer on `/api/health`. The DEPLOY gate reads that field and fails the
 * rollout, turning a silent user-visible outage into a red deploy.
 *
 * Deliberately NOT part of the 200/503 decision: a short OCI blip must not pull
 * every API pod out of the load balancer. `ok` stays "the process is healthy";
 * `storage.ok` is the deploy-time assertion.
 */

import { HeadBucketCommand } from '@aws-sdk/client-s3'
import { getS3Client } from '../lib/s3'
import { PUBLISH_DATA_BUCKET, publishS3Client } from '../lib/publish-storage'

/** How often a running API re-checks. Slow on purpose: existence is not liveness. */
export const STORAGE_HEALTH_REFRESH_MS = 10 * 60 * 1000

/** One HeadBucket must never hold a health response open. */
const HEAD_TIMEOUT_MS = 5_000

export interface StorageHealth {
  /** False when a configured bucket does not exist. */
  ok: boolean
  /** The ENV VAR NAMES of the buckets that returned 404 — never bucket names. */
  missing: string[]
}

export interface BucketTarget {
  /** The env var that configures it; this is what a report names. */
  env: string
  bucket: string
}

/**
 * Buckets this deployment is configured to use, by env name.
 *
 * Nothing is checked for an unset env: desktop has no object storage, and a
 * cluster that has not wired `PUBLISH_DATA_BUCKET` yet is a configuration
 * choice, not a missing bucket. `PUBLISH_BUCKET` is read straight from the
 * environment because `lib/publish-storage` carries a local-dev fallback value
 * that must never be probed for real.
 */
export function configuredBuckets(env: NodeJS.ProcessEnv = process.env): BucketTarget[] {
  const targets: BucketTarget[] = []
  const project = (env.S3_PROJECT_BUCKET || '').trim()
  if (project) targets.push({ env: 'S3_PROJECT_BUCKET', bucket: project })
  const publishData = (PUBLISH_DATA_BUCKET || env.S3_PUBLISHED_DATA_BUCKET || '').trim()
  if (publishData) targets.push({ env: 'PUBLISH_DATA_BUCKET', bucket: publishData })
  const publish = (env.PUBLISH_BUCKET || '').trim()
  if (publish) targets.push({ env: 'PUBLISH_BUCKET', bucket: publish })
  return targets
}

function clientFor(env: string): { send: (command: any, options?: any) => Promise<any> } {
  // The project bucket is written through the internal client; both publish
  // buckets share theirs. Picking the one that actually writes the bucket keeps
  // this from vouching for a bucket the writes never reach.
  if (env === 'S3_PROJECT_BUCKET') return getS3Client()
  return publishS3Client
}

/** True for the responses that mean "this bucket does not exist". */
function isMissingBucket(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode
  const name = String(err?.name ?? '')
  const code = String(err?.Code ?? err?.code ?? '')
  return (
    status === 404 ||
    name === 'NotFound' ||
    name === 'NoSuchBucket' ||
    code === 'NoSuchBucket' ||
    code === 'NotFound'
  )
}

/**
 * One HeadBucket per configured bucket.
 *
 * A 404 (or `NoSuchBucket`) marks the env missing. Any other failure — a
 * timeout, a 403, a 5xx — is logged and NOT reported as missing: this field
 * fails deploys, so it must not turn a transient network error into "the bucket
 * is gone". The next interval retries.
 */
export async function checkConfiguredBuckets(opts: {
  env?: NodeJS.ProcessEnv
  head?: (target: BucketTarget) => Promise<void>
} = {}): Promise<StorageHealth> {
  const targets = configuredBuckets(opts.env)
  const head =
    opts.head ??
    (async (target: BucketTarget) => {
      await clientFor(target.env).send(new HeadBucketCommand({ Bucket: target.bucket }), {
        abortSignal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      })
    })

  const missing: string[] = []
  // Concurrent: three sequential 5s timeouts would hold a health probe open for
  // 15s on a bad day, and this runs on every fresh pod's first request.
  const results = await Promise.allSettled(targets.map((target) => head(target)))
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') return
    const target = targets[i]!
    const err = result.reason
    if (isMissingBucket(err)) {
      console.error(
        `[StorageHealth] ${target.env} bucket does not exist (${target.bucket}): run terraform.yml apply for this environment`,
      )
      missing.push(target.env)
    } else {
      console.warn(
        `[StorageHealth] could not verify ${target.env} (${err?.message ?? err}); not reporting it missing`,
      )
    }
  })
  return { ok: missing.length === 0, missing }
}

interface CachedHealth {
  at: number
  health: StorageHealth
}

let cached: CachedHealth | null = null
let inFlight: Promise<StorageHealth> | null = null
/** When the last caller-forced check ran; forced checks are rate-limited. */
let lastForced = 0

/** Drop the cache. For tests, and for a deliberate re-check. */
export function resetStorageHealthCache(): void {
  cached = null
  inFlight = null
  lastForced = 0
}

/** Shortest gap between two caller-forced checks. */
const FORCED_REFRESH_MIN_GAP_MS = 30_000

function refresh(opts: { env?: NodeJS.ProcessEnv; head?: (target: BucketTarget) => Promise<void> }, stampedAt: number) {
  if (!inFlight) {
    inFlight = checkConfiguredBuckets(opts)
      .then((health) => {
        cached = { at: stampedAt, health }
        return health
      })
      .catch((err: any) => {
        // Never let a check failure mask the API: report nothing missing.
        console.warn(`[StorageHealth] check failed (${err?.message ?? err}); reporting storage ok`)
        return { ok: true, missing: [] }
      })
      .finally(() => {
        inFlight = null
      })
  }
  return inFlight
}

/** The last known verdict, or "ok" before the first check has finished. */
export function lastStorageHealth(): StorageHealth {
  return cached?.health ?? { ok: true, missing: [] }
}

/**
 * Start a check if the cached answer is stale, without waiting for it.
 *
 * Called at boot and on every health probe, because a probe has a 1s timeout:
 * three HeadBuckets must never decide whether the pod is Ready.
 *
 * `now` is the same clock the caller judged staleness with. Mixing an injected
 * clock with a real one makes a cache entry stamped in the past look fresh, and
 * a test would then never see the refresh it is asserting on.
 */
export function refreshStorageHealthInBackground(
  opts: { env?: NodeJS.ProcessEnv; head?: (target: BucketTarget) => Promise<void>; now?: number } = {},
): void {
  const now = opts.now ?? Date.now()
  if (cached && now - cached.at < STORAGE_HEALTH_REFRESH_MS) return
  if (inFlight) return
  void refresh(opts, now)
}

/**
 * The cached answer, refreshed when stale.
 *
 * Never waits on the network unless the caller passes `force` — the deploy gate
 * does, so its verdict is authoritative rather than whatever happened to be
 * cached. Forced checks are rate-limited so a public endpoint cannot be turned
 * into a bucket-scan amplifier.
 */
export async function storageHealth(opts: {
  now?: number
  env?: NodeJS.ProcessEnv
  head?: (target: BucketTarget) => Promise<void>
  force?: boolean
} = {}): Promise<StorageHealth> {
  const now = opts.now ?? Date.now()

  if (opts.force && now - lastForced >= FORCED_REFRESH_MIN_GAP_MS) {
    lastForced = now
    return refresh(opts, now)
  }

  if (cached && now - cached.at < STORAGE_HEALTH_REFRESH_MS) return cached.health
  // Stale or never checked: answer with what we have and start the refresh. The
  // caller that needs a fresh answer passes `force`.
  refreshStorageHealthInBackground({ env: opts.env, head: opts.head, now })
  return lastStorageHealth()
}
