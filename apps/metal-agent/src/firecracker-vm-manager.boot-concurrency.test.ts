// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Parallel Firecracker boots must not fail a boot that was fine (SHO-545).
 *
 * The boot path used to run every host command synchronously (`execFileSync`
 * for `losetup`/`dmsetup`/`ip`/`iptables`/`mkfs.ext4`, `copyFileSync` for the
 * rootfs) on the agent's single event loop. One VM's boot therefore froze every
 * other VM's socket waiter, and `waitForSocket` — which allowed 3 s of pure
 * wall-clock time — then threw `FC API socket never appeared` and the catch
 * block killed a boot whose socket had been there all along. Staging measured
 * 19 failures in 40 parallel assigns with plenty of RAM free.
 *
 * Two things keep it fixed, and both are pinned here:
 *   1. the socket wait needs real polls as well as wall time, and looks once
 *      more after its deadline; and
 *   2. nothing on the boot/restore/teardown paths spawns a child synchronously,
 *      so no boot can starve another's waiter in the first place.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { config } from './config'
import { FirecrackerVMManager } from './firecracker-vm-manager'
import { run } from './run'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeMgr() {
  const dir = mkdtempSync(join(tmpdir(), 'fc-boot-concurrency-'))
  dirs.push(dir)
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    rootfsCow: 'full' as const,
  }
  const mgr = new FirecrackerVMManager(cfg as any)
  return { mgr, cfg }
}

/** Stand-in for the Firecracker child: still alive, unless `exitCode` says otherwise. */
function fakeProc(exitCode: number | null = null) {
  return { exitCode, killed: false, kill: () => {} }
}

/** Block the event loop for `ms`, exactly as a synchronous `execFileSync` would. */
function blockLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* spin */
  }
}

describe('waitForSocket survives a stalled event loop', () => {
  test('the socket appearing during a >3 s stall still boots', async () => {
    // Regression for SHO-545. On main this throws "FC API socket never
    // appeared": the waiter's 3 s of wall-clock time is spent by the stall, so
    // it gives up the moment it wakes even though the socket is right there.
    const { mgr, cfg } = makeMgr()
    const socketPath = join(cfg.runDir, 'fcvm-1.sock')
    const serialLog = join(cfg.runDir, 'fcvm-1.serial')
    ;(mgr as any).procs.set('fcvm-1', fakeProc())

    const waiting = (mgr as any).waitForSocket('fcvm-1', socketPath, serialLog, 3000)
    // Another boot's synchronous work, long past this waiter's whole budget.
    blockLoop(3500)
    writeFileSync(socketPath, '') // the socket was created the whole time

    await expect(waiting).resolves.toBeUndefined()
  })

  test('a Firecracker child that exited fails fast, with its exit code and serial tail', async () => {
    // A real FC failure must not be waited out (or reported) as a socket
    // timeout: the process is gone, no socket is ever coming.
    const { mgr, cfg } = makeMgr()
    const socketPath = join(cfg.runDir, 'fcvm-2.sock')
    const serialLog = join(cfg.runDir, 'fcvm-2.serial')
    writeFileSync(serialLog, 'booting...\nGuest panic: root device not found\n')
    ;(mgr as any).procs.set('fcvm-2', fakeProc(1))

    const started = Date.now()
    const err = await (mgr as any)
      .waitForSocket('fcvm-2', socketPath, serialLog, 10_000)
      .then(() => null, (e: Error) => e)
    const elapsed = Date.now() - started

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('code 1')
    expect(err.message).toContain('Guest panic: root device not found')
    expect(elapsed).toBeLessThan(1000) // not the 10 s budget
  })

  test('a socket that really never appears still fails, after the tick-and-time budget', async () => {
    const { mgr, cfg } = makeMgr()
    const socketPath = join(cfg.runDir, 'fcvm-3.sock')
    const serialLog = join(cfg.runDir, 'fcvm-3.serial')
    ;(mgr as any).procs.set('fcvm-3', fakeProc())

    const started = Date.now()
    const err = await (mgr as any)
      .waitForSocket('fcvm-3', socketPath, serialLog, 250)
      .then(() => null, (e: Error) => e)
    const elapsed = Date.now() - started

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('never appeared')
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(3000)
  })
})

describe('parallel boots keep the event loop free', () => {
  test('several boots of ~1 s of host work each all succeed, and the loop never stalls', async () => {
    // The other half of the fix: the host work a boot does is a child process
    // the loop waits on, not one it blocks in. `run` is the helper every
    // dmsetup/losetup/ip/iptables/mkfs call goes through, so driving it with a
    // real ~1 s child is the same shape as four boots preparing their disks.
    const { mgr, cfg } = makeMgr()
    const boots = 4

    let worstGapMs = 0
    let last = Date.now()
    const probe = setInterval(() => {
      const now = Date.now()
      worstGapMs = Math.max(worstGapMs, now - last)
      last = now
    }, 10)

    try {
      const results = await Promise.all(
        Array.from({ length: boots }, async (_, i) => {
          const id = `fcvm-par-${i}`
          const socketPath = join(cfg.runDir, `${id}.sock`)
          ;(mgr as any).procs.set(id, fakeProc())
          const waiting = (mgr as any).waitForSocket(id, socketPath, join(cfg.runDir, `${id}.serial`), 3000)
          await run('sleep', ['1']) // the fake dmsetup / mkfs.ext4
          writeFileSync(socketPath, '')
          await waiting
          return i
        }),
      )
      expect(results).toEqual([0, 1, 2, 3])
    } finally {
      clearInterval(probe)
    }

    // Three seconds of wall-clock budget across four boots that each spend one
    // second on host work: under the old synchronous path the third boot's
    // waiter would have expired without ever polling.
    expect(worstGapMs).toBeLessThan(200)
  }, 20_000)
})

describe('no synchronous host work on the boot paths (guard)', () => {
  const SOURCES = ['rootfs.ts', 'net.ts', 'data-drive.ts', 'firecracker-vm-manager.ts']
  const FORBIDDEN = ['execFileSync', 'execSync', 'spawnSync', 'copyFileSync']

  for (const file of SOURCES) {
    test(`${file} has no synchronous child process or copy`, () => {
      const src = readFileSync(resolve(import.meta.dir, file), 'utf8')
      const found = FORBIDDEN.filter((token) => src.includes(token))
      expect(found).toEqual([])
    })
  }
})
