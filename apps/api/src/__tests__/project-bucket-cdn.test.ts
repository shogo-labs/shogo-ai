// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The project-bucket CDN guard (SHO-491).
 *
 * `cdn.<domain>/<projectId>/<key>` is rewritten to `p/<projectId>/public/<key>`
 * before it reaches the read-only pre-authenticated request — and that PAR
 * covers the WHOLE bucket, so the rewrite is the only thing keeping a private
 * object off the public CDN.
 *
 * The edge copy of the rewrite lives in the Terraform-generated Worker
 * (`terraform/modules/publish-hosting-oci`), which cannot import application
 * code. These tests pin the API's implementation and then evaluate the
 * Worker's copy straight out of the Terraform source, so a change to either
 * side fails here instead of shipping a hole.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cdnCacheControl, cdnObjectKey } from '../lib/project-bucket-cdn'

const WORKER_SOURCE = join(
  import.meta.dir,
  '../../../../terraform/modules/publish-hosting-oci/main.tf',
)

/** Pull one `function name(...) { … }` body out of the Worker's inline script. */
function workerFunction(name: string): (...args: any[]) => any {
  const source = readFileSync(WORKER_SOURCE, 'utf8')
  const start = source.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const bodyStart = source.indexOf('{', start)
  // Brace-match: the Worker's functions are plain JS, so counting braces is
  // enough and it keeps this test from having to know the indentation.
  let depth = 0
  let end = -1
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  expect(end).toBeGreaterThan(-1)
  const declaration = source.slice(start, end)
  // eslint-disable-next-line no-new-func
  return new Function(`${declaration}; return ${name}`)()
}

const PATHS = [
  '/abc123/hero.png',
  'abc123/hero.png',
  '//abc123//hero.png',
  '/abc123/nested/deep/file.mp4',
  '/abc-123_x/upload%20space.png',
  '/abc123/../secret.png',
  '/abc123/a/../../secret.png',
  '/abc123/./hero.png',
  '/abc123/',
  '/abc123',
  '/',
  '',
  '/.hidden/hero.png',
  '/abc.123/hero.png',
  '/abc 123/hero.png',
  `/${'a'.repeat(64)}/hero.png`,
  `/${'a'.repeat(65)}/hero.png`,
  '/abc123//hero.png',
  '/abc123/private/report.pdf',
]

describe('cdnObjectKey', () => {
  test('maps a public path into the project namespace', () => {
    expect(cdnObjectKey('/abc123/hero.png')).toBe('p/abc123/public/hero.png')
    expect(cdnObjectKey('abc123/hero.png')).toBe('p/abc123/public/hero.png')
    expect(cdnObjectKey('/abc123/nested/deep/file.mp4')).toBe(
      'p/abc123/public/nested/deep/file.mp4',
    )
  })

  test('keeps percent-encoded segments opaque', () => {
    expect(cdnObjectKey('/abc-123_x/upload%20space.png')).toBe(
      'p/abc-123_x/public/upload%20space.png',
    )
  })

  test('refuses traversal and empty segments instead of normalising them', () => {
    expect(cdnObjectKey('/abc123/../secret.png')).toBeNull()
    expect(cdnObjectKey('/abc123/a/../../secret.png')).toBeNull()
    expect(cdnObjectKey('/abc123/./hero.png')).toBeNull()
    expect(cdnObjectKey('/abc123//hero.png')).toBeNull()
  })

  test('refuses anything that is not exactly a project id plus a key', () => {
    expect(cdnObjectKey('/')).toBeNull()
    expect(cdnObjectKey('')).toBeNull()
    expect(cdnObjectKey('/abc123')).toBeNull()
    expect(cdnObjectKey('/abc123/')).toBeNull()
    // A dotted id is how a path walks out of one project's namespace.
    expect(cdnObjectKey('/abc.123/hero.png')).toBeNull()
    expect(cdnObjectKey('/.hidden/hero.png')).toBeNull()
    expect(cdnObjectKey('/abc 123/hero.png')).toBeNull()
  })

  test('bounds the project id length', () => {
    expect(cdnObjectKey(`/${'a'.repeat(64)}/hero.png`)).toBe(
      `p/${'a'.repeat(64)}/public/hero.png`,
    )
    expect(cdnObjectKey(`/${'a'.repeat(65)}/hero.png`)).toBeNull()
  })

  test('a key that merely looks like a visibility folder stays under public/', () => {
    expect(cdnObjectKey('/abc123/private/report.pdf')).toBe(
      'p/abc123/public/private/report.pdf',
    )
  })
})

describe('cdnCacheControl', () => {
  test('content-addressed names are immutable, everything else is short-lived', () => {
    expect(cdnCacheControl('p/p1/public/0123456789abcdef-hero.png')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(cdnCacheControl(`p/p1/public/${'a'.repeat(64)}.png`)).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(cdnCacheControl('p/p1/public/hero.png')).toBe('public, max-age=300')
    // A short hex prefix is not content addressing, and neither is a hash in a
    // directory name — those would let an overwrite serve a stale object.
    expect(cdnCacheControl('p/p1/public/abc123.png')).toBe('public, max-age=300')
    expect(cdnCacheControl('p/p1/public/0123456789abcdef/hero.png')).toBe(
      'public, max-age=300',
    )
  })
})

describe('the edge Worker agrees with this implementation', () => {
  const workerKey = workerFunction('cdnObjectKey')
  const workerCache = workerFunction('cdnCacheControl')

  test('every path maps to the same storage key (or to the same refusal)', () => {
    for (const path of PATHS) {
      expect({ path, key: workerKey(path) }).toEqual({ path, key: cdnObjectKey(path) })
    }
  })

  test('the cache policy is byte-identical', () => {
    const keys = PATHS.map((path) => cdnObjectKey(path)).filter((key): key is string => !!key)
    for (const key of keys) {
      expect({ key, cache: workerCache(key) }).toEqual({ key, cache: cdnCacheControl(key) })
    }
  })
})
