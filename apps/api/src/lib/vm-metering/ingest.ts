// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Ingest a metal host's VM meter into `VmUsageHour` rows (SHO-424).
 *
 * The node-agent reports CUMULATIVE per-VM counters on every heartbeat
 * (`meter: { seq, vms, closed }`). This module turns them into usage:
 *
 *   delta = reported counters − `VmMeterCursor` for that (host, vmId, assignedAt)
 *
 * and adds `delta` to the current hour's row for the machine size that VM
 * booted. Two properties fall out of that shape, and both are tested:
 *
 *  - **Replay is free.** A heartbeat the control plane receives twice computes a
 *    zero delta the second time, so nothing is double-counted.
 *  - **A lost heartbeat costs nothing.** The counters are cumulative, so the
 *    next heartbeat carries the whole total, not just the last 30 seconds.
 *
 * A counter that goes BACKWARDS means the agent restarted (its counters live in
 * memory): the new value is taken as the delta rather than subtracting, which is
 * the only reading that cannot bill a negative amount.
 *
 * Attribution granularity: a delta is charged to the hour the heartbeat lands
 * in, not spread across a sub-tick boundary. Heartbeats are 30 s apart, so the
 * worst-case misplacement is one tick at an hour edge.
 *
 * Region safety: `hostId` is part of every key below, and a host heartbeats to
 * exactly one region, so the write sets of the two regions are disjoint and
 * logical replication never sees an `insert_exists` conflict (SHO-344/345).
 */

import { prisma } from '../prisma'
import { isVmCause, type IngestMetersResult, type MetalMeterPayload, type VmMeterReport } from './types'

/** How long a cursor with no heartbeat is kept before it is pruned. */
const CURSOR_TTL_MS = 24 * 60 * 60_000
/** Bounded work per heartbeat: a host cannot report more VMs than this. */
const MAX_VMS_PER_HEARTBEAT = 500
/** CAS retries per VM row when a peer replica advanced the same cursor. */
const CAS_ATTEMPTS = 3

export function truncateToHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000)
}

/** Is this a `meter` block we can act on at all? */
export function isMeterPayload(v: unknown): v is MetalMeterPayload {
  if (!v || typeof v !== 'object') return false
  const m = v as MetalMeterPayload
  return typeof m.seq === 'number' && Array.isArray(m.vms)
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Coerce one wire row; undefined when it has no usable identity. */
function normalise(raw: unknown): VmMeterReport | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const vmId = typeof r.vmId === 'string' ? r.vmId.trim() : ''
  const runtimeKey = typeof r.runtimeKey === 'string' ? r.runtimeKey.trim() : ''
  const assignedAt = Number(r.assignedAt)
  if (!vmId || !runtimeKey || !Number.isFinite(assignedAt) || assignedAt <= 0) return undefined
  return {
    runtimeKey,
    vmId: vmId.slice(0, 200),
    assignedAt,
    // A VM that never reported a size is not billable (we cannot price it
    // honestly), but its time is still recorded against 0 vCPU / 0 MiB... and a
    // 0-sized row would be a free hour that looks billed. So default to the
    // standard 2 vCPU / 4096 MiB the fleet boots — the same class default the
    // host applies when nothing overrides it (METAL_VCPUS/METAL_MEM_MIB).
    vcpus: Math.min(Math.round(num(r.vcpus, 2)) || 2, 128),
    memMiB: Math.min(Math.round(num(r.memMiB, 4096)) || 4096, 1_048_576),
    vmClass: typeof r.vmClass === 'string' ? r.vmClass.slice(0, 40) : 'standard',
    cause: isVmCause(r.cause) ? r.cause : 'user_open',
    alwaysOn: r.alwaysOn === true,
    agentMs: Math.round(num(r.agentMs)),
    appMs: Math.round(num(r.appMs)),
    idleMs: Math.round(num(r.idleMs)),
    ...(num(r.endedAt) > 0 ? { endedAt: Math.round(num(r.endedAt)) } : {}),
  }
}

interface ResolvedRuntime {
  workspaceId: string
  /** '' for a workspace-level runtime that belongs to no single project. */
  projectId: string
}

/**
 * Map runtime keys to the workspace/project they bill to.
 *
 * `ws:<workspaceId>` is a workspace-session runtime (no project);
 * `ws:proj:<projectId>` is one project's canvas runtime inside a workspace;
 * a bare key is a legacy per-project runtime; `published:<id>` is a live site's
 * own VM, which is billed as `published_hosting` and so is not metered here.
 */
