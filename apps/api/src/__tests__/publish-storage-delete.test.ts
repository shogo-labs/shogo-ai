// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-207: published-site teardown must actually remove the bytes.
//
// Deleting a project left its site serving because `DeleteObjects` was rejected
// by OCI ("Missing required header for this request: Content-MD5 or
// x-amz-checksum-sha256 or x-amz-checksum-crc32c") — `@aws-sdk/client-s3`
// ≥3.975 stopped sending that header. Every teardown logged
// `static-bundle failed …` and the site stayed live, in prod too.
//
// These tests pin the fix at the request level: one `DeleteObjectCommand` per
// key (no batch delete at all), and a delete that did not take effect is
// reported rather than swallowed. The teardown's own suite already pins that a
// throwing step becomes `{ok:false}` (services/__tests__/published-site-teardown
// .test.ts: "a failing step does not stop the rest, and is reported not thrown"),
// so storage throwing is what makes the step honest.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const DATA_BUCKET = 'test-published-data'
process.env.PUBLISH_BUCKET = 'test-published-apps'
process.env.PUBLISH_DATA_BUCKET = DATA_BUCKET

/** Every command the SUT sends, in order. */
const sent: Array<{ name: string; input: any }> = []
/** Pages handed back by successive ListObjectsV2 calls (shifted, one per call). */
let listPages: any[] = []
/** Behaviour of a single-object DELETE; tests override it to fail. */
let deleteImpl: (input: any) => Promise<any> = async () => ({})

class ListObjectsV2Command {
  input: any
  constructor(input: any) {
    this.input = input
  }
}

class DeleteObjectCommand {
  input: any
  constructor(input: any) {
    this.input = input
  }
}

class FakeS3Client {
  constructor(_cfg: any) {}
  send(cmd: any): Promise<any> {
    const name = cmd?.constructor?.name ?? 'unknown'
    sent.push({ name, input: cmd?.input })
    if (name === 'ListObjectsV2Command') {
      return Promise.resolve(listPages.shift() ?? { Contents: [], IsTruncated: false })
    }
    if (name === 'DeleteObjectCommand') return deleteImpl(cmd.input)
    return Promise.resolve({})
  }
}

// `DeleteObjectsCommand` is deliberately NOT exported: if the SUT ever reaches
// for the batch path again it throws here instead of shipping the OCI bug back.
mock.module('@aws-sdk/client-s3', () => ({
  S3Client: FakeS3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
}))

const { deletePublishedStaticBundle, deletePublishedDataArchive } = await import(
  '../lib/publish-storage'
)
const { teardownPublishedSite } = await import('../services/published-site-teardown')

/** One list page with the given keys, then an empty page for the verify re-list. */
const listed = (...keys: string[]) => [
  { Contents: keys.map((Key) => ({ Key })), IsTruncated: false },
  { Contents: [], IsTruncated: false },
]

const names = () => sent.map((s) => s.name)
const deletes = () => sent.filter((s) => s.name === 'DeleteObjectCommand')

beforeEach(() => {
  sent.length = 0
  listPages = []
  deleteImpl = async () => ({})
})

describe('deletePublishedStaticBundle', () => {
  test('deletes each key with its own DeleteObjectCommand, never a batch delete', async () => {
    listPages = listed('site/index.html', 'site/app.js')

    await deletePublishedStaticBundle('site')

    expect(names()).toEqual([
      'ListObjectsV2Command',
      'DeleteObjectCommand',
      'DeleteObjectCommand',
      'ListObjectsV2Command',
    ])
    // The regression guard: a batch delete is what OCI rejects.
    expect(names()).not.toContain('DeleteObjectsCommand')
    expect(deletes().map((d) => d.input)).toEqual([
      { Bucket: 'test-published-apps', Key: 'site/index.html' },
      { Bucket: 'test-published-apps', Key: 'site/app.js' },
    ])
  })

  test('an empty prefix is a no-op — no delete is attempted', async () => {
    listPages = [{ Contents: [], IsTruncated: false }]

    await deletePublishedStaticBundle('nothing-here')

    expect(names()).toEqual(['ListObjectsV2Command'])
  })

  test('paginates the listing, so a bundle over 1000 keys is fully removed', async () => {
    listPages = [
      { Contents: [{ Key: 'site/a.js' }], IsTruncated: true, NextContinuationToken: 'page-2' },
      { Contents: [{ Key: 'site/b.js' }], IsTruncated: false },
      { Contents: [], IsTruncated: false },
    ]

    await deletePublishedStaticBundle('site')

    const lists = sent.filter((s) => s.name === 'ListObjectsV2Command')
    expect(lists[1].input).toEqual({
      Bucket: 'test-published-apps',
      Prefix: 'site/',
      ContinuationToken: 'page-2',
    })
    expect(deletes().map((d) => d.input.Key)).toEqual(['site/a.js', 'site/b.js'])
  })

  test('a delete S3 rejects is reported, not swallowed', async () => {
    listPages = listed('site/index.html', 'site/app.js')
    deleteImpl = async (input) => {
      if (input.Key === 'site/app.js') throw new Error('AccessDenied')
      return {}
    }

    const err = await deletePublishedStaticBundle('site').catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('Could not remove the static bundle for site')
    expect(err.message).toContain('site/app.js')
    expect(err.message).toContain('AccessDenied')
  })

  test('objects that survive the delete are reported, not swallowed', async () => {
    // Both deletes "succeed", but the site is still there on the re-list — the
    // shape of the original bug: a green step and a live site.
    listPages = [
      { Contents: [{ Key: 'site/index.html' }], IsTruncated: false },
      { Contents: [{ Key: 'site/index.html' }], IsTruncated: false },
    ]

    const err = await deletePublishedStaticBundle('site').catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('1 object(s) still present')
    expect(err.message).toContain('site/index.html')
  })
})

