// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { injectE2eFault } from './e2e-faults'
import { MetalWarmPool } from './pool'
import type { SnapshotStore } from './snapshot-store'
import { FakeHost, FakeS3, fakeHostConfig, untar, useFakeS3Env } from './test-harness/fake-metal-host'

const ENV = { RUNTIME_AUTH_SECRET: 'tok' }
let restoreEnv: () => void
const cleanups: Array<() => void> = []

beforeAll(() => {
  restoreEnv = useFakeS3Env()
})
afterAll(() => restoreEnv())
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function rig() {
  const s3 = new FakeS3()
  const host = new FakeHost()
  const dir = mkdtempSync(join(tmpdir(), 'e2e-fault-'))
  cleanups.push(() => s3.stop(), () => host.stopAll(), () => rmSync(dir, { recursive: true, force: true }))
  const pool = new MetalWarmPool(host.manager(), fakeHostConfig(dir, s3), { kind: 'none' } as unknown as SnapshotStore)
  return { s3, host, pool }
}

describe('injectE2eFault', () => {
  test('crash kills the Firecracker process, and the next open rescues the work from its disk', async () => {
    const { s3, host, pool } = rig()
    await pool.open('p1', ENV)
    const a = pool.getAssigned('p1')!
    host.guestFor(a.handle)!.edit('src/App.tsx', 'work since the last backup\n')

    const killed: number[] = []
    const r = await injectE2eFault(pool, 'p1', 'crash', (pid) => {
      killed.push(pid)
      host.crash(a.handle.id)
    })
    expect(r).toEqual({ ok: true, action: 'crash', vmId: a.handle.id })
    expect(killed).toEqual([a.handle.pid])

    await pool.open('p1', ENV)
    expect(pool.getAssigned('p1')!.handle.id).not.toBe(a.handle.id)
    expect(host.guestFor(pool.getAssigned('p1')!.handle)!.read('src/App.tsx')).toBe('work since the last backup\n')
    expect(untar(s3.body('p1/project-src.tar.gz')!)['src/App.tsx']).toBe('work since the last backup\n')
  }, 60_000)

  test('crash refuses a project that is not running here', async () => {
    const { pool } = rig()
    expect(await injectE2eFault(pool, 'p1', 'crash', () => { throw new Error('must not kill') })).toMatchObject({ ok: false })
  })

  test('drop-snapshot refuses a running project', async () => {
    const { pool } = rig()
    await pool.open('p1', ENV)
    expect(await injectE2eFault(pool, 'p1', 'drop-snapshot')).toMatchObject({ ok: false, error: expect.stringMatching(/suspend it first/) })
  }, 60_000)

  test('drop-snapshot evicts local and durable copies', async () => {
    const calls: unknown[] = []
    const pool = {
      getAssigned: () => undefined,
      evictForGc: async (id: string, opts?: { alsoDurable?: boolean }) => {
        calls.push([id, opts])
        return true
      },
    }
    expect(await injectE2eFault(pool as any, 'p1', 'drop-snapshot')).toEqual({ ok: true, action: 'drop-snapshot' })
    expect(calls).toEqual([['p1', { alsoDurable: true }]])
  })

  test('evict-local drops only the local copy, and refuses a running project', async () => {
    const calls: unknown[] = []
    let running = true
    const pool = {
      getAssigned: () => (running ? ({} as any) : undefined),
      evictForGc: async (id: string, opts?: { alsoDurable?: boolean }) => {
        calls.push([id, opts])
        return true
      },
    }
    expect(await injectE2eFault(pool as any, 'p1', 'evict-local')).toMatchObject({ ok: false })
    running = false
    expect(await injectE2eFault(pool as any, 'p1', 'evict-local')).toEqual({ ok: true, action: 'evict-local' })
    expect(calls).toEqual([['p1', undefined]])
  })

  test('evict-local reports when there is no durable copy to fall back on', async () => {
    const pool = { getAssigned: () => undefined, evictForGc: async () => false }
    expect(await injectE2eFault(pool as any, 'p1', 'evict-local')).toMatchObject({ ok: false, error: expect.stringMatching(/durable/) })
  })

  test('unknown actions are rejected', async () => {
    const { pool } = rig()
    expect(await injectE2eFault(pool, 'p1', 'reboot')).toMatchObject({ ok: false, error: expect.stringMatching(/unknown fault/) })
  })
})
