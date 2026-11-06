// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-308 §2 — the image ref/digest scheme.
//
// Three callers share this scheme (the build that pushes, the ksvc that runs,
// the deployment row rollback switches to). If any of them disagrees with the
// others, rollback serves an image nobody built, so the shape is pinned here.

import { describe, expect, it } from 'bun:test'
import {
  digestOfImageRef,
  isDigestPinnedImageRef,
  publishedImageDigestRef,
  publishedImageRepository,
  publishedImageRepositoryOf,
  publishedImageTag,
  publishedImageTagRef,
} from '../published-image-ref'

const digest = `sha256:${'a'.repeat(64)}`

describe('repository and tag', () => {
  it('puts one repository per project under the registry namespace', () => {
    expect(
      publishedImageRepository({ registry: 'us-ashburn-1.ocir.io/', namespace: '/ax9/', projectId: 'proj-1' }),
    ).toBe('us-ashburn-1.ocir.io/ax9/shogo/published/proj-1')
  })

  it('refuses to invent a ref without a registry', () => {
    expect(() => publishedImageRepository({ registry: '', namespace: 'ns', projectId: 'p' })).toThrow()
  })

  it('sanitizes a project id into a tag-safe segment', () => {
    expect(publishedImageRepository({ registry: 'r', namespace: 'n', projectId: 'Proj_1/x y' })).toBe(
      'r/n/shogo/published/proj_1-x-y',
    )
  })

  it('lowercases the commit, because a docker tag cannot be uppercase', () => {
    expect(publishedImageTag('ABC123')).toBe('abc123')
    expect(() => publishedImageTag('  ')).toThrow()
  })

  it('tags a commit inside the project repository', () => {
    expect(
      publishedImageTagRef({ registry: 'r', namespace: 'n', projectId: 'proj-1', commitSha: 'ABC123' }),
    ).toBe('r/n/shogo/published/proj-1:abc123')
  })
})

describe('digest pinning', () => {
  it('pins a repo to a bare digest and does not double-prefix sha256', () => {
    expect(publishedImageDigestRef('r/n/p', digest)).toBe(`r/n/p@${digest}`)
    expect(publishedImageDigestRef('r/n/p', 'a'.repeat(64))).toBe(`r/n/p@${digest}`)
  })

  it('returns the repository when there is no digest yet', () => {
    expect(publishedImageDigestRef('r/n/p', null)).toBe('r/n/p')
  })

  it('re-pins a digest ref rather than appending a second @', () => {
    const other = `sha256:${'b'.repeat(64)}`
    expect(publishedImageDigestRef(`r/n/p@${digest}`, other)).toBe(`r/n/p@${other}`)
  })

  it('recognises a pinned ref, and does not mistake a tag for one', () => {
    expect(isDigestPinnedImageRef(`r/n/p@${digest}`)).toBe(true)
    expect(isDigestPinnedImageRef('r/n/p:abc123')).toBe(false)
    expect(isDigestPinnedImageRef(null)).toBe(false)
  })

  it('round-trips the digest out of a pinned ref', () => {
    expect(digestOfImageRef(`r/n/p@${digest}`)).toBe(digest)
    expect(digestOfImageRef('r/n/p:abc123')).toBeNull()
  })

  it('finds the repository inside either ref shape, ports included', () => {
    expect(publishedImageRepositoryOf(`r/n/p@${digest}`)).toBe('r/n/p')
    expect(publishedImageRepositoryOf('r/n/p:abc123')).toBe('r/n/p')
    // A registry host:port is not a tag.
    expect(publishedImageRepositoryOf('us-ashburn-1.ocir.io:5000/n/p:abc123')).toBe(
      'us-ashburn-1.ocir.io:5000/n/p',
    )
    expect(publishedImageRepositoryOf('us-ashburn-1.ocir.io:5000/n/p')).toBe('us-ashburn-1.ocir.io:5000/n/p')
  })
})
