// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud workspaces a signed-in desktop is a live client of: the user's team
 * workspaces and their own Personal one (which then stands in for the
 * desktop's local Personal, so desktop and mobile share it). Each one has
 * its own device key (keys are workspace-scoped on the cloud), stored in
 * localConfig `SHOGO_CLOUD_WORKSPACES`. Nothing from those workspaces is
 * copied into SQLite; the local API relays requests with the matching key.
 */

import { prisma } from '../lib/prisma'
import { getShogoCloudUrl } from '../lib/cloud-urls'

const CONFIG_KEY = 'SHOGO_CLOUD_WORKSPACES'
const SYNC_INTERVAL_MS = 10 * 60_000

export interface CloudWorkspaceEntry {
  id: string
  name: string
  slug: string | null
  kind: 'personal' | 'team'
  key: string
}

export interface CloudUser {
  id: string
  name: string | null
  email: string | null
}

interface Stored {
  /** Set when the user chose to show all their workspaces at sign-in. */
  enabled: boolean
  user: CloudUser | null
  workspaces: CloudWorkspaceEntry[]
  syncedAt: string | null
}

const localDb = prisma as any
let cache: Stored | null = null
let reachable = true
let timer: ReturnType<typeof setInterval> | null = null
let inflight: Promise<void> | null = null

async function load(): Promise<Stored> {
  if (cache) return cache
  const row = await localDb.localConfig.findUnique({ where: { key: CONFIG_KEY } }).catch(() => null)
  let parsed: Stored = { enabled: false, user: null, workspaces: [], syncedAt: null }
  try {
    if (row?.value) parsed = { ...parsed, ...JSON.parse(row.value) }
  } catch {}
  parsed.workspaces = parsed.workspaces.map((w) => ({ ...w, kind: w.kind === 'personal' ? 'personal' : 'team' }))
  cache = parsed
  return parsed
}

async function save(next: Stored): Promise<void> {
  cache = next
  const value = JSON.stringify(next)
  await localDb.localConfig.upsert({ where: { key: CONFIG_KEY }, update: { value }, create: { key: CONFIG_KEY, value } })
}

export async function listCloudWorkspaces(): Promise<{ user: CloudUser | null; workspaces: CloudWorkspaceEntry[]; reachable: boolean }> {
  const stored = await load()
  return { user: stored.user, workspaces: stored.workspaces, reachable }
}

export async function cloudWorkspaceKey(workspaceId: string): Promise<string | null> {
  const stored = await load()
  return stored.workspaces.find((w) => w.id === workspaceId)?.key ?? null
}

export async function cloudWorkspaceUser(): Promise<CloudUser | null> {
  return (await load()).user
}

/** Stores the keys handed over at sign-in; replaces any previous set. */
export async function setCloudWorkspaces(input: {
  user: CloudUser | null
  workspaces: Array<{ workspace: { id: string; name: string; slug?: string | null; kind?: string }; key: string }>
}): Promise<void> {
  await save({
    enabled: true,
    user: input.user,
    workspaces: input.workspaces
      .filter((w) => w?.workspace?.id && typeof w.key === 'string' && w.key.startsWith('shogo_sk_'))
      .map((w) => ({
        id: w.workspace.id,
        name: w.workspace.name,
        slug: w.workspace.slug ?? null,
        kind: w.workspace.kind === 'personal' ? ('personal' as const) : ('team' as const),
        key: w.key,
      })),
    syncedAt: new Date().toISOString(),
  })
  reachable = true
}

export async function clearCloudWorkspaces(): Promise<void> {
  cache = { enabled: false, user: null, workspaces: [], syncedAt: null }
  reachable = true
  await localDb.localConfig.deleteMany({ where: { key: CONFIG_KEY } }).catch(() => {})
}

export function markCloudReachable(ok: boolean): void {
  reachable = ok
}

/**
 * Picks up keys for team workspaces joined since sign-in and drops the ones
 * the user left. Authenticates with the primary device key.
 */
export function syncCloudWorkspaces(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    const primary = process.env.SHOGO_API_KEY
    if (!primary) return
    const stored = await load()
    if (!stored.enabled) return
    try {
      const res = await fetch(`${getShogoCloudUrl()}/api/cli/device-keys/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${primary}` },
        body: JSON.stringify({ have: stored.workspaces.map((w) => w.id) }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        reachable = res.status < 500
        return
      }
      const data = (await res.json()) as {
        workspaces?: Array<{ workspace: { id: string; name: string; slug: string | null; kind?: string }; key?: string }>
      }
      const byId = new Map(stored.workspaces.map((w) => [w.id, w]))
      const next: CloudWorkspaceEntry[] = []
      for (const { workspace, key } of data.workspaces ?? []) {
        const resolved = key ?? byId.get(workspace.id)?.key
        const kind = workspace.kind === 'personal' ? 'personal' : 'team'
        if (resolved) next.push({ id: workspace.id, name: workspace.name, slug: workspace.slug ?? null, kind, key: resolved })
      }
      await save({ ...stored, workspaces: next, syncedAt: new Date().toISOString() })
      reachable = true
    } catch {
      reachable = false
    }
  })().finally(() => {
    inflight = null
  })
  return inflight
}

export function startCloudWorkspaceSync(): void {
  if (timer) return
  void syncCloudWorkspaces()
  timer = setInterval(() => void syncCloudWorkspaces(), SYNC_INTERVAL_MS)
  ;(timer as any).unref?.()
}

export function _resetCloudWorkspacesForTests(): void {
  cache = null
  reachable = true
  if (timer) clearInterval(timer)
  timer = null
}
