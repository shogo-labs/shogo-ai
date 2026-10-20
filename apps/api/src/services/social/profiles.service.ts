// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Zernio profile ↔ workspace *scope*.
 *
 * A workspace is one brand, so it owns one profile for the cloud scope
 * (`localWorkspaceId = ""`). A desktop's local-only workspaces each own their
 * own profile too — they connect through the same cloud Zernio account, and
 * without a scope every one of them would resolve to the same profile and
 * collide on the unique columns.
 *
 * `externalId` is derived and stable, never random and never re-derived on
 * rename: it is the only key Zernio echoes back on a webhook, so the webhook
 * route resolves `externalId → (workspaceId, localWorkspaceId)` without a
 * second lookup table.
 */

import { prisma } from '../../lib/prisma'
import { SocialError, getSocialClient } from './client'
import { isScopeId, localScopeFor } from './local-scope'

const db = prisma as any

export interface SocialProfileRow {
  id: string
  workspaceId: string
  /** `""` for the cloud scope, the local workspace id for a desktop scope. */
  localWorkspaceId: string
  zernioProfileId: string
  externalId: string
  name: string
}

/** `ws_<workspaceId>` for the cloud scope, `lws_<localWorkspaceId>` for a desktop scope. */
export function externalIdFor(workspaceId: string, localWorkspaceId = ''): string {
  return localWorkspaceId ? `lws_${localWorkspaceId}` : `ws_${workspaceId}`
}

/** A local scope must be a workspace id; anything else is a caller bug, not a lookup. */
export function isLocalScopeId(value: string): boolean {
  return isScopeId(value)
}

/** Zernio may answer `{ id }` or wrap profiles in a list; read either shape. */
export function pickProfileId(payload: any): string | null {
  const candidate = payload?.id ?? payload?.profileId ?? payload?.profile?.id
  return typeof candidate === 'string' && candidate ? candidate : null
}

export function profileFromList(payload: any, externalId: string): any | null {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.profiles)
      ? payload.profiles
      : Array.isArray(payload?.data)
        ? payload.data
        : []
  return list.find((p: any) => p && p.externalId === externalId) ?? list[0] ?? null
}

export async function getProfile(
  workspaceId: string,
  localWorkspaceId = '',
): Promise<SocialProfileRow | null> {
  return db.socialProfile.findUnique({
    where: { workspaceId_localWorkspaceId: { workspaceId, localWorkspaceId } },
  })
}

/** Every scope of a workspace: the cloud one plus each desktop local workspace. */
export async function listProfilesForWorkspace(workspaceId: string): Promise<SocialProfileRow[]> {
  return db.socialProfile.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })
}

export async function getProfileByExternalId(externalId: string): Promise<SocialProfileRow | null> {
  return db.socialProfile.findUnique({ where: { externalId } })
}

/**
 * Return the scope's profile, creating the Zernio side on first use.
 * Idempotent: a concurrent create loses the race on the scope pair and then
 * re-reads, and an existing Zernio profile (same `externalId`) is adopted
 * rather than duplicated.
 *
 * The scope defaults to the one this process is acting for: `""` in the cloud,
 * or the local workspace id on a desktop. Through the relay the cloud also
 * forces `externalId` onto the scope it resolved from the header, so the
 * provider's echo is trusted over ours.
 */
