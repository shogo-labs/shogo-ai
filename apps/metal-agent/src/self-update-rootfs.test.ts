// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The pinned, verified rootfs rebuild. The release gate trusts the revision a
 * host reports, so a rebuild must only replace the live image when the new
 * one provably holds the requested commit. On 2026-09-23 a rebuild pulled the
 * moving `-latest` tag before the new image was published, baked the old
 * guest code, and every host still stamped the new release.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildRootfsImage, getRootfsRevision, readImageRevision, type BuildRootfsDeps } from './self-update'

const SHA = '50be85788b10561c7052f2eaef7a7f88f0633a3a'
const OTHER = '5f2728d0000000000000000000000000000000aa'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rootfs-rebuild-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Stands in for build-runtime-rootfs.sh: writes `$OUT` with the pulled image's
 * revision as its content, or fails like `docker pull` does for a missing tag.
 */
function fakeBuild(published: Record<string, string>): BuildRootfsDeps {
  return {
    run: async (_cmd, _args, _cwd, env) => {
      const image = env?.RUNTIME_IMAGE ?? 'registry/shogo-runtime:production-multiarch-latest'
      const rev = published[image]
      if (rev === undefined) throw new Error('bash exited 1') // manifest unknown
      writeFileSync(env!.OUT, rev)
    },
    readRevision: (image) => readFileSync(image, 'utf8') || null,
  }
}

describe('buildRootfsImage', () => {
  const pinned = `registry/shogo-runtime:production-multiarch-${SHA}`

  test('swaps in the image when the pinned build holds the requested revision', async () => {
    const out = join(dir, 'runtime.ext4')
    writeFileSync(out, 'old')
    await buildRootfsImage(
      { script: 's.sh', out, runtimeImage: pinned, runtimeRevision: SHA },
      fakeBuild({ [pinned]: SHA }),
    )
    expect(readFileSync(out, 'utf8')).toBe(SHA)
    expect(existsSync(`${out}.new`)).toBe(false)
  })

  test('passes the pinned image to the build script instead of the env tag', async () => {
    const seen: Record<string, string>[] = []
    const out = join(dir, 'runtime.ext4')
    await buildRootfsImage(
      { script: 's.sh', out, runtimeImage: pinned, runtimeRevision: SHA },
      {
        run: async (_c, _a, _w, env) => {
          seen.push(env!)
          writeFileSync(env!.OUT, SHA)
        },
        readRevision: (p) => readFileSync(p, 'utf8'),
      },
    )
    expect(seen).toEqual([{ OUT: `${out}.new`, RUNTIME_IMAGE: pinned }])
  })

  test('refuses a build whose stamped revision differs: old image stays, temp file removed', async () => {
    const out = join(dir, 'runtime.ext4')
    writeFileSync(out, 'old')
    await expect(
      buildRootfsImage(
        { script: 's.sh', out, runtimeImage: pinned, runtimeRevision: SHA },
        fakeBuild({ [pinned]: OTHER }),
      ),
    ).rejects.toThrow(/holds revision 5f2728d.*want 50be857/)
    expect(readFileSync(out, 'utf8')).toBe('old')
    expect(existsSync(`${out}.new`)).toBe(false)
  })

  test('accepts a short-sha pin against the full revision stamped in the image', async () => {
    const out = join(dir, 'runtime.ext4')
    const short = `registry/shogo-runtime:production-multiarch-${SHA.slice(0, 7)}`
    await buildRootfsImage(
      { script: 's.sh', out, runtimeImage: short, runtimeRevision: SHA.slice(0, 7) },
      fakeBuild({ [short]: SHA }),
    )
    expect(readFileSync(out, 'utf8')).toBe(SHA)
  })

  test('refuses an image with no revision file when a revision is required', async () => {
    const out = join(dir, 'runtime.ext4')
    writeFileSync(out, 'old')
    await expect(
      buildRootfsImage({ script: 's.sh', out, runtimeImage: pinned, runtimeRevision: SHA }, fakeBuild({ [pinned]: '' })),
    ).rejects.toThrow(/holds revision none/)
    expect(readFileSync(out, 'utf8')).toBe('old')
  })

  test('a pinned tag that is not published yet fails the rebuild and leaves the live image alone', async () => {
    const out = join(dir, 'runtime.ext4')
    writeFileSync(out, 'old')
    await expect(
      buildRootfsImage({ script: 's.sh', out, runtimeImage: pinned, runtimeRevision: SHA }, fakeBuild({})),
    ).rejects.toThrow(/exited 1/)
    expect(readFileSync(out, 'utf8')).toBe('old')
    expect(existsSync(`${out}.new`)).toBe(false)
  })

  test('an unpinned release still builds from the env tag without a revision check', async () => {
    const out = join(dir, 'runtime.ext4')
    const latest = 'registry/shogo-runtime:production-multiarch-latest'
    await buildRootfsImage({ script: 's.sh', out }, fakeBuild({ [latest]: 'anything' }))
    expect(readFileSync(out, 'utf8')).toBe('anything')
  })
})

const mkfs = ['/opt/homebrew/opt/e2fsprogs/sbin', '/usr/local/opt/e2fsprogs/sbin', '/usr/sbin', '/sbin']
  .map((d) => join(d, 'mkfs.ext4'))
  .find((p) => existsSync(p))
const debugfsOnPath = spawnSync('debugfs', ['-V']).status === 0
const haveE2fs = !!mkfs && debugfsOnPath

function makeExt4(path: string, revision: string | null): void {
  const root = join(dir, `root-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, 'etc'), { recursive: true })
  if (revision !== null) writeFileSync(join(root, 'etc', 'shogo-runtime-revision'), `${revision}\n`)
  const r = spawnSync(mkfs!, ['-q', '-F', '-d', root, path, '8M'])
  if (r.status !== 0) throw new Error(`mkfs.ext4 failed: ${r.stderr}`)
}

describe.skipIf(!haveE2fs)('readImageRevision on a real ext4', () => {
  test('reads the stamped commit', () => {
    const img = join(dir, 'a.ext4')
    makeExt4(img, SHA)
    expect(readImageRevision(img)).toBe(SHA)
  })

  test('returns null when the image predates the stamp', () => {
    const img = join(dir, 'b.ext4')
    makeExt4(img, null)
    expect(readImageRevision(img)).toBeNull()
  })

  test("returns null for the Dockerfile's 'unknown' default", () => {
    const img = join(dir, 'c.ext4')
    makeExt4(img, 'unknown')
    expect(readImageRevision(img)).toBeNull()
  })

  test('getRootfsRevision picks up an image renamed into place by a rebuild', () => {
    const img = join(dir, 'd.ext4')
    makeExt4(img, SHA)
    expect(getRootfsRevision(img)).toBe(SHA)
    const tmp = join(dir, 'd.ext4.new')
    makeExt4(tmp, OTHER)
    spawnSync('mv', ['-f', tmp, img])
    const t = new Date(statSync(img).mtimeMs + 5_000)
    utimesSync(img, t, t)
    expect(getRootfsRevision(img)).toBe(OTHER)
  })

  test('getRootfsRevision is null for a missing image', () => {
    expect(getRootfsRevision(join(dir, 'nope.ext4'))).toBeNull()
  })
})
