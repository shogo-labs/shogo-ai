// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * End-to-end: the agent's home directory (`~/.ssh`, `~/.oci`, ...) survives a
 * cold boot, and is never clobbered by a VM that could not restore it.
 *
 * The incident shape: an agent set up an SSH key and an OCI profile in its
 * home, a pod rebuild wiped `/app`, and the agent's workaround was to copy the
 * private key into the workspace. Here the snapshot is dropped outright (what
 * a rootfs rebuild does to every snapshot at once), so the only way the key
 * comes back is the durable home archive.
 *
 * Real: the pool, Bun's S3 client and the SigV4 conditional writer against an
 * object store that enforces If-Match / If-None-Match, and the guest's own
 * home-state handlers (scan, tar, AES-GCM, validated restore) over a real
 * directory. Fake: only the VM.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { SnapshotStore } from './snapshot-store'
import { FakeHost, FakeS3, fakeHostConfig, useFakeS3Env, type FakeGuest } from './test-harness/fake-metal-host'

const KEY = 'p1/home-state.enc'
let restoreEnv: () => void
const cleanups: Array<() => void> = []

beforeAll(() => {
  restoreEnv = useFakeS3Env()
})
afterAll(() => restoreEnv())
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function envFor(homeKey = randomBytes(32).toString('base64')): Record<string, string> {
  return {
    RUNTIME_AUTH_SECRET: 'tok',
    SHOGO_DURABILITY_HOST_MEDIATED: '1',
    HOME_STATE_KEY: homeKey,
    HOME_STATE_KEY_VERSION: '1',
  }
}

function rig() {
  const s3 = new FakeS3()
  const host = new FakeHost()
  const dir = mkdtempSync(join(tmpdir(), 'home-e2e-'))
  cleanups.push(() => s3.stop(), () => host.stopAll(), () => rmSync(dir, { recursive: true, force: true }))
  const pool = new MetalWarmPool(host.manager(), fakeHostConfig(dir, s3), { kind: 'none' } as unknown as SnapshotStore)
  const assigned = (id = 'p1'): AssignedVm => pool.getAssigned(id)!
  const guest = (id = 'p1'): FakeGuest => host.guestFor(assigned(id).handle)!
  return { s3, host, pool, assigned, guest }
}

/** The agent doing ops work, as in the staging report. */
function setUpCredentials(g: FakeGuest): void {
  g.writeHome('.ssh/id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----\nAGENT-PRIVATE-KEY\n', 0o600)
  g.writeHome('.ssh/id_ed25519.pub', 'ssh-ed25519 AAAA agent@shogo\n')
  g.writeHome('.oci/config', '[DEFAULT]\ntenancy=ocid1.tenancy.oc1..secret\nkey_file=~/.oci/oci_api_key.pem\n')
  g.writeHome('.oci/oci_api_key.pem', '-----BEGIN PRIVATE KEY-----\nOCI-PRIVATE-KEY\n', 0o600)
}

/** A rootfs rebuild: every snapshot is invalid, so the next open cold-boots. */
async function rebuildAndReopen(pool: MetalWarmPool, env: Record<string, string>): Promise<void> {
  await pool.suspend('p1')
  await pool.evictForGc('p1', { alsoDurable: true })
  await pool.open('p1', env)
}

