// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One machine, one `instances` row — whatever its hostname says (SHO-276).
 *
 * Instance identity used to be `(workspaceId, userId, hostname)`. macOS renames
 * its host per network — `Russells-MacBook-Pro-2.local` became
 * `unknown2e36ea9404bb.attlocal.net` on the AT&T router — so one Mac registered
 * a *second* row, and every push from it was refused `409 mirror_ownership`
 * because its workspace rows belonged to the first. The cloud copy of that
 * workspace froze for two days.
 *
 * The desktop already has a stable id (`~/.shogo/device-id`, sent as
 * `x-shogo-device-id` and carried in the heartbeat's `metadata.machine.id`).
 * Resolution is therefore:
 *
 *   1. device id → that row, with `hostname`/`name` updated in place;
 *   2. otherwise the hostname row, **adopted**: the device id is written onto
 *      it, so the next hostname change is caught by (1);
 *   3. otherwise create.
 *
 * A client that sends neither field behaves exactly as before.
 */

export interface InstanceIdentity {
  workspaceId: string
  userId: string
  hostname: string
  name: string
  os: string | null
  arch: string | null
  kind: string
  deviceId?: string | null
  metadata?: unknown
  /** Also stamp `lastSeenAt`/`status` — a heartbeat, not a read. */
  touch?: boolean
}

export interface ResolvedInstance {
  id: string
  hostname: string
  name: string
  os: string | null
  arch: string | null
  kind: string
  lastSeenAt: Date | null
  wsRequestedAt: Date | null
  deviceId: string | null
  /** True when the row was found before this call (i.e. nothing was created). */
  existing: boolean
  /** True when the device id on the row had to be written (adoption). */
  adopted: boolean
}

/**
 * The device id a request speaks for: the header, else the machine snapshot's
 * own id (a desktop that has not shipped the header yet still identifies
 * itself in every heartbeat's `metadata.machine.id`).
 */
export function deviceIdFrom(
  header: string | null | undefined,
  metadata?: unknown,
): string | null {
  const direct = (header ?? '').trim()
  if (direct) return direct
  const machine = (metadata as any)?.machine
  const nested = typeof machine?.id === 'string' ? machine.id.trim() : ''
  return nested || null
}

/** The `metadata.machine.id` already stored on a row, if any. */
function storedMachineId(metadata: unknown): string | null {
  if (!metadata) return null
  let parsed: unknown = metadata
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata)
    } catch {
      return null
    }
  }
  const id = (parsed as any)?.machine?.id
  return typeof id === 'string' && id ? id : null
}

/** The columns the caller needs to decide whether the row has to be written. */
const ROW_SELECT = {
  id: true,
  hostname: true,
  name: true,
  os: true,
  arch: true,
  kind: true,
  lastSeenAt: true,
  wsRequestedAt: true,
  deviceId: true,
} as const

type IdentityRow = {
  id: string
  hostname: string
  name: string
  os: string | null
  arch: string | null
  kind: string
  lastSeenAt: Date | null
  wsRequestedAt: Date | null
  deviceId: string | null
}

/**
 * The row this machine already has, without writing anything.
 *
 * Device id first; hostname only as the legacy key for a client that does not
 * send one (or whose row predates the column).
 */
export async function findIdentityRow(
  tx: any,
  identity: InstanceIdentity,
): Promise<IdentityRow | null> {
  const { workspaceId, userId, hostname } = identity
  const deviceId = deviceIdFrom(identity.deviceId ?? null, identity.metadata)
  if (deviceId) {
    const byDevice = (await tx.instance.findFirst({
      where: { workspaceId, userId, deviceId },
      select: ROW_SELECT,
    })) as IdentityRow | null
    if (byDevice) return byDevice
  }
  return (await tx.instance.findUnique({
    where: { workspaceId_userId_hostname: { workspaceId, userId, hostname } },
    select: ROW_SELECT,
  })) as IdentityRow | null
}