export async function resolveRuntimeKeys(keys: string[]): Promise<Map<string, ResolvedRuntime | null>> {
  const out = new Map<string, ResolvedRuntime | null>()
  const projectIds = new Set<string>()
  /**
   * projectId → the runtime keys that asked for it. `proj-1` and
   * `ws:proj:proj-1` are the same project under two keys, and the caller looks
   * its answer up by the key IT sent, so both have to be written back.
   */
  const projectKeys = new Map<string, string[]>()
  const workspaceIds = new Set<string>()
  const wantsProject = (projectId: string, key: string) => {
    projectIds.add(projectId)
    const list = projectKeys.get(projectId) ?? []
    if (!list.includes(key)) list.push(key)
    projectKeys.set(projectId, list)
  }

  for (const key of keys) {
    if (key.startsWith('published:')) {
      out.set(key, null)
      continue
    }
    if (key.startsWith('ws:proj:')) {
      const id = key.slice('ws:proj:'.length)
      if (id) wantsProject(id, key)
      else out.set(key, null)
      continue
    }
    if (key.startsWith('ws:')) {
      const id = key.slice('ws:'.length)
      if (id) {
        // Registered so the aliveness pass below can rule a deleted workspace's
        // session runtime unbillable — keeping it out of `workspaceIds` skipped
        // that check for exactly the keys that need it most.
        workspaceIds.add(id)
        out.set(key, { workspaceId: id, projectId: '' })
      } else {
        out.set(key, null)
      }
      continue
    }
    if (key) wantsProject(key, key)
  }

  if (projectIds.size > 0) {
    const projects = await prisma.project.findMany({
      where: { id: { in: [...projectIds] } },
      select: { id: true, workspaceId: true },
    })
    for (const p of projects) {
      const resolved: ResolvedRuntime = { workspaceId: p.workspaceId, projectId: p.id }
      for (const key of projectKeys.get(p.id) ?? []) out.set(key, resolved)
      workspaceIds.add(p.workspaceId)
    }
  }

  // A workspace-session key must point at a live workspace: a deleted
  // workspace's runtime stops being rebuilt, and metering its last heartbeat
  // would mint rows no one can bill or display.
  if (workspaceIds.size > 0) {
    const ws = await prisma.workspace.findMany({
      where: { id: { in: [...workspaceIds] } },
      select: { id: true },
    })
    const alive = new Set(ws.map((w) => w.id))
    for (const [key, resolved] of out) {
      if (!resolved) continue
      if (!alive.has(resolved.workspaceId)) out.set(key, null)
    }
  }

  // Every requested key gets an entry. A project that no longer exists is
  // explicitly null so callers can tell "not billable" from "we forgot to look".
  for (const key of keys) if (!out.has(key)) out.set(key, null)

  return out
}


/**
 * Ingest one register heartbeat's meter block. Never throws on bad input: a
 * malformed meter must not break a host's liveness heartbeat, which is what
 * keeps its projects routable.
 */
export async function ingestMetalMeters(params: {
  hostId: string
  payload: unknown
  now?: Date
}): Promise<IngestMetersResult> {
  const now = params.now ?? new Date()
  const result: IngestMetersResult = {
    ack: 0,
    rows: 0,
    metered: 0,
    unresolved: 0,
    agentSeconds: 0,
    appSeconds: 0,
    idleSeconds: 0,
    invalid: 0,
  }
  if (!isMeterPayload(params.payload)) return result
  const payload = params.payload
  result.ack = Math.max(0, Math.floor(payload.seq))

  const raw = [...payload.vms, ...(payload.closed ?? [])].slice(0, MAX_VMS_PER_HEARTBEAT)
  const rows: VmMeterReport[] = []
  for (const r of raw) {
    const norm = normalise(r)
    if (norm) rows.push(norm)
    else result.invalid++
  }
  result.rows = rows.length
  if (rows.length === 0) return result

  const resolved = await resolveRuntimeKeys([...new Set(rows.map((r) => r.runtimeKey))])
  const hour = truncateToHour(now)

  for (const row of rows) {
    const target = resolved.get(row.runtimeKey)
    if (!target) {
      result.unresolved++
      // Still advance the cursor: otherwise a deleted project's VM re-sends its
      // whole counter history on every heartbeat until it is destroyed.
      await advanceCursor(params.hostId, row, row.agentMs, row.appMs, row.idleMs, now).catch(() => {})
      continue
    }
    const delta = await ingestOneVm(params.hostId, target, row, hour, now)
    if (!delta) continue
    if (delta.agentMs + delta.appMs + delta.idleMs <= 0) continue
    result.metered++
    result.agentSeconds += Math.round(delta.agentMs / 1000)
    result.appSeconds += Math.round(delta.appMs / 1000)
    result.idleSeconds += Math.round(delta.idleMs / 1000)
  }

  // Bounded cleanup: a host that is decommissioned stops heartbeating and its
  // cursors would otherwise sit in the table forever.
  await prisma.vmMeterCursor
    .deleteMany({ where: { hostId: params.hostId, lastSeenAt: { lt: new Date(now.getTime() - CURSOR_TTL_MS) } } })
    .catch(() => {})

  return result
}

interface MeterDelta {
  agentMs: number
  appMs: number
  idleMs: number
}

/**
 * Turn ONE VM's cumulative counters into a delta and write it, with the cursor
 * update in the same transaction so a crash between the two cannot double-count
 * or lose time.
 *
 * Returns the delta, or null when a peer replica advanced the cursor first
 * (the delta was theirs to record).
 */
