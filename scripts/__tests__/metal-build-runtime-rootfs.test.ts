// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `build-runtime-rootfs.sh` must not leave a multi-GB `rootfs.tar` behind when
 * it fails (SHO-271).
 *
 * The tar was only removed on the success path at the very end of the script.
 * A failed `docker export` (disk full, image gone) or a failed extract exited
 * with `set -e` while the tar sat in `$WORKDIR` — several GB per attempt on a
 * disk that was failing precisely because it was full. This runs the real
 * script against a fake `docker` and asserts the EXIT trap cleans up.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const SCRIPT = resolve(import.meta.dir, '..', '..', 'scripts', 'metal-agent', 'build-runtime-rootfs.sh')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rootfs-script-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A `docker` that pulls and creates fine, then fails the export. */
function fakeDocker(bin: string, failOn: 'export' | 'none'): void {
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "$@" >> "${join(bin, 'docker.log')}"
case "$1" in
  info) exit 0 ;;
  pull) exit 0 ;;
  create) echo fake-container-id ;;
  export)
    # A partial tar, exactly what a disk-full export leaves behind.
    printf 'partial' > "$3"
    ${failOn === 'export' ? 'exit 1' : 'exit 0'} ;;
  rm|rmi) exit 0 ;;
  images) exit 0 ;;
  image) exit 0 ;;
  container) exit 0 ;;
  *) exit 0 ;;
esac
`,
  )
  chmodSync(join(bin, 'docker'), 0o755)
  writeFileSync(join(bin, 'systemctl'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(join(bin, 'systemctl'), 0o755)
}

function run(failOn: 'export' | 'none') {
  const bin = join(dir, 'bin')
  const work = join(dir, 'work')
  mkdirSync(bin, { recursive: true })
  mkdirSync(work, { recursive: true })
  fakeDocker(bin, failOn)
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      WORKDIR: work,
      OUT: join(dir, 'img', 'rootfs.ext4'),
      RUNTIME_IMAGE: 'registry.test/shogo/shogo-runtime:staging-test',
      DOCKER_CONFIG: dir,
    },
  })
  return { res, work }
}

describe('build-runtime-rootfs.sh', () => {
  test('a failed export leaves no rootfs.tar in $WORKDIR', () => {
    const { res, work } = run('export')
    expect(res.status).not.toBe(0)
    const left = readdirSync(work)
    expect(left).not.toContain('rootfs.tar')
    // The partial tar the export wrote, and the staging image, are gone too.
    expect(left.filter((f) => f.startsWith('rootfs.ext4.new'))).toEqual([])
  })

  test('the export container carries the label image-gc prunes by', () => {
    const { res } = run('export')
    expect(res.status).not.toBe(0)
    const log = readFileSync(join(dir, 'bin', 'docker.log'), 'utf8')
    expect(log).toContain('create --label shogo-rootfs-build=1')
  })
})
