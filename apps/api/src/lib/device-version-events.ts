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
 *
 * Ids are never derived from row content: every row relies on the model's
 * `@default(cuid())` and nothing here passes `id`. A key computed from
 * replicated data is identical in every region by construction, which is what
 * took US -> EU replication down on 2026-10-22 — see the RUNBOOK section
 * «Multi-region migration rules».
 */

import { prisma } from './prisma'
import { parseChannel, parseClient, parseDevicePlatform } from './device-platform'
import { RAW_REGION_ID } from './region'

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

/** The columns of a history row the read model needs. */
export interface DeviceVersionEventRow {
  deviceId: string
  version: string
  firstSeenAt: Date
  lastSeenAt: Date
}

/** The version a device last reported. */
export type DeviceVersionObservation = DeviceVersionEventRow

/**
 * Reduce version history to the version each device is on *now*: the row with
 * the newest `lastSeenAt`, i.e. the last version the device actually reported.
 *
 * Newest sighting beats highest semver on purpose (SHO-126). `api_keys` only
 * keeps the current row and its `lastSeenAt` is bumped by touches that carry no
 * version, which is why the aggregates used to prefer the highest version ever
 * seen — and why a device that moved *down* (a rollback, a beta opt-out, a
 * re-pinned install) kept its higher label forever. A history row is only
 * written by a caller that carried a version, so the newest one is the truth.
 * `firstSeenAt` breaks a tie (a backfilled 2.3.6 -> 2.2.27 pair shares a
 * `lastSeenAt`) in favour of the version seen later.
 */
export function newestVersionPerDevice(
  rows: DeviceVersionEventRow[],
): Map<string, DeviceVersionObservation> {
  const current = new Map<string, DeviceVersionObservation>()
  for (const row of rows) {
    const deviceId = row.deviceId?.trim()
    if (!deviceId) continue
    const seen = current.get(deviceId)
    if (seen && !isLaterObservation(row, seen)) continue
    current.set(deviceId, {
      deviceId,
      version: row.version,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    })
  }
  return current
}

function isLaterObservation(candidate: DeviceVersionEventRow, current: DeviceVersionEventRow): boolean {
  const seen = candidate.lastSeenAt.getTime() - current.lastSeenAt.getTime()
  if (seen !== 0) return seen > 0
  return candidate.firstSeenAt.getTime() > current.firstSeenAt.getTime()
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
 * The `region` stamped on a row this build writes.
 *
 * `RAW_REGION_ID` is null in single-region and desktop mode, where the row is
 * still region-scoped — `local` is a real value, so the key never contains a
 * NULL the database would treat as distinct. Pre-region rows keep NULL on
 * purpose (see the migration header); this function never returns it.
 */
export function resolveWritingRegion(rawRegionId: string | null): string {
  return rawRegionId ?? 'local'
}

/**
 * Upsert one row per (region, deviceId, version): insert on a version change,
 * bump `lastSeenAt` on every later sighting. `region` is part of the lookup
 * key and is never in `update` — a device that already has a pre-region row
 * gets a second, tagged row rather than rewriting history.
 *
 * Analytics must never break auth, so a storage failure is swallowed after
 * being reported to the caller.
 */
export async function recordDeviceVersionEvent(
  touch: DeviceVersionTouch,
  client: DeviceVersionEventClient = prisma as unknown as DeviceVersionEventClient,
): Promise<boolean> {
  const deviceId = touch.deviceId?.trim()
  const version = normalizeDeviceVersion(touch.version)
  if (!deviceId || !version) return false

  const region = resolveWritingRegion(RAW_REGION_ID)
  const { os, arch } = parseDevicePlatform(touch.platform)
  const deviceClient = parseClient(version, touch.platform)
  const channel = parseChannel(version)
  const seenAt = touch.seenAt ?? new Date()

  try {
    await client.deviceVersionEvent.upsert({
      where: { region_deviceId_version: { region, deviceId, version } },
      create: {
        region,
        deviceId,
        version,
        os,
        arch,
        client: deviceClient,
        channel,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      },
      update: { os, arch, client: deviceClient, channel, lastSeenAt: seenAt },
    })
    return true
  } catch (error) {
    console.warn('[device-version] failed to record version event:', error)
    return false
  }
}
