// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pin the source a server-backed publish ships.
 *
 * A server-backed site without a per-commit image boots the shared runtime
 * image and hydrates its source when the pod starts. It used to take that
 * source from the editing runtime's durable backup (`repo.git.tar.gz`, then
 * `project-src.tar.gz`). A metal runtime only writes those backups when it
 * stops or suspends, so a publish from a long-lived runtime uploaded fresh
 * static files and then booted days-old `server.tsx`: new routes 404'd and a
 * security fix never reached production, however many times it was published
 * (KIF CRM, 2026-11-16).
 *
 * The publish now pulls the source from the editing runtime itself
 * (`/agent/publish-source`) and writes it to `{subdomain}/source.tar.gz` in the
 * published-data bucket before the service rolls. The published pod hydrates
 * from that first. If the snapshot cannot be taken the publish fails: shipping
 * a server we know may be stale is the bug this exists to remove.
 */

import { PUBLISHED_SOURCE_KEY } from '@shogo/shared-runtime/published-source'

export const PUBLISH_SOURCE_TIMEOUT_MS = 180_000

export interface PinPublishedSourceDeps {
  /** The published-data bucket, or '' when the cluster has none. */
  bucket: string
  podUrl(projectId: string): Promise<string>
  runtimeToken(projectId: string): Promise<string>
  fetch(url: string, init: RequestInit): Promise<Response>
  put(bucket: string, key: string, body: Uint8Array): Promise<void>
}

export type PinPublishedSourceResult =
  | { ok: true; key: string; bytes: number }
  | { ok: true; skipped: 'no_data_bucket' }
  | { ok: false; code: 'source_snapshot_failed'; message: string }

export function publishedSourceKey(subdomain: string): string {
  return `${subdomain}/${PUBLISHED_SOURCE_KEY}`
}

async function defaultDeps(): Promise<PinPublishedSourceDeps> {
  const { PUBLISH_DATA_BUCKET, publishS3Client } = await import('../lib/publish-storage')
  const { getProjectPodUrl } = await import('../lib/knative-project-manager')
  const { deriveProjectRuntimeToken } = await import('../lib/project-runtime-token')
  const { PutObjectCommand } = await import('@aws-sdk/client-s3')
  return {
    bucket: PUBLISH_DATA_BUCKET,
    podUrl: getProjectPodUrl,
    runtimeToken: deriveProjectRuntimeToken,
    fetch: (url, init) => fetch(url, init),
    put: async (bucket, key, body) => {
      await publishS3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/gzip',
          CacheControl: 'no-store',
        }),
      )
    },
  }
}

export async function pinPublishedSource(
  input: { projectId: string; subdomain: string },
  deps?: PinPublishedSourceDeps,
): Promise<PinPublishedSourceResult> {
  const d = deps ?? (await defaultDeps())
  if (!d.bucket) {
    // Same degradation as the writable-state seed: a cluster without the bucket
    // keeps hydrating from the durable backups.
    console.warn(`[Publish] PUBLISH_DATA_BUCKET unset — not pinning the source for ${input.projectId}`)
    return { ok: true, skipped: 'no_data_bucket' }
  }
  const fail = (message: string): PinPublishedSourceResult => ({
    ok: false,
    code: 'source_snapshot_failed',
    message: `Could not snapshot the project's source for the published server: ${message}`,
  })
  let bytes: Uint8Array
  try {
    const podUrl = await d.podUrl(input.projectId)
    const res = await d.fetch(
      `${podUrl}/agent/publish-source?projectId=${encodeURIComponent(input.projectId)}`,
      {
        headers: { 'x-runtime-token': await d.runtimeToken(input.projectId) },
        signal: AbortSignal.timeout(PUBLISH_SOURCE_TIMEOUT_MS),
      },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return fail(`the runtime answered ${res.status}${body ? ` (${body.slice(0, 300)})` : ''}`)
    }
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (err: any) {
    return fail(err?.message ?? String(err))
  }
  if (bytes.byteLength === 0) return fail('the runtime returned an empty archive')

  const key = publishedSourceKey(input.subdomain)
  try {
    await d.put(d.bucket, key, bytes)
  } catch (err: any) {
    return fail(`upload to ${key} failed: ${err?.message ?? err}`)
  }
  console.log(`[Publish] Pinned published source for ${input.projectId} at ${key} (${bytes.byteLength} bytes)`)
  return { ok: true, key, bytes: bytes.byteLength }
}
