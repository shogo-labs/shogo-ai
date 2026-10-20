// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which scope a social operation belongs to.
 *
 * The cloud treats a workspace as one brand (`""`). A desktop also lets people
 * create *local-only* workspaces next to the cloud ones it is a client of, and
 * each of those is its own brand — so it relays with that workspace's id as its
 * scope and the cloud keeps one Zernio profile per scope. Without this, two
 * local workspaces resolve to the same profile and collide on the unique
 * `zernioProfileId` / `externalId` columns.
 *
 * A cloud workspace the desktop is merely a client of has no local scope: its
 * rows live in the cloud and the relay scopes it by the key alone.
 */

import { socialMode } from './client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isScopeId(value: string): boolean {
  return UUID.test(value)
}

/** `""` for the cloud scope, the local-only workspace id otherwise. */
export async function localScopeFor(workspaceId: string): Promise<string> {
  if (socialMode() === 'cloud') return ''
  try {
    const { cloudWorkspaceKey } = await import('../cloud-workspaces')
    return (await cloudWorkspaceKey(workspaceId)) ? '' : workspaceId
  } catch {
    // Cloud list unavailable: the workspace is still this machine's own, and
    // scoping it locally is what keeps two of them apart.
    return workspaceId
  }
}
