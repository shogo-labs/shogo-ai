// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Adapters for the generated CRUD hooks, which receive a `HookContext`
 * instead of a Hono context.
 */

import type { Permission } from '@shogo/authz'
import { loadAccess, type AccessCache, type AccessContext, type AccessScope, type Principal } from './access'
import { decide, denial } from './index'

export interface AuthzHookContext {
  userId?: string
  tunnelAuthenticated?: boolean
  auth?: Principal
}

export interface HookDenial {
  ok: false
  error: { code: string; message: string }
}

const caches = new WeakMap<object, AccessCache>()

export function hookPrincipal(ctx: AuthzHookContext): Principal {
  if (ctx.auth) return ctx.auth
  return {
    userId: ctx.userId,
    isAuthenticated: !!ctx.userId,
    tunnelAuthenticated: ctx.tunnelAuthenticated,
    via: ctx.tunnelAuthenticated ? 'tunnel' : 'session',
  }
}

export function hookAccess(ctx: AuthzHookContext, scope: AccessScope): Promise<AccessContext> {
  let cache = caches.get(ctx)
  if (!cache) {
    cache = new Map()
    caches.set(ctx, cache)
  }
  return loadAccess(hookPrincipal(ctx), scope, cache)
}

export async function hookCan(ctx: AuthzHookContext, permission: Permission, scope: AccessScope): Promise<boolean> {
  return (await hookAccess(ctx, scope)).permissions.has(permission)
}

function toHookDenial(d: { code: string; message: string }): HookDenial {
  return { ok: false, error: { code: d.code, message: d.message } }
}

/**
 * Strict check: returns a hook rejection when `permission` is missing,
 * otherwise null. Use where an existing role check is being replaced.
 */
export async function hookRequire(
  ctx: AuthzHookContext,
  permission: Permission,
  scope: AccessScope,
): Promise<HookDenial | null> {
  const access = await hookAccess(ctx, scope)
  if (access.permissions.has(permission)) return null
  return toHookDenial(denial(access, permission, hookPrincipal(ctx)))
}

/**
 * Mode-aware check (shadow/on): use where the rule is stricter than the
 * pre-RBAC behavior.
 */
export async function hookAuthorize(
  ctx: AuthzHookContext,
  permission: Permission,
  scope: AccessScope,
  where: string,
): Promise<HookDenial | null> {
  const access = await hookAccess(ctx, scope)
  const d = await decide(access, permission, hookPrincipal(ctx), where)
  return d.ok ? null : toHookDenial(d)
}
