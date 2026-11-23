// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Key, layout and multipart rules for a project's bucket (SHO-491).
 *
 * These are the checks everything else trusts: the API validates a caller's key
 * once, then the S3 driver, the filesystem driver, the storage meter and the CDN
 * all join it into a path. A hole here is a traversal, so each rejection is
 * pinned rather than assumed.
 */

import { describe, expect, test } from 'bun:test'
import {
  BUCKET_KEY_MAX_LENGTH,
  BUCKET_PREFIX,
  MULTIPART_MAX_PARTS,
  MULTIPART_PART_SIZE,
  MULTIPART_THRESHOLD_BYTES,
  bucketObjectPath,
  encodePathSegments,
  multipartPartCount,
  normalizeBucketVisibility,
  parseBucketObjectPath,
  projectBucketPrefix,
  shouldUseMultipart,
  validateBucketKey,
} from '../lib/project-bucket-keys'

describe('validateBucketKey', () => {
  test('accepts a nested key and strips a leading slash', () => {
    expect(validateBucketKey('media/renders/hero.mp4')).toEqual({
      ok: true,
      key: 'media/renders/hero.mp4',
    })
    expect(validateBucketKey('/media/hero.mp4')).toEqual({ ok: true, key: 'media/hero.mp4' })
  })

  test('accepts spaces, hash and unicode inside a segment', () => {
    expect(validateBucketKey('a b/c#d/é.png')).toEqual({ ok: true, key: 'a b/c#d/é.png' })
  })

  test('rejects a non-string, an empty key and a bare slash', () => {
    for (const raw of [undefined, null, 42, {}, '', '/', '///']) {
      const result = validateBucketKey(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('invalid_key')
    }
  })

  test('rejects traversal, dot segments and empty segments instead of normalising', () => {
    for (const key of ['..', '../etc/passwd', 'a/../b', 'a/./b', 'a//b', './x', 'x/..']) {
      const result = validateBucketKey(key)
      expect({ key, ok: result.ok }).toEqual({ key, ok: false })
    }
  })

  test('rejects backslashes, because a desktop path join would treat them as separators', () => {
    expect(validateBucketKey('a\\b')).toEqual({
      ok: false,
      code: 'invalid_key',
      message: 'key must use "/" separators',
    })
  })

  test('rejects control characters', () => {
    expect(validateBucketKey('a\u0000b').ok).toBe(false)
    expect(validateBucketKey('a\nb').ok).toBe(false)
    expect(validateBucketKey('a\u007fb').ok).toBe(false)
  })

  test('enforces the length cap on the whole key and on each segment', () => {
    // Segments of 255 joined by slashes: 1023 characters, just under the cap.
    const nearCap = ['a', 'b', 'c', 'd'].map((char) => char.repeat(255)).join('/')
    expect(nearCap.length).toBe(BUCKET_KEY_MAX_LENGTH - 1)
    expect(validateBucketKey(nearCap).ok).toBe(true)

    // The only difference is one character, and every segment is still legal,
    // so this can only be refused by the whole-key cap.
    const overCap = `${nearCap}/x`
    expect(overCap.length).toBe(BUCKET_KEY_MAX_LENGTH + 1)
    const result = validateBucketKey(overCap)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain(`at most ${BUCKET_KEY_MAX_LENGTH}`)

    // A single over-long segment is out even when the whole key is short.
    expect(validateBucketKey('a'.repeat(255)).ok).toBe(true)
    expect(validateBucketKey('a'.repeat(256)).ok).toBe(false)
  })
})

describe('layout', () => {
  test('objects live under p/<projectId>/<visibility>/<key>', () => {
    expect(BUCKET_PREFIX).toBe('p/')
    expect(bucketObjectPath('p1', 'public', 'a/b.png')).toBe('p/p1/public/a/b.png')
    expect(bucketObjectPath('p1', 'private', 'a/b.png')).toBe('p/p1/private/a/b.png')
    expect(projectBucketPrefix('p1')).toBe('p/p1/')
  })

  test('parseBucketObjectPath is the inverse, and refuses anything outside the namespace', () => {
    expect(parseBucketObjectPath('p/p1/public/a/b.png')).toEqual({
      projectId: 'p1',
      visibility: 'public',
      key: 'a/b.png',
    })
    expect(parseBucketObjectPath('p/p1/private/x.pdf')).toEqual({
      projectId: 'p1',
      visibility: 'private',
      key: 'x.pdf',
    })

    for (const path of [
      'other/p1/public/a.png',
      'p/',
      'p/p1',
      'p/p1/public',
      'p/p1/public/',
      'p//public/a.png',
      'p/p1/secret/a.png',
      'p/public/a.png',
    ]) {
      expect({ path, parsed: parseBucketObjectPath(path) }).toEqual({ path, parsed: null })
    }
  })

  test('a round trip preserves the key', () => {
    for (const key of ['a.png', 'deep/nested/path/file.bin', 'with space.png', 'hash#tag.txt']) {
      const parsed = parseBucketObjectPath(bucketObjectPath('p1', 'public', key))
      expect(parsed?.key).toBe(key)
    }
  })

  test('visibility normalises to public unless it says private', () => {
    expect(normalizeBucketVisibility('private')).toBe('private')
    expect(normalizeBucketVisibility('public')).toBe('public')
    expect(normalizeBucketVisibility(undefined)).toBe('public')
    expect(normalizeBucketVisibility('nonsense')).toBe('public')
  })

  test('a key is percent-encoded per segment, keeping the separators', () => {
    expect(encodePathSegments('a b/c#d/e.png')).toBe('a%20b/c%23d/e.png')
  })
})

describe('multipart thresholds', () => {
  test('only big objects go multipart', () => {
    expect(MULTIPART_THRESHOLD_BYTES).toBe(64 * 1024 * 1024)
    expect(shouldUseMultipart(MULTIPART_THRESHOLD_BYTES - 1)).toBe(false)
    expect(shouldUseMultipart(MULTIPART_THRESHOLD_BYTES)).toBe(true)
    // A stream has no size: never claim multipart for a NaN/Infinity.
    expect(shouldUseMultipart(Number.NaN)).toBe(false)
    expect(shouldUseMultipart(Number.POSITIVE_INFINITY)).toBe(false)
  })

  test('part count covers the size and stays inside the provider limit', () => {
    expect(MULTIPART_PART_SIZE).toBe(16 * 1024 * 1024)
    expect(multipartPartCount(0)).toBe(1)
    expect(multipartPartCount(Number.NaN)).toBe(1)
    expect(multipartPartCount(1)).toBe(1)
    expect(multipartPartCount(MULTIPART_PART_SIZE)).toBe(1)
    expect(multipartPartCount(MULTIPART_PART_SIZE + 1)).toBe(2)
    expect(multipartPartCount(MULTIPART_PART_SIZE * 10)).toBe(10)
  })

  test('the part cap is under S3 limits and inside MULTIPART_MAX_PARTS parts', () => {
    expect(MULTIPART_MAX_PARTS).toBeLessThanOrEqual(10_000)
    // Large-but-realistic object: 1000 parts * 16 MiB = < 16 GiB per upload.
    expect(MULTIPART_MAX_PARTS * MULTIPART_PART_SIZE).toBeGreaterThan(15 * 1024 ** 3)
  })
})
