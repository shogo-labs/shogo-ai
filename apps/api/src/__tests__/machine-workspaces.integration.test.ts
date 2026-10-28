// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-185, acceptance criterion 10 — a real desktop, two real cloud API pods,
 * real Postgres and real Redis.
 *
 * The unit suites cover the pieces (triggers on a real SQLite database, ingest
 * against a Prisma-shaped gateway, the interceptor's read/write split). This is
 * the only test that runs the whole thing: a desktop process writing to its own
 * SQLite database, pushing over HTTPS, two API pods reading the copied rows
 * through the *normal* cloud routes, and the workspace still readable after the
 * desktop is switched off.
 *
 *   CHANNELS_TEST_PG_URL=postgresql://user@127.0.0.1:5432/postgres \
 *   TEST_REDIS_URL=redis://127.0.0.1:6379 \
 *   bun --no-env-file test src/__tests__/machine-workspaces.integration.test.ts
 *
 * Cloud = Postgres, desktop = SQLite, both real, because that is production.
 * Skips (loudly in CI) without the two services.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawn, type Subprocess } from 'bun'
import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const REQUIRED = process.env.CI_REQUIRE_MACHINE_INFRA === '1'

if (REQUIRED && (!PG_URL || !REDIS_URL)) {
  throw new Error('SHO-185 machine-workspace test needs CHANNELS_TEST_PG_URL and TEST_REDIS_URL')
}

const WORKER = join(import.meta.dir, 'helpers', 'machine-workspace-pod.ts')
const DESKTOP_MIGRATIONS = resolve(import.meta.dir, '../../../desktop/prisma/migrations')
const API_ROOT = join(import.meta.dir, '..', '..')

const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

type Topology = {
  label: string
  instanceId: string
  /** The cloud user the device key was issued to — the voice of the desktop. */
  ownerUserId: string
  /** The workspace the machine is paired into: a real cloud workspace. */
  deviceWorkspaceId: string
  desktop: Subprocess
  desktopUrl: string
  /** The SQLite URL the desktop process opened — reused by a restart. */
  desktopDbUrl: string
  /** The minted device key, for a heartbeat or a `/sync` the test sends itself. */
  deviceKey: string
  pods: Subprocess[]
  /** The HTTP port of each pod, in start order: A is the machine's, B is where a read lands. */
  ports: number[]
  cloudUrl: string
}

let db: any
const spawned: Subprocess[] = []
const readers = new WeakMap<Subprocess, { reader: ReadableStreamDefaultReader<Uint8Array>; buffer: string }>()
let topologies: Topology[] = []

function env(official: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v
  for (const [k, v] of Object.entries(official)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}

/** Every line a worker has printed, so a failure can say what the pods saw. */
const workerLog = new WeakMap<Subprocess, string[]>()

function record(proc: Subprocess, line: string): void {
  const lines = workerLog.get(proc) ?? []
  lines.push(line)
  workerLog.set(proc, lines)
}

function run(args: string[], extraEnv: Record<string, string | undefined>): Subprocess {
  const proc = spawn({
    cmd: ['bun', '--no-env-file', WORKER, ...args],
    cwd: API_ROOT,
    env: env(extraEnv),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })
  spawned.push(proc)
  readers.set(proc, { reader: (proc.stdout as ReadableStream<Uint8Array>).getReader(), buffer: '' })
  // stderr carries the pods' warnings, which is where an ingest failure explains itself.
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      for (const line of decoder.decode(chunk, { stream: true }).split('\n')) {
        if (line.trim()) record(proc, `[stderr] ${line.trim()}`)
      }
    }
  })()
  return proc
}

async function waitForLine(proc: Subprocess, match: (line: string) => boolean, deadlineMs = 30_000): Promise<string> {
  const state = readers.get(proc)!
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const newline = state.buffer.indexOf('\n')
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline).trim()
      state.buffer = state.buffer.slice(newline + 1)
      if (line) record(proc, line)
      if (line && match(line)) return line
      continue
    }
    const remaining = deadline - Date.now()
    const read = await Promise.race([
      state.reader.read(),
      new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), Math.max(remaining, 1))),
    ])
    if (read.done) {
      throw new Error(`worker produced no matching line. buffered=${JSON.stringify(state.buffer.trim())} log=${JSON.stringify(workerLog.get(proc) ?? [])}`)
    }
    state.buffer += new TextDecoder().decode(read.value, { stream: true })
  }
  throw new Error('worker timed out producing a line')
}

