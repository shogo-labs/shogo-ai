// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Discriminate object-store failures that point at missing credentials from
 * those that point at a missing object (SHO-551 §C).
 *
 * An auth failure (`NoSuchBucket`, `AccessDenied`, `InvalidAccessKeyId`, or the
 * HTTP 403/404 equivalents) means the runtime's store was not set up correctly —
 * there is nothing the publish caller can do except fix the credentials. A
 * missing object (`NoSuchKey`, 404) means the object the caller expected was
 * never uploaded, which is a data-loss signal that must NOT be swallowed.
 *
 * The publish path uses this to decide whether a media-offload error aborts the
 * publish: a credential failure is not data loss, but a missing object is.
 */
export function isObjectStoreAuthFailure(err: unknown): boolean {
  if (!err) return false
  const code = (err as any)?.Code ?? (err as any)?.code ?? ''
  if (typeof code === 'string') {
    if (/NoSuchBucket|AccessDenied|InvalidAccessKeyId|InvalidSecurity|RequestExpired/.test(code)) return true
  }
  const status = (err as any)?.$metadata?.httpStatusCode ?? (err as any)?.statusCode ?? (err as any)?.status
  if (typeof status === 'number' && (status === 403 || status === 401)) return true
  const message = String((err as any)?.message ?? '')
  return /access denied|invalid access key|no such bucket|credentials/i.test(message)
}
