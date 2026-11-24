// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance for SHO-563 — a rebuilt golden rootfs passed its boot probe and
 * then every cold boot died (staging `d9b63a52`, blocking v2.6.4).
 *
 * The root cause was in metal-agent, not in the image: the startup host-scan
 * reaper SIGKILLed the warm VMs a concurrent fill had just spawned (AC1). The
 * probe could not have caught it and could not have prevented it, but it was also
 * not booting the way live boots (AC2), did not hold a VM up long enough to see
 * it die (AC3), threw the failed image away instead of keeping it (AC4), and sent
 * an operator to `ssh` for evidence the agent already had (AC5, AC6).
 *
 * AC1  reapHostOrphans is age-gated and gets every id the pool owns (see
 *      firecracker-vm-manager.boot-race.test.ts and pool-adopt's keep-set test).
 * AC2  dm mode: the probe snapshots the staged file like live does, not a copy
 *      (rootfs-dm-probe.test.ts).
 * AC3  A probe VM that answers /health and then dies inside the hold window fails
 *      the probe; one that stays up passes.
 * AC4  A rollback keeps the failed image at `<base>.failed` with `ROOTFS_FAILED`
 *      (version, revision, reason, serial copies), one per class, replaced by the
 *      next rollback, deleted when a watch passes, and dropped before `.prev`
 *      under disk pressure.
 * AC5  `POST /admin/probe-rootfs` boots a named kept image and returns
 *      `{ok, error, healthyAfterMs, fcExit, serialTail}`, and never touches the
 *      live image, the pool or the watch ledger.
 * AC6  `exited before healthy` carries the FC exit code/signal and a serial tail.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcVmConfig, FcVmHandle } from './firecracker-vm-manager'
import { MetalWarmPool } from './pool'
import type { SnapshotStore } from './snapshot-store'
import { readBadList, readFailed, readPrevious, readWatch, writeWatch } from './rootfs-rollback'
import {
  coldBoots,
  dropSpareGenerations,
  failedRootfsPath,
  getRootfsFailed,
  keptRootfsImage,
  maybeRollbackRootfs,
  prevRootfsPath,
  reportColdBoot,
  rollbackRootfs,
  stagedRootfsPath,
} from './self-update'

// ─── test-local helpers ───────────────────────────────────────────────────────

let dir: string
let savedPath: string
const saved = {
  agentDir: config.agentDir,
  baseRootfs: config.baseRootfs,
  dockerBaseRootfs: config.dockerClass.baseRootfs,
  probeHoldMs: config.rootfsProbeHoldMs,
}

function fakeDebugfs(): void {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'debugfs'),
    `#!/usr/bin/env bash
if [[ "$*" == *"cat /etc/shogo-runtime-revision"* ]]; then
  echo "abc1234"
  exit 0
fi
echo "Inode: 42   Type: regular    Mode:  0755   Flags: 0x0"
`,
  )
  chmodSync(join(bin, 'debugfs'), 0o755)
  process.env.PATH = `${bin}:${savedPath}`
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-sho563-'))
  savedPath = process.env.PATH ?? ''
  ;(config as any).agentDir = dir
  ;(config as any).baseRootfs = join(dir, 'runtime.ext4')
  ;(config as any).dockerClass = { ...config.dockerClass, baseRootfs: undefined }
  coldBoots.reset()
  fakeDebugfs()
})

afterEach(() => {
  process.env.PATH = savedPath
  ;(config as any).agentDir = saved.agentDir
  ;(config as any).baseRootfs = saved.baseRootfs
  ;(config as any).dockerClass = { ...config.dockerClass, baseRootfs: saved.dockerBaseRootfs }
  ;(config as any).rootfsProbeHoldMs = saved.probeHoldMs
  rmSync(dir, { recursive: true, force: true })
})

function writeWatchMarker(version: string, prevVersion: string | null, now = Date.now()): void {
  writeWatch(dir, { version, prevVersion, activatedAt: now, until: now + 900_000 })
}

/**
 * A guest HTTP server that can be told to die — the image that answers /health
 * and then falls over, which is the failure a probe used to score as healthy.
 */