/** Keep reading a worker's stdout after it is up, so its logs survive for a failure. */
function drain(proc: Subprocess): void {
  const state = readers.get(proc)!
  void (async () => {
    while (true) {
      const read = await state.reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (read.done) return
      state.buffer += new TextDecoder().decode(read.value, { stream: true })
      let newline = state.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = state.buffer.slice(0, newline).trim()
        state.buffer = state.buffer.slice(newline + 1)
        if (line) record(proc, line)
        newline = state.buffer.indexOf('\n')
      }
    }
  })()
}

/** A fresh desktop database: the real SQLite migration history, replayed. */
function freshDesktopDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-desktop-'))
  const path = join(dir, 'desktop.db')
  const sqlite = new Database(path)
  const migrations = readdirSync(DESKTOP_MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  for (const name of migrations) {
    sqlite.exec(readFileSync(join(DESKTOP_MIGRATIONS, name, 'migration.sql'), 'utf-8'))
  }
  sqlite.close()
  return `file:${path}`
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  const port = server.port as number
  server.stop(true)
  return port
}

type TopologyOptions = {
  /**
   * Reuse the SQLite file a previous desktop process left behind. A restart on
   * the same database is the shape that stayed broken in production.
   */
  desktopDbUrl?: string
  /** Extra env for the desktop process (the recovery knobs). */
  desktopEnv?: Record<string, string | undefined>
  /** `instances` rows an older, fan-out desktop left behind, in other workspaces. */
  siblingRows?: number
}

let dbCounter = 0
const podId = () => `pod-mw-${++dbCounter}`

/**
 * One desktop paired to a two-pod cloud. `suffix` keeps the ids of two
 * topologies distinct, so a test can run two desktops side by side.
 *
 * `options` exists for the recovery shapes (SHO-241 §D): a desktop whose first
 * push was refused and then restarted on the same SQLite file, and a machine the
 * cloud still holds one row per workspace for.
 */
async function startTopology(suffix: string, options: TopologyOptions = {}): Promise<Topology> {
  const cloudUser = await db.user.create({
    data: { name: `Owner ${suffix}`, email: `owner-${suffix}@example.com` },
  })
  // The workspace the device key was issued in — where the machine is filed,
  // which is *not* the workspace whose rows get copied.
  const deviceWorkspace = await db.workspace.create({
    data: { name: `Devices ${suffix}`, slug: `devices-${suffix}`, kind: 'team' },
  })
  // Pairing happens in a workspace the person is a member of; the unpair route
  // authorises on exactly that.
  await db.member.create({
    data: { userId: cloudUser.id, workspaceId: deviceWorkspace.id, role: 'owner' },
  })
  const instanceId = `inst-${suffix}-${Date.now()}`
  await db.instance.create({
    data: {
      id: instanceId,
      userId: cloudUser.id,
      workspaceId: deviceWorkspace.id,
      hostname: `mac-${suffix}`,
      name: `Mac ${suffix}`,
      kind: 'desktop',
      // Never connected: this topology has no WebSocket, which is what makes
      // the read-only assertions meaningful.
      lastSeenAt: null,
      metadata: {},
    },
  })

  // The device key the desktop signed in with: a real minted key, so the sync
  // route resolves it to this machine's owner and workspace.
  const { mintDeviceApiKey } = await import('../lib/api-keys-mint')
  const deviceKey = await mintDeviceApiKey({
    prisma: db,
    workspaceId: deviceWorkspace.id,
    userId: cloudUser.id,
    deviceId: instanceId,
    deviceName: `Mac ${suffix}`,
    devicePlatform: 'darwin-arm64',
  })

  // The rows an older desktop left behind by opening one tunnel per stored
  // device key (SHO-241 §C). The heartbeat has to fold them into the one row
  // without losing what pointed at them.
  for (let i = 0; i < (options.siblingRows ?? 0); i++) {
    const workspace = await db.workspace.create({
      data: { name: `Side ${suffix} ${i}`, slug: `side-${suffix}-${i}`, kind: 'team' },
    })
    await db.instance.create({
      data: {
        id: `${instanceId}-sib-${i}`,
        userId: cloudUser.id,
        workspaceId: workspace.id,
        hostname: `mac-${suffix}`,
        name: `Mac ${suffix}`,
        kind: 'desktop',
        lastSeenAt: new Date(),
        metadata: {},
      },
    })
  }

  const pods: Subprocess[] = []
  const ports: number[] = []
  let cloudUrl = ''
  for (const role of ['a', 'b']) {
    const port = await freePort()
    const pod = run(['cloud', String(port)], {
      // Cloud: Postgres, never local mode.
      SHOGO_LOCAL_MODE: undefined,
      SHOGO_APP_DATABASE_URL: process.env.SHOGO_APP_DATABASE_URL,
      DATABASE_URL: process.env.SHOGO_APP_DATABASE_URL,
      REDIS_URL,
      HOSTNAME: podId(),
      POD_ID: podId(),
    })
    await waitForLine(pod, (l) => l.startsWith('READY'))
    pods.push(pod)
    ports.push(port)
    if (role === 'a') cloudUrl = `http://127.0.0.1:${port}`
  }

  const desktopPort = await freePort()
  const desktopDbUrl = options.desktopDbUrl ?? freshDesktopDb()
  const desktop = run(['desktop', String(desktopPort)], {
    SHOGO_LOCAL_MODE: 'true',
    SHOGO_APP_DATABASE_URL: desktopDbUrl,
    DATABASE_URL: undefined,
    SHOGO_CLOUD_URL: cloudUrl,
    MACHINE_INSTANCE_ID: instanceId,
    MACHINE_DEVICE_KEY: deviceKey.fullKey,
    MACHINE_SEED_SUFFIX: suffix,
    // The desktop is not a pod; it must not join the cloud's tunnel registry.
    REDIS_URL: undefined,
    POD_ID: undefined,
    ...(options.desktopEnv ?? {}),
  })
  await waitForLine(desktop, (l) => l.startsWith('READY'))

  const topology: Topology = {
    label: suffix,
    instanceId,
    ownerUserId: cloudUser.id,
    deviceWorkspaceId: deviceWorkspace.id,
    desktop,
    desktopUrl: `http://127.0.0.1:${desktopPort}`,
    desktopDbUrl,
    deviceKey: deviceKey.fullKey,
    pods,
    ports,
    cloudUrl,
  }
  topologies.push(topology)
  for (const proc of [desktop, ...pods]) drain(proc)
  return topology
}

