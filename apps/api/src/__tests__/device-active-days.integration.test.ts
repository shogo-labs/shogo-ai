// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-477 section 5 — `device_active_days` against a real database (AC12).
 *
 * The unit tests drive `recordDeviceActiveDay` through a Prisma stub, which
 * cannot show the two things that decide whether the trend line ever leaves
 * "Collecting data":
 *
 *  - the upsert's conflict target (`region_deviceId_day`) has to exist as a
 *    unique constraint in the migrated database, and
 *  - `recordDeviceActiveDay` swallows storage errors, so a wrong column or key
 *    is silent — the row simply never appears.
 *
 * So this file replays the real migrations (desktop SQLite by default, Postgres
 * when `CHANNELS_TEST_PG_URL` is set) and asserts the rows, through all three
 * write paths: the mint, the heartbeat route and the proxy's `resolveApiKey`.
 *
 *   cd apps/api && bun --no-env-file test ./src/__tests__/device-active-days.integration.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor } from './helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { apiKeyRoutes, resolveApiKey } = await import('../routes/api-keys')
const { mintDeviceApiKey, hashApiKey } = await import('../lib/api-keys-mint')
const { recordDeviceActiveDay, utcDayKey } = await import('../lib/device-version-events')

const db = prisma as any

const app = new Hono()
app.route('/api', apiKeyRoutes())

const heartbeat = (key: string) =>
  app.request('/api/api-keys/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  })

const DAY_MS = 24 * 60 * 60 * 1000
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

let workspaceId = ''
let userId = ''

beforeAll(async () => {
  const seeded = await seedWorkspace(db)
  workspaceId = seeded.workspaceId
  userId = seeded.owner
})

const rowsFor = (deviceId: string) =>
  db.deviceActiveDay.findMany({ where: { deviceId }, orderBy: { day: 'asc' } })

const deviceKey = () => `dev-${crypto.randomUUID()}`

describe('device_active_days on a migrated database', () => {
  test('two touches of one device on one UTC day keep one row and bump lastSeenAt', async () => {
    const deviceId = deviceKey()
    const morning = new Date('2026-11-04T08:00:00.000Z')
    const evening = new Date('2026-11-04T19:30:00.000Z')

    expect(
      await recordDeviceActiveDay({
        deviceId,
        version: '1.2.20',
        platform: 'darwin-arm64',
        seenAt: morning,
      }),
    ).toBe(true)

    // Later, same UTC day: the conflict target has to be there for this to land
    // on the existing row instead of throwing (and being swallowed).
    expect(
      await recordDeviceActiveDay({
        deviceId,
        version: '1.2.20',
        platform: 'darwin-arm64',
        seenAt: evening,
      }),
    ).toBe(true)

    const rows = await rowsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].day).toBe('2026-11-04')
    expect(rows[0].region).toBe('local')
    expect(rows[0].os).toBe('macos')
    expect(rows[0].client).toBe('desktop')
    expect(rows[0].version).toBe('1.2.20')
    expect(rows[0].firstSeenAt.getTime()).toBe(morning.getTime())
    expect(rows[0].lastSeenAt.getTime()).toBe(evening.getTime())

    // A new UTC day is a new row, which is what the daily count reads.
    await recordDeviceActiveDay({
      deviceId,
      version: '1.2.20',
      platform: 'darwin-arm64',
      seenAt: new Date('2026-11-05T09:00:00.000Z'),
    })
    expect(await rowsFor(deviceId)).toHaveLength(2)
  })

  test('the mint leaves one row for a fresh device', async () => {
    const deviceId = deviceKey()
    const minted = await mintDeviceApiKey({
      prisma: db,
      workspaceId,
      userId,
      deviceId,
      deviceName: 'Mint box',
      devicePlatform: 'darwin-arm64',
      deviceAppVersion: '1.2.20',
    })
    expect(minted.fullKey.startsWith('shogo_sk_')).toBe(true)

    const rows = await rowsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].day).toBe(utcDayKey(rows[0].lastSeenAt))
    expect(rows[0].client).toBe('desktop')
  })

  test('a heartbeat writes the day row, and only once per day', async () => {
    // Seeded rather than minted: a mint already writes today's row, and the
    // point here is the heartbeat's own write. Yesterday's `lastSeenAt` is what
    // makes `planApiKeyTouch.recordActiveDay` true on the first touch.
    const deviceId = deviceKey()
    const key = `shogo_sk_${crypto.randomUUID().replace(/-/g, '')}`
    await db.apiKey.create({
      data: {
        name: 'Heartbeat box',
        keyHash: await hashApiKey(key),
        keyPrefix: key.slice(0, 12),
        workspaceId,
        userId,
        kind: 'device',
        deviceId,
        deviceName: 'Heartbeat box',
        devicePlatform: 'darwin-arm64',
        deviceAppVersion: '1.2.20',
        lastSeenAt: new Date(Date.now() - DAY_MS),
      },
    })

    const first = await heartbeat(key)
    expect(first.status).toBe(200)
    let rows = await rowsFor(deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].day).toBe(utcDayKey(new Date()))

    // Same day again: the gate skips the write, and the row count holds.
    const second = await heartbeat(key)
    expect(second.status).toBe(200)
    rows = await rowsFor(deviceId)
    expect(rows).toHaveLength(1)
  })

  test('a device-key proxy call writes the day row too, once per day', async () => {
    const deviceId = deviceKey()
    const key = `shogo_sk_${crypto.randomUUID().replace(/-/g, '')}`
    await db.apiKey.create({
      data: {
        name: 'Proxy box',
        keyHash: await hashApiKey(key),
        keyPrefix: key.slice(0, 12),
        workspaceId,
        userId,
        kind: 'device',
        deviceId,
        deviceName: 'Proxy box',
        devicePlatform: 'win32-x64',
        deviceAppVersion: '1.2.20',
        lastSeenAt: new Date(Date.now() - DAY_MS),
      },
    })

    // `resolveApiKey` fires the write without awaiting it, so wait for the row.
    const context = await resolveApiKey(key)
    expect(context?.deviceId).toBe(deviceId)
    const rows = await waitFor(async () => {
      const found = await rowsFor(deviceId)
      return found.length > 0 ? found : null
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].day).toBe(utcDayKey(new Date()))
    expect(rows[0].os).toBe('windows')

    await resolveApiKey(key)
    // Let any stray second write land before counting.
    await new Promise((r) => setTimeout(r, 50))
    expect(await rowsFor(deviceId)).toHaveLength(1)
  })

  test('a version-less touch does not downgrade what the day recorded', async () => {
    const deviceId = deviceKey()
    const at = new Date(`${isoDay(new Date())}T06:00:00.000Z`)

    await recordDeviceActiveDay({
      deviceId,
      version: '1.2.20',
      platform: 'darwin-arm64',
      seenAt: at,
    })
    // A proxy call that carries no version reports `unknown` for both columns.
    await recordDeviceActiveDay({ deviceId, seenAt: new Date(at.getTime() + 60_000) })

    const [row] = await rowsFor(deviceId)
    expect(row.client).toBe('desktop')
    expect(row.os).toBe('macos')
    expect(row.version).toBe('1.2.20')
    expect(row.lastSeenAt.getTime()).toBe(at.getTime() + 60_000)
  })
})