export async function ensureProfile(
  workspaceId: string,
  workspaceName: string,
  localWorkspaceId?: string,
): Promise<SocialProfileRow> {
  const scope = localWorkspaceId ?? (await localScopeFor(workspaceId))
  const existing = await getProfile(workspaceId, scope)
  if (existing) return existing

  const routingId = externalIdFor(workspaceId, scope)
  const client = getSocialClient()
  let zernioProfileId: string | null = null
  let externalId = routingId
  try {
    const created = await client.request<any>({
      workspaceId,
      method: 'POST',
      path: '/profiles',
      body: { name: workspaceName, externalId: routingId },
      idempotencyKey: `social-profile-${routingId}`,
    })
    zernioProfileId = pickProfileId(created)
    if (typeof created?.externalId === 'string' && created.externalId) externalId = created.externalId
  } catch (err) {
    if (!(err instanceof SocialError) || (err.status !== 409 && err.status !== 422)) throw err
  }

  if (!zernioProfileId) {
    const found = await client.request<any>({
      workspaceId,
      method: 'GET',
      path: '/profiles',
      query: { externalId: routingId },
    })
    const profile = profileFromList(found, routingId)
    zernioProfileId = profile?.id ?? profile?.profileId ?? null
    if (typeof profile?.externalId === 'string' && profile.externalId) externalId = profile.externalId
  }

  if (!zernioProfileId) {
    throw new SocialError(502, 'social_profile_unresolved', 'Zernio did not return a profile id.')
  }

  try {
    return await db.socialProfile.create({
      data: { workspaceId, localWorkspaceId: scope, zernioProfileId, externalId, name: workspaceName },
    })
  } catch (err: any) {
    if (err?.code === 'P2002') {
      const raced = await getProfile(workspaceId, scope)
      if (raced) return raced
    }
    throw err
  }
}

/**
 * Record which Zernio profile a scope owns. The cloud relay calls this when it
 * forces a desktop's `POST /profiles`, so the cloud always has the row its
 * webhook routing and per-account metering resolve against.
 */
export async function recordProfileMapping(args: {
  workspaceId: string
  localWorkspaceId?: string
  zernioProfileId: string
  /** The routing id the provider echoed; defaults to the scope's derived value. */
  externalId?: string
}): Promise<SocialProfileRow> {
  const localWorkspaceId = args.localWorkspaceId ?? ''
  const externalId = args.externalId || externalIdFor(args.workspaceId, localWorkspaceId)
  const name = await workspaceName(args.workspaceId)
  return db.socialProfile.upsert({
    where: { workspaceId_localWorkspaceId: { workspaceId: args.workspaceId, localWorkspaceId } },
    create: {
      workspaceId: args.workspaceId,
      localWorkspaceId,
      zernioProfileId: args.zernioProfileId,
      externalId,
      name,
    },
    update: { zernioProfileId: args.zernioProfileId, externalId, name },
  })
}

/** Keep every scope's Zernio profile name in step with the workspace name. */
export async function renameProfile(workspaceId: string, name: string): Promise<void> {
  const profiles = await listProfilesForWorkspace(workspaceId)
  if (profiles.length === 0) return
  const client = getSocialClient()
  for (const profile of profiles) {
    await client.request({
      workspaceId,
      method: 'PATCH',
      path: `/profiles/${encodeURIComponent(profile.zernioProfileId)}`,
      body: { name },
    })
  }
  await db.socialProfile.updateMany({ where: { workspaceId }, data: { name } })
}

/** The rename source of truth for the Zernio profile's display name. */
export async function workspaceName(workspaceId: string): Promise<string> {
  const row = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })
  return (row?.name as string | undefined)?.trim() || 'Shogo workspace'
}

/**
 * Delete every Zernio profile of the workspace with the workspace itself.
 * Zernio bills per connected account, so an orphaned profile is a permanent
 * charge — this must run before the workspace row (and its cascade) disappears.
 * The local rows are deleted either way; `error` reports the first provider
 * failure so the wipe can surface it.
 */
export async function deleteProfileForWorkspace(
  workspaceId: string,
): Promise<{ deleted: boolean; error?: string }> {
  const profiles = await listProfilesForWorkspace(workspaceId)
  if (profiles.length === 0) return { deleted: false }

  let error: string | undefined
  for (const profile of profiles) {
    try {
      await getSocialClient().request({
        workspaceId,
        method: 'DELETE',
        path: `/profiles/${encodeURIComponent(profile.zernioProfileId)}`,
      })
    } catch (err) {
      error ??= err instanceof SocialError ? `${err.code}: ${err.message}` : String(err)
    }
  }

  await db.socialProfile.deleteMany({ where: { workspaceId } }).catch(() => {})
  return { deleted: true, error }
}