/**
 * Find (or create) the row for this machine, keyed on the device id first.
 *
 * `tx` is a Prisma client or transaction. Returns the row the caller should
 * register the tunnel against.
 */
export async function resolveInstanceIdentity(
  tx: any,
  identity: InstanceIdentity,
): Promise<ResolvedInstance> {
  const { workspaceId, userId, hostname, name, os, arch, kind } = identity
  const deviceId = deviceIdFrom(identity.deviceId ?? null, identity.metadata)
  const metadata = (identity.metadata ?? undefined) as any
  const touch = identity.touch === true

  const existing = await findIdentityRow(tx, identity)
  if (existing) {
    // Adopt only a row nobody has claimed yet: a row that already names another
    // device is another machine that happens to share this hostname.
    const adopted = Boolean(deviceId) && !existing.deviceId
    await tx.instance.update({
      where: { id: existing.id },
      data: {
        hostname,
        name,
        os,
        arch,
        kind,
        ...(adopted ? { deviceId } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        ...(touch ? { lastSeenAt: new Date(), status: 'online' } : {}),
      },
    })
    return {
      ...existing,
      hostname,
      name,
      os,
      arch,
      kind,
      deviceId: existing.deviceId ?? deviceId ?? null,
      existing: true,
      adopted,
    }
  }

  const data = {
    workspaceId,
    userId,
    hostname,
    name,
    os,
    arch,
    kind,
    deviceId: deviceId ?? null,
    ...(touch ? { lastSeenAt: new Date(), status: 'online' } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  }

  let created: IdentityRow
  try {
    created = (await tx.instance.create({ data, select: ROW_SELECT })) as IdentityRow
  } catch (err) {
    // Two heartbeats of one machine can both miss the read. The hostname unique
    // key is what used to make this safe (`upsert`), so a lost race resolves to
    // the row the winner created instead of a 500.
    if ((err as any)?.code !== 'P2002') throw err
    const raced = await findIdentityRow(tx, identity)
    if (!raced) throw err
    await tx.instance.update({
      where: { id: raced.id },
      data: { ...data, hostname, name },
    })
    return { ...raced, hostname, name, os, arch, kind, deviceId: raced.deviceId ?? deviceId ?? null, existing: true, adopted: false }
  }
  return { ...created, existing: false, adopted: false }
}


/**
 * Rows that are this same physical machine under another hostname.
 *
 * Two ways a duplicate shows up: it already carries the device id (the fix is
 * live and the row is a leftover), or it carries the same
 * `metadata.machine.id` and was created before device ids existed (Russell's
 * `cmvt382…`). Hostname alone is never the test — that is what forked it.
 *
 * Comparison happens in JS because `metadata` is `Json` on PG and `String` on
 * SQLite, and a JSON path filter is a PG-only expression.
 */
export async function duplicateMachineRowIds(params: {
  tx: any
  instanceId: string
  workspaceId: string
  userId: string
  kind: string
  deviceId: string | null
  metadata?: unknown
}): Promise<string[]> {
  const { tx, instanceId, workspaceId, userId, kind, deviceId } = params

  const ids = new Set<string>()
  if (deviceId) {
    const sameDevice = await tx.instance.findMany({
      where: { workspaceId, userId, deviceId, id: { not: instanceId } },
      select: { id: true },
    })
    for (const row of sameDevice) ids.add(row.id)
  }

  const machineId = storedMachineId(params.metadata)
  if (machineId) {
    // Bounded: the rows of one person's machines.
    const candidates = await tx.instance.findMany({
      where: { userId, kind, id: { not: instanceId } },
      select: { id: true, metadata: true, deviceId: true },
    })
    for (const row of candidates) {
      if (row.deviceId && deviceId && row.deviceId === deviceId) ids.add(row.id)
      else if (storedMachineId(row.metadata) === machineId) ids.add(row.id)
    }
  }

  return [...ids]
}
