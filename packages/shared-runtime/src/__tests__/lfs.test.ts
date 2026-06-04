// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the pure / fs-level helpers in `lfs.ts`. The git-spawning
 * transfer helpers (push/pull/track) need a real git+git-lfs and are covered
 * by integration, not here.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  isValidLfsOid,
  lfsObjectKey,
  lfsKeyPrefix,
  buildLfsEndpointUrl,
  isLfsEnabled,
  buildManagedAttributesBlock,
  writeManagedGitAttributes,
} from '../lfs'

const OID = 'a'.repeat(64)

describe('isValidLfsOid', () => {
  it('accepts a 64-char lowercase hex digest', () => {
    expect(isValidLfsOid(OID)).toBe(true)
  })
  it('rejects wrong length, uppercase, and non-hex', () => {
    expect(isValidLfsOid('abc')).toBe(false)
    expect(isValidLfsOid('A'.repeat(64))).toBe(false)
    expect(isValidLfsOid('g'.repeat(64))).toBe(false)
    expect(isValidLfsOid('../../etc/passwd')).toBe(false)
  })
})

describe('lfsObjectKey', () => {
  it('shards by the first two byte-pairs of the oid', () => {
    expect(lfsObjectKey('p1', OID, 'lfs/objects')).toBe(`p1/lfs/objects/aa/aa/${OID}`)
  })
  it('throws on an invalid oid (no key-namespace escape)', () => {
    expect(() => lfsObjectKey('p1', 'not-an-oid')).toThrow()
  })
})

describe('lfsKeyPrefix', () => {
  it('defaults to lfs/objects and honors S3_LFS_PREFIX', () => {
    expect(lfsKeyPrefix({} as any)).toBe('lfs/objects')
    expect(lfsKeyPrefix({ S3_LFS_PREFIX: '/custom/lfs/' } as any)).toBe('custom/lfs')
  })
})

describe('buildLfsEndpointUrl', () => {
  it('builds the LFS base the client appends /objects/batch to', () => {
    expect(buildLfsEndpointUrl('https://api.shogo.ai/', 'p1')).toBe(
      'https://api.shogo.ai/api/projects/p1/git/info/lfs',
    )
  })
})

describe('isLfsEnabled', () => {
  it('is true only for "true"/"1"', () => {
    expect(isLfsEnabled({ LFS_ENABLED: 'true' } as any)).toBe(true)
    expect(isLfsEnabled({ LFS_ENABLED: '1' } as any)).toBe(true)
    expect(isLfsEnabled({ LFS_ENABLED: 'false' } as any)).toBe(false)
    expect(isLfsEnabled({} as any)).toBe(false)
  })
})

describe('buildManagedAttributesBlock', () => {
  it('wraps curated patterns in managed markers', () => {
    const block = buildManagedAttributesBlock()
    expect(block).toContain('# >>> shogo git-lfs (managed) >>>')
    expect(block).toContain('# <<< shogo git-lfs (managed) <<<')
    expect(block).toContain('*.png filter=lfs diff=lfs merge=lfs -text')
    expect(block).toContain('*.safetensors filter=lfs diff=lfs merge=lfs -text')
  })
})

describe('writeManagedGitAttributes', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('creates .gitattributes with the managed block', () => {
    dir = mkdtempSync(join(tmpdir(), 'lfs-attr-'))
    writeManagedGitAttributes(dir)
    const content = readFileSync(join(dir, '.gitattributes'), 'utf-8')
    expect(content).toContain('*.mp4 filter=lfs diff=lfs merge=lfs -text')
  })

  it('preserves user content and is idempotent', () => {
    dir = mkdtempSync(join(tmpdir(), 'lfs-attr-'))
    const attrPath = join(dir, '.gitattributes')
    writeFileSync(attrPath, '*.custom text\n')
    writeManagedGitAttributes(dir)
    writeManagedGitAttributes(dir) // second call must not duplicate the block
    const content = readFileSync(attrPath, 'utf-8')
    expect(content).toContain('*.custom text')
    const markerCount = content.split('# >>> shogo git-lfs (managed) >>>').length - 1
    expect(markerCount).toBe(1)
  })
})
