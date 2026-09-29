// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Model-based invariants for the MetalWarmPool lifecycle.
 *
 * Each post-2.0 metal fix (rewound repos, clobbered backups, reaping a VM
 * mid-suspend, rescue quarantining a disk it could have saved, workspace keys
 * written under the wrong prefix) was a specific interleaving of open / edit /
 * backup / suspend / reap / crash / evict that no example test happened to
 * cover. Here a seeded random sequence of those operations runs against the
 * real pool (real S3 client and lineage guards, real tar and git) on a fake
 * host, and after every step we check what must always hold:
 *
 *   - durable source never goes backwards, the durable repo never drops a
 *     commit, and another writer's work at the durable key is never
 *     overwritten;
 *   - no user edit is ever lost without trace: it is on the live guest, in the
 *     durable store, in a conflict copy, or on a quarantined disk;
 *   - `open` never hands back a tree older than the durable copy;
 *   - the dead-VM reaper never takes a VM while its suspend is in flight;
 *   - for `ws:proj:` runtimes, source goes only under member keys and the
 *     merged repo only under the anchor key.
 *
 * A failure prints the seed and the op trace; rerun one sequence with
 * POOL_INVARIANT_SEED=<seed>.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { SnapshotStore } from './snapshot-store'
import {
  FakeHost,
  FakeS3,
  fakeHostConfig,
  repoFileAtHead,
  repoHeadContaining,
  tarOf,
  untar,
  useFakeS3Env,
  writeRel,
} from './test-harness/fake-metal-host'

const ENV = { RUNTIME_AUTH_SECRET: 'tok' }
const APP = 'src/App.tsx'

let restoreEnv: () => void
const cleanups: Array<() => void> = []

beforeAll(() => {
  restoreEnv = useFakeS3Env()
})
afterAll(() => restoreEnv())
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** User edits write `v<N>`; the template is version 0. */
function versionOf(body: string | undefined | null): number {
  const m = body?.match(/^v(\d+)\b/)
  return m ? Number(m[1]) : 0
}

function markersOf(files: Record<string, string>): Set<string> {
  return new Set(Object.keys(files).filter((f) => f.startsWith('foreign/')))
}

function rig() {
  const s3 = new FakeS3()
  const host = new FakeHost()
  const dir = mkdtempSync(join(tmpdir(), 'pool-inv-'))
  cleanups.push(() => s3.stop(), () => host.stopAll(), () => rmSync(dir, { recursive: true, force: true }))
  const pool = new MetalWarmPool(host.manager(), fakeHostConfig(dir, s3), { kind: 'none' } as unknown as SnapshotStore)
  return { s3, host, pool, dir }
}

