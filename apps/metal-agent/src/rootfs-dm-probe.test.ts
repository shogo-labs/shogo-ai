// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * In dm mode the boot probe must boot the staged image the way LIVE will boot it
 * once the rename lands: a dm snapshot over a read-only loop of that file
 * (SHO-563).
 *
 * It used to copy the file and boot the copy. That is a different provisioners
 * path — a plain block device with no origin loop and no CoW store — so a probe
 * could pass while every live VM on the same bytes failed, which is exactly what
 * happened on staging: the probe passed, the image was activated, and all 8 cold
 * boots after the restart died.
 *
 * The assertions are on the host commands, so a change to the boot path shows up
 * here instead of on a host at 08:47 on a Sunday.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import { RootfsProvisioner, type RootfsExec } from './rootfs'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A config whose golden image is a real file of a known size. */
function makeCfg(sizeBytes = 8 * 1024 * 1024): { cfg: MetalConfig; dir: string; staged: string; docker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rootfsdm-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'run'), { recursive: true })
  const baseRootfs = join(dir, 'runtime.ext4')
  const dockerBase = join(dir, 'docker-runtime.ext4')
  const staged = `${baseRootfs}.staged`
  writeFileSync(baseRootfs, '')
  truncateSync(baseRootfs, sizeBytes)
  writeFileSync(staged, '')
  truncateSync(staged, sizeBytes + 8192) // the staged build is a different size on purpose
  writeFileSync(dockerBase, '')
  truncateSync(dockerBase, sizeBytes)
  const cfg = {
    ...config,
    work: dir,
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    baseRootfs,
    dockerClass: { ...config.dockerClass, baseRootfs: dockerBase },
    rootfsCow: 'dm' as const,
    dmCowSize: '2G',
  } as MetalConfig
  return { cfg, dir, staged, docker: dockerBase }
}

/** Records every host command and answers the way the kernel would. */
function fakeExec(): { calls: Array<{ cmd: string; args: string[] }>; exec: RootfsExec } {
  const calls: Array<{ cmd: string; args: string[] }> = []
  let loop = 100
  const exec: RootfsExec = async (cmd, args) => {
    calls.push({ cmd, args })
    if (cmd === 'losetup' && args[0] === '--find') return `/dev/loop${++loop}`
    if (cmd === 'losetup' && args[0] === '-j') return ''
    if (cmd === 'losetup' && args[0] === '-a') return ''
    if (cmd === 'dmsetup' && args[0] === 'info') throw new Error('no such device')
    if (cmd === 'dmsetup' && args[0] === 'status') return ''
    if (cmd === 'dmsetup' && args[0] === 'ls') return ''
    return ''
  }
  return { calls, exec }
}

const sectors = (path: string) => Math.floor(statSync(path).size / 512)

/** The device the fake exec returned for the `--find` call at `index` (each one is new). */
function awaitLeakedLoop(calls: Array<{ cmd: string; args: string[] }>, index: number): string {
  const before = calls.slice(0, index + 1).filter((c) => c.cmd === 'losetup' && c.args[0] === '--find').length
  return `/dev/loop${100 + before}`
}

describe('dm mode: a probe of the staged image uses the live boot path', () => {
  test('the staged file is looped read-only and snapshotted, not copied', async () => {
    const { cfg, staged } = makeCfg()
    const { calls, exec } = fakeExec()
    const rootfs = new RootfsProvisioner(cfg, exec)

    const path = await rootfs.provision('fcvm-3-probe', staged, { dmBase: true })

    expect(path).toBe('/dev/mapper/mvm-fcvm-3-probe')
    // Its own read-only loop of the STAGED file, never the live base.
    const stagedLoopIdx = calls.findIndex((c) => c.cmd === 'losetup' && c.args[0] === '--find' && c.args.includes(staged))
    expect(stagedLoopIdx).toBeGreaterThanOrEqual(0)
    const stagedLoop = calls[stagedLoopIdx]
    const stagedLoopDev = (awaitLeakedLoop(calls, stagedLoopIdx))
    expect(stagedLoop!.args).toContain('--read-only')
    expect(calls.some((c) => c.cmd === 'losetup' && c.args.includes(cfg.baseRootfs))).toBe(false)

    // A persistent snapshot whose origin is that loop and whose length is the
    // staged file's — the device live will mount as /dev/vda.
    const dm = calls.find((c) => c.cmd === 'dmsetup' && c.args[0] === 'create')
    expect(dm).toBeDefined()
    const table = dm!.args[dm!.args.indexOf('--table') + 1]
    const [, len, target, origin, cowLoop] = table.split(' ')
    expect(target).toBe('snapshot')
    expect(Number(len)).toBe(sectors(staged))
    expect(origin).toBe(stagedLoopDev!) // the loop handed out for the staged file
    expect(cowLoop).toMatch(/^\/dev\/loop/)

    // And the determinism that matters: nothing copied 8 MiB to prove it boots.
    expect(calls.some((c) => c.cmd === 'cp' || c.cmd === 'dd')).toBe(false)
  })

  test('releasing the probe detaches its base loop, so repeated probes cannot leak /dev/loop*', async () => {
    const { cfg, staged } = makeCfg()
    const { calls, exec } = fakeExec()
    const rootfs = new RootfsProvisioner(cfg, exec)
    const path = await rootfs.provision('fcvm-4-probe', staged, { dmBase: true })

    await rootfs.release(path)

    const baseLoop = calls.find((c) => c.cmd === 'losetup' && c.args[0] === '--find' && c.args.includes(staged))
    expect(baseLoop).toBeDefined()
    const baseLoopDev = awaitLeakedLoop(calls, calls.indexOf(baseLoop!))
    const detached = calls.filter((c) => c.cmd === 'losetup' && c.args[0] === '-d').map((c) => c.args[1])
    expect(detached).toContain(baseLoopDev)
  })

  test('a docker-class base is still copied: that class boots a copy live, so the probe copies too', async () => {
    const { cfg, docker } = makeCfg()
    const { calls, exec } = fakeExec()
    const rootfs = new RootfsProvisioner(cfg, exec)

    const path = await rootfs.provision('fcvm-5-dockerprobe', docker)

    expect(path).toBe(join(cfg.runDir, 'fcvm-5-dockerprobe.rootfs.ext4'))
    expect(statSync(path).size).toBe(statSync(docker).size)
    expect(calls.some((c) => c.cmd === 'dmsetup' && c.args[0] === 'create')).toBe(false)
  })

  test('a live-image boot is unchanged: the shared base loop, no per-VM loop', async () => {
    const { cfg } = makeCfg()
    const { calls, exec } = fakeExec()
    const rootfs = new RootfsProvisioner(cfg, exec)

    const path = await rootfs.provision('fcvm-6-live')

    expect(path).toBe('/dev/mapper/mvm-fcvm-6-live')
    const loops = calls.filter((c) => c.cmd === 'losetup' && c.args[0] === '--find')
    expect(loops).toHaveLength(2) // base + CoW, as before
    expect(loops[0].args).toContain(cfg.baseRootfs)
  })
})
