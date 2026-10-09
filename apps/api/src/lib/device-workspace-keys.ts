// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One device key per cloud workspace the desktop opens (the user's team
 * workspaces and their own Personal one), so a signed-in desktop can act as
 * a client of each (keys stay workspace-scoped; see `authorizeProject` in
 * middleware/auth.ts).
 */

import type { PrismaClient } from '@prisma/client'
import { mintDeviceApiKey } from './api-keys-mint'

export interface DeviceWorkspaceKey {
  workspace: { id: string; name: string; slug: string | null; kind: 'personal' | 'team' }
  /** Present only when a key was minted by this call. */
  key?: string
}

export interface DeviceInfo {
  deviceId: string
  deviceName?: string
  devicePlatform?: string
  deviceAppVersion?: string
  defaultDeviceName?: string
}

async function memberships(prisma: PrismaClient, userId: string) {
  const members = await (prisma as any).member.findMany({
    where: { userId, workspaceId: { not: null }, projectId: null },
    select: { workspace: { select: { id: true, name: true, slug: true, kind: true } } },
    orderBy: { createdAt: 'asc' },
  })
  const all = new Set<string>()
  const opened: DeviceWorkspaceKey['workspace'][] = []
  for (const m of members) {
    if (!m.workspace || all.has(m.workspace.id)) continue
    all.add(m.workspace.id)
    const kind = m.workspace.kind === 'personal' ? 'personal' : 'team'
    opened.push({ id: m.workspace.id, name: m.workspace.name, slug: m.workspace.slug ?? null, kind })
  }
  return { all, opened }
}

/**
 * Mints device keys for the user's workspaces the device doesn't hold yet
 * (`have`), and revokes this device's keys for workspaces the user is no
 * longer a member of. Returns every current workspace, with `key` on the
 * new ones.
 */
export async function syncDeviceWorkspaceKeys(args: {
  prisma: PrismaClient
  userId: string
  device: DeviceInfo
  have?: string[]
  /** The caller's own key: handed back for its workspace instead of minting (which would revoke it). */
  callerKey?: { workspaceId: string; key: string }
}): Promise<{ workspaces: DeviceWorkspaceKey[]; removed: string[] }> {
  const { prisma, userId, device } = args
  const have = new Set(args.have ?? [])
  const { all: memberOf, opened: current } = await memberships(prisma, userId)
  const currentIds = new Set(current.map((w) => w.id))

  const held = await (prisma as any).apiKey.findMany({
    where: { userId, deviceId: device.deviceId, kind: 'device', revokedAt: null },
    select: { id: true, workspaceId: true },
  })
  const heldIds = new Set<string>(held.map((k: any) => k.workspaceId))
  // Only workspaces the user left: the primary key may be for a personal one.
  const stale = held.filter((k: any) => !memberOf.has(k.workspaceId))
  if (stale.length) {
    await (prisma as any).apiKey.updateMany({
      where: { id: { in: stale.map((k: any) => k.id) } },
      data: { revokedAt: new Date() },
    })
  }

  const workspaces: DeviceWorkspaceKey[] = []
  for (const workspace of current) {
    if (args.callerKey?.workspaceId === workspace.id) {
      workspaces.push({ workspace, key: args.callerKey.key })
      continue
    }
    if (have.has(workspace.id) && heldIds.has(workspace.id)) {
      workspaces.push({ workspace })
      continue
    }
    const { fullKey } = await mintDeviceApiKey({ prisma, workspaceId: workspace.id, userId, ...device })
    workspaces.push({ workspace, key: fullKey })
  }
  const removed = [...new Set<string>(stale.map((k: any) => k.workspaceId))]
  for (const id of have) if (!memberOf.has(id) && !removed.includes(id)) removed.push(id)
  return { workspaces, removed }
}