/**
 * The pod a person's Studio request lands on — deliberately *not* the pod the
 * desktop pushes to, because "it works on the pod that holds the tunnel" is the
 * assumption that hid the relay bug.
 */
function podB(topology: Topology): string {
  return `http://127.0.0.1:${topology.ports[1]}`
}

/**
 * Start the desktop again on the database the last process left behind.
 *
 * This is the shape that stayed broken: a desktop whose first snapshot was
 * refused restarts, finds its own state row (epoch set, nothing ingested) and has
 * to send a snapshot rather than deltas the cloud cannot apply (SHO-241).
 */
async function restartDesktop(
  topology: Topology,
  extraEnv: Record<string, string | undefined> = {},
): Promise<void> {
  try {
    topology.desktop.kill()
  } catch {
    /* already gone */
  }
  await topology.desktop.exited.catch(() => {})
  const port = await freePort()
  const proc = run(['desktop', String(port)], {
    SHOGO_LOCAL_MODE: 'true',
    SHOGO_APP_DATABASE_URL: topology.desktopDbUrl,
    DATABASE_URL: undefined,
    SHOGO_CLOUD_URL: topology.cloudUrl,
    MACHINE_INSTANCE_ID: topology.instanceId,
    MACHINE_DEVICE_KEY: topology.deviceKey,
    MACHINE_SEED_SUFFIX: topology.label,
    // The rows, the change log and the sync state are the previous process's.
    MACHINE_RESTART: '1',
    MACHINE_SKIP_SEED: '1',
    REDIS_URL: undefined,
    POD_ID: undefined,
    ...extraEnv,
  })
  await waitForLine(proc, (l) => l.startsWith('READY'))
  topology.desktop = proc
  topology.desktopUrl = `http://127.0.0.1:${port}`
  drain(proc)
}

/** Everything the pods said, for when an assertion about them fails. */
function dumpLogs(topology: Topology): void {
  for (const proc of [topology.desktop, ...topology.pods]) {
    console.log(`[worker log] ${JSON.stringify(workerLog.get(proc) ?? [])}`)
  }
}

async function waitUntil<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('waitUntil timed out')
}

function authHeaders(userId: string, extra: Record<string, string> = {}) {
  return { 'x-test-user-id': userId, ...extra }
}

// The cloud's own schema, on a throwaway Postgres database. This has to happen at
// module scope, before `lib/prisma` is loaded — and never inside `beforeAll`,
// because the helper registers its `afterAll` drop from wherever it is called.
if (PG_URL && REDIS_URL) setupChannelsTestDb()

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  const mod = await import('../lib/prisma')
  db = mod.prisma
})

function killAll() {
  for (const proc of spawned) {
    try { proc.kill() } catch { /* already gone */ }
  }
  spawned.length = 0
  topologies = []
}

afterEach(() => killAll())
afterAll(() => killAll())

