// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The single insert point for `device_version_events`.
 *
 * A version change must append exactly one row per (device, version); the same
 * version seen again only bumps `lastSeenAt`. Everything is normalised here, so
 * a new caller cannot reintroduce the 8 platform spellings.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

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

const { recordDeviceVersionEvent, normalizeDeviceVersion, MAX_DEVICE_VERSION_LENGTH } =
  await import('../device-version-events')

beforeEach(() => {
  store.upserts.length = 0
  shouldThrow = false
})

describe('recordDeviceVersionEvent', () => {
  test('appends one row per (device, version) with normalised OS/arch/client/channel', async () => {
    const seenAt = new Date('2026-10-21T07:00:00.000Z')

    await recordDeviceVersionEvent({
      deviceId: 'device-1',
      version: '2.3.6-beta.20261020t083308',
      platform: 'darwin-arm64',
      seenAt,
    })

    expect(store.upserts).toHaveLength(1)
    expect(store.upserts[0].where).toEqual({
      deviceId_version: { deviceId: 'device-1', version: '2.3.6-beta.20261020t083308' },
    })
    expect(store.upserts[0].create).toMatchObject({
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

  test('a version change appends a new row, a re-sighting only bumps lastSeenAt', async () => {
    const first = new Date('2026-10-19T00:00:00.000Z')
    const second = new Date('2026-10-21T00:00:00.000Z')

    await recordDeviceVersionEvent({ deviceId: 'device-1', version: '2.3.5', platform: 'darwin', seenAt: first })
    await recordDeviceVersionEvent({ deviceId: 'device-1', version: '2.3.6', platform: 'darwin', seenAt: second })
    await recordDeviceVersionEvent({ deviceId: 'device-1', version: '2.3.6', platform: 'darwin', seenAt: second })

    expect(store.upserts).toHaveLength(3)
    expect(store.upserts.map((args) => args.where.deviceId_version.version)).toEqual([
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
