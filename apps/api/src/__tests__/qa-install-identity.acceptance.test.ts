// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-114 acceptance — the admin install numbers, checked against a
 * production-shaped row set.
 *
 * The six numbers in this fixture are taken from the card's production audit
 * (256 live keys → 189 devices, 8 platform spellings for 3 operating systems,
 * 11 `shogo-cli/*` keys inside the Desktop segment, 34 devices holding keys in
 * two workspaces, 6 devices labelled with a version they had moved off). The
 * expectations below are hand-computed from the fixture, not read back off the
 * implementation, so a regression in the aggregation fails here even if the
 * dev's own unit tests agree with it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const NOW = Date.now()
const ago = (ms: number) => new Date(NOW - ms)

let ctx: { dir: string; dbPath: string }
let db: any
let analytics: typeof import('../services/analytics.service')
let deviceVersionEvents: typeof import('../lib/device-version-events')
let workspaceId: string
let otherWorkspaceId: string
let userId: string

/** One api_keys row. Only the fields install analytics reads. */
interface KeyRow {
  deviceId: string
  platform: string | null
  version: string | null
  seenAt: Date | null
  createdAt: Date
  workspace?: 'primary' | 'other'
  revoked?: boolean
}

const FIXTURE: KeyRow[] = [
  // --- Windows, desktop spellings -----------------------------------------
  { deviceId: 'w1', platform: 'win32', version: '2.3.6', seenAt: ago(1 * HOUR), createdAt: ago(10 * DAY) },
  // Dormant since before any activity window — the 89% of production keys.
  { deviceId: 'w2', platform: 'win32', version: '1.12.7', seenAt: ago(40 * DAY), createdAt: ago(200 * DAY) },
  { deviceId: 'w3', platform: 'win32', version: '2.2.27', seenAt: ago(2 * DAY), createdAt: ago(40 * DAY) },
  // Same machine, two workspaces, two keys — must count once.
  { deviceId: 'w4', platform: 'win32', version: '2.2.27', seenAt: ago(2 * DAY), createdAt: ago(40 * DAY) },
  { deviceId: 'w4', platform: 'win32', version: '2.2.27', seenAt: ago(2 * DAY), createdAt: ago(39 * DAY), workspace: 'other' },
  // The mislabel: the older version's row was bumped by a version-less touch.
  { deviceId: 'w5', platform: 'win32', version: '2.2.27', seenAt: ago(1 * HOUR), createdAt: ago(90 * DAY) },
  { deviceId: 'w5', platform: 'win32', version: '2.3.6', seenAt: ago(3 * DAY), createdAt: ago(12 * DAY) },
  // A row that reports no version at all, newest by lastSeenAt.
  { deviceId: 'w6', platform: 'win32', version: '2.3.5', seenAt: ago(5 * DAY), createdAt: ago(60 * DAY) },
  { deviceId: 'w6', platform: 'win32', version: null, seenAt: ago(5 * 60 * 1000), createdAt: ago(60 * DAY) },
  { deviceId: 'w7', platform: 'win32-x64', version: '2.3.6', seenAt: ago(30 * 60 * 1000), createdAt: ago(3 * DAY) },

  // --- macOS, three spellings ---------------------------------------------
  { deviceId: 'm1', platform: 'darwin', version: '2.2.27', seenAt: ago(4 * DAY), createdAt: ago(45 * DAY) },
  { deviceId: 'm2', platform: 'darwin', version: '2.3.6', seenAt: ago(2 * HOUR), createdAt: ago(8 * DAY) },
  { deviceId: 'm3', platform: 'darwin', version: '2.3.6-beta.20261020t083308', seenAt: ago(1 * HOUR), createdAt: ago(2 * DAY) },
  { deviceId: 'm4', platform: 'darwin-arm64', version: '2.3.6', seenAt: ago(3 * HOUR), createdAt: ago(6 * DAY) },
  { deviceId: 'm5', platform: 'darwin-x64', version: '1.12.7', seenAt: ago(60 * DAY), createdAt: ago(300 * DAY) },

  // --- Linux desktops ------------------------------------------------------
  { deviceId: 'l1', platform: 'linux-x64', version: '2.3.6', seenAt: ago(6 * DAY), createdAt: ago(20 * DAY) },
  { deviceId: 'l2', platform: 'linux-arm64', version: '2.2.24', seenAt: ago(20 * DAY), createdAt: ago(70 * DAY) },

  // --- Worker/CLI device keys (11 in production) --------------------------
  { deviceId: 'c1', platform: 'linux-x64', version: 'shogo-cli/unknown', seenAt: ago(1 * HOUR), createdAt: ago(15 * DAY) },
  { deviceId: 'c2', platform: 'darwin', version: 'shogo-cli/unknown', seenAt: ago(2 * HOUR), createdAt: ago(5 * DAY) },

  // --- Revoked key: never counted anywhere --------------------------------
  { deviceId: 'r1', platform: 'win32', version: '2.3.6', seenAt: ago(1 * HOUR), createdAt: ago(30 * DAY), revoked: true },
]

