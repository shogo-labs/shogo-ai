// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One machine, however many cloud workspaces it is registered in.
 *
 * Since a paired desktop opens one tunnel per stored device key (see
 * `instance-tunnel.ts`), the same machine has one `instances` row per workspace
 * it is signed into. `@@unique([workspaceId, userId, hostname])` already treats
 * `hostname` as the machine's identity inside a workspace; these helpers extend
 * that across workspaces, so the switcher and Settings each list `samsra` once
 * with every workspace it appears in.
 */
import { prisma } from './prisma'

/** The columns grouping needs; both Prisma clients' rows satisfy it. */
export interface MachineRowLike {
  id: string
  hostname: string
  workspaceId: string
  lastSeenAt: Date | null
  createdAt?: Date | null
  /**
   * `desktop` or `cli-worker`. A dev box that runs both is two things to open,
   * so the kind is part of the machine's identity — `/instances` lists both,
   * while `/machines` filters the workers out.
   */
  kind?: string | null
}

/**
 * Workspace id → display name, best-effort.
 *
 * A deleted workspace (or an id this database has never seen) simply has no
 * name; the row still counts as "registered there".
 */
export async function workspaceNamesById(workspaceIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(workspaceIds.filter(Boolean))]
  if (!ids.length) return new Map()
  try {
    const rows = await prisma.workspace.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    })
    return new Map(rows.map((row) => [row.id, row.name]))
  } catch {
    return new Map()
  }
}

export interface MachineWorkspaceRef {
  id: string
  name: string
}

export interface GroupedMachine<T extends MachineRowLike> {
  /**
   * The row that represents the machine. Stable: the row that owns the cloud
   * copy when there is one, else the oldest row — never "whichever row
   * heartbeated last", which changes every few seconds and made a live machine
   * look unpaired (SHO-241).
   */
  row: T
  /** Every cloud workspace this machine is registered in, by name. */
  workspaces: MachineWorkspaceRef[]
  /** All rows for the machine, freshest first — one per workspace. */
  rows: T[]
}

function seenAt(row: Pick<MachineRowLike, 'lastSeenAt'>): number {
  return row.lastSeenAt instanceof Date ? row.lastSeenAt.getTime() : 0
}

function createdAt(row: Pick<MachineRowLike, 'createdAt'>): number {
  return row.createdAt instanceof Date ? row.createdAt.getTime() : 0
}

/** The freshest heartbeat any of a machine's rows has had. */
function groupSeenAt<T extends MachineRowLike>(machine: GroupedMachine<T>): number {
  return machine.rows.reduce((newest, row) => Math.max(newest, seenAt(row)), 0)
}

/**
 * Group instance rows into machines by hostname.
 *
 * `preferWorkspaceId` picks the representative row when the caller is looking
 * from inside one workspace (a project's runtime picker), so ids the caller
 * already holds stay valid.
 *
 * Otherwise the representative is **stable**, which is the whole point: the
 * desktop opens one row per device key, they heartbeat in turn, and picking the
 * freshest one returned a different `id` every few seconds. The client stores
 * that id, then cannot find it on the next poll and reports a live machine as
 * "offline — stopped heartbeating". So: the row that owns the cloud copy
 * (`copyOwners`), else the oldest row. Both only change when the copy moves or a
 * row is added.
 *
 * `nameFor` resolves a workspace id to its display name; unknown ids are left
 * with `name: ''` rather than dropped, so a row for a deleted workspace still
 * counts as "registered there".
 */
export function groupMachinesByHostname<T extends MachineRowLike>(
  rows: T[],
  opts: {
    preferWorkspaceId?: string | null
    nameFor?: (workspaceId: string) => string | undefined
    /** Rows that own a cloud copy of this machine (they have sync state). */
    copyOwners?: Set<string>
  } = {},
): Array<GroupedMachine<T>> {
  const byHost = new Map<string, T[]>()
  for (const row of rows) {
    // Hostname *and* kind: one dev box can hold a desktop app and a `cli_worker`,
    // and merging those would offer one of them as the other.
    const key = `${row.hostname || row.id}\u0000${row.kind ?? ''}`
    const list = byHost.get(key)
    if (list) list.push(row)
    else byHost.set(key, [row])
  }

  const grouped: Array<GroupedMachine<T>> = []
  for (const list of byHost.values()) {
    const sorted = [...list].sort((a, b) => seenAt(b) - seenAt(a))
    const preferred = opts.preferWorkspaceId
      ? list.find((row) => row.workspaceId === opts.preferWorkspaceId)
      : undefined
    const oldestFirst = [...list].sort((a, b) => createdAt(a) - createdAt(b) || a.id.localeCompare(b.id))
    const copyOwner = opts.copyOwners
      ? oldestFirst.find((row) => opts.copyOwners!.has(row.id))
      : undefined
    const row = preferred ?? copyOwner ?? oldestFirst[0]
    const seen = new Set<string>()
    const workspaces: MachineWorkspaceRef[] = []
    for (const candidate of sorted) {
      if (seen.has(candidate.workspaceId)) continue
      seen.add(candidate.workspaceId)
      workspaces.push({
        id: candidate.workspaceId,
        name: opts.nameFor?.(candidate.workspaceId) ?? '',
      })
    }
    grouped.push({ row, workspaces, rows: sorted })
  }

  // Stable order for a list UI: the machine heard from most recently first.
  return grouped.sort((a, b) => groupSeenAt(b) - groupSeenAt(a))
}
