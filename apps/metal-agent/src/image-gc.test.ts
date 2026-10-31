// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Runtime-image GC (SHO-271).
 *
 * The bug: `build-runtime-rootfs.sh` pulls a fresh `shogo-runtime` image per
 * release and never removes the old one, so `/var/lib/docker` grew ~5.7 GB per
 * release on the ROOT disk. dal-2 reached 83 images on a 440 GB disk, filled it
 * to 100%, and failed 14,007 updates in 24h ("no space left on device") while
 * still serving a ten-day-old guest image.
 */

import { describe, expect, test } from 'bun:test'
import { imageRef, parseImageList, planImageGc, runImageGc, type DockerImageRow } from './image-gc'

const REPO = 'us-ashburn-1.ocir.io/idin4oltblww/shogo/shogo-runtime'

function img(tag: string, repository = REPO): DockerImageRow {
  return { Repository: repository, Tag: tag, ID: `sha256:${tag}`, Size: '5.7GB' }
}

const current = `${REPO}:production-multiarch-50be857`
const dockerVariant = `${REPO}:production-docker-multiarch-50be857`

const fiveOld = [
  img('staging-multiarch-aaa'),
  img('staging-multiarch-bbb'),
  img('production-multiarch-ccc'),
  img('production-multiarch-ddd'),
  img('production-multiarch-eee'),
]

describe('planImageGc', () => {
  test('removes the five old tags and keeps the desired release plus its docker variant', () => {
    const rows = [...fiveOld, img('production-multiarch-50be857'), img('production-docker-multiarch-50be857')]
    const remove = planImageGc(rows, [current, dockerVariant])
    expect(remove).toHaveLength(5)
    expect(remove).not.toContain(current)
    expect(remove).not.toContain(dockerVariant)
    expect(remove).toContain(`${REPO}:staging-multiarch-aaa`)
  })

  test('keeps an image a rebuild is using right now', () => {
    const inFlight = `${REPO}:production-multiarch-inflight`
    const remove = planImageGc([...fiveOld, img('production-multiarch-inflight')], [current, inFlight])
    expect(remove).toHaveLength(5)
    expect(remove).not.toContain(inFlight)
  })

  test('never touches another repository', () => {
    const rows = [
      ...fiveOld,
      img('latest', 'registry.example.com/platform/other-sidecar'),
      img('v1', 'redis'),
      img('latest', 'postgres'),
    ]
    const remove = planImageGc(rows, [current])
    expect(remove.every((r) => r.includes('shogo-runtime'))).toBe(true)
    expect(remove.some((r) => r.startsWith('redis:'))).toBe(false)
    expect(remove.some((r) => r.startsWith('postgres:'))).toBe(false)
  })

  test('ignores <none> tags — those are dangling layers, left to `image prune`', () => {
    const rows = [...fiveOld, { Repository: '<none>', Tag: '<none>' }, { Repository: REPO, Tag: '<none>' }]
    const remove = planImageGc(rows, [current])
    expect(remove).toHaveLength(5)
    expect(remove.some((r) => r.includes('<none>'))).toBe(false)
  })

  test('a caller that only knows the tag still protects that image', () => {
    const rows = [img('production-multiarch-50be857'), img('production-multiarch-aaa')]
    expect(planImageGc(rows, ['production-multiarch-50be857'])).toEqual([`${REPO}:production-multiarch-aaa`])
  })

  test('returns nothing when the keep list covers every image', () => {
    expect(planImageGc([img('production-multiarch-50be857')], [current, dockerVariant])).toEqual([])
  })
})

describe('imageRef', () => {
  test('rejects untagged and foreign rows', () => {
    expect(imageRef({ Repository: REPO, Tag: '<none>' })).toBeNull()
    expect(imageRef({ Repository: '<none>', Tag: '<none>' })).toBeNull()
    expect(imageRef({ Repository: 'redis', Tag: 'latest' })).toBeNull()
    expect(imageRef({ Repository: REPO, Tag: 'v1' })).toBe(`${REPO}:v1`)
  })
})

describe('parseImageList', () => {
  test('reads one JSON object per line and skips anything garbled', () => {
    const rows = parseImageList(
      [
        JSON.stringify(img('a')),
        '',
        'not json',
        '{"Repository":"' + REPO + '","Tag":"b"}',
      ].join('\n'),
    )
    expect(rows.map((r) => r.Tag)).toEqual(['a', 'b'])
  })
})

describe('runImageGc', () => {
  const disk = (usedPct: number) => ({ totalBytes: 440e9, freeBytes: 440e9 * (1 - usedPct / 100), usedBytes: 0, usedPct })

  test('removes the planned tags and reports root-disk usage before and after', async () => {
    const calls: string[][] = []
    let first = true
    const res = await runImageGc(
      { reason: 'test', keep: [current] },
      {
        exec: async (cmd, args) => {
          calls.push([cmd, ...args])
          if (args[0] === 'images') return [...fiveOld, img('production-multiarch-50be857')].map((r) => JSON.stringify(r)).join('\n')
          return ''
        },
        disk: () => {
          const u = disk(first ? 99 : 95)
          first = false
          return u
        },
      },
    )
    expect(res.removed).toHaveLength(5)
    expect(res.failed).toHaveLength(0)
    expect(res.rootDiskBefore.usedPct).toBe(99)
    expect(res.rootDiskAfter.usedPct).toBe(95)
    expect(res.freedBytes).toBeGreaterThan(0)
    expect(calls.filter((c) => c[1] === 'rmi')).toHaveLength(5)
    // dangling layers, then the build script's leftover containers only
    expect(calls.some((c) => c[1] === 'image' && c[2] === 'prune')).toBe(true)
    expect(calls.some((c) => c[1] === 'container' && c.includes('label=shogo-rootfs-build=1'))).toBe(true)
  })

  test('a docker error is recorded, not thrown — the host keeps serving', async () => {
    const res = await runImageGc(
      { reason: 'test', keep: [] },
      {
        exec: async (_cmd, args) => {
          if (args[0] === 'images') return JSON.stringify(img('old'))
          throw new Error('Cannot connect to the Docker daemon')
        },
        disk: () => disk(50),
      },
    )
    expect(res.removed).toEqual([])
    expect(res.failed.map((f) => f.tag)).toEqual([`${REPO}:old`])
  })

  test('an unreadable image list does not throw', async () => {
    const res = await runImageGc(
      { reason: 'test', keep: [] },
      {
        exec: async () => {
          throw new Error('docker: not found')
        },
        disk: () => disk(70),
      },
    )
    expect(res.removed).toEqual([])
  })
})
