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
  DeleteObjectsCommand,
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

/**
 * Delete every object under a subdomain's prefix from the static bucket — the
 * site's HTML/JS/assets. Idempotent: no objects means nothing to do.
 */
export async function deletePublishedStaticBundle(subdomain: string): Promise<void> {
  console.log(`[Publish] Deleting files for subdomain ${subdomain} from S3`)

  let deleted = 0
  let continuationToken: string | undefined
  // Paginate: ListObjectsV2 returns at most 1000 keys, and a static bundle left
  // behind is exactly what this call exists to remove.
  do {
    const listResponse = await publishS3Client.send(
      new ListObjectsV2Command({
        Bucket: PUBLISH_BUCKET,
        Prefix: `${subdomain}/`,
        ContinuationToken: continuationToken,
      }),
    )

    const objects = (listResponse.Contents ?? [])
      .filter((obj) => obj.Key)
      .map((obj) => ({ Key: obj.Key! }))
    if (objects.length > 0) {
      await publishS3Client.send(
        new DeleteObjectsCommand({
          Bucket: PUBLISH_BUCKET,
          Delete: { Objects: objects },
        }),
      )
      deleted += objects.length
    }

    continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined
  } while (continuationToken)

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

  let deleted = 0
  let continuationToken: string | undefined
  do {
    const listResponse = await publishS3Client.send(
      new ListObjectsV2Command({
        Bucket: PUBLISH_DATA_BUCKET,
        Prefix: `${subdomain}/`,
        ContinuationToken: continuationToken,
      }),
    )

    const keys = (listResponse.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((k): k is string => !!k)
    if (keys.length > 0) {
      await publishS3Client.send(
        new DeleteObjectsCommand({
          Bucket: PUBLISH_DATA_BUCKET,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      )
      deleted += keys.length
    }

    continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined
  } while (continuationToken)

  if (deleted === 0) return

  console.log(`[Publish] Deleted published-data archive (${deleted} objects) for ${subdomain}`)
}
