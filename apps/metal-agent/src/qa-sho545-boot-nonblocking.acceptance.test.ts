// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-545 acceptance (QA): the boot's *other* blocking half.
 *
 * The 19/40 staging failures were produced by two kinds of synchronous work on
 * the metal-agent's single event loop: child processes (`losetup`/`dmsetup`/
 * `ip`/`iptables`/`mkfs.ext4`) and the up-to-8 GiB `copyFileSync` of the rootfs.
 * The branch's own suite pins the child-process half through the `run` helper
 * and a source scan; this pins the copy, behaviourally, through the public
 * `RootfsProvisioner.provision` a boot actually calls.
 *
 * The instrument is `setImmediate`, not a timer: immediates only run while the
 * loop is free, so a synchronous copy lets through exactly zero of them no
 * matter how fast the filesystem is (APFS `copyFile` can clone 64 MiB in under
 * a millisecond, which makes a ms-based threshold meaningless). The same file
 * runs against origin/main and fails there — `provision` is synchronous, so the
 * control case below is what main does on every boot.
 */

import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { RootfsProvisioner } from './rootfs'

const MiB = 1024 * 1024
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeProvisioner(baseMiB: number, mode: 'full' | 'reflink' = 'full') {
  const dir = mkdtempSync(join(tmpdir(), 'qa545-rootfs-'))
  dirs.push(dir)
  const runDir = join(dir, 'run')
  const dmCowDir = join(dir, 'cow')
  mkdirSync(runDir, { recursive: true })
  const baseRootfs = join(dir, 'base.ext4')
  // A real file, not sparse: the copy has to move bytes like a boot's does.
  writeFileSync(baseRootfs, Buffer.alloc(baseMiB * MiB, 7))
  const cfg = { ...config, work: dir, runDir, dmCowDir, rootfsCow: mode, baseRootfs }
  return { prov: new RootfsProvisioner(cfg as any), dir, baseRootfs, runDir }
}

/**
 * How many times the event loop turned while `fn` was in flight. A synchronous
 * call — what every boot used to do — lets through zero: nothing else in the
 * process runs until it returns, which is precisely how one VM's boot starved
 * another's `waitForSocket`.
 */
async function loopTurnsDuring(fn: () => Promise<unknown> | unknown): Promise<number> {
  let turns = 0
  let stop = false
  const spin = () => {
    if (stop) return
    turns++
    setImmediate(spin)
  }
  setImmediate(spin)
  try {
    await fn()
  } finally {
    stop = true
  }
  return turns
}

test('a full-mode rootfs copy yields the event loop (the 8 GiB copyFileSync a boot used to block in)', async () => {
  const { prov, runDir, baseRootfs } = makeProvisioner(64)

  // Control: the same copy, synchronously — the shape origin/main's boot used.
  const syncTurns = await loopTurnsDuring(() => {
    copyFileSync(baseRootfs, join(runDir, 'sync-control.ext4'))
  })
  expect(syncTurns).toBe(0)

  let dst = ''
  const asyncTurns = await loopTurnsDuring(async () => {
    dst = await prov.provision('fcvm-qa-1')
  })

  expect(dst).toBe(join(runDir, 'fcvm-qa-1.rootfs.ext4'))
  expect(statSync(dst).size).toBe(statSync(baseRootfs).size)
  expect(asyncTurns).toBeGreaterThan(10)
})

test('parallel boots each keep yielding while the others copy', async () => {
  const { prov, runDir } = makeProvisioner(32)
  const ids = ['fcvm-qa-2', 'fcvm-qa-3', 'fcvm-qa-4', 'fcvm-qa-5']

  const perBoot = new Map<string, number>()
  await loopTurnsDuring(async () => {
    await Promise.all(
      ids.map(async (id) => {
        perBoot.set(id, await loopTurnsDuring(() => prov.provision(id)))
      }),
    )
  })

  // Every boot made progress on its own, so no boot's copy starved another's
  // waiter — the real failure mode (`FC API socket never appeared`).
  expect([...perBoot.keys()].sort()).toEqual([...ids].sort())
  for (const id of ids) {
    expect(perBoot.get(id)!).toBeGreaterThan(10)
    expect(statSync(join(runDir, `${id}.rootfs.ext4`)).size).toBeGreaterThan(0)
  }
})

test('a docker-class override copies asynchronously too', async () => {
  // dm mode snapshots only the standard golden base; a docker-class image is
  // copied instead, on the boot path, and used to be a synchronous 8 GiB copy.
  const { prov, dir } = makeProvisioner(48)
  const dockerBase = join(dir, 'docker.ext4')
  writeFileSync(dockerBase, Buffer.alloc(48 * MiB, 3))

  const turns = await loopTurnsDuring(() => prov.provision('fcvm-qa-6', dockerBase))
  expect(turns).toBeGreaterThan(10)
})