async function ingestOneVm(
  hostId: string,
  target: ResolvedRuntime,
  row: VmMeterReport,
  hour: Date,
  now: Date,
): Promise<MeterDelta | null> {
  const key = { hostId_vmId_assignedAt: { hostId, vmId: row.vmId, assignedAt: BigInt(row.assignedAt) } }

  for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
    const cursor = await prisma.vmMeterCursor.findUnique({ where: key })
    const delta = diffCounters(cursor, row)
    // `VmUsageHour` stores whole seconds, so only whole seconds advance the
    // cursor: the sub-second remainder stays in it and is metered by the next
    // heartbeat. Without that, a 30 s heartbeat at 29.6 s of counted time would
    // drop 0.4 s every tick — a slow, silent under-bill.
    const agentSec = Math.floor(delta.agentMs / 1000)
    const appSec = Math.floor(delta.appMs / 1000)
    const idleSec = Math.floor(delta.idleMs / 1000)
    const total = agentSec + appSec + idleSec
    const nextCounters = {
      agentMs: (cursor?.agentMs ?? 0) + agentSec * 1000,
      appMs: (cursor?.appMs ?? 0) + appSec * 1000,
      idleMs: (cursor?.idleMs ?? 0) + idleSec * 1000,
    }

    const wrote = await prisma.$transaction(async (tx) => {
      if (cursor) {
        // Compare-and-swap on the exact counters we read: exactly one writer can
        // move a cursor from a given state, so two replicas ingesting the same
        // host cannot both charge the same seconds.
        const moved = await tx.vmMeterCursor.updateMany({
          where: {
            id: cursor.id,
            agentMs: cursor.agentMs,
            appMs: cursor.appMs,
            idleMs: cursor.idleMs,
          },
          data: {
            agentMs: nextCounters.agentMs,
            appMs: nextCounters.appMs,
            idleMs: nextCounters.idleMs,
            lastSeenAt: now,
          },
        })
        if (moved.count === 0) return false
      } else {
        try {
          await tx.vmMeterCursor.create({
            data: {
              hostId,
              vmId: row.vmId,
              assignedAt: BigInt(row.assignedAt),
              agentMs: nextCounters.agentMs,
              appMs: nextCounters.appMs,
              idleMs: nextCounters.idleMs,
              lastSeenAt: now,
            },
          })
        } catch (err: any) {
          // P2002: a peer created it between our read and our write.
          if (String(err?.code ?? '') === 'P2002') return false
          throw err
        }
      }

      if (total > 0) {
        await tx.vmUsageHour.upsert({
          where: {
            workspaceId_projectId_hour_hostId_vcpus_memMiB_cause: {
              workspaceId: target.workspaceId,
              projectId: target.projectId,
              hour,
              hostId,
              vcpus: row.vcpus,
              memMiB: row.memMiB,
              cause: row.cause,
            },
          },
          create: {
            workspaceId: target.workspaceId,
            projectId: target.projectId,
            hour,
            hostId,
            vcpus: row.vcpus,
            memMiB: row.memMiB,
            cause: row.cause,
            agentSeconds: agentSec,
            appSeconds: appSec,
            idleSeconds: idleSec,
          },
          update: {
            agentSeconds: { increment: agentSec },
            appSeconds: { increment: appSec },
            idleSeconds: { increment: idleSec },
          },
        })
      }
      return true
    })

    if (wrote) {
      return { agentMs: agentSec * 1000, appMs: appSec * 1000, idleMs: idleSec * 1000 }
    }
  }
  // Every attempt lost the CAS: a peer replica is ingesting this host. Its
  // delta is the authoritative one; ours would double-count.
  return null
}

/**
 * Counters are cumulative. A negative difference means the agent restarted (its
 * counters live in memory) — take the new value as the delta rather than
 * subtracting, so a restart records the time since it came back and never a
 * negative charge.
 */
export function diffCounters(
  cursor: { agentMs: number; appMs: number; idleMs: number } | null,
  row: { agentMs: number; appMs: number; idleMs: number },
): MeterDelta {
  const one = (prev: number | undefined, next: number): number => {
    const p = prev ?? 0
    return next >= p ? next - p : next
  }
  return {
    agentMs: one(cursor?.agentMs, row.agentMs),
    appMs: one(cursor?.appMs, row.appMs),
    idleMs: one(cursor?.idleMs, row.idleMs),
  }
}

async function advanceCursor(
  hostId: string,
  row: VmMeterReport,
  agentMs: number,
  appMs: number,
  idleMs: number,
  now: Date,
): Promise<void> {
  await prisma.vmMeterCursor.upsert({
    where: { hostId_vmId_assignedAt: { hostId, vmId: row.vmId, assignedAt: BigInt(row.assignedAt) } },
    create: { hostId, vmId: row.vmId, assignedAt: BigInt(row.assignedAt), agentMs, appMs, idleMs, lastSeenAt: now },
    update: { agentMs, appMs, idleMs, lastSeenAt: now },
  })
}
