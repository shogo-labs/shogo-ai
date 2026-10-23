// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The single insert point for `device_version_events`.
 *
 * A version change must append exactly one row per (region, device, version);
 * the same version seen again only bumps `lastSeenAt`. Everything is normalised
 * here, so a new caller cannot reintroduce the 8 platform spellings.
 *
 * `region` is part of the key (SHO-142): two regions must be able to hold their
 * own tag for one (device, version) without the peer's apply colliding, and the
 * row must never carry an id derived from its content.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Set before the module graph loads `./region`, which snapshots REGION_ID.
process.env.REGION_ID = 'us-ashburn-1'

const store: { upserts: any[] } = { upserts: [] }
let shouldThrow = false

mock.module('../prisma', () => ({
  prisma: {
    deviceVersionEvent: {
      upsert: mock(async (args: any) => {
        if (shouldThrow) throw new Error('db down')
        store.upserts.push(args)
        return { id: 'dve-1', ...args.create }
      }),
    },
  },
}))

const { recordDeviceVersionEvent, normalizeDeviceVersion, resolveWritingRegion, MAX_DEVICE_VERSION_LENGTH } =
  await import('../device-version-events')
const { RAW_REGION_ID } = await import('../region')

/** Whatever this process resolved at load — `local` when REGION_ID is unset. */
const REGION = resolveWritingRegion(RAW_REGION_ID)

beforeEach(() => {
  store.upserts.length = 0
  shouldThrow = false
})

describe('recordDeviceVersionEvent', () => {
  test('appends one row per (region, device, version) with normalised OS/arch/client/channel', async () => {
    const seenAt = new Date('2026-10-21T07:00:00.000Z')

    await recordDeviceVersionEvent({
      deviceId: 'device-1',
      version: '2.3.6-beta.20261020t083308',
      platform: 'darwin-arm64',
      seenAt,
    })

    expect(store.upserts).toHaveLength(1)
    expect(store.upserts[0].where).toEqual({
      region_deviceId_version: { region: REGION, deviceId: 'device-1', version: '2.3.6-beta.20261020t083308' },
    })
    expect(store.upserts[0].create).toMatchObject({
      region: REGION,
      deviceId: 'device-1',
      version: '2.3.6-beta.20261020t083308',
      os: 'macos',
      arch: 'arm64',
      client: 'desktop',
      channel: 'beta',
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    })
  })

  test('writes the region from REGION_ID, and `local` when there is none', () => {
    expect(resolveWritingRegion('us-ashburn-1')).toBe('us-ashburn-1')
    expect(resolveWritingRegion('eu-frankfurt-1')).toBe('eu-frankfurt-1')
    // Single-region and desktop mode: a real value, never NULL (NULL is the
    // pre-region marker and would make the row invisible to the upsert key).
    expect(resolveWritingRegion(null)).toBe('local')
  })

  test('never passes an id — the column default owns it', async () => {
    await recordDeviceVersionEvent({ deviceId: 'device-1', version: '2.3.6' })
    const args = store.upserts[0]
    expect(args.create.id).toBeUndefined()
    expect(args.update.id).toBeUndefined()
    expect(Object.keys(args.create)).not.toContain('id')
    expect(Object.keys(args.update)).not.toContain('id')
  })

  test('region is part of the lookup key and never rewritten by the update half', async () => {
    await recordDeviceVersionEvent({ deviceId: 'device-1', version: '2.3.6' })
    const args = store.upserts[0]
    expect(Object.keys(args.where)).toEqual(['region_deviceId_version'])
    expect(args.where.region_deviceId_version.region).toBe(REGION)
    expect(args.update.region).toBeUndefined()
  })

  test('a version change appends a new row, a re-sighting only bumps lastSeenAt', async () => {
    const first = new Date('2026-10-19T00:00:00.000Z')
    const second = new Date('2026-10-21T00:00:00.000Z')

    await recordDeviceVersionEvent({ deviceId: 'device-1', version: '2.3.5', platform: 'darwin', seenAt: first })
    await recordDeviceVersionEvent({ deviceId: 'device-1', version: '2.3.6', platform: 'darwin', seenAt: second })
    await recordDeviceVersionEvent({ deviceId: 'device-1', version: '2.3.6', platform: 'darwin', seenAt: second })

    expect(store.upserts).toHaveLength(3)
    expect(store.upserts.map((args) => args.where.region_deviceId_version.version)).toEqual([
      '2.3.5',
      '2.3.6',
      '2.3.6',
    ])
    // Only the update half moves on a re-sighting — firstSeenAt is never rewritten.
    expect(store.upserts[2].update).toEqual({
      os: 'macos',
      arch: null,
      client: 'desktop',
      channel: 'stable',
      lastSeenAt: second,
    })
    expect(store.upserts[2].update.firstSeenAt).toBeUndefined()
  })

  test('CLI device keys are stored as their own client', async () => {
    await recordDeviceVersionEvent({
      deviceId: 'cli-1',
      version: 'shogo-cli/unknown',
      platform: 'linux-x64',
    })
    expect(store.upserts[0].create).toMatchObject({ client: 'cli', os: 'linux', arch: 'x64' })
  })

  test('ignores a touch with no device or no version', async () => {
    expect(await recordDeviceVersionEvent({ deviceId: null, version: '2.3.6' })).toBe(false)
    expect(await recordDeviceVersionEvent({ deviceId: 'device-1', version: '' })).toBe(false)
    expect(await recordDeviceVersionEvent({ deviceId: 'device-1', version: '   ' })).toBe(false)
    expect(store.upserts).toHaveLength(0)
  })

  test('never breaks auth when the write fails', async () => {
    shouldThrow = true
    expect(await recordDeviceVersionEvent({ deviceId: 'device-1', version: '2.3.6' })).toBe(false)
  })
})

describe('normalizeDeviceVersion', () => {
  test('trims and clamps to the column width', () => {
    expect(normalizeDeviceVersion('  2.3.6  ')).toBe('2.3.6')
    expect(normalizeDeviceVersion(null)).toBeNull()
    expect(normalizeDeviceVersion('9'.repeat(80))?.length).toBe(MAX_DEVICE_VERSION_LENGTH)
  })
})