describeIfInfra('a real desktop and two real cloud pods', () => {
  test('the copy lands, reads work with the desktop off, and a write is refused', async () => {
    const topology = await startTopology('one')
    const suffix = 'one'

    // ─── Backfill ────────────────────────────────────────────────────────
    // The desktop pushed its whole database on start. The copied workspace is
    // tagged, keeps the desktop's id, and carries the rewritten slug.
    const copied = await waitUntil(async () =>
      db.workspace.findFirst({ where: { id: `ws-local-${suffix}` } }),
    ).catch((err: unknown) => {
      dumpLogs(topology)
      throw err
    })
    expect(copied.machineInstanceId).toBeString()
    expect(copied.slug).toBe(`samsara-m-${copied.machineInstanceId.slice(0, 8)}`)
    expect(copied.name).toBe('Samsara')

    // The desktop's local user is copied as an address that cannot sign in.
    const copiedUser = await db.user.findUnique({ where: { id: `u-local-${suffix}` } })
    expect(copiedUser.email).toBe(`u-local-${suffix}@machines.shogo.invalid`)

    // The project came across with its desktop id, under the copied workspace.
    const copiedProject = await db.project.findUnique({ where: { id: `p-local-${suffix}` } })
    expect(copiedProject.workspaceId).toBe(`ws-local-${suffix}`)
    expect(copiedProject.name).toBe('Local Project')

    // Which machine owns each row — what the ownership check and the delete use.
    const mirrored = await db.machineMirrorRow.findMany({
      where: { instanceId: copied.machineInstanceId },
    })
    expect(mirrored.length).toBeGreaterThan(0)
    expect(mirrored.some((r: any) => r.model === 'Workspace' && r.recordId === `ws-local-${suffix}`)).toBe(true)

    // The instance owner was added as a member, so the normal routes serve them.
    const membership = await db.member.findFirst({
      where: { workspaceId: `ws-local-${suffix}`, projectId: null },
    })
    expect(membership).toBeTruthy()

    // ─── The desktop goes away ───────────────────────────────────────────
    topology.desktop.kill()
    await topology.desktop.exited

    // Reads are answered by the copy, on the pod the request lands on.
    const projects = await fetch(`${podB(topology)}/api/projects?workspaceId=ws-local-${suffix}`, {
      headers: authHeaders(membership.userId),
    })
    expect(projects.status).toBe(200)
    const listed = (await projects.json()) as any
    const rows = listed.items as any[]
    expect(rows.map((p: any) => p.id)).toContain(`p-local-${suffix}`)

    // A write has nowhere to land: the machine is offline and nothing is queued.
    const send = await fetch(
      `${podB(topology)}/api/machines/${topology.instanceId}/w/ws-local-${suffix}/api/chat-messages`,
      {
        method: 'POST',
        headers: { ...authHeaders(membership.userId), 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hello?' }),
      },
    )
    expect(send.status).toBe(409)
    const body = (await send.json()) as any
    expect(body.error.code).toBe('machine_offline_readonly')
  }, 180_000)

  test('a read of the companion profile creates no row, so the desktop can still push its own', async () => {
    const topology = await startTopology('profile')
    const suffix = 'profile'
    const workspaceId = `ws-local-${suffix}`

    const copied = await waitUntil(async () => db.workspace.findFirst({ where: { id: workspaceId } }))
    const membership = await db.member.findFirst({
      where: { workspaceId, projectId: null },
    })

    // The panel the studio opens first. `getOrCreateAgentProfile` upserts on a
    // cloud workspace — on a copy that would mint a row with a cloud id for a
    // `workspaceId` the desktop also pushes, and the desktop's own row would
    // then fail the unique `workspaceId` and wedge the whole ingest batch.
    const first = await fetch(`${podB(topology)}/api/workspaces/${workspaceId}/agent-profile`, {
      headers: authHeaders(membership.userId),
    })
    expect(first.status).toBe(200)
    const profile = ((await first.json()) as any).profile
    expect(profile.name).toBeString()
    expect(profile.workspaceId).toBe(workspaceId)

    // Nothing was written. The read is a read.
    expect(await db.workspaceAgentProfile.count({ where: { workspaceId } })).toBe(0)

    // The desktop writes its own profile, in its own Settings, and pushes it.
    const created = await fetch(`${topology.desktopUrl}/api/test/agent-profile`, { method: 'POST' })
    expect(created.status).toBe(200)
    const desktopRow = (await created.json()) as any

    await waitUntil(async () =>
      (await db.workspaceAgentProfile.findUnique({ where: { workspaceId } }))?.id === desktopRow.id,
    ).catch((err: unknown) => {
      dumpLogs(topology)
      throw err
    })

    // One row, the desktop's id — the copy carries what the writer made, not a
    // cloud stand-in that would have collided with it.
    const rows = await db.workspaceAgentProfile.findMany({ where: { workspaceId } })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(desktopRow.id)
    expect(rows[0].name).toBe('Shogo on the desktop')

    // And the next read shows it, instead of the defaults.
    const second = await fetch(`${podB(topology)}/api/workspaces/${workspaceId}/agent-profile`, {
      headers: authHeaders(membership.userId),
    })
    const after = ((await second.json()) as any).profile
    expect(after.id).toBe(desktopRow.id)
    expect(after.name).toBe('Shogo on the desktop')

    // Ingest kept working after it: a second desktop write still lands.
    const renamed = await fetch(`${topology.desktopUrl}/api/projects/p-local-${suffix}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Still ingesting' }),
    })
    expect(renamed.status).toBe(200)
    await waitUntil(async () =>
      (await db.project.findUnique({ where: { id: `p-local-${suffix}` } }))?.name === 'Still ingesting',
    ).catch((err: unknown) => {
      dumpLogs(topology)
      throw err
    })
    expect(copied.machineInstanceId).toBeString()
    // One snapshot at boot, then deltas. A desktop that re-snapshots on every
    // write is SHO-188: it adopted a fresh epoch for the snapshot on the cloud
    // but kept the pre-snapshot one locally, so every delta was refused and the
    // whole database went again — slow enough to blow a `waitUntil` budget on a
    // busy runner.
    const mismatches = (workerLog.get(topology.desktop) ?? []).filter((line) => /epoch mismatch/i.test(line))
    if (mismatches.length) dumpLogs(topology)
    expect(mismatches).toHaveLength(0)
  }, 180_000)

  test('switching sync off deletes the copy, and a live desktop cannot put it back', async () => {
    const topology = await startTopology('off')
    const suffix = 'off'

    await waitUntil(async () => db.workspace.findFirst({ where: { id: `ws-local-${suffix}` } }))

    const off = await fetch(`${topology.cloudUrl}/api/machines/${topology.instanceId}/sync-settings`, {
      method: 'PATCH',
      headers: { ...authHeaders(topology.ownerUserId), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(off.status).toBe(200)
    expect(((await off.json()) as any).enabled).toBe(false)

    // The copy is gone, not just marked hidden.
    await waitUntil(async () => (await db.workspace.count({ where: { id: `ws-local-${suffix}` } })) === 0)
    expect(await db.project.findFirst({ where: { id: `p-local-${suffix}` } })).toBeNull()

    // The desktop is still running: this write is its own, and its pusher wakes
    // up to send it. The cloud has to answer "disabled" and the desktop has to
    // stop — otherwise the copy someone just deleted comes straight back.
    const renamed = await fetch(`${topology.desktopUrl}/api/projects/p-local-${suffix}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed after the switch' }),
    })
    expect(renamed.status).toBe(200)

    await waitUntil(async () =>
      (workerLog.get(topology.desktop) ?? []).some((line) => /sync is off|sync disabled/i.test(line)),
    ).catch((err: unknown) => {
      dumpLogs(topology)
      throw err
    })
    expect(await db.workspace.count({ where: { id: `ws-local-${suffix}` } })).toBe(0)
    expect(await db.project.findFirst({ where: { id: `p-local-${suffix}` } })).toBeNull()
    const state = await db.machineSyncState.findUnique({ where: { instanceId: topology.instanceId } })
    // The state row survives on purpose: deleting it would let a desktop that is
    // still running recreate the copy a person just switched off.
    expect(state.enabled).toBe(false)
  }, 180_000)

  test('two desktops with the same local email and slug do not collide, and neither owner can read the other', async () => {
    // Both desktops ship a `local@shogo.local` user and a workspace called
    // Samsara with slug `samsara` — the collision the rewrites exist for.
    const [left, right] = await Promise.all([startTopology('left'), startTopology('right')])

    const [leftCopy, rightCopy] = await Promise.all([
      waitUntil(async () => db.workspace.findFirst({ where: { id: 'ws-local-left' } })),
      waitUntil(async () => db.workspace.findFirst({ where: { id: 'ws-local-right' } })),
    ])
    expect(leftCopy.machineInstanceId).toBe(left.instanceId)
    expect(rightCopy.machineInstanceId).toBe(right.instanceId)
    expect(leftCopy.slug).not.toBe(rightCopy.slug)
    expect(leftCopy.slug).toBe(`samsara-m-${left.instanceId.slice(0, 8)}`)

    // Each project landed under its own copy, not under the other machine's.
    const [leftProject, rightProject] = await Promise.all([
      db.project.findUnique({ where: { id: 'p-local-left' } }),
      db.project.findUnique({ where: { id: 'p-local-right' } }),
    ])
    expect(leftProject.workspaceId).toBe('ws-local-left')
    expect(rightProject.workspaceId).toBe('ws-local-right')

    // Reads are authorised by membership: the left owner is a member of the left
    // copy only, so the right copy is not theirs to read.
    const leftMembership = await db.member.findFirst({
      where: { workspaceId: 'ws-local-left', projectId: null },
    })
    const crossRead = await fetch(`${podB(right)}/api/projects?workspaceId=ws-local-right`, {
      headers: authHeaders(leftMembership.userId),
    })
    expect(crossRead.status).not.toBe(200)
    const ownRead = await fetch(`${podB(left)}/api/projects?workspaceId=ws-local-left`, {
      headers: authHeaders(leftMembership.userId),
    })
    expect(ownRead.status).toBe(200)
  }, 180_000)

  test('every cloud worker leaves the copy alone, and still serves a normal workspace', async () => {
    const topology = await startTopology('quiet')
    const suffix = 'quiet'
    await waitUntil(async () => db.workspace.findFirst({ where: { id: `ws-local-${suffix}` } }))

    const now = Date.now()
    const past = new Date(now - 60 * 60_000)
    const copyId = `ws-local-${suffix}`
    const conversationId = `conv-copy-${suffix}`
    const controlConversationId = `conv-cloud-${suffix}`

    await db.conversation.create({
      data: { id: conversationId, workspaceId: copyId, kind: 'public', name: 'copy' },
    })
    await db.conversation.create({
      data: {
        id: controlConversationId,
        workspaceId: topology.deviceWorkspaceId,
        kind: 'public',
        name: 'cloud',
      },
    })

    // Work that would run on the cloud if the copy were not filtered out.
    await db.agentWake.create({
      data: {
        workspaceId: copyId,
        conversationId,
        triggerMessageId: `msg-copy-${suffix}`,
        agentRef: 'workspace',
        userId: topology.ownerUserId,
        createdAt: past,
      },
    })
    const copyScheduled = await db.scheduledMessage.create({
      data: {
        workspaceId: copyId,
        conversationId,
        userId: topology.ownerUserId,
        text: 'should not send',
        sendAt: past,
      },
    })
    const copyReminder = await db.chatReminder.create({
      data: { workspaceId: copyId, userId: topology.ownerUserId, text: 'should not fire', remindAt: past },
    })
    const copySession = await db.chatSession.create({
      data: {
        contextType: 'workspace',
        inferredName: `copy ${suffix}`,
        workspaceId: copyId,
      },
    })
    const copyQueued = await db.chatQueuedMessage.create({
      data: {
        sessionId: copySession.id,
        userId: topology.ownerUserId,
        status: 'pending',
        content: 'should not dispatch',
        body: 'should not dispatch',
        position: 1,
      },
    })

    // The control: a reminder in a real cloud workspace, due at the same time.
    const cloudReminder = await db.chatReminder.create({
      data: {
        workspaceId: topology.deviceWorkspaceId,
        userId: topology.ownerUserId,
        text: 'should fire',
        remindAt: past,
      },
    })

    const { sweepPendingAgentWakes } = await import('../services/conversation-agent-dispatcher')
    const { fireDueReminders, sendDueScheduledMessages } = await import('../services/chat-items')
    const { dispatchPendingSessions } = await import('../services/chat-queue-dispatcher.service')

    // Each worker once, with the clock already past every due time.
    const wakes = await sweepPendingAgentWakes(0)
    const sent = await sendDueScheduledMessages(new Date(now))
    const fired = await fireDueReminders(new Date(now))
    const dispatched = await dispatchPendingSessions()

    // Nothing in the copy moved: still pending, never claimed, never sent.
    const wake = await db.agentWake.findFirst({ where: { workspaceId: copyId } })
    expect(wake.status).toBe('pending')
    expect(wake.attempts).toBe(0)
    expect((await db.scheduledMessage.findUnique({ where: { id: copyScheduled.id } }))?.status).toBe('pending')
    expect((await db.chatReminder.findUnique({ where: { id: copyReminder.id } }))?.status).toBe('pending')
    expect((await db.chatQueuedMessage.findUnique({ where: { id: copyQueued.id } }))?.status).toBe('pending')
    expect(await db.conversationMessage.count({ where: { conversationId } })).toBe(0)

    // …while the filter is not so broad that it stops ordinary cloud work: the
    // control reminder fired, and only the copy's rows were held back.
    expect(wakes).toBe(0)
    expect(sent).toBe(0)
    expect(dispatched).toBe(0)
    expect(fired).toBeGreaterThanOrEqual(1)
    expect((await db.chatReminder.findUnique({ where: { id: cloudReminder.id } }))?.status).toBe('fired')
  }, 180_000)

  test('a desktop whose first push was refused copies itself after a restart', async () => {
    // Prod, both machines: the first snapshot was refused at the door (the
    // device key's header), so an epoch was minted and nothing was ever ingested.
    // Every later launch then sent deltas against a copy that did not exist, and
    // retried the same refusal every 30 s for four days (SHO-241).
    const topology = await startTopology('recover', {
      desktopEnv: { MACHINE_FIRST_PUSH_REFUSED: '50' },
    })

    // The refusal left the local state exactly as production had it: an epoch,
    // no accepted ingest, and the change log filling up behind it.
    const local = new Database(topology.desktopDbUrl.replace(/^file:/, ''))
    const stranded = local
      .query('select epoch, cursor, lastIngestAt from machine_sync_states')
      .get() as { epoch: string; cursor: number; lastIngestAt: string | null } | null
    local.close()
    expect(stranded?.epoch).toBeString()
    expect(stranded?.lastIngestAt ?? null).toBeNull()
    expect(await db.machineSyncState.findUnique({ where: { instanceId: topology.instanceId } })).toBeNull()
    expect(await db.workspace.count({ where: { id: 'ws-local-recover' } })).toBe(0)

    // The app is started again with the key working.
    await restartDesktop(topology)

    const copied = await waitUntil(async () =>
      db.workspace.findFirst({ where: { id: 'ws-local-recover' } }),
    ).catch((err: unknown) => {
      dumpLogs(topology)
      throw err
    })
    expect(copied.machineInstanceId).toBe(topology.instanceId)

    // Both ends now agree there is a copy, and the desktop keeps the epoch the
    // cloud holds — otherwise the next delta is refused and it snapshots forever.
    const cloudState = await db.machineSyncState.findUnique({
      where: { instanceId: topology.instanceId },
    })
    expect(cloudState.lastIngestAt).toBeInstanceOf(Date)
    const after = new Database(topology.desktopDbUrl.replace(/^file:/, ''))
    const localAfter = after
      .query('select epoch, lastIngestAt from machine_sync_states')
      .get() as { epoch: string; lastIngestAt: string | null }
    after.close()
    expect(localAfter.epoch).toBe(cloudState.epoch)
    expect(localAfter.lastIngestAt).not.toBeNull()

    // The owner is a member, so the normal routes serve the copy.
    const membership = await db.member.findFirst({
      where: {
        workspaceId: 'ws-local-recover',
        userId: topology.ownerUserId,
        projectId: null,
      },
    })
    expect(membership).toBeTruthy()
    const projects = await fetch(`${podB(topology)}/api/projects?workspaceId=ws-local-recover`, {
      headers: authHeaders(topology.ownerUserId),
    })
    expect(projects.status).toBe(200)
    expect(((await projects.json()) as any).items.map((p: any) => p.id)).toContain('p-local-recover')
  }, 240_000)

  test('a desktop left with an orphaned state and a full change log snapshots instead of replaying deltas', async () => {
    // The same shape, reached from the other side: a database that already has a
    // state row with an epoch and nothing ingested, plus a change log that has
    // been growing since (563k rows on the real Mac). A pusher that reads the
    // epoch as "already initialised" replays deltas forever.
    const topology = await startTopology('orphan', {
      desktopEnv: { MACHINE_ORPHANED_STATE: '1', MACHINE_PENDING_CHANGES: '500' },
    })

    await waitUntil(async () => db.workspace.findFirst({ where: { id: 'ws-local-orphan' } })).catch(
      (err: unknown) => {
        dumpLogs(topology)
        throw err
      },
    )

    const state = await db.machineSyncState.findUnique({ where: { instanceId: topology.instanceId } })
    expect(state.lastIngestAt).toBeInstanceOf(Date)
    // A new epoch: the stranded one never described a copy, so it was replaced
    // rather than reused.
    expect(state.epoch).not.toBe('epoch-stranded-orphan')

    // The accepted snapshot pruned the change log instead of leaving it to grow.
    const local = new Database(topology.desktopDbUrl.replace(/^file:/, ''))
    const pending = local.query('select count(*) as n from machine_sync_changes').get() as { n: number }
    local.close()
    expect(pending.n).toBeLessThan(500)
  }, 240_000)

  test('one machine sends one heartbeat: the rows an older desktop left are folded into one', async () => {
    // An older desktop opened a tunnel per stored device key, so the cloud holds
    // one row per workspace for one machine (nine, on the real Mac). The first
    // heartbeat from a single-tunnel desktop folds them in (SHO-241 §C).
    const topology = await startTopology('fold', { siblingRows: 2 })
    const siblings = await db.instance.findMany({
      where: { userId: topology.ownerUserId, hostname: 'mac-fold', id: { not: topology.instanceId } },
    })
    expect(siblings).toHaveLength(2)

    // What pointed at a sibling has to survive the cleanup.
    const pinned = await db.project.create({
      data: {
        name: 'Pinned to the old row',
        workspaceId: siblings[0].workspaceId,
        preferredInstanceId: siblings[0].id,
      },
    })
    await db.pushSubscription.create({
      data: {
        instanceId: siblings[1].id,
        userId: topology.ownerUserId,
        pushToken: 'tok-fold',
        platform: 'darwin',
      },
    })

    const beat = await fetch(`${podB(topology)}/api/instances/heartbeat`, {
      method: 'POST',
      headers: {
        // The heartbeat authenticates with the device key itself, not a session.
        'x-api-key': topology.deviceKey,
        'content-type': 'application/json',
        'x-shogo-kind': 'desktop',
      },
      body: JSON.stringify({ hostname: 'mac-fold', name: 'Mac fold', os: 'darwin', arch: 'arm64' }),
    })
    expect(beat.status).toBe(200)
    expect(((await beat.json()) as any).instanceId).toBe(topology.instanceId)

    const remaining = await db.instance.findMany({
      where: { userId: topology.ownerUserId, hostname: 'mac-fold' },
    })
    expect(remaining.map((row: any) => row.id)).toEqual([topology.instanceId])
    expect((await db.project.findUnique({ where: { id: pinned.id } }))?.preferredInstanceId).toBe(
      topology.instanceId,
    )
    const subs = await db.pushSubscription.findMany({ where: { instanceId: topology.instanceId } })
    expect(subs.map((row: any) => row.pushToken)).toEqual(['tok-fold'])

    // And the machine list shows it once, carrying every workspace it was in.
    const machines = await fetch(`${podB(topology)}/api/machines`, {
      headers: authHeaders(topology.ownerUserId),
    })
    expect(machines.status).toBe(200)
    const listed = ((await machines.json()) as any).machines.filter(
      (m: any) => m.hostname === 'mac-fold',
    )
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(topology.instanceId)
  }, 180_000)

  test("a workspace's picker lists the owner's machine wherever its row lives, and another member sees nothing", async () => {
    const topology = await startTopology('owner')

    // The machine's row is filed under the workspace its key was issued in.
    const same = await fetch(
      `${podB(topology)}/api/instances?workspaceId=${topology.deviceWorkspaceId}`,
      { headers: authHeaders(topology.ownerUserId) },
    )
    expect(same.status).toBe(200)
    expect(((await same.json()) as any).instances.map((i: any) => i.id)).toEqual([topology.instanceId])

    // From a workspace the row is *not* filed in, the owner still sees the
    // machine: it belongs to the person, not to the workspace the key came from.
    const elsewhere = await db.workspace.create({
      data: { name: 'Elsewhere', slug: 'elsewhere-owner', kind: 'team' },
    })
    await db.member.create({
      data: { userId: topology.ownerUserId, workspaceId: elsewhere.id, role: 'owner' },
    })
    const fromElsewhere = await fetch(`${podB(topology)}/api/instances?workspaceId=${elsewhere.id}`, {
      headers: authHeaders(topology.ownerUserId),
    })
    expect(fromElsewhere.status).toBe(200)
    expect(((await fromElsewhere.json()) as any).instances.map((i: any) => i.id)).toEqual([
      topology.instanceId,
    ])

    // Another member of that workspace sees no machine of their own — ownership
    // is what scopes this list, not membership.
    const other = await db.user.create({
      data: { name: 'Other', email: 'other-owner@example.com' },
    })
    await db.member.create({ data: { userId: other.id, workspaceId: elsewhere.id, role: 'member' } })
    const theirs = await fetch(`${podB(topology)}/api/instances?workspaceId=${elsewhere.id}`, {
      headers: authHeaders(other.id),
    })
    expect(theirs.status).toBe(200)
    expect(((await theirs.json()) as any).instances).toEqual([])
  }, 180_000)

  test('unpairing the machine deletes its copy', async () => {
    const topology = await startTopology('unpair')
    await waitUntil(async () => db.workspace.findFirst({ where: { id: 'ws-local-unpair' } }))

    const res = await fetch(`${podB(topology)}/api/instances/${topology.instanceId}`, {
      method: 'DELETE',
      headers: authHeaders(topology.ownerUserId),
    })
    expect(res.status).toBe(200)

    expect(await db.workspace.count({ where: { id: 'ws-local-unpair' } })).toBe(0)
    expect(await db.project.findFirst({ where: { id: 'p-local-unpair' } })).toBeNull()
    expect(await db.user.findFirst({ where: { id: 'u-local-unpair' } })).toBeNull()
    expect(await db.instance.findUnique({ where: { id: topology.instanceId } })).toBeNull()
  }, 180_000)
})