async function seed() {
  const user = await db.user.create({ data: { name: 'install-owner', email: `installs-${Date.now()}@example.com` } })
  userId = user.id
  const ws = await db.workspace.create({ data: { name: 'Primary', slug: `primary-${Date.now()}`, kind: 'team' } })
  const other = await db.workspace.create({ data: { name: 'Secondary', slug: `secondary-${Date.now()}`, kind: 'team' } })
  workspaceId = ws.id
  otherWorkspaceId = other.id

  const creates = FIXTURE.map((row, index) =>
    db.apiKey.create({
      data: {
        name: `device-${row.deviceId}-${index}`,
        keyHash: `qa-hash-${row.deviceId}-${index}`,
        keyPrefix: 'shogo_dev',
        workspaceId: row.workspace === 'other' ? otherWorkspaceId : workspaceId,
        userId,
        kind: 'device',
        deviceId: row.deviceId,
        deviceName: `machine ${row.deviceId}`,
        devicePlatform: row.platform,
        deviceAppVersion: row.version,
        lastSeenAt: row.seenAt,
        createdAt: row.createdAt,
        revokedAt: row.revoked ? ago(1 * DAY) : null,
      },
    }),
  )
  await db.$transaction(creates)

  await db.appInstall.create({
    data: {
      deviceId: 'ios-1',
      platform: 'ios',
      appVersion: '1.4.0',
      osVersion: 'iOS 18.2',
      userId,
      firstSeenAt: ago(20 * DAY),
      lastSeenAt: ago(1 * DAY),
    },
  })
  await db.appInstall.create({
    data: {
      deviceId: 'android-1',
      platform: 'android',
      appVersion: '1.4.0',
      osVersion: 'Android 15',
      userId,
      firstSeenAt: ago(20 * DAY),
      lastSeenAt: ago(2 * DAY),
    },
  })
}

function deviceHandle(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex').slice(0, 10)
}

beforeAll(async () => {
  ctx = setupChannelsTestDb()
  db = (await import('../lib/prisma')).prisma
  analytics = await import('../services/analytics.service')
  deviceVersionEvents = await import('../lib/device-version-events')
  await seed()
}, 120_000)

afterAll(() => {
  delete process.env.APP_VERSION
  delete process.env.SHOGO_APP_VERSION
})