function makeGuest() {
  let up = true
  const server = Bun.serve({
    port: 0,
    fetch: () => (up ? new Response(JSON.stringify({ status: 'ok' })) : new Response('down', { status: 503 })),
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    kill: () => {
      up = false
      server.stop(true)
    },
    stop: () => server.stop(true),
  }
}

function handleFor(id: string, url: string, serialLog: string): FcVmHandle {
  return {
    id,
    agentUrl: url,
    guestIp: '127.0.0.1',
    pid: 1234,
    platform: 'linux',
    net: { tap: 'fctap1', guestIp: '127.0.0.1' } as any,
    rootfs: join(dir, `${id}.rootfs`),
    socketPath: join(dir, `${id}.sock`),
    serialLog,
    vcpus: 2,
    memoryMB: 1024,
    vmClass: 'standard',
  }
}

/** A pool whose manager boots `guest` and whose serial log says what the guest said. */
function makeProbePool(guest: (id: string) => { url: string; alive: () => boolean; serial: string }) {
  let n = 0
  const stopped: string[] = []
  const started: FcVmConfig[] = []
  const fakeMgr = {
    async startVM(cfg: FcVmConfig = {}): Promise<FcVmHandle> {
      n++
      started.push(cfg)
      const g = guest(`vm-${n}`)
      writeFileSync(g.serial, '[entrypoint] Launching bun server...\n[agent-runtime] Started server: http://localhost:8080\n')
      return handleFor(`vm-${n}`, g.url, g.serial)
    },
    async stopVM(handle: FcVmHandle): Promise<void> {
      stopped.push(handle.id)
    },
    isRunning: (handle: FcVmHandle) => guest(handle.id).alive(),
    procExit: () => ({ code: 0, signal: null, ageMs: 900 }),
    exitSummary: () => 'code 0 0.9s after spawn',
    procCount: () => 0,
    reapHostOrphans: () => 0,
    adoptVM: () => {},
  }
  const cfg = {
    ...config,
    work: dir,
    runDir: join(dir, 'run'),
    snapDir: join(dir, 'snap'),
    dmCowDir: join(dir, 'cow'),
    baseRootfs: join(dir, 'rootfs.ext4'),
    poolSize: 0,
    snapStore: 'none',
    rootfsProbeHoldMs: 300,
  } as MetalConfig
  mkdirSync(cfg.runDir, { recursive: true })
  const pool = new MetalWarmPool(fakeMgr as any, cfg as any, { durable: null } as unknown as SnapshotStore)
  return { pool, stopped, started }
}

// ─── AC3: the probe holds the VM up ───────────────────────────────────────────

describe('AC3 — a probe only passes if the VM is still serving at the end of the hold', () => {
  test('a VM that answers /health and then dies inside the hold window fails the probe', async () => {
    const guests = new Map<string, { url: string; alive: () => boolean; serial: string }>()
    let made = 0
    const { pool } = makeProbePool((id) => {
      const g = makeGuest()
      const entry = { url: g.url, alive: () => true, serial: join(dir, `${id}.serial`) }
      guests.set(id, entry)
      made++
      // The first probe VM dies 60 ms after it is up: healthy once, then gone.
      if (made === 1) setTimeout(() => {
        entry.alive = () => false
        g.kill()
      }, 60)
      return entry
    })

    const res = await pool.probeBoot('standard', join(dir, 'runtime.ext4.staged'), { holdMs: 400 })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('hold window')
    expect(res.healthyAfterMs).not.toBeNull() // it WAS healthy — that is the whole trap
    expect(res.serialTail).toContain('Launching bun server')
  })

  test('a VM that stays up for the whole hold passes, and is stopped afterwards', async () => {
    const { pool, stopped } = makeProbePool((id) => {
      const g = makeGuest()
      return { url: g.url, alive: () => true, serial: join(dir, `${id}.serial`) }
    })

    const res = await pool.probeBoot('standard', join(dir, 'runtime.ext4.staged'), { holdMs: 150 })

    expect(res.ok).toBe(true)
    expect(res.error).toBeNull()
    expect(stopped.length).toBeGreaterThan(0)
  })

  test('the hold is long by default: MTAL-agnostic, config.rootfsProbeHoldMs is 30s', () => {
    expect(saved.probeHoldMs).toBeGreaterThanOrEqual(30_000)
  })
})

// ─── AC4: a rollback keeps the failed generation ──────────────────────────────

function seedFailingGeneration(): void {
  ;(config as any).baseRootfs = join(dir, 'runtime.ext4')
  writeFileSync(config.baseRootfs, 'generation that every boot fails on')
  writeFileSync(prevRootfsPath(config.baseRootfs), 'generation that worked')
  writeFileSync(join(dir, 'ROOTFS_SHA'), 'd9b63a5')
  writeFileSync(
    join(dir, 'ROOTFS_PREV'),
    JSON.stringify({ version: '191a3fc', revision: 'abc1234', identities: { standard: 'sz1-mt1' }, activatedAt: 1 }),
  )
  writeWatchMarker('d9b63a5', '191a3fc', 1)
  // The first failed cold boots, with the serial logs they left behind.
  for (let i = 1; i <= 4; i++) {
    const serial = join(dir, `fcvm-${i}-mwugbkru.serial`)
    writeFileSync(serial, `[entrypoint] Launching bun server...\nboot ${i}\n`)
    reportColdBoot(false, `VM fcvm-${i}-mwugbkru exited before healthy (signal SIGKILL)`, serial)
  }
}

describe('AC4 — a rollback keeps the generation that failed', () => {
  test('the bad image survives at <base>.failed with ROOTFS_FAILED and its serials', async () => {
    seedFailingGeneration()

    const res = await rollbackRootfs('auto', { now: Date.now(), restart: () => {} })
    expect(res.ok).toBe(true)

    // `.prev` is back as the live image…
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('generation that worked')
    expect(existsSync(prevRootfsPath(config.baseRootfs))).toBe(false)
    // …and the bad bytes are still on disk, not destroyed by the rename.
    const failed = failedRootfsPath(config.baseRootfs)
    expect(existsSync(failed)).toBe(true)
    expect(readFileSync(failed, 'utf8')).toBe('generation that every boot fails on')

    const marker = getRootfsFailed()
    expect(marker).not.toBeNull()
    expect(marker!.version).toBe('d9b63a5')
    expect(marker!.reason).toContain('cold boots failed')
    expect(marker!.serials).toHaveLength(3) // the first three failed boots
    for (const s of marker!.serials) {
      expect(existsSync(s)).toBe(true)
      expect(readFileSync(s, 'utf8')).toContain('Launching bun server')
    }

    // The version is also on the bad list, so no heartbeat rebuilds it.
    expect(readBadList(dir)[0].version).toBe('d9b63a5')
  })

  test('a second rollback replaces the failed generation instead of accumulating one', async () => {
    seedFailingGeneration()
    await rollbackRootfs('auto', { now: Date.now(), restart: () => {} })
    const first = readFileSync(failedRootfsPath(config.baseRootfs), 'utf8')

    // A second activation, and a second rollback.
    writeFileSync(join(dir, 'ROOTFS_SHA'), 'aaa1111')
    writeFileSync(prevRootfsPath(config.baseRootfs), first)
    writeFileSync(config.baseRootfs, 'second bad generation')
    writeFileSync(
      join(dir, 'ROOTFS_PREV'),
      JSON.stringify({ version: 'd9b63a5', revision: 'abc1234', identities: { standard: 'sz1-mt1' }, activatedAt: 1 }),
    )
    writeWatchMarker('aaa1111', 'd9b63a5', Date.now())
    await rollbackRootfs('auto', { now: Date.now(), restart: () => {} })

    expect(readFileSync(config.baseRootfs, 'utf8')).toBe(first)
    expect(readFileSync(failedRootfsPath(config.baseRootfs), 'utf8')).toBe('second bad generation')
    expect(getRootfsFailed()!.version).toBe('aaa1111')
  })

  test('a watch that passes deletes the failed generation', async () => {
    seedFailingGeneration()
    await rollbackRootfs('auto', { now: Date.now(), restart: () => {} })
    expect(existsSync(failedRootfsPath(config.baseRootfs))).toBe(true)

    // A later activation whose watch expires cleanly.
    const now = Date.now()
    writeWatchMarker('newrelease', '191a3fc', now)
    coldBoots.reset()
    reportColdBoot(true)
    const rolledBack = await maybeRollbackRootfs(now + 20 * 60_000)

    expect(rolledBack).toBe(false)
    expect(readWatch(dir)).toBeNull()
    expect(existsSync(failedRootfsPath(config.baseRootfs))).toBe(false)
    expect(getRootfsFailed()).toBeNull()
  })

  test('disk pressure drops .failed first, and .prev not at all while a watch is open', () => {
    seedFailingGeneration()
    writeFileSync(failedRootfsPath(config.baseRootfs), 'bad generation')

    dropSpareGenerations(92)

    expect(existsSync(failedRootfsPath(config.baseRootfs))).toBe(false) // evidence goes first
    expect(existsSync(prevRootfsPath(config.baseRootfs))).toBe(true) // the rollback target stays
    expect(getRootfsFailed()).toBeNull()

    // With no watch open the previous generation goes too.
    rmSync(join(dir, 'ROOTFS_WATCH'), { force: true })
    dropSpareGenerations(92)
    expect(existsSync(prevRootfsPath(config.baseRootfs))).toBe(false)
    expect(readPrevious(dir)).toBeNull()
  })
})

// ─── AC5: probe a kept image on demand ────────────────────────────────────────

describe('AC5 — POST /admin/probe-rootfs boots a kept image', () => {
  test('probes the kept failed image and returns the documented shape', async () => {
    seedFailingGeneration()
    await rollbackRootfs('auto', { now: Date.now(), restart: () => {} })
    expect(keptRootfsImage('failed', 'standard')).toBe(failedRootfsPath(config.baseRootfs))

    const { pool, started } = makeProbePool((id) => {
      const g = makeGuest()
      return { url: g.url, alive: () => true, serial: join(dir, `${id}.serial`) }
    })
    // A watch is open on the live image: the probe must not close it.
    writeWatchMarker('9999999', '191a3fc')
    const ledgerBefore = coldBoots.size()
    const res = await pool.probeKeptRootfs('failed', 'standard', 100)

    expect(res.ok).toBe(true)
    expect(res.image).toBe(failedRootfsPath(config.baseRootfs))
    expect(typeof res.healthyAfterMs).toBe('number')
    expect(res.fcExit).toBeNull()
    expect(typeof res.serialTail).toBe('string')
    // The probe booted the KEPT image, not the live base.
    expect(started[0].rootfsBase).toBe(failedRootfsPath(config.baseRootfs))
    // …and it does not touch the live image or the watch ledger.
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('generation that worked')
    expect(readWatch(dir)).not.toBeNull()
    expect(coldBoots.size()).toBe(ledgerBefore) // the probe added no cold boot
  })

  test('refuses an image the host does not hold, without booting anything', async () => {
    writeFileSync(config.baseRootfs, 'live')
    expect(keptRootfsImage('failed', 'standard')).toBeNull()
    expect(keptRootfsImage('prev', 'standard')).toBeNull()
    expect(keptRootfsImage('live', 'standard')).toBe(config.baseRootfs)

    const { pool, started } = makeProbePool((id) => {
      const g = makeGuest()
      return { url: g.url, alive: () => true, serial: join(dir, `${id}.serial`) }
    })
    const res = await pool.probeKeptRootfs('prev', 'standard', 50)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no prev image')
    expect(started).toHaveLength(0)
  })
})

// ─── AC6: say why a VM died ───────────────────────────────────────────────────

describe('AC6 — a boot error names the firecracker exit and the guest serial tail', () => {
  test('exited before healthy carries the signal/code and the last serial line', async () => {
    const serial = join(dir, 'fcvm-5-mwugbkru.serial')
    writeFileSync(serial, 'EXT4-fs (vdb): mounted\n[entrypoint] Launching bun server...\n')
    const handle = handleFor('fcvm-5-mwugbkru', 'http://127.0.0.1:1', serial)

    const fakeMgr = {
      isRunning: () => false,
      procExit: () => ({ code: null, signal: 'SIGKILL', ageMs: 2100 }),
      exitSummary: () => 'signal SIGKILL 2.1s after spawn',
    }
    const cfg = {
      ...config,
      work: dir,
      runDir: join(dir, 'run'),
      snapDir: join(dir, 'snap'),
      dmCowDir: join(dir, 'cow'),
      snapStore: 'none',
      poolSize: 0,
    } as MetalConfig
    mkdirSync(cfg.runDir, { recursive: true })
    const pool = new MetalWarmPool(fakeMgr as any, cfg as any, { durable: null } as unknown as SnapshotStore)

    let thrown: any
    try {
      await pool.waitForHealth(handle, () => false)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeDefined()
    expect(thrown.message).toContain('exited before healthy')
    expect(thrown.message).toContain('signal SIGKILL')
    expect(thrown.message).toContain('last: [entrypoint] Launching bun server...')
    expect(thrown.serialTail).toContain('EXT4-fs (vdb): mounted')
  })

  test('the ledger keeps the serial of a failed cold boot for the rollback to copy', () => {
    reportColdBoot(false, 'VM a exited before healthy', '/run/a.serial')
    reportColdBoot(false, 'VM b exited before healthy', '/run/b.serial')
    reportColdBoot(true)
    reportColdBoot(false, 'VM c exited before healthy', '/run/c.serial')

    expect(coldBoots.failedSerials(3)).toEqual(['/run/a.serial', '/run/b.serial', '/run/c.serial'])
    expect(coldBoots.failedSerials(1)).toEqual(['/run/a.serial'])
    expect(coldBoots.counts().topError).toBe('VM a exited before healthy')
  })
})

// ─── the staged path is still what the probe is pointed at ────────────────────

test('the staged file for a class is where the probe looks', () => {
  const base = config.baseRootfs
  writeFileSync(stagedRootfsPath(base), 'staged')
  expect(keptRootfsImage('staged', 'standard')).toBe(stagedRootfsPath(base))
})
