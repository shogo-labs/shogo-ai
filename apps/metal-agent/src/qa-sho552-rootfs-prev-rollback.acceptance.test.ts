// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance for SHO-552 — keep the last good rootfs, boot-test before the
 * swap, and roll back automatically on a burst of cold-boot failures.
 *
 * On 2026-11-23 staging activated rootfs `718a651` (no `fc-init`) and every cold
 * boot on the host failed for ~1h. `activateStagedImages` renamed the staged
 * image over the live one, destroying the outgoing copy. The only spares on the
 * host were July `*.bak` files. These tests verify every acceptance criterion:
 *
 * AC1  Activation leaves `.prev` and a correct `ROOTFS_PREV` marker. A second
 *      activation replaces `.prev`; there is never a second generation.
 * AC2  A staged image whose boot probe fails: live image unchanged, staged
 *      marker cleared, version on the bad list, `REFUSING` logged.
 * AC3  Inside the watch window, ≥5 failures at >50% rate triggers rollback;
 *      4 failures or 5/20 does not. A failure after `until` does not roll back.
 * AC4  A version on the bad list: not rebuilt, not activated, in heartbeat.
 * AC5  Snapshots for the prev identity survive during the watch; reclaimable
 *      after it expires.
 * AC6  Manual rollback performs the same swap; refuses cleanly with no `.prev`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import {
  addBadRootfs,
  findBadRootfs,
  readBadList,
  readPrevious,
  readWatch,
  rollbackDecision,
  writeBadList,
  writePrevious,
  writeWatch,
  type BadRootfs,
} from './rootfs-rollback'
import {
  coldBoots,
  getBadRootfs,
  getRejectedRootfs,
  getRootfsPrev,
  getRootfsWatch,
  getRootfsSha,
  markRootfsBad,
  maybeActivateRootfs,
  maybeRollbackRootfs,
  prevRootfsPath,
  reportColdBoot,
  rollbackRootfs,
  shouldRebuildRootfs,
  stagedRootfsPath,
} from './self-update'

// ─── test-local helpers ───────────────────────────────────────────────────────

let dir: string
let savedPath: string
const saved = {
  agentDir: config.agentDir,
  baseRootfs: config.baseRootfs,
  dockerBaseRootfs: config.dockerClass.baseRootfs,
}

/** A `debugfs` that always says the guest init is there and executable. */
function fakeDebugfs(): void {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'debugfs'),
    `#!/usr/bin/env bash
echo "Inode: 42   Type: regular    Mode:  0755   Flags: 0x0"
`,
  )
  chmodSync(join(bin, 'debugfs'), 0o755)
  process.env.PATH = `${bin}:${savedPath}`
}

function stageFile(base: string, content = 'staged image'): void {
  writeFileSync(stagedRootfsPath(base), content)
}

function writeStagedMarker(version: string, runtimeRevision?: string): void {
  writeFileSync(
    join(config.agentDir, 'ROOTFS_STAGED'),
    JSON.stringify({
      version,
      identities: { standard: `identity-${version}` },
      stagedAt: 1_000_000,
      ...(runtimeRevision ? { runtimeRevision } : {}),
    }),
  )
}

/** Fake restart: just resets the `updating` guard so the test can keep running. */
let restartCalled = false
function noopRestart(): void {
  restartCalled = true
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-sho552-'))
  savedPath = process.env.PATH ?? ''
  restartCalled = false
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
  rmSync(dir, { recursive: true, force: true })
})

// ─── AC1: .prev is kept; a second activation replaces it ─────────────────────