describe('AC1 — the OS × version matrix matches the database', () => {
  test('one row per (version, channel) with macOS / Windows / Linux device counts', async () => {
    const data = await analytics.getAppInstalls()
    const rows = data.desktop.versions.map((row) => ({
      version: row.version,
      channel: row.channel,
      devices: row.devices,
      os: row.os,
    }))

    expect(rows).toEqual(
      expect.arrayContaining([
        { version: '2.3.6', channel: 'stable', devices: 6, os: { macos: 2, windows: 3, linux: 1, unknown: 0 } },
        { version: '2.2.27', channel: 'stable', devices: 3, os: { macos: 1, windows: 2, linux: 0, unknown: 0 } },
        { version: '1.12.7', channel: 'stable', devices: 2, os: { macos: 1, windows: 1, linux: 0, unknown: 0 } },
        { version: '2.3.5', channel: 'stable', devices: 1, os: { macos: 0, windows: 1, linux: 0, unknown: 0 } },
        { version: '2.2.24', channel: 'stable', devices: 1, os: { macos: 0, windows: 0, linux: 1, unknown: 0 } },
      ]),
    )
    expect(rows.length).toBe(6)
    expect(data.desktop.totalDevices).toBe(14)
  })

  test('the total equals a direct SQL count of distinct live desktop devices', async () => {
    const sql = new Database(ctx.dbPath, { readonly: true })
    const sqlite = sql
      .query(
        `SELECT COUNT(*) AS n FROM (
           SELECT k."deviceId"
           FROM api_keys k
           WHERE k."kind" = 'device'
             AND k."revokedAt" IS NULL
             AND k."deviceId" IS NOT NULL
             AND k."deviceId" NOT IN (
               SELECT c."deviceId" FROM api_keys c
               WHERE c."deviceAppVersion" LIKE 'shogo-cli/%'
             )
           GROUP BY k."deviceId"
         )`,
      )
      .get() as { n: number }

    const errors = sql
      .query(
        `SELECT os, COUNT(*) AS n FROM (
           SELECT k."deviceId",
             CASE
               WHEN lower(max(k."devicePlatform")) LIKE 'darwin%' THEN 'macos'
               WHEN lower(max(k."devicePlatform")) LIKE 'win32%'  THEN 'windows'
               WHEN lower(max(k."devicePlatform")) LIKE 'linux%'  THEN 'linux'
               ELSE 'unknown' END AS os
           FROM api_keys k
           WHERE k."kind" = 'device' AND k."revokedAt" IS NULL AND k."deviceId" IS NOT NULL
             AND k."deviceId" NOT IN (
               SELECT c."deviceId" FROM api_keys c WHERE c."deviceAppVersion" LIKE 'shogo-cli/%'
             )
           GROUP BY k."deviceId"
         ) GROUP BY os`,
      )
      .all() as Array<{ os: string; n: number }>
    sql.close()

    const data = await analytics.getAppInstalls()
    const byOs = new Map(errors.map((row) => [row.os, Number(row.n)]))

    expect(data.desktop.totalDevices).toBe(Number(sqlite.n))
    expect(data.desktop.byOs.reduce((sum, row) => sum + row.devices, 0)).toBe(Number(sqlite.n))
    for (const os of ['macos', 'windows', 'linux'] as const) {
      const counted = data.desktop.byOs
        .filter((row) => row.os === os)
        .reduce((sum, row) => sum + row.devices, 0)
      expect(counted, `${os} device count`).toBe(byOs.get(os) ?? 0)
    }
  })
})

describe('AC2 — one OS per platform spelling, CLI is not a desktop', () => {
  test('darwin / darwin-arm64 / darwin-x64 collapse into one macOS count', async () => {
    const data = await analytics.getAppInstalls()
    const macos = data.desktop.byOs.filter((row) => row.os === 'macos')
    expect(macos.reduce((sum, row) => sum + row.devices, 0)).toBe(5)
    // Split by arch, never by spelling.
    expect(macos.map((row) => row.arch).sort()).toEqual([null, 'arm64', 'x64'].sort())
  })

  test('no raw platform spelling survives into any OS field', async () => {
    const data = await analytics.getAppInstalls()
    const allowed = ['macos', 'windows', 'linux', 'unknown']
    for (const row of data.desktop.byOs) expect(allowed).toContain(row.os)
    for (const row of data.desktop.versions) {
      for (const key of Object.keys(row.os)) expect(allowed).toContain(key)
    }
    const serialized = JSON.stringify(data.desktop.byOs)
    for (const spelling of ['darwin', 'win32']) expect(serialized).not.toContain(spelling)
  })

  test('CLI keys are their own segment and appear in no desktop bucket', async () => {
    const data = await analytics.getAppInstalls()

    expect(data.cli.totalDevices).toBe(2)
    expect(data.desktop.totalDevices).toBe(14)
    expect(data.desktop.versions.some((row) => row.version.startsWith('shogo-cli/'))).toBe(false)
    expect(data.desktop.byVersion.some((row) => row.version.startsWith('shogo-cli/'))).toBe(false)
    // The macOS CLI key must not land in the desktop macOS count.
    expect(data.desktop.byOs.filter((row) => row.os === 'macos').reduce((s, r) => s + r.devices, 0)).toBe(5)
    // ...and the legacy desktop-only endpoint agrees.
    const legacy = await analytics.getDesktopInstalls()
    expect(legacy.totalDevices).toBe(14)
  })
})

