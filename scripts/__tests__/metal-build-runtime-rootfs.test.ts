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
  // e2fsprogs is a hard dependency of the script and absent from a dev mac; the
  // contract tests only need the names to exist here.
  for (const t of ['mkfs.ext4', 'debugfs']) {
    writeFileSync(join(bin, t), '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(join(bin, t), 0o755)
  }
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

  test('a failed export leaves no per-run build directory behind', () => {
    const { work } = run('export')
    // The tar lives in $WORKDIR/build.XXXXXX now, so a failed run must take the
    // whole directory with it rather than just the tar.
    expect(readdirSync(work).filter((f) => f.startsWith('build.'))).toEqual([])
  })
})

/**
 * The gate that decides whether an image may go live reads the ext4 file with
 * debugfs. A mountpoint cannot stand in for it — on staging (SHO-549) an image
 * with no fc-init passed the mountpoint check, shipped, and every cold boot on
 * the host panicked in the kernel with
 * `Requested init /usr/local/bin/fc-init failed (error -2)`.
 */
const FC_INIT = String.raw`#!/bin/bash
ulimit -n 1048576 2>/dev/null || ulimit -n 65536 2>/dev/null || true
printf '127.0.0.1\tlocalhost\n' >> /etc/hosts
echo 'nameserver 10.0.0.1' > /etc/resolv.conf
WS_DEV=$(blkid -L shogo-ws)
resize2fs "$WS_DEV" >/dev/null 2>&1 || true
exec /entrypoint.sh
`

describe('build-runtime-rootfs.sh shipped-image gate', () => {
  /** A fake `debugfs` that answers for `missing` paths as "not there". */
  function runGate(missing: string[]) {
    const bin = join(dir, 'bin')
    const img = join(dir, 'runtime.ext4')
    const fixture = join(dir, 'fc-init.fixture')
    const log = join(dir, 'debugfs.log')
    mkdirSync(bin, { recursive: true })
    writeFileSync(img, 'stand-in for the ext4 bytes')
    writeFileSync(fixture, FC_INIT)
    writeFileSync(
      join(bin, 'debugfs'),
      `#!/usr/bin/env bash
cmd=""; img=""
while [ $# -gt 0 ]; do
  case "$1" in
    -R) cmd="$2"; shift 2 ;;
    *) img="$1"; shift ;;
  esac
done
echo "$img|$cmd" >> "${log}"
case "$cmd" in
  "cat /usr/local/bin/fc-init") cat "${fixture}"; exit 0 ;;
  "cat /etc/gitconfig") printf '[safe]\\n\\tdirectory = *\\n'; exit 0 ;;
  stat*)
    for m in ${missing.join(' ')}; do
      [ "stat $m" = "$cmd" ] && { echo "debugfs: File not found by ext2_lookup" >&2; exit 1; }
    done
    echo "Inode: 4242   Type: regular    Mode:  0755   Flags: 0x0"
    exit 0 ;;
esac
exit 1
`,
    )
    chmodSync(join(bin, 'debugfs'), 0o755)
    const res = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VERIFY_ROOTFS_IMAGE_ONLY: img },
    })
    return { res, log, img }
  }

  test('passes an image that carries its guest init', () => {
    const { res, log, img } = runGate([])
    expect(res.stdout).not.toContain('CONTRACT:')
    expect(res.status).toBe(0)
    // Answered from the file it was given, with nothing mounted.
    expect(readFileSync(log, 'utf8')).toContain(`${img}|stat /usr/local/bin/fc-init`)
  })

  test('refuses an image with no /usr/local/bin/fc-init', () => {
    const { res } = runGate(['/usr/local/bin/fc-init'])
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('/usr/local/bin/fc-init missing or not executable in the staged image')
    expect(res.stdout).toContain('panics at boot')
  })

  test('refuses an image without the entrypoint or the workspace tools', () => {
    const { res } = runGate(['/entrypoint.sh', '/sbin/resize2fs', '/usr/sbin/resize2fs'])
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('/entrypoint.sh missing or not executable in the staged image')
    expect(res.stdout).toContain('resize2fs missing in the staged image')
  })
})