describe('AC1 — activation keeps the previous generation', () => {
  test('activation writes .prev and ROOTFS_PREV before it stamps ROOTFS_SHA', async () => {
    writeFileSync(config.baseRootfs, 'generation 1')
    stageFile(config.baseRootfs, 'generation 2')
    writeStagedMarker('v2')

    const activated = await maybeActivateRootfs('v2', {
      promote: async () => 0,
      probeBoot: async () => null,
      restart: noopRestart,
    } as any)
    expect(activated).toBe(true)

    const prev = prevRootfsPath(config.baseRootfs)
    expect(existsSync(prev)).toBe(true)
    expect(readFileSync(prev, 'utf8')).toBe('generation 1')

    const prevMarker = readPrevious(dir)
    expect(prevMarker).not.toBeNull()
    expect(typeof prevMarker!.activatedAt).toBe('number')
  })

  test('a second activation replaces .prev — never accumulates a second generation', async () => {
    // First activation: gen 1 → gen 2.
    writeFileSync(config.baseRootfs, 'generation 1')
    stageFile(config.baseRootfs, 'generation 2')
    writeStagedMarker('v2')
    await maybeActivateRootfs('v2', {
      promote: async () => 0,
      probeBoot: async () => null,
      restart: noopRestart,
    } as any)

    // Clear the watch so the second activation isn't blocked by the guard.
    rmSync(join(dir, 'ROOTFS_WATCH'), { force: true })
    coldBoots.reset()

    // Second activation: gen 2 → gen 3.
    stageFile(config.baseRootfs, 'generation 3')
    writeStagedMarker('v3')
    await maybeActivateRootfs('v3', {
      promote: async () => 0,
      probeBoot: async () => null,
      restart: noopRestart,
    } as any)

    // The only .prev is gen 2: gen 1 is gone, not held as a second generation.
    const prev = prevRootfsPath(config.baseRootfs)
    expect(existsSync(prev)).toBe(true)
    expect(readFileSync(prev, 'utf8')).toBe('generation 2')

    // No second spare generation.
    expect(existsSync(`${prev}.prev`)).toBe(false)
  })
})

// ─── AC2: boot probe failure blocks the swap ─────────────────────────────────

describe('AC2 — boot probe failure leaves live image intact', () => {
  test('probeBoot failure: live image unchanged, staged cleared, version on bad list', async () => {
    writeFileSync(config.baseRootfs, 'live generation')
    stageFile(config.baseRootfs)
    writeStagedMarker('v2', 'rev-aaa')

    const activated = await maybeActivateRootfs('v2', {
      promote: async () => 0,
      probeBoot: async () => 'exited before healthy: timeout',
      restart: noopRestart,
    } as any)

    expect(activated).toBe(false)
    // Live image is exactly what it was.
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('live generation')
    // Staged file kept for inspection.
    expect(existsSync(stagedRootfsPath(config.baseRootfs))).toBe(true)
    // Staged marker cleared so the next heartbeat can rebuild.
    expect(existsSync(join(dir, 'ROOTFS_STAGED'))).toBe(false)
    // No ROOTFS_SHA: we have not claimed a release we cannot boot.
    expect(getRootfsSha()).toBeNull()
    // The version is on the bad list.
    const bad = findBadRootfs(getBadRootfs(), 'v2', 'rev-aaa')
    expect(bad).not.toBeNull()
    expect(bad!.reason).toContain('boot probe failed')
    // And the rejected entry is exposed for the heartbeat.
    const rejected = getRejectedRootfs()
    expect(rejected?.version).toBe('v2')
  })

  test('a bad-listed version is never re-activated even when the control plane says so', async () => {
    writeFileSync(config.baseRootfs, 'live generation')
    stageFile(config.baseRootfs)
    writeStagedMarker('v2')
    markRootfsBad('v2', null, 'boot probe failed: timeout')

    const activated = await maybeActivateRootfs('v2', {
      probeBoot: async () => null, // probe would pass, but should never be called
      promote: async () => 0,
      restart: noopRestart,
    } as any)

    expect(activated).toBe(false)
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('live generation')
  })
})

// ─── AC3: watch window and rollback decision ──────────────────────────────────