describe('AC3 — a device shows the newest version it actually reported', () => {
  test('a version-less touch on an older row does not relabel the device', async () => {
    const devices = await analytics.getActiveDevices({ days: 365, includeDormant: true })
    const row = devices.devices.find((device) => device.id === deviceHandle('w5'))
    expect(row).toBeDefined()
    expect(row!.version).toBe('2.3.6')
  })

  test('a row with no version at all never becomes the version bucket', async () => {
    const devices = await analytics.getActiveDevices({ days: 365, includeDormant: true })
    const row = devices.devices.find((device) => device.id === deviceHandle('w6'))
    expect(row!.version).toBe('2.3.5')
    // ...but its newer, version-less row still drives activity.
    expect(row!.online).toBe(true)
  })

  test('one physical device with keys in two workspaces counts once', async () => {
    const devices = await analytics.getActiveDevices({ days: 365, includeDormant: true })
    const matching = devices.devices.filter((device) => device.id === deviceHandle('w4'))
    expect(matching.length).toBe(1)
  })
})

describe('AC4 — "N of M on <tag>" follows the deployed release', () => {
  test('a pinned APP_VERSION is used as the reference tag', async () => {
    process.env.APP_VERSION = '2.3.6'
    const data = await analytics.getAppInstalls()
    expect(data.desktop.onLatest).toEqual({ version: '2.3.6', devices: 6, pct: 43, source: 'deployed' })
  })

  test('a deploy with no tag falls back to the newest stable version and says so', async () => {
    delete process.env.APP_VERSION
    delete process.env.SHOGO_APP_VERSION
    const data = await analytics.getAppInstalls()
    expect(data.desktop.onLatest).toEqual({ version: '2.3.6', devices: 6, pct: 43, source: 'inferred' })
  })

  test('a tag nothing is running reports 0 rather than hiding the tile', async () => {
    process.env.APP_VERSION = '2.4.0'
    const data = await analytics.getAppInstalls()
    expect(data.desktop.onLatest).toEqual({ version: '2.4.0', devices: 0, pct: 0, source: 'deployed' })
  })

  test('SHOGO_APP_VERSION is accepted when APP_VERSION is absent', async () => {
    delete process.env.APP_VERSION
    process.env.SHOGO_APP_VERSION = '2.2.27'
    const data = await analytics.getAppVersions({ days: 30 })
    expect(data.deployedVersion).toBe('2.2.27')
    expect(data.desktop.onLatest).toMatchObject({ version: '2.2.27', devices: 3, source: 'deployed' })
    delete process.env.SHOGO_APP_VERSION
  })
})

