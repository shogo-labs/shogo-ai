// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one insert point for per-device version history.
 *
 * Every surface that reports a device version funnels here: the desktop
 * heartbeat (`POST /api-keys/heartbeat`), the opportunistic refresh inside
 * `resolveApiKey` (ai-proxy header, local-auth forwarder), and the device mint.
 * A new caller records history by reusing the touch that already exists — it
 * must not re-implement the normalisation or write `device_version_events`
 * itself.
 */

import { prisma } from './prisma'
import { parseChannel, parseClient, parseDevicePlatform } from './device-platform'

export interface DeviceVersionTouch {
  deviceId: string | null | undefined
  version: string | null | undefined
  platform?: string | null
  /** Defaults to now; the touch that refreshed `lastSeenAt` passes its own. */
  seenAt?: Date
}

/** Versions are stored as the desktop/CLI report them; 32 chars fits both. */
export const MAX_DEVICE_VERSION_LENGTH = 32

export function normalizeDeviceVersion(version: string | null | undefined): string | null {
  const value = version?.trim()
  if (!value) return null
  return value.slice(0, MAX_DEVICE_VERSION_LENGTH)
}

/**
 * Minimal surface of the prisma client this module needs. Callers that already
 * hold a client (the device mint) pass theirs so the write lands in the same
 * place as the rest of their work.
 */
export interface DeviceVersionEventClient {
  deviceVersionEvent: {
    upsert: (args: any) => Promise<unknown>
  }
}

/**
 * Upsert the (deviceId, version) row: insert on a version change, bump
 * `lastSeenAt` on every later sighting. Analytics must never break auth, so a
 * storage failure is swallowed after being reported to the caller.
 */
export async function recordDeviceVersionEvent(
  touch: DeviceVersionTouch,
  client: DeviceVersionEventClient = prisma as unknown as DeviceVersionEventClient,
): Promise<boolean> {
  const deviceId = touch.deviceId?.trim()
  const version = normalizeDeviceVersion(touch.version)
  if (!deviceId || !version) return false

  const { os, arch } = parseDevicePlatform(touch.platform)
  const deviceClient = parseClient(version, touch.platform)
  const channel = parseChannel(version)
  const seenAt = touch.seenAt ?? new Date()

  try {
    await client.deviceVersionEvent.upsert({
      where: { deviceId_version: { deviceId, version } },
      create: { deviceId, version, os, arch, client: deviceClient, channel, firstSeenAt: seenAt, lastSeenAt: seenAt },
      update: { os, arch, client: deviceClient, channel, lastSeenAt: seenAt },
    })
    return true
  } catch (error) {
    console.warn('[device-version] failed to record version event:', error)
    return false
  }
}