describe('single-project lifecycle invariants (seeded random op sequences)', () => {
  const seeds = process.env.POOL_INVARIANT_SEED
    ? [Number(process.env.POOL_INVARIANT_SEED)]
    : Array.from({ length: Number(process.env.POOL_INVARIANT_SEEDS ?? 8) }, (_, i) => 1000 + i * 7919)
  const STEPS = Number(process.env.POOL_INVARIANT_STEPS ?? 28)

  test.each(seeds)('seed %d', async (seed) => {
    const rand = mulberry32(seed)
    const { s3, host, pool } = rig()
    const P = 'p1'
    const SRC = `${P}/project-src.tar.gz`
    const REPO = `${P}/repo.git.tar.gz`

    let maxEdited = 0
    let foreign = 0
    let lastDurableVer = -1
    let lastDurableMarkers = new Set<string>()
    let lastRepoHead: string | null = null
    const trace: string[] = []

    const live = (): { a: AssignedVm; ws: string } | null => {
      const a = pool.getAssigned(P)
      if (!a) return null
      const g = host.guests.get(a.handle.id)
      return g?.alive ? { a, ws: g.ws } : null
    }
    const readApp = (ws: string) => (existsSync(join(ws, APP)) ? readFileSync(join(ws, APP), 'utf-8') : '')
    const durable = () => {
      const b = s3.body(SRC)
      return b ? untar(b) : null
    }

    /** Every place a user version can legitimately survive. */
    const heldVersions = (): number[] => {
      const held: number[] = []
      // Running guests, and crashed ones whose disk the pool has not handled yet.
      for (const g of host.guests.values()) held.push(versionOf(readApp(g.ws)))
      const d = durable()
      if (d) held.push(versionOf(d[APP]))
      const r = s3.body(REPO)
      if (r) held.push(versionOf(repoFileAtHead(r, APP)))
      for (const k of s3.keys(`conflict/${P}/`)) {
        const body = s3.body(k)!
        let v = 0
        try { v = versionOf(untar(body)[APP]) } catch { /* not a source tar */ }
        held.push(Math.max(v, versionOf(repoFileAtHead(body, APP))))
      }
      for (const kept of host.quarantined.values()) held.push(versionOf(readApp(kept)))
      return held
    }

    const fail = (msg: string) => {
      throw new Error(`seed ${seed}: ${msg}\n  ops: ${trace.join(' → ')}`)
    }

    const checkInvariants = () => {
      const d = durable()
      if (d) {
        const v = versionOf(d[APP])
        const markers = markersOf(d)
        if (v < lastDurableVer) fail(`durable source went backwards: v${lastDurableVer} → v${v}`)
        for (const m of lastDurableMarkers) {
          if (!markers.has(m)) fail(`another writer's ${m} was overwritten at the durable key`)
        }
        lastDurableVer = v
        lastDurableMarkers = markers
      }
      const r = s3.body(REPO)
      if (r) {
        const got = repoHeadContaining(r, lastRepoHead)
        if (!got) fail('durable repo archive is unreadable')
        if (!got!.contains) fail(`durable repo dropped commit ${lastRepoHead} (new HEAD ${got!.head} does not descend from it)`)
        lastRepoHead = got!.head
      }
      const held = heldVersions()
      if (maxEdited > 0 && Math.max(0, ...held) < maxEdited) {
        fail(`user edit v${maxEdited} lost without trace (held: ${held.map((h) => `v${h}`).join(', ') || 'nothing'})`)
      }
    }

    const ops: Array<[weight: number, name: string, run: () => Promise<void>]> = [
      [4, 'open', async () => {
        const before = durable()
        const r = await pool.open(P, ENV)
        const l = live()
        if (!l) fail('open returned without a live guest')
        // A reused VM keeps its own tree even if another writer moved the
        // durable copy on; its backups are quarantined instead (checked above).
        if (before && !r.reused) {
          const got = versionOf(readApp(l!.ws))
          if (got < versionOf(before[APP])) fail(`open rewound the tree below the durable copy (v${got} < v${versionOf(before[APP])})`)
          for (const m of markersOf(before)) {
            if (!existsSync(join(l!.ws, m))) fail(`open dropped durable ${m}`)
          }
        }
      }],
      [6, 'edit', async () => {
        const l = live()
        if (!l) return
        maxEdited += 1
        writeRel(l.ws, APP, `v${maxEdited}\n`)
        // Half the edits are committed by the agent, half are left in the tree.
        if (rand() < 0.5) {
          host.guestFor(l.a.handle)!.edit(APP, `v${maxEdited}\n`)
        }
      }],
      [3, 'backup', async () => {
        const l = live()
        if (l) await (pool as any).saveBackupToStore(l.a)
      }],
      [2, 'saveRepo', async () => {
        const l = live()
        if (l) await pool.saveRepoToStore(l.a)
      }],
      [2, 'suspend', async () => {
        if (live()) await pool.suspend(P)
      }],
      [1, 'reapIdle', async () => {
        await pool.reapIdle(1)
      }],
      [1, 'crash', async () => {
        const l = live()
        if (l) host.crash(l.a.handle.id)
      }],
      [2, 'reapDead', async () => {
        await pool.reapDeadAssigned()
      }],
      [1, 'evictLocal', async () => {
        pool.evictLocal(P)
      }],
      [1, 'foreignWrite', async () => {
        const d = durable()
        if (!d) return
        foreign += 1
        s3.put(SRC, tarOf({ ...d, [`foreign/${foreign}.txt`]: `another writer #${foreign}\n` }))
      }],
      [1, 'suspendRacingReap', async () => {
        if (!live()) return
        let done = false
        const suspending = pool.suspend(P).finally(() => { done = true })
        const reaped: string[] = []
        while (!done) {
          reaped.push(...(await pool.reapDeadAssigned()))
          await Bun.sleep(0)
        }
        await suspending
        if (reaped.includes(P)) fail('the dead-VM reaper took a VM while its suspend was in flight')
      }],
    ]
    const total = ops.reduce((n, [w]) => n + w, 0)
    const pick = () => {
      let r = rand() * total
      for (const op of ops) {
        r -= op[0]
        if (r < 0) return op
      }
      return ops[0]
    }

    await ops[0][2]()
    trace.push('open')
    checkInvariants()
    for (let i = 0; i < STEPS; i++) {
      const [, name, run] = pick()
      trace.push(name)
      await run()
      checkInvariants()
    }
    // Whatever state the sequence ended in, the user's latest work must come back.
    trace.push('open (final)')
    await ops[0][2]()
    checkInvariants()
  }, 120_000)
})