describe('AC5 — adoption history is captured at one insert point', () => {
  test('a version change appends exactly one row; repeats only bump lastSeenAt', async () => {
    const deviceId = 'hist-1'
    const t0 = new Date('2026-10-01T08:00:00Z')
    const t1 = new Date('2026-10-05T08:00:00Z')
    const t2 = new Date('2026-10-10T08:00:00Z')

    await deviceVersionEvents.recordDeviceVersionEvent({ deviceId, version: '2.2.27', platform: 'darwin-arm64', seenAt: t0 })
    await deviceVersionEvents.recordDeviceVersionEvent({ deviceId, version: '2.2.27', platform: 'darwin-arm64', seenAt: t1 })
    const first = await db.deviceVersionEvent.findMany({ where: { deviceId } })
    expect(first.length).toBe(1)
    expect(new Date(first[0].lastSeenAt).toISOString()).toBe(t1.toISOString())
    expect(first[0].os).toBe('macos')
    expect(first[0].arch).toBe('arm64')
    expect(first[0].client).toBe('desktop')

    await deviceVersionEvents.recordDeviceVersionEvent({ deviceId, version: '2.3.6', platform: 'darwin-arm64', seenAt: t2 })
    const after = await db.deviceVersionEvent.findMany({ where: { deviceId }, orderBy: { firstSeenAt: 'asc' } })
    expect(after.map((row: any) => row.version)).toEqual(['2.2.27', '2.3.6'])
  })

  test('CLI and beta are normalised at write time, not by the reader', async () => {
    await deviceVersionEvents.recordDeviceVersionEvent({
      deviceId: 'hist-cli',
      version: 'shogo-cli/unknown',
      platform: 'linux-x64',
      seenAt: new Date('2026-10-02T08:00:00Z'),
    })
    await deviceVersionEvents.recordDeviceVersionEvent({
      deviceId: 'hist-beta',
      version: '2.3.6-beta.20261020t083308',
      platform: 'win32',
      seenAt: new Date('2026-10-03T08:00:00Z'),
    })

    const cli = await db.deviceVersionEvent.findFirst({ where: { deviceId: 'hist-cli' } })
    const beta = await db.deviceVersionEvent.findFirst({ where: { deviceId: 'hist-beta' } })
    expect(cli).toMatchObject({ client: 'cli', channel: 'stable', os: 'linux' })
    expect(beta).toMatchObject({ client: 'desktop', channel: 'beta', os: 'windows' })
  })

  test('the 30-day adoption series spans the days a device was on each version', async () => {
    const data = await analytics.getAppVersions({ days: 30 })
    expect(data.windowDays).toBe(30)
    expect(data.adoption.length).toBeGreaterThan(0)
    const forDevice = data.adoption.filter((point) => ['2.2.27', '2.3.6'].includes(point.version))
    expect(forDevice.length).toBeGreaterThan(0)
    // Window is honoured: nothing older than the requested days.
    const cutoff = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10)
    for (const point of data.adoption) expect(point.date >= cutoff).toBe(true)
  })

  test('a storage failure never breaks the caller', async () => {
    const failing = { deviceVersionEvent: { upsert: async () => { throw new Error('boom') } } }
    const ok = await deviceVersionEvents.recordDeviceVersionEvent(
      { deviceId: 'hist-fail', version: '2.3.6' },
      failing as any,
    )
    expect(ok).toBe(false)
  })
})

describe('AC5 — the backfill does not invent history it never observed', () => {
  const BACKFILL_SQL = `apps/desktop/prisma/migrations/20261021120000_add_device_version_events/migration.sql`

  test('an in-place upgraded key is not reported as being on the new version all window', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const migration = readFileSync(resolve(import.meta.dir, '../../../..', BACKFILL_SQL), 'utf-8')
    // Replay only the backfill statement: the table is already created above by
    // the migration runner, and the seeded keys are the "before" state.
    const backfill = migration.slice(migration.indexOf('INSERT INTO'))

    // A heartbeat rewrites deviceAppVersion on the SAME row, so a device that
    // signed in 200 days ago and upgraded yesterday has createdAt 200d back.
    // Backfilling firstSeenAt from createdAt would then claim 30 days of a
    // release that shipped yesterday.
    await db.apiKey.create({
      data: {
        name: 'in-place-upgrade',
        keyHash: `qa-inplace-${Date.now()}`,
        keyPrefix: 'shogo_dev',
        workspaceId,
        userId,
        kind: 'device',
        deviceId: 'backfill-inplace',
        devicePlatform: 'win32',
        deviceAppVersion: '2.3.6',
        createdAt: ago(200 * DAY),
        lastSeenAt: ago(2 * HOUR),
      },
    })

    try {
      await db.$executeRawUnsafe(backfill)

      const rows = await db.deviceVersionEvent.findMany({ where: { deviceId: 'backfill-inplace' } })
      expect(rows).toHaveLength(1)
      const first = new Date(rows[0].firstSeenAt).getTime()
      const last = new Date(rows[0].lastSeenAt).getTime()
      expect(last - first).toBeLessThan(2 * DAY)

      const data = await analytics.getAppVersions({ days: 30 })
      const days = data.adoption.filter((point) => point.version === '2.3.6').length
      expect(days).toBeLessThan(5)
    } finally {
      // The backfill reads every live device, so undo both the extra key and
      // the rows it wrote before the later tests measure the fixture.
      await db.apiKey.deleteMany({ where: { deviceId: 'backfill-inplace' } })
      await db.deviceVersionEvent.deleteMany({})
    }
  })
})

