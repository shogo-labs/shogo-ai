// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Key and layout rules for a project's bucket (SHO-491).
 *
 * Kept dependency-free so the storage meter (`services/storage.service.ts`,
 * which runs in a 6-hourly job and must not pull the billing stack in) and the
 * bucket service share one definition of what a valid key is and where it
 * lives:
 *
 *   `p/<projectId>/<visibility>/<key>`   in `S3_PROJECT_BUCKET`
 *   `<dataDir>/project-buckets/<projectId>/<visibility>/<key>`   on desktop
 */

/** Longest key we accept. Deep upload trees are fine; a serialized dir is not. */
export const BUCKET_KEY_MAX_LENGTH = 1024

/** Where every project bucket object lives, in the bucket and on disk. */
export const BUCKET_PREFIX = 'p/'

export type BucketVisibility = 'public' | 'private'

export interface BucketKeyError {
  ok: false
  code: 'invalid_key'
  message: string
}

/**
 * Validate a caller's key and normalise it: no leading `/`, no empty segments,
 * no `..`, no backslashes, no control characters. Everything the CDN and the
 * filesystem driver later join into a path is checked here once.
 */
export function validateBucketKey(raw: unknown): { ok: true; key: string } | BucketKeyError {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'invalid_key', message: 'key must be a string' }
  }
  const key = raw.replace(/^\/+/, '')
  if (!key) return { ok: false, code: 'invalid_key', message: 'key must not be empty' }
  if (key.length > BUCKET_KEY_MAX_LENGTH) {
    return {
      ok: false,
      code: 'invalid_key',
      message: `key must be at most ${BUCKET_KEY_MAX_LENGTH} characters`,
    }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    return { ok: false, code: 'invalid_key', message: 'key must not contain control characters' }
  }
  if (key.includes('\\')) {
    return { ok: false, code: 'invalid_key', message: 'key must use "/" separators' }
  }
  const segments = key.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return {
      ok: false,
      code: 'invalid_key',
      message: 'key must not contain empty, "." or ".." segments',
    }
  }
  if (segments.some((segment) => segment.length > 255)) {
    return { ok: false, code: 'invalid_key', message: 'each key segment must be at most 255 characters' }
  }
  return { ok: true, key }
}

export function normalizeBucketVisibility(raw: unknown): BucketVisibility {
  return raw === 'private' ? 'private' : 'public'
}

/** The bucket/disk path of one object: `p/<projectId>/<visibility>/<key>`. */
export function bucketObjectPath(projectId: string, visibility: BucketVisibility, key: string): string {
  return `${BUCKET_PREFIX}${projectId}/${visibility}/${key}`
}

/** The prefix a project's whole bucket lives under. */
export function projectBucketPrefix(projectId: string): string {
  return `${BUCKET_PREFIX}${projectId}/`
}

/**
 * Inverse of {@link bucketObjectPath}: which project, visibility and key a
 * storage path names. Null for anything outside the project-bucket namespace
 * (the storage meter skips it rather than attributing a stray object to a
 * project that merely shares an id).
 */
export function parseBucketObjectPath(
  path: string,
): { projectId: string; visibility: BucketVisibility; key: string } | null {
  if (!path.startsWith(BUCKET_PREFIX)) return null
  const rest = path.slice(BUCKET_PREFIX.length)
  const first = rest.indexOf('/')
  if (first <= 0) return null
  const projectId = rest.slice(0, first)
  const afterProject = rest.slice(first + 1)
  const visibilityEnd = afterProject.indexOf('/')
  if (visibilityEnd <= 0) return null
  const visibility = afterProject.slice(0, visibilityEnd)
  if (visibility !== 'public' && visibility !== 'private') return null
  const key = afterProject.slice(visibilityEnd + 1)
  if (!key) return null
  return { projectId, visibility, key }
}

// ---------------------------------------------------------------------------
// Multipart thresholds
// ---------------------------------------------------------------------------

/** At or above this, an upload ticket is multipart. */
export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024

/** 16 MiB parts: above every provider minimum, and a bounded per-part buffer. */
export const MULTIPART_PART_SIZE = 16 * 1024 * 1024

/** Upper bound on parts per upload (S3 allows 10 000). */
export const MULTIPART_MAX_PARTS = 1000

export function shouldUseMultipart(sizeBytes: number): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes >= MULTIPART_THRESHOLD_BYTES
}

/** Parts a multipart upload of `sizeBytes` needs, at {@link MULTIPART_PART_SIZE}. */
export function multipartPartCount(sizeBytes: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 1
  return Math.max(1, Math.ceil(sizeBytes / MULTIPART_PART_SIZE))
}

/** Percent-encode each segment of a key, keeping the `/` separators. */
export function encodePathSegments(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}