describe('crash rescue keeps uncommitted edits (seed 56433)', () => {
  for (const backedUp of [true, false]) {
    test(`uncommitted edit ${backedUp ? 'already in the durable backup' : 'only on the disk'} survives crash → open`, async () => {
      const { s3, host, pool } = rig()
      await pool.open('p1', ENV)
      const g = host.guestFor(pool.getAssigned('p1')!.handle)!
      g.edit(APP, 'v1\n')
      await pool.saveRepoToStore(pool.getAssigned('p1')!)
      writeRel(g.ws, APP, 'v2\n')
      if (backedUp) expect(await (pool as any).saveBackupToStore(pool.getAssigned('p1')!)).toBe('written')

      host.crash(pool.getAssigned('p1')!.handle.id)
      await pool.open('p1', ENV)

      const after = host.guestFor(pool.getAssigned('p1')!.handle)!
      expect(after.read(APP)).toBe('v2\n')
      expect(untar(s3.body('p1/project-src.tar.gz')!)[APP]).toBe('v2\n')
    }, 60_000)
  }
})

describe('ws:proj runtime key mapping', () => {
  test('source only under member keys, the merged repo only under the anchor key', async () => {
    const { s3, host, pool } = rig()
    const ANCHOR = 'ws:proj:m1'
    const WS_ENV = { ...ENV, WORKSPACE_PROJECT_IDS: 'm1,m2' }
    s3.put('m1/project-src.tar.gz', tarOf({ 'App.tsx': 'm1 v0\n' }))
    s3.put('m2/project-src.tar.gz', tarOf({ 'App.tsx': 'm2 v0\n' }))

    const rand = mulberry32(42)
    for (let round = 1; round <= 3; round++) {
      await pool.open(ANCHOR, WS_ENV)
      const a = pool.getAssigned(ANCHOR)!
      const g = host.guestFor(a.handle)!
      g.edit('m1/App.tsx', `m1 v${round}\n`)
      g.edit('m2/App.tsx', `m2 v${round}\n`)
      if (rand() < 0.5) await pool.saveRepoToStore(a)
      await (pool as any).saveWorkspaceMembersToStore(a)
      await pool.suspend(ANCHOR)
      if (rand() < 0.5) pool.evictLocal(ANCHOR)
    }

    const bad = s3.writes.filter((k) => {
      if (k.startsWith('conflict/')) return false
      if (k.endsWith('/project-src.tar.gz')) return !/^m[12]\//.test(k)
      if (k.endsWith('/repo.git.tar.gz')) return k !== `${ANCHOR}/repo.git.tar.gz`
      return false
    })
    expect(bad).toEqual([])
    expect(s3.writes).toContain('m1/project-src.tar.gz')
    expect(s3.writes).toContain(`${ANCHOR}/repo.git.tar.gz`)
    expect(untar(s3.body('m1/project-src.tar.gz')!)['App.tsx']).toBe('m1 v3\n')
    expect(untar(s3.body('m2/project-src.tar.gz')!)['App.tsx']).toBe('m2 v3\n')
  }, 120_000)
})
