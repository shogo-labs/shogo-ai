// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Storage for published sites: the static dist bucket and the published-data
 * (writable state) bucket.
 *
 * Split out of `routes/publish.ts` so the teardown path (`services/published-
 * site-teardown.ts`) can delete a site's bytes without importing a route module
 * — the delete hooks run long after the publish route is in the module graph.
 *
 * `PUBLISH_BUCKET` must be set explicitly in every K8s overlay
 * (k8s/overlays/{staging,production-*}/api-service.yaml) — the fallback below is
 * a deliberately wrong-looking local-dev value so a missing overlay value can't
 * silently route prod uploads to the staging bucket. That happened on
 * 2026-05-26: prod api ksvc had no PUBLISH_BUCKET, the old default
 * `shogo-published-apps-staging` won, and every prod publish wrote to the
 * staging bucket while the Cloudflare Worker for *.shogo.one was reading from
 * `shogo-published-apps-production` — every published app served
 * `ObjectNotFound`. `uploadToS3()` asserts at call time as well.
 */

import {
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'

export const PUBLISH_BUCKET = process.env.PUBLISH_BUCKET || 'shogo-published-apps-LOCAL-DEV'

/**
 * Writable-state bucket for SERVER-BACKED published apps (the SQLite DB +
 * upload dirs the running server.tsx persists). Separate from PUBLISH_BUCKET
 * (static dist). Unset → server-backed publishing degrades to "no durable
 * writes" but still serves dynamic /api/* from the source-seed DB.
 */
export const PUBLISH_DATA_BUCKET =
  process.env.PUBLISH_DATA_BUCKET || process.env.S3_PUBLISHED_DATA_BUCKET || ''

const AWS_REGION = process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1'

export const publishS3Client = new S3Client({
  region: AWS_REGION,
  ...(process.env.S3_ENDPOINT && {
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
  }),
})

/** Max concurrent single-object DELETEs. A bundle is tens of keys, not thousands. */
const DELETE_CONCURRENCY = 8

/** Every key under `prefix`, paginated (ListObjectsV2 caps a page at 1000). */
async function listKeysUnder(bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let continuationToken: string | undefined
  do {
    const res = await publishS3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key)
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (continuationToken)
  return keys
}

/**
 * Delete every object under `prefix`, then PROVE they are gone.
 *
 * One `DeleteObjectCommand` per key, never a `DeleteObjects` batch: OCI's
 * S3-compatible API rejects a multi-delete that carries no checksum header
 * ("Missing required header for this request: Content-MD5 or
 * x-amz-checksum-sha256 or x-amz-checksum-crc32c") and `@aws-sdk/client-s3`
 * ≥3.975 stopped sending one — so every teardown 500'd and left the site
 * serving (SHO-207). Single-object DELETEs need no checksum. It also drops the
 * batch API's silent partial failure: a `DeleteObjects` response can return 200
 * with per-key `Errors`, which nothing here ever read.
 *
 * Throws when a delete fails or when a re-list still finds objects. That is what
 * lets the teardown report `ok:false`: "we asked S3 to delete it" is not the
 * same claim as "it is gone", and only the second one means the site is down.
 */
async function purgePrefix(bucket: string, prefix: string, what: string): Promise<number> {
  const keys = await listKeysUnder(bucket, prefix)
  if (keys.length === 0) return 0

  const failures: string[] = []
  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    await Promise.all(
      keys.slice(i, i + DELETE_CONCURRENCY).map(async (Key) => {
        try {
          await publishS3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key }))
        } catch (err: any) {
          failures.push(`${Key}: ${err?.message ?? err}`)
        }
      }),
    )
  }

  const remaining = await listKeysUnder(bucket, prefix)
  if (failures.length > 0 || remaining.length > 0) {
    const parts = [
      failures.length > 0
        ? `${failures.length} delete(s) failed (${failures.slice(0, 3).join('; ')})`
        : null,
      remaining.length > 0
        ? `${remaining.length} object(s) still present (${remaining.slice(0, 3).join(', ')})`
        : null,
    ].filter(Boolean)
    throw new Error(`Could not remove ${what}: ${parts.join('; ')}`)
  }

  return keys.length
}

/**
 * Delete every object under a subdomain's prefix from the static bucket — the
 * site's HTML/JS/assets. Idempotent: no objects means nothing to do.
 *
 * Throws when the bytes are not actually gone, so the teardown step reports
 * `ok:false` instead of leaving a live site behind a green log line.
 */
export async function deletePublishedStaticBundle(subdomain: string): Promise<void> {
  console.log(`[Publish] Deleting files for subdomain ${subdomain} from S3`)

  const deleted = await purgePrefix(PUBLISH_BUCKET, `${subdomain}/`, `the static bundle for ${subdomain}`)

  if (deleted === 0) {
    console.log(`[Publish] No files found for subdomain ${subdomain}`)
    return
  }

  console.log(`[Publish] Deleted ${deleted} files for ${subdomain}`)
}

/**
 * Delete the published-data archive (`{subdomain}/data.tar.gz` + its timestamped
 * backups) for a subdomain. Unpublish KEEPS this on purpose so a republish
 * restores end-user writes; a project DELETE purges it, because nothing can ever
 * republish a project whose row is gone.
 */
export async function deletePublishedDataArchive(subdomain: string): Promise<void> {
  if (!PUBLISH_DATA_BUCKET) {
    console.log('[Publish] PUBLISH_DATA_BUCKET unset — no published-data archive to delete')
    return
  }

  const deleted = await purgePrefix(
    PUBLISH_DATA_BUCKET,
    `${subdomain}/`,
    `the published-data archive for ${subdomain}`,
  )

  if (deleted === 0) return

  console.log(`[Publish] Deleted published-data archive (${deleted} objects) for ${subdomain}`)
}