describe('deletePublishedDataArchive', () => {
  test('purges the archive the same per-key way, from the data bucket', async () => {
    listPages = listed('site/data.tar.gz', 'site/data-2026-10-25.tar.gz')

    await deletePublishedDataArchive('site')

    expect(names()).not.toContain('DeleteObjectsCommand')
    expect(deletes().map((d) => d.input)).toEqual([
      { Bucket: DATA_BUCKET, Key: 'site/data.tar.gz' },
      { Bucket: DATA_BUCKET, Key: 'site/data-2026-10-25.tar.gz' },
    ])
  })

  test('a failed archive purge is reported too', async () => {
    listPages = listed('site/data.tar.gz')
    deleteImpl = async () => {
      throw new Error('Missing required header for this request: Content-MD5')
    }

    const err = await deletePublishedDataArchive('site').catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('Could not remove the published-data archive for site')
    expect(err.message).toContain('Content-MD5')
  })
})

/**
 * The wiring QA asked for: the REAL delete functions under the REAL teardown,
 * not the `deps` seam. `qa-sho138-teardown-wiring.acceptance.test.ts` mocks
 * `../lib/publish-storage` wholesale, so nothing there proves that a delete
 * which did not take effect reaches the caller as `ok:false` — which is the
 * half of SHO-207 that left sites live behind a green log line.
 */
describe('teardownPublishedSite + the real delete path', () => {
  // Everything except the two delete steps, which stay real.
  const stubbedDeps = {
    unpublishRuntime: async () => {},
    clearSitePassword: async () => {},
    clearServerBackedFlag: async () => {},
    clearCustomDomains: async () => {},
    deletePublishPointer: async () => {},
  }

  test('a delete that did not take effect is ok:false, not ok:true', async () => {
    listPages = [
      { Contents: [{ Key: 'site/index.html' }], IsTruncated: false },
      { Contents: [{ Key: 'site/index.html' }], IsTruncated: false },
    ]

    const outcomes = await teardownPublishedSite('proj-1', 'site', {
      dropPublishPointer: false,
      deps: stubbedDeps,
    })

    const staticBundle = outcomes.find((o) => o.step === 'static-bundle')
    expect(staticBundle).toMatchObject({ step: 'static-bundle', ok: false })
    expect(staticBundle?.error).toContain('still present')
  })

  test('a rejected delete is ok:false for the bundle and for the archive', async () => {
    // Each step lists twice (find keys, then verify), so queue pages per step.
    listPages = [
      { Contents: [{ Key: 'site/index.html' }], IsTruncated: false },
      { Contents: [{ Key: 'site/index.html' }], IsTruncated: false },
      { Contents: [{ Key: 'site/data.tar.gz' }], IsTruncated: false },
      { Contents: [{ Key: 'site/data.tar.gz' }], IsTruncated: false },
    ]
    deleteImpl = async () => {
      throw new Error('AccessDenied')
    }

    const outcomes = await teardownPublishedSite('proj-1', 'site', {
      purgePublishedData: true,
      dropPublishPointer: false,
      deps: stubbedDeps,
    })

    expect(outcomes.find((o) => o.step === 'static-bundle')).toMatchObject({ ok: false })
    expect(outcomes.find((o) => o.step === 'published-data')).toMatchObject({ ok: false })
  })

  test('a clean delete is ok:true', async () => {
    listPages = listed('site/index.html')

    const outcomes = await teardownPublishedSite('proj-1', 'site', {
      dropPublishPointer: false,
      deps: stubbedDeps,
    })

    expect(outcomes.find((o) => o.step === 'static-bundle')).toEqual({
      step: 'static-bundle',
      ok: true,
    })
  })
})