describe('home directory durability (e2e)', () => {
  test('credentials survive a cold boot, encrypted at rest, with their permissions', async () => {
    const { s3, pool, assigned, guest } = rig()
    const env = envFor()
    await pool.open('p1', env)
    const firstVm = assigned().handle.id
    setUpCredentials(guest())

    expect(await pool.exportAllHomeState()).toBe(1)
    const stored = Buffer.from(s3.body(KEY)!)
    expect(stored.subarray(0, 4).toString()).toBe('SHGH')
    for (const secret of ['AGENT-PRIVATE-KEY', 'OCI-PRIVATE-KEY', 'ocid1.tenancy', 'id_ed25519']) {
      expect(stored.includes(Buffer.from(secret))).toBe(false)
    }

    await rebuildAndReopen(pool, env)
    expect(assigned().handle.id).not.toBe(firstVm)
    const g = guest()
    expect(g.readHome('.ssh/id_ed25519')).toContain('AGENT-PRIVATE-KEY')
    expect(g.readHome('.oci/oci_api_key.pem')).toContain('OCI-PRIVATE-KEY')
    expect(lstatSync(join(g.home, '.ssh/id_ed25519')).mode & 0o777).toBe(0o600)
    expect(g.readHome('.oci/config')).toContain('key_file=~/.oci/oci_api_key.pem')
    expect(assigned().homeParentEtag).toBe(s3.objects.get(KEY)!.etag)
  }, 60_000)

  test('suspend alone persists the home, without waiting for the periodic export', async () => {
    const { s3, pool, guest } = rig()
    const env = envFor()
    await pool.open('p1', env)
    setUpCredentials(guest())
    await rebuildAndReopen(pool, env)
    expect(s3.body(KEY)).toBeDefined()
    expect(guest().readHome('.ssh/id_ed25519')).toContain('AGENT-PRIVATE-KEY')
  }, 60_000)

  test('an idle home costs a 304: no upload, no new object version', async () => {
    const { s3, pool, guest } = rig()
    await pool.open('p1', envFor())
    setUpCredentials(guest())
    expect(await pool.exportAllHomeState()).toBe(1)
    const writes = s3.writes.filter((k) => k === KEY).length
    expect(await pool.exportAllHomeState()).toBe(0)
    expect(await pool.exportAllHomeState()).toBe(0)
    expect(s3.writes.filter((k) => k === KEY).length).toBe(writes)

    guest().writeHome('.kube/config', 'apiVersion: v1\n')
    expect(await pool.exportAllHomeState()).toBe(1)
  }, 60_000)

  test('lineage carries across a snapshot resume, so the resumed VM can keep writing', async () => {
    const { s3, pool, assigned, guest } = rig()
    const env = envFor()
    await pool.open('p1', env)
    setUpCredentials(guest())
    await pool.suspend('p1')
    const etagAtSuspend = s3.objects.get(KEY)!.etag

    await pool.open('p1', env)
    expect(assigned().homeParentEtag).toBe(etagAtSuspend)
    expect(guest().readHome('.ssh/id_ed25519')).toContain('AGENT-PRIVATE-KEY')

    guest().writeHome('.oci/config', '[DEFAULT]\nregion=us-phoenix-1\n')
    expect(await pool.exportAllHomeState()).toBe(1)
    expect(s3.objects.get(KEY)!.etag).not.toBe(etagAtSuspend)
    expect(assigned().homeUntrustedReason).toBeUndefined()
  }, 60_000)

  test('a key deleted before the export stays deleted after a cold boot', async () => {
    const { pool, guest } = rig()
    const env = envFor()
    await pool.open('p1', env)
    setUpCredentials(guest())
    await pool.exportAllHomeState()
    rmSync(join(guest().home, '.ssh/id_ed25519'))
    await rebuildAndReopen(pool, env)
    expect(guest().readHome('.ssh/id_ed25519')).toBeNull()
    expect(guest().readHome('.ssh/id_ed25519.pub')).toContain('ssh-ed25519')
  }, 60_000)

  test('an archive the guest cannot open marks the VM untrusted, and the archive is never overwritten', async () => {
    const { s3, pool, assigned, guest } = rig()
    // Written under one key, read back with another: the key was rotated, or
    // the blob belongs to someone else. Either way it must not be replaced by
    // whatever this VM happens to have in its (empty) home.
    await pool.open('p1', envFor())
    setUpCredentials(guest())
    await pool.exportAllHomeState()
    const before = s3.objects.get(KEY)!
    await pool.suspend('p1')
    await pool.evictForGc('p1', { alsoDurable: true })

    await pool.open('p1', envFor())
    expect(assigned().homeUntrustedReason).toMatch(/hydrate-home failed \(422\)/)
    expect(guest().readHome('.ssh/id_ed25519')).toBeNull()

    guest().writeHome('.ssh/id_ed25519', 'A DIFFERENT KEY', 0o600)
    expect(await pool.exportAllHomeState()).toBe(0)
    await pool.suspend('p1')
    expect(s3.objects.get(KEY)!.etag).toBe(before.etag)
    expect(Buffer.from(s3.objects.get(KEY)!.body).equals(Buffer.from(before.body))).toBe(true)
    expect(s3.keys('conflict/p1/').some((k) => k.endsWith('-home.enc'))).toBe(true)
  }, 60_000)

  test("a project's archive copied under another project's key does not restore there", async () => {
    const { s3, pool, assigned, guest } = rig()
    const homeKey = randomBytes(32).toString('base64')
    await pool.open('p1', envFor(homeKey))
    setUpCredentials(guest())
    await pool.exportAllHomeState()

    // Even with the SAME key, the project id is authenticated into the blob.
    s3.put('p2/home-state.enc', s3.body(KEY)!)
    await pool.open('p2', envFor(homeKey))
    expect(assigned('p2').homeUntrustedReason).toMatch(/422/)
    expect(guest('p2').readHome('.ssh/id_ed25519')).toBeNull()
  }, 60_000)

  test('a guest with no key is asked once, then left alone; nothing is stored', async () => {
    const { s3, pool, assigned, guest } = rig()
    const env = { RUNTIME_AUTH_SECRET: 'tok', SHOGO_DURABILITY_HOST_MEDIATED: '1' }
    await pool.open('p1', env)
    setUpCredentials(guest())
    expect(await pool.exportAllHomeState()).toBe(0)
    expect(assigned().homeExportUnsupported).toBe(true)
    expect(await pool.exportAllHomeState()).toBe(0)
    expect(s3.body(KEY)).toBeUndefined()
  }, 60_000)

  test('speed: cold-boot restore and the idle sweep are cheap next to a VM boot', async () => {
    const { pool, assigned, guest } = rig()
    const env = envFor()
    await pool.open('p1', env)
    setUpCredentials(guest())
    for (let i = 0; i < 50; i++) guest().writeHome(`.config/tool${i}/config.json`, `{"n":${i}}`)
    await pool.exportAllHomeState()

    const idle: number[] = []
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now()
      await pool.exportAllHomeState()
      idle.push(performance.now() - t0)
    }
    idle.sort((a, b) => a - b)

    const hydrate: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      await (pool as any).hydrateHomeState('p1', assigned().handle, env)
      hydrate.push(performance.now() - t0)
    }
    hydrate.sort((a, b) => a - b)

    const idleMs = idle[Math.floor(idle.length / 2)]
    const hydrateMs = hydrate[Math.floor(hydrate.length / 2)]
    console.log(
      `\n  home-state host round trips (median): idle sweep ${idleMs.toFixed(1)}ms · ` +
        `cold-boot restore (S3 GET + push + decrypt + extract) ${hydrateMs.toFixed(1)}ms`,
    )
    expect(idleMs).toBeLessThan(100)
    expect(hydrateMs).toBeLessThan(750)
  }, 60_000)
})
