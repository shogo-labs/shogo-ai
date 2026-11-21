// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `@shogo-ai/sdk/bucket` — the project's own object storage + CDN (SHO-491).
 *
 * **Server-only.** The credential this uses (the runtime token in a pod, or a
 * `shogo_sk_` API key outside one) must never reach a browser bundle. End-user
 * uploads from the browser go through the app's own route: that route calls
 * {@link BucketClient.createUpload} and hands the browser the presigned URL.
 *
 * ```ts
 * import { shogo } from '@/lib/shogo'
 *
 * await shogo.bucket.put('media/intro.mp4', Bun.file('./intro.mp4'), { public: true })
 * shogo.bucket.url('media/intro.mp4')            // CDN URL, sync, no network
 * await shogo.bucket.signedUrl('exports/report.pdf')  // private, short-lived
 * ```
 *
 * The same calls work on desktop; only the URL base differs (the local API
 * instead of the CDN), and `url()` reflects whichever one `createClient` was
 * pointed at.
 */

export {
  BucketClient,
  BucketError,
  BucketKeyExistsError,
  BucketNotConfiguredError,
  BucketPaymentRequiredError,
  type BucketClientOptions,
  type BucketDeleteResult,
  type BucketListedObject,
  type BucketListOptions,
  type BucketListPage,
  type BucketPutOptions,
  type BucketPutResult,
  type BucketUploadRequest,
  type BucketUploadTicket,
  type BucketUsage,
} from './client.js'

import type { BucketClientOptions } from './client.js'
import { BucketClient } from './client.js'

/**
 * Build a bucket client. `createClient({ projectId })` inside a pod needs
 * nothing else (`RUNTIME_AUTH_SECRET` is picked up); outside one, pass
 * `shogoApiKey`.
 */
export function createBucketClient(options: BucketClientOptions): BucketClient {
  return new BucketClient(options)
}
