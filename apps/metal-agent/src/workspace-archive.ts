// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Host-side fetch of a project's durable workspace source backup.
 *
 * On bare metal the *guest* VM must never hold S3 credentials — a compromised
 * guest would otherwise reach the shared workspace bucket. So the trusted
 * metal-agent (this process) is the only thing that talks to S3. On a cold
 * miss (a fresh warm VM booted from the template, no snapshot to resume) it
 * pulls `{projectId}/project-src.tar.gz` and hands the bytes to the guest over
 * the control channel (`POST /pool/hydrate`), which extracts + rebuilds.
 *
 * This mirrors the key layout used by the Knative runtime's s3-sync
 * (packages/shared-runtime/src/s3-sync.ts): the durable source archive lives at
 * the bucket root under `{projectId}/project-src.tar.gz`. The bucket is the
 * workspaces bucket (`S3_WORKSPACES_BUCKET`), which on our deployments is the
 * same OCI bucket as the snapshot store — we fall back to the snapshot bucket
 * when `S3_WORKSPACES_BUCKET` is unset.
 */

import type { MetalConfig } from './config'

/**
 * Download `{projectId}/project-src.tar.gz` from the durable workspace bucket.
 * Returns the gzipped tar bytes, or `null` when there is no durable backup
 * (a genuinely new project) or S3 is not configured. Throws only on unexpected
 * transport errors so the caller can log + fall back to serving the template.
 */
export async function fetchWorkspaceArchive(
  projectId: string,
  cfg: MetalConfig,
): Promise<Uint8Array | null> {
  const bucket = process.env.S3_WORKSPACES_BUCKET || cfg.snapStoreBucket
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

  const key = `${projectId}/project-src.tar.gz`
  const file = client.file(key)
  // `exists()` distinguishes "no durable backup yet" (new project → serve
  // template) from a real fetch failure that the caller should log.
  if (!(await file.exists())) return null
  const buf = await file.arrayBuffer()
  return new Uint8Array(buf)
}
