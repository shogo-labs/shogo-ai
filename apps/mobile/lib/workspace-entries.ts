// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One workspace list for every switcher (SHO-108, SHO-285).
 *
 * Every row is a cloud workspace from `GET /workspaces`. A workspace whose
 * compute is a paired desktop (`hostInstanceId`) is the same kind of row with
 * a host badge: same id, same routes, same selection. The only thing the
 * paired machines contribute is the badge's name and presence.
 *
 * The list is derived, never stored: `buildWorkspaceEntries` is a pure function
 * of the cloud list and the hosts, so re-renders cannot reorder it. Order is the
 * server's — never a sort by id (SHO-56).
 */

import { useMemo } from 'react'

export type MachinePresence = 'online' | 'heartbeat' | 'offline'

/** A paired desktop, as `GET /machines` reports it. */
export interface WorkspaceHostInfo {
  instanceId: string
  hostname: string
  /** `desktop` or `cli-worker`; a worker VM never hosts a workspace (SHO-120). */
  kind?: string
  presence: MachinePresence
  lastSeenAt?: string | null
}

/** Where a workspace's agent runs. Cloud workspaces have an implicit host. */
export type WorkspaceHost =
  | { kind: 'cloud' }
  | {
      kind: 'machine'
      instanceId: string
      /** The desktop's name, or a placeholder until `GET /machines` answers. */
      hostname: string
      presence: MachinePresence
      lastSeenAt?: string | null
    }

export interface WorkspaceEntry {
  /** Stable across renders: `cloud:<id>`. */
  key: string
  /** The workspace id — the same on the cloud and on its host. */
  id: string
  name: string
  kind: 'personal' | 'team'
  host: WorkspaceHost
}

/** A cloud workspace as the collections hand it over. */
export interface CloudWorkspaceLike {
  id: string
  name: string
  kind?: string
  /** Set when a paired desktop is this workspace's host (SHO-285). */
  hostInstanceId?: string | null
}

export function cloudWorkspaceKey(id: string): string {
  return `cloud:${id}`
}

function toKind(kind: string | undefined): 'personal' | 'team' {
  return kind === 'personal' ? 'personal' : 'team'
}

function hostFor(
  workspace: CloudWorkspaceLike,
  hosts: WorkspaceHostInfo[] | undefined,
): WorkspaceHost {
  if (!workspace.hostInstanceId) return { kind: 'cloud' }
  const host = hosts?.find((h) => h.instanceId === workspace.hostInstanceId)
  return {
    kind: 'machine',
    instanceId: workspace.hostInstanceId,
    hostname: host?.hostname ?? 'Your computer',
    presence: host?.presence ?? 'offline',
    lastSeenAt: host?.lastSeenAt ?? null,
  }
}

/**
 * A `shogo worker` VM is an execution target, not a computer: it serves
 * `/agent/*` and no data API, so it never hosts a workspace (SHO-120).
 */
export function isExecutionOnlyMachine(machine: { kind?: string } | null | undefined): boolean {
  const kind = (machine?.kind ?? '').toLowerCase().replace(/[-\s]/g, '_')
  return kind === 'cli_worker'
}

/** The one list: cloud workspaces in the server's order, hosted ones badged. */
export function buildWorkspaceEntries(input: {
  workspaces: CloudWorkspaceLike[]
  hosts?: WorkspaceHostInfo[]
}): WorkspaceEntry[] {
  return input.workspaces.map((workspace) => ({
    key: cloudWorkspaceKey(workspace.id),
    id: workspace.id,
    name: workspace.name,
    kind: toKind(workspace.kind),
    host: hostFor(workspace, input.hosts),
  }))
}

/** The row that is checked: the selected workspace's. */
export function currentWorkspaceKey(input: {
  entries: WorkspaceEntry[]
  currentWorkspaceId?: string | null
}): string | null {
  if (!input.currentWorkspaceId) return null
  const key = cloudWorkspaceKey(input.currentWorkspaceId)
  return input.entries.some((entry) => entry.key === key) ? key : null
}

/** The entry in view, for callers that need more than its key. */
export function currentWorkspaceEntry(input: {
  entries: WorkspaceEntry[]
  currentWorkspaceId?: string | null
}): WorkspaceEntry | null {
  const key = currentWorkspaceKey(input)
  return key ? (input.entries.find((entry) => entry.key === key) ?? null) : null
}

/** Where a workspace lands: the workspace agent, on a fresh chat for a team. */
export function workspaceLandingKind(entry: WorkspaceEntry | null | undefined): 'personal' | 'team' {
  return entry?.kind === 'personal' ? 'personal' : 'team'
}

/**
 * The switcher's list, derived at render. Reads nothing from state that could
 * re-sort it: the same cloud list and the same machine report always build the
 * same array, in the same order.
 */
export function useWorkspaceEntries(input: {
  workspaces: CloudWorkspaceLike[]
  hosts?: WorkspaceHostInfo[]
}): WorkspaceEntry[] {
  const { workspaces, hosts } = input
  return useMemo(() => buildWorkspaceEntries({ workspaces, hosts }), [workspaces, hosts])
}

/** "just now" / "4 min ago" / "2 h ago" / "3 d ago" — the switcher's one-liner. */
export function relativeWhen(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'no activity yet'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'no activity yet'
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} d ago`
}

/**
 * The host badge (SHO-285): `Host: odin · online`, or
 * `Host: odin · offline · last seen 4 min ago`.
 */
export function hostSubtitle(host: WorkspaceHost, now: number = Date.now()): string | null {
  if (host.kind !== 'machine') return null
  if (host.presence === 'online') return `Host: ${host.hostname} · online`
  const state = host.presence === 'heartbeat' ? 'reconnecting' : 'offline'
  const seen = host.lastSeenAt ? ` · last seen ${relativeWhen(host.lastSeenAt, now)}` : ''
  return `Host: ${host.hostname} · ${state}${seen}`
}