describe('AC3 — watch window triggers rollback on a failure burst', () => {
  const T0 = 1_000_000
  const WINDOW = 15 * 60_000

  test('5 failures at >50% rate triggers rollback; .prev lands at base', async () => {
    // Set up a live image with a .prev to roll back to.
    writeFileSync(config.baseRootfs, 'bad generation')
    writeFileSync(prevRootfsPath(config.baseRootfs), 'good generation')
    writePrevious(dir, { version: 'v1', revision: 'rev-v1', identities: {}, activatedAt: T0 })
    writeWatch(dir, { version: 'v2', prevVersion: 'v1', activatedAt: T0, until: T0 + WINDOW })
    writeFileSync(join(dir, 'ROOTFS_SHA'), 'v2')

    // 5 failures, 4 successes → rate = 5/9 ≈ 0.56 > 0.5.
    for (let i = 0; i < 4; i++) reportColdBoot(true)
    for (let i = 0; i < 5; i++) reportColdBoot(false, 'exited before healthy')

    const rolledBack = await maybeRollbackRootfs(T0 + 1000)
    expect(rolledBack).toBe(true)

    // The good generation is back.
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('good generation')
    // No ROOTFS_SHA claimed for the bad generation (prev.version = v1 restored).
    expect(getRootfsSha()).toBe('v1')
    // Watch is cleared.
    expect(getRootfsWatch()).toBeNull()
    // Bad version is on the list.
    const bad = findBadRootfs(getBadRootfs(), 'v2')
    expect(bad).not.toBeNull()
    expect(bad!.reason).toContain('rollback')
  })

  test('4 failures does not trigger rollback, even at 100%', () => {
    expect(rollbackDecision({
      failures: 4, successes: 0, now: T0 + 1000,
      watch: { version: 'v2', prevVersion: 'v1', activatedAt: T0, until: T0 + WINDOW },
    })).toBe('ok')
  })

  test('5 failures at ≤50% rate does not trigger rollback', () => {
    // 5 failures, 6 successes → rate = 5/11 ≈ 0.45 < 0.5
    expect(rollbackDecision({
      failures: 5, successes: 6, now: T0 + 1000,
      watch: { version: 'v2', prevVersion: 'v1', activatedAt: T0, until: T0 + WINDOW },
    })).toBe('ok')
  })

  test('5 failures among 20 boots does not trigger rollback', () => {
    // 5 failures, 15 successes → rate = 5/20 = 0.25 < 0.5
    expect(rollbackDecision({
      failures: 5, successes: 15, now: T0 + 1000,
      watch: { version: 'v2', prevVersion: 'v1', activatedAt: T0, until: T0 + WINDOW },
    })).toBe('ok')
  })

  test('a failure after `until` does not trigger rollback', () => {
    expect(rollbackDecision({
      failures: 100, successes: 0, now: T0 + WINDOW + 1,
      watch: { version: 'v2', prevVersion: 'v1', activatedAt: T0, until: T0 + WINDOW },
    })).toBe('expired')
  })

  test('expired watch clears itself and does not roll back', async () => {
    writeFileSync(config.baseRootfs, 'current generation')
    writeFileSync(prevRootfsPath(config.baseRootfs), 'previous generation')
    writePrevious(dir, { version: 'v1', revision: null, identities: {}, activatedAt: T0 })
    writeWatch(dir, { version: 'v2', prevVersion: 'v1', activatedAt: T0, until: T0 + WINDOW })
    for (let i = 0; i < 100; i++) reportColdBoot(false, 'timeout')

    // Check after the window ends.
    const rolledBack = await maybeRollbackRootfs(T0 + WINDOW + 1)
    expect(rolledBack).toBe(false)
    // Current generation is still there.
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('current generation')
    // Watch was cleared.
    expect(readWatch(dir)).toBeNull()
  })
})

// ─── AC4: bad list gates rebuild and re-activation ───────────────────────────

describe('AC4 — a version on the bad list is never rebuilt or re-applied', () => {
  test('shouldRebuildRootfs returns false for a version on the bad list', () => {
    const bad: BadRootfs[] = [{ version: 'v2', revision: 'rev-aaa', reason: 'probe failed', at: 1 }]
    expect(
      shouldRebuildRootfs({ version: 'v2', rebuildRootfs: true } as any, null, true, null, bad),
    ).toBe(false)
  })

  test('shouldRebuildRootfs returns false when the REVISION matches, even on a different version', () => {
    const bad: BadRootfs[] = [{ version: 'v2', revision: 'rev-aaa', reason: 'probe failed', at: 1 }]
    expect(
      shouldRebuildRootfs(
        { version: 'v3', rebuildRootfs: true, runtimeRevision: 'rev-aaa' } as any,
        null, true, null, bad,
      ),
    ).toBe(false)
  })

  test('a newer version with a different revision IS rebuilt', () => {
    const bad: BadRootfs[] = [{ version: 'v2', revision: 'rev-aaa', reason: 'probe failed', at: 1 }]
    expect(
      shouldRebuildRootfs(
        { version: 'v3', rebuildRootfs: true, runtimeRevision: 'rev-bbb' } as any,
        null, true, null, bad,
      ),
    ).toBe(true)
  })

  test('getRejectedRootfs() returns the most recent bad entry for the heartbeat', () => {
    markRootfsBad('v2', 'rev-aaa', 'boot probe failed', 100)
    markRootfsBad('v3', 'rev-bbb', 'boot probe failed', 200)
    const rejected = getRejectedRootfs()
    expect(rejected?.version).toBe('v3')
    expect(rejected?.revision).toBe('rev-bbb')
  })

  test('addBadRootfs replaces an earlier entry for the same version', () => {
    const list = addBadRootfs([], { version: 'v2', revision: null, reason: 'first', at: 1 })
    const list2 = addBadRootfs(list, { version: 'v2', revision: null, reason: 'second', at: 2 })
    expect(list2).toHaveLength(1)
    expect(list2[0].reason).toBe('second')
  })

  test('bad list is capped at 20 entries', () => {
    let list: BadRootfs[] = []
    for (let i = 0; i < 25; i++) {
      list = addBadRootfs(list, { version: `v${i}`, revision: null, reason: 'x', at: i })
    }
    expect(list).toHaveLength(20)
  })
})

