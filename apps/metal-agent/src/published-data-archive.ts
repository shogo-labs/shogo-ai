// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Host-side durability for SERVER-BACKED published microVMs — the metal analog
 * of the Knative runtime's PublishedDataSync (packages/shared-runtime/src/
 * published-data-sync.ts).
 *
 * On Knative the published pod holds S3 credentials and syncs its own writable
 * state (SQLite DB + upload dirs) to `{subdomain}/data.tar.gz` in the
 * published-data bucket. On bare metal the *guest* VM must never hold S3
 * credentials (a compromised guest would reach the shared bucket), so the
 * trusted metal-agent is the only thing that talks to S3:
 *
 *   - cold boot  → `fetchPublishedDataArchive` pulls `{subdomain}/data.tar.gz`
 *                  and the pool overlays it into the guest (host-side hydration,
 *                  mirroring the source-workspace archive path);
 *   - periodic / on suspend → the pool pulls the guest's packed writable state
 *                  and `uploadPublishedDataArchive` writes it back to S3.
 *
 * The bucket + key layout match the API side exactly (apps/api/src/routes/
 * publish.ts `putPublishedArchive`) so the same archive is interchangeable
 * between the Knative pod, the manual dev->live data push, and the metal VM.
 */

import type { MetalConfig } from './config'

/** Key holding a published subdomain's writable-state archive. */
function dataKey(subdomain: string): string {
  return `${subdomain}/data.tar.gz`
}

/** Bucket + credential resolution for the published-data bucket. Null when unusable. */
function publishedDataS3(cfg: MetalConfig): { client: import('bun').S3Client } | null {
  const bucket = cfg.publishDataBucket
  if (!bucket) return null
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return null

  const { S3Client } = require('bun') as typeof import('bun')
  const client = new S3Client({
    bucket,
    endpoint: cfg.s3Endpoint || undefined,
    region: cfg.s3Region,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  })
  return { client }
}

/**
 * Download `{subdomain}/data.tar.gz` from the published-data bucket. Returns the
 * gzipped tar bytes, or `null` when there is no archive yet (a first publish
 * with no seed) or S3 is not configured. Throws only on unexpected transport
 * errors so the caller can log + fall back to the git-seeded DB.
 */
export async function fetchPublishedDataArchive(
  subdomain: string,
  cfg: MetalConfig,
): Promise<Uint8Array | null> {
  const s3 = publishedDataS3(cfg)
  if (!s3) return null
  const file = s3.client.file(dataKey(subdomain))
  if (!(await file.exists())) return null
  const buf = await file.arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * Upload `{subdomain}/data.tar.gz` to the published-data bucket. Returns `false`
 * (no throw) when S3 is not configured so the caller can treat durability as
 * best-effort; throws only on a real transport error.
 */
export async function uploadPublishedDataArchive(
  subdomain: string,
  bytes: Uint8Array,
  cfg: MetalConfig,
): Promise<boolean> {
  const s3 = publishedDataS3(cfg)
  if (!s3) return false
  await s3.client.write(dataKey(subdomain), bytes, { type: 'application/gzip' })
  return true
}
