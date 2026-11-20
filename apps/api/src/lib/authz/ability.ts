// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The server-side ability gate (SHO-417).
 *
 * The runtime hides a tool the person may not use, but that only saves turns:
 * this is the check that actually refuses the call. Every internal route behind
 * a gated tool calls `enforceAbility` with the same permission the runtime's
 * `TOOL_ABILITIES` maps the tool to, so a hidden tool and a refused route can
 * never disagree.
 *
 * Everything goes through the RBAC mode, so it all runs in `shadow` first: a
 * shadow denial logs and writes an audit row, then lets the call through.
 *
 * `checkAbility` is the same decision without a Hono context, for services that
 * throw their own error type instead of returning a Response. Both go through
 * one implementation so a service can never accidentally bypass the mode.
 */

import type { Context } from 'hono'
import type { Permission } from '@shogo/authz'
import { getRbacMode } from './mode'
import { canUse, recordAccessEvent } from '../../services/access-policy.service'

export interface AbilityDenial {
  code: 'ability_not_allowed'
  permission: Permission
  message: string
}

/**
 * The decision, without a Response: `null` when the call may proceed
 * (including a shadow-mode denial, which is only recorded).
 *
 * `userId` is the person the call acts for — never the runtime's own identity.
 */
export async function checkAbility(
  workspaceId: string,
  userId: string | null | undefined,
  permission: Permission,
  detail: Record<string, unknown> = {},
): Promise<AbilityDenial | null> {
  if (!userId) return null
  if (await canUse(workspaceId, userId, permission)) return null

  const mode = await getRbacMode()
  await recordAccessEvent({
    workspaceId,
    kind: mode === 'on' ? 'denied' : 'shadow_denied',
    onBehalfOfUserId: userId,
    permission,
    detail: { ...detail, mode },
  })
  if (mode !== 'on') {
    console.warn('[rbac] shadow-deny ability', { workspaceId, userId, permission })
    return null
  }
  return {
    code: 'ability_not_allowed',
    permission,
    message: `Ask a workspace admin for ${permission}.`,
  }
}

/**
 * Refuse the request when `userId` lacks `permission`. Returns `null` when the
 * call may proceed (including a shadow-mode denial, which is only recorded).
 */
export async function enforceAbility(
  c: Context,
  workspaceId: string,
  userId: string | null | undefined,
  permission: Permission,
): Promise<Response | null> {
  const denial = await checkAbility(workspaceId, userId, permission, {
    route: `${c.req.method} ${c.req.path}`,
  })
  if (!denial) return null
  return c.json({ error: denial }, 403)
}
