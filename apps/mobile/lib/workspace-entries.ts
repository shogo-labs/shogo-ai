// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One workspace list for every switcher (SHO-108).
 *
 * A workspace has a *host*. A cloud workspace's host is Shogo's machine; a
 * machine workspace's host is the user's own computer. That is the only
 * difference, so the switcher renders one list of `WorkspaceEntry` and one row
 * component — no second block, no nested group, no second switch path.
 *
 * The list is derived, never stored: `buildWorkspaceEntries` is a pure function
 * of the cloud list, the paired machines and (for the current row) the active
 * instance, so re-renders cannot reorder it. Order is the server's for cloud
 * rows, then each machine's own order — never a sort by id (SHO-56).
 */

import { useMemo } from 'react'
import type { ActiveInstance } from '../contexts/active-instance'

export type MachinePresence = 'online' | 'heartbeat' | 'offline'

/** A workspace of a paired desktop, as that desktop reports it. */
export interface MachineWorkspaceRow {
  id: string
  name: string
  kind?: string
  projectCount?: number
  lastActivityAt?: string | null
}

/** One paired desktop and the workspaces it runs. */
export interface MachineGroupData {
  id: string
  name: string
  /**
   * The device kind as the cloud reports it — `desktop` or `cli-worker`. A
   * `shogo worker` VM is an execution target with no data API, so it never
   * contributes workspace rows (SHO-120); the field travels so callers can
   * tell one from a Mac without guessing.
   */
  kind?: string
  status: MachinePresence
  /** True when these rows are the machine's last-known snapshot, not live. */
  stale?: boolean
  lastSeenAt?: string | null
  workspaces: MachineWorkspaceRow[]
}

/** The host a workspace runs on. Cloud workspaces have an implicit one. */
export type WorkspaceHost =
  | { kind: 'cloud' }
  | {
      kind: 'machine'
      instanceId: string
      hostname: string
      presence: MachinePresence
      /** These rows are the host's last-known snapshot, not its live list. */
      stale?: boolean
      lastSeenAt?: string | null
    }

export interface WorkspaceEntry {
  /** Stable across renders and hosts: `cloud:<id>` / `machine:<instance>:<id>`. */
  key: string
  /** The workspace's own id — a cloud id or the machine's local id. */
  id: string
  name: string
  kind: 'personal' | 'team'
  host: WorkspaceHost
  /** Machine rows only: last activity the host reported, if it reported one. */
  lastActivityAt?: string | null
}

/** A cloud workspace as the collections hand it over. */
export interface CloudWorkspaceLike {
  id: string
  name: string
  kind?: string
}

export function cloudWorkspaceKey(id: string): string {
  return `cloud:${id}`
}

export function machineWorkspaceKey(instanceId: string, localId: string): string {
  return `machine:${instanceId}:${localId}`
}

function toKind(kind: string | undefined): 'personal' | 'team' {
  return kind === 'personal' ? 'personal' : 'team'
}

function cloudEntry(workspace: CloudWorkspaceLike): WorkspaceEntry {
  return {
    key: cloudWorkspaceKey(workspace.id),
    id: workspace.id,
    name: workspace.name,
    kind: toKind(workspace.kind),
    host: { kind: 'cloud' },
  }
}

/**
 * A `shogo worker` VM is an execution target, not a computer: it serves
 * `/agent/*` and no data API, so it has no workspaces to open and must never
 * appear as a workspace host (SHO-120). It stays reachable as a project
 * runtime through the instance picker.
 */
export function isExecutionOnlyMachine(machine: { kind?: string } | null | undefined): boolean {
  const kind = (machine?.kind ?? '').toLowerCase().replace(/[-\s]/g, '_')
  return kind === 'cli_worker'
}

function machineEntries(machine: MachineGroupData): WorkspaceEntry[] {
  if (isExecutionOnlyMachine(machine)) return []
  return machine.workspaces.map((workspace) => ({
    key: machineWorkspaceKey(machine.id, workspace.id),
    id: workspace.id,
    name: workspace.name,
    kind: toKind(workspace.kind),
    lastActivityAt: workspace.lastActivityAt ?? null,
    host: {
      kind: 'machine',
      instanceId: machine.id,
      hostname: machine.name,
      presence: machine.status,
      stale: machine.stale,
      lastSeenAt: machine.lastSeenAt ?? null,
    },
  }))
}

/**
 * The one list: cloud workspaces in the server's order, then each machine's
 * workspaces in the order that machine reports them.
 *
 * A machine with no workspaces and no snapshot contributes nothing — there is
 * nothing to show, so its rows are not invented.
 */
export function buildWorkspaceEntries(input: {
  workspaces: CloudWorkspaceLike[]
  machines?: MachineGroupData[]
}): WorkspaceEntry[] {
  const entries = input.workspaces.map(cloudEntry)
  for (const machine of input.machines ?? []) {
    entries.push(...machineEntries(machine))
  }
  return entries
}

/** The row that is checked: the machine's while it is open, else the cloud one. */
export function currentWorkspaceKey(input: {
  entries: WorkspaceEntry[]
  currentWorkspaceId?: string | null
  activeInstance?: ActiveInstance | null
}): string | null {
  const instance = input.activeInstance
  if (instance?.source === 'machine' && instance.localWorkspaceId) {
    const key = machineWorkspaceKey(instance.instanceId, instance.localWorkspaceId)
    if (input.entries.some((entry) => entry.key === key)) return key
  }
  if (!input.currentWorkspaceId) return null
  const key = cloudWorkspaceKey(input.currentWorkspaceId)
  return input.entries.some((entry) => entry.key === key) ? key : null
}

/** The entry in view, for callers that need more than its key. */
export function currentWorkspaceEntry(input: {
  entries: WorkspaceEntry[]
  currentWorkspaceId?: string | null
  activeInstance?: ActiveInstance | null
}): WorkspaceEntry | null {
  const key = currentWorkspaceKey(input)
  return key ? (input.entries.find((entry) => entry.key === key) ?? null) : null
}

/** Where a workspace lands: the workspace agent, on a fresh chat for a team. */
export function workspaceLandingKind(entry: WorkspaceEntry | null | undefined): 'personal' | 'team' {
  return entry?.kind === 'personal' ? 'personal' : 'team'
}

/**
 * The active-instance selection that makes this machine entry the workspace in
 * view, or `null` for a cloud entry.
 *
 * One mapping for every caller: the switcher's machine row and the phone sheet's
 * machine row must select the same thing, and the machine's own name and kind
 * travel with it so the shell and the identity header follow the workspace in
 * view rather than the cloud workspace that happens to be selected.
 */
export function machineInstanceForEntry(
  entry: WorkspaceEntry,
  cloudWorkspaceId?: string | null,
): ActiveInstance | null {
  if (entry.host.kind !== 'machine') return null
  return {
    instanceId: entry.host.instanceId,
    name: entry.host.hostname,
    hostname: entry.host.hostname,
    workspaceId: cloudWorkspaceId ?? '',
    kind: 'desktop',
    source: 'machine',
    localWorkspaceId: entry.id,
    localWorkspaceName: entry.name,
    localWorkspaceKind: entry.kind,
  }
}

/**
 * The switcher's list, derived at render. Reads nothing from state that could
 * re-sort it: the same cloud list and the same machine report always build the
 * same array, in the same order.
 */
export function useWorkspaceEntries(input: {
  workspaces: CloudWorkspaceLike[]
  machines?: MachineGroupData[]
}): WorkspaceEntry[] {
  const { workspaces, machines } = input
  return useMemo(() => buildWorkspaceEntries({ workspaces, machines }), [workspaces, machines])
}
