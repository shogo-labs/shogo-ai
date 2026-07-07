// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * DB-backed identity/ops metadata for bare-metal fleet hosts.
 *
 * The committed baseline (config/metal-fleet.ts) declares the DESIRED fleet
 * shape (hostId, region, site, billing, role) — non-sensitive and safe to keep
 * in a public repo. Provider-specific, sensitive, or operationally-mutable
 * details (the Latitude `serverId`, the box's `publicIp`, an enable/disable
 * flag, free-form notes) live HERE, in the database, so they never land in
 * source control and can be managed by a super-admin at runtime.
 *
 * Stored as a single JSON array under the `metal.fleet.hosts` PlatformSetting
 * key (same pattern as the DB model catalog / provider keys) — no dedicated
 * table/migration required. The live IP a host actually serves on always comes
 * from its heartbeat; `publicIp` here is just the recorded/informational value
 * the super-admin sees for provider ops.
 */

import { prisma } from './prisma'

export const METAL_FLEET_HOSTS_KEY = 'metal.fleet.hosts'

export interface MetalHostRecord {
  /** Stable host id the node-agent registers with (METAL_HOST_ID). */
  hostId: string
  region?: string
  site?: string
  /** Provider server id (Latitude sv_...). Sensitive — DB only. */
  serverId?: string | null
  /** Recorded public IP (informational). Sensitive — DB only. */
  publicIp?: string | null
  billing?: 'monthly' | 'hourly'
  role?: string
  /** Super-admin toggle; false = do not treat as an expected baseline host. */
  enabled?: boolean
  provider?: string
  notes?: string
  updatedAt?: string
}

/** Editable fields a super-admin may set on a host record. */
const EDITABLE: (keyof MetalHostRecord)[] = [
  'region', 'site', 'serverId', 'publicIp', 'billing', 'role', 'enabled', 'provider', 'notes',
]

export async function getMetalHostRecords(): Promise<MetalHostRecord[]> {
  try {
    const row = (await prisma.platformSetting.findUnique({
      where: { key: METAL_FLEET_HOSTS_KEY },
    })) as { value: string } | null
    if (!row?.value) return []
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed) ? (parsed as MetalHostRecord[]) : []
  } catch {
    return []
  }
}

export async function getMetalHostRecordMap(): Promise<Map<string, MetalHostRecord>> {
  const recs = await getMetalHostRecords()
  return new Map(recs.map((r) => [r.hostId, r]))
}

async function writeRecords(records: MetalHostRecord[], updatedBy?: string | null): Promise<void> {
  const value = JSON.stringify(records)
  await prisma.platformSetting.upsert({
    where: { key: METAL_FLEET_HOSTS_KEY },
    update: { value, updatedBy: updatedBy ?? null },
    create: { key: METAL_FLEET_HOSTS_KEY, value, updatedBy: updatedBy ?? null },
  })
}

/** Insert or merge a host record by hostId; returns the full updated list. */
export async function upsertMetalHostRecord(
  input: MetalHostRecord,
  updatedBy?: string | null,
): Promise<MetalHostRecord[]> {
  if (!input.hostId) throw new Error('hostId required')
  const recs = await getMetalHostRecords()
  const patch: MetalHostRecord = { hostId: input.hostId }
  for (const k of EDITABLE) {
    if (input[k] !== undefined) (patch as any)[k] = input[k]
  }
  patch.updatedAt = new Date().toISOString()
  const idx = recs.findIndex((r) => r.hostId === input.hostId)
  if (idx >= 0) recs[idx] = { ...recs[idx], ...patch }
  else recs.push(patch)
  await writeRecords(recs, updatedBy)
  return recs
}

/** Remove a host record by hostId; returns the full updated list. */
export async function deleteMetalHostRecord(
  hostId: string,
  updatedBy?: string | null,
): Promise<MetalHostRecord[]> {
  const recs = (await getMetalHostRecords()).filter((r) => r.hostId !== hostId)
  await writeRecords(recs, updatedBy)
  return recs
}
