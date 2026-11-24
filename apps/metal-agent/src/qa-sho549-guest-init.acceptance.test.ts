// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance for SHO-549 — the gates that keep a rootfs without its guest init
 * from ever going live.
 *
 * The dev's tests stub `guestInitProblem` itself, so nothing exercised the probe
 * production actually runs, nor the agent-side gates without a hook. Both are
 * driven here against a real PATH `debugfs`, so the debugfs output parsing, the
 * default-deps wiring in `buildRootfsImage`, and `maybeActivateRootfs` with no
 * `guestInitProblem` hook are all shipping code.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import {
  buildRootfsImage,
  getRootfsSha,
  guestInitProblem,
  maybeActivateRootfs,
  stagedRootfsPath,
} from './self-update'

const SHA = 'a'.repeat(40)
const PINNED = `registry/shogo-runtime:production-multiarch-${SHA.slice(0, 7)}`

let dir: string
let savedPath: string
const saved = {
  agentDir: config.agentDir,
  baseRootfs: config.baseRootfs,
  dockerBaseRootfs: config.dockerClass.baseRootfs,
}

/**
 * A `debugfs` that answers from the image it is given: an executable regular
 * file (`mode`) unless `<image>.noinit` sits beside it, which is "this filesystem
 * has no /usr/local/bin/fc-init" — the staging image of 2026-11-23.
 */
function fakeDebugfs(mode = '0755'): void {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'debugfs'),
    `#!/usr/bin/env bash
img=""
while [ $# -gt 0 ]; do
  case "$1" in
    -R) shift 2 ;;
    *) img="$1"; shift ;;
  esac
done
if [ -e "$img.noinit" ]; then
  echo "debugfs: File not found by ext2_lookup" >&2
  exit 1
fi
echo "Inode: 4242   Type: regular    Mode:  ${mode}   Flags: 0x0"
`,
  )
  chmodSync(join(bin, 'debugfs'), 0o755)
  process.env.PATH = `${bin}:${savedPath}`
}

function noInit(image: string): string {
  writeFileSync(`${image}.noinit`, '')
  return image
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-sho549-'))
  savedPath = process.env.PATH ?? ''
  ;(config as any).agentDir = dir
  ;(config as any).baseRootfs = join(dir, 'runtime.ext4')
  fakeDebugfs()
})

afterEach(() => {
  process.env.PATH = savedPath
  ;(config as any).agentDir = saved.agentDir
  ;(config as any).baseRootfs = saved.baseRootfs
  ;(config as any).dockerClass = { ...config.dockerClass, baseRootfs: saved.dockerBaseRootfs }
  rmSync(dir, { recursive: true, force: true })
})

describe('guestInitProblem reads the image, not a mountpoint', () => {
  test('an executable guest init is fine', () => {
    expect(guestInitProblem('/opt/fc-spike/img/runtime.ext4')).toBeNull()
  })

  test('a guest init without an execute bit is a problem', () => {
    fakeDebugfs('0644')
    expect(guestInitProblem('/img.ext4')).toContain('is not executable')
  })

  test('a missing guest init is a problem, whatever debugfs exits with', () => {
    const image = noInit(join(dir, 'img.ext4'))
    const problem = guestInitProblem(image)
    expect(problem).toContain(`/usr/local/bin/fc-init is not in ${image}`)
    expect(problem).toContain('panics at boot')
  })

  test('no debugfs at all fails closed rather than booting blind', () => {
    const empty = join(dir, 'empty-bin')
    mkdirSync(empty, { recursive: true })
    process.env.PATH = empty
    expect(guestInitProblem('/img.ext4')).toContain('debugfs failed')
  })
})

describe('buildRootfsImage with no deps hook (the production wiring)', () => {
  const out = () => join(dir, 'runtime.ext4')

  function build(withInit = false): Promise<void> {
    return buildRootfsImage(
      { script: 's.sh', out: out(), runtimeImage: PINNED, runtimeRevision: SHA },
      {
        run: async () => {
          // The build script wrote a file, but not one with a guest init in it.
          writeFileSync(`${out()}.new`, 'the image that shipped')
          if (!withInit) noInit(`${out()}.new`)
        },
        readRevision: () => SHA,
      },
    )
  }

  test('refuses a build whose shipped file has no guest init, and keeps `out`', async () => {
    writeFileSync(out(), 'previous image')
    await expect(build()).rejects.toThrow(/rootfs built without its guest init/)
    expect(readFileSync(out(), 'utf8')).toBe('previous image')
    expect(existsSync(`${out()}.new`)).toBe(false)
  })

  test('the same build goes live when the probe finds the init', async () => {
    // Positive control: only the debugfs answer differs from the test above.
    writeFileSync(out(), 'previous image')
    await build(true)
    expect(readFileSync(out(), 'utf8')).toBe('the image that shipped')
  })
})

describe('maybeActivateRootfs with no hook (the production wiring)', () => {
  const marker = () => join(config.agentDir, 'ROOTFS_STAGED')

  function stage(): void {
    writeFileSync(config.baseRootfs, 'live image')
    writeFileSync(stagedRootfsPath(config.baseRootfs), 'staged image')
    writeFileSync(
      marker(),
      JSON.stringify({ version: 'v2', identities: { standard: 'sz1-mt1' }, stagedAt: 1_000_000 }),
    )
  }

  test('a staged image with no guest init is never renamed over the live one', async () => {
    stage()
    noInit(stagedRootfsPath(config.baseRootfs))
    expect(await maybeActivateRootfs('v2')).toBe(false)
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('live image')
    // The evidence is kept; the marker is not, so the next heartbeat rebuilds.
    expect(existsSync(stagedRootfsPath(config.baseRootfs))).toBe(true)
    expect(existsSync(marker())).toBe(false)
    // And no ROOTFS_SHA: the host has not claimed a release it cannot boot.
    expect(getRootfsSha()).toBeNull()
  })

  test('an unusable docker-class staged image blocks the switch too', async () => {
    // Both images are renamed in one switch, so a docker-class image without its
    // init must stop the standard rename as well.
    stage()
    const dockerBase = join(dir, 'docker-runtime.ext4')
    writeFileSync(dockerBase, 'live docker image')
    writeFileSync(stagedRootfsPath(dockerBase), 'staged docker image')
    ;(config as any).dockerClass = { ...config.dockerClass, baseRootfs: dockerBase }
    noInit(stagedRootfsPath(dockerBase))
    expect(await maybeActivateRootfs('v2')).toBe(false)
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('live image')
    expect(readFileSync(dockerBase, 'utf8')).toBe('live docker image')
    expect(existsSync(marker())).toBe(false)
  })

  test('a healthy staged pair still switches', async () => {
    stage()
    const dockerBase = join(dir, 'docker-runtime.ext4')
    writeFileSync(dockerBase, 'live docker image')
    writeFileSync(stagedRootfsPath(dockerBase), 'staged docker image')
    ;(config as any).dockerClass = { ...config.dockerClass, baseRootfs: dockerBase }
    expect(await maybeActivateRootfs('v2', { promote: () => 0 })).toBe(true)
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('staged image')
    expect(readFileSync(dockerBase, 'utf8')).toBe('staged docker image')
  })
})