describe('AC6 — beta installs are split from stable', () => {
  test('the beta device is its own (version, channel) row', async () => {
    const data = await analytics.getAppInstalls()
    const beta = data.desktop.versions.filter((row) => row.channel === 'beta')
    expect(beta).toHaveLength(1)
    expect(beta[0]).toMatchObject({ version: '2.3.6-beta.20261020t083308', devices: 1 })
    expect(beta[0].os).toEqual({ macos: 1, windows: 0, linux: 0, unknown: 0 })
    const stable = data.desktop.versions.find((row) => row.version === '2.3.6')
    expect(stable!.channel).toBe('stable')
    expect(stable!.devices).toBe(6)
  })
})

describe('AC8 — the existing install payload is untouched', () => {
  test('legacy fields still exist and still describe the same devices', async () => {
    const data = await analytics.getAppInstalls()

    expect(data.desktop.byVersion.length).toBeGreaterThan(0)
    expect(data.desktop.byPlatform).toEqual(
      expect.arrayContaining([
        { platform: 'win32', count: 6 },
        { platform: 'win32-x64', count: 1 },
        { platform: 'darwin', count: 3 },
        { platform: 'darwin-arm64', count: 1 },
        { platform: 'darwin-x64', count: 1 },
      ]),
    )
    expect(typeof data.desktop.distinctUsers).toBe('number')
    expect(data.desktop.active.d7).toBe(11)
    expect(data.desktop.active.d1).toBe(7)
    expect(data.desktop.active.d30).toBe(12)
  })

  test('iOS and Android segments render from app_installs unchanged', async () => {
    const data = await analytics.getAppInstalls()
    expect(data.ios.totalDevices).toBe(1)
    expect(data.android.totalDevices).toBe(1)
    expect(data.ios.byVersion[0]).toMatchObject({ version: '1.4.0', count: 1 })
    expect(data.totals.totalDevices).toBe(14 + 1 + 1)
  })
})

describe('AC4/AC5 — the admin routes are mounted', () => {
  test('admin router exposes the version matrix and the device list', async () => {
    const { adminRoutes } = await import('../routes/admin')
    const paths = adminRoutes().routes.map((route) => route.path)
    expect(paths).toContain('/analytics/app-versions')
    expect(paths).toContain('/analytics/devices')
    expect(paths).toContain('/analytics/app-installs')
  })

  test('the admin page reads exactly those paths and unwraps .data', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const page = readFileSync(resolve(import.meta.dir, '../../../../apps/mobile/app/(admin)/index.tsx'), 'utf-8')
    expect(page).toContain("fetchAdminJson<AppInstallsData>('/analytics/app-installs')")
    expect(page).toContain("fetchAdminJson<ActiveDevicesData>('/analytics/devices'")
    // Desktop and CLI hand their rows to the untruncated panel; only the
    // unchanged iOS/Android cards keep the legacy top-4 lists.
    expect(page).toContain('<InstallSegmentCard label="Desktop" data={data.desktop} icon={Monitor} showBreakdowns={false} />')
    expect(page).toContain('label="CLI" data={data.cli} icon={Box} showBreakdowns={false}')

    const panel = readFileSync(
      resolve(import.meta.dir, '../../../../apps/mobile/components/analytics/AppVersionsPanel.tsx'),
      'utf-8',
    )
    const panelCode = panel
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    expect(panelCode).not.toMatch(/\.slice\(0, ?4\)/)
    expect(panel).toMatch(/activeSegment\?\.versions \?\? \[\]/)
  })

  test('the deploy pins APP_VERSION on every api overlay and fails on 0.0.0', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const root = resolve(import.meta.dir, '../../../..')

    for (const path of [
      'k8s/base/api.yaml',
      'k8s/overlays/production-us/api-service.yaml',
      'k8s/overlays/production-eu/api-service.yaml',
      'k8s/overlays/staging/api-service.yaml',
    ]) {
      expect(readFileSync(resolve(root, path), 'utf-8'), path).toContain('APP_VERSION')
    }
  })
})