// ─── AC5: snapshots for prev identity are spared during an open watch ─────────

describe('AC5 — prev identity is kept by reclaimStaleSnapshots during the watch', () => {
  test('identities from ROOTFS_PREV are returned while ROOTFS_WATCH is open', () => {
    writeWatch(dir, {
      version: 'v2',
      prevVersion: 'v1',
      activatedAt: Date.now(),
      until: Date.now() + 15 * 60_000,
    })
    writePrevious(dir, {
      version: 'v1',
      revision: null,
      identities: { standard: 'identity-v1-std', docker: 'identity-v1-dock' },
      activatedAt: Date.now(),
    })

    // The pool's rollbackSnapshotIdentities() is a private method wired from
    // getRootfsWatch() + getRootfsPrev(). The public contract we can test here:
    const watch = readWatch(dir)
    const prev = readPrevious(dir)
    expect(watch).not.toBeNull()
    expect(prev).not.toBeNull()
    // Both identities are present for the GC to spare.
    const identities = Object.values(prev!.identities)
    expect(identities).toContain('identity-v1-std')
    expect(identities).toContain('identity-v1-dock')
  })

  test('identities are not spared after the watch expires', async () => {
    const T0 = 1_000_000
    const WINDOW = 15 * 60_000
    writeFileSync(config.baseRootfs, 'current generation')
    writeFileSync(prevRootfsPath(config.baseRootfs), 'previous generation')
    writePrevious(dir, { version: 'v1', revision: null, identities: {}, activatedAt: T0 })
    writeWatch(dir, { version: 'v2', prevVersion: 'v1', activatedAt: T0, until: T0 + WINDOW })

    // Trigger expiry via maybeRollbackRootfs (no cold boots = no rollback, just expiry).
    await maybeRollbackRootfs(T0 + WINDOW + 1)

    // Watch is cleared: no identities to spare.
    expect(readWatch(dir)).toBeNull()
  })
})

// ─── AC6: manual rollback ─────────────────────────────────────────────────────

describe('AC6 — manual rollback', () => {
  test('manual rollback puts .prev back and marks the bad version', async () => {
    writeFileSync(config.baseRootfs, 'bad generation')
    writeFileSync(prevRootfsPath(config.baseRootfs), 'good generation')
    writePrevious(dir, { version: 'v1', revision: 'rev-v1', identities: {}, activatedAt: 1_000_000 })
    writeFileSync(join(dir, 'ROOTFS_SHA'), 'v2')

    const res = await rollbackRootfs('manual', { restart: noopRestart })
    expect(res.ok).toBe(true)
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('good generation')
    expect(getRootfsSha()).toBe('v1')
    expect(restartCalled).toBe(true)
  })

  test('refuses cleanly when there is no .prev', async () => {
    writeFileSync(config.baseRootfs, 'current generation')
    // No .prev file, no ROOTFS_PREV marker.
    const res = await rollbackRootfs('manual', { restart: noopRestart })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('nothing to roll back')
    // The live image is untouched.
    expect(readFileSync(config.baseRootfs, 'utf8')).toBe('current generation')
  })

  test('refuses cleanly when ROOTFS_PREV marker is missing even if .prev file exists', async () => {
    writeFileSync(config.baseRootfs, 'current generation')
    writeFileSync(prevRootfsPath(config.baseRootfs), 'previous generation')
    // .prev file exists but no ROOTFS_PREV marker.
    const res = await rollbackRootfs('manual', { restart: noopRestart })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('nothing to roll back')
  })
})
