// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One person, two ids: the machine owner's cloud account and their account on
 * the machine (SHO-185).
 *
 * A paired desktop's database knows its owner by a local user id; the cloud
 * knows them by their cloud account. The copy and the relay both serve the
 * desktop's rows as they are, so without a link the owner, opened from the
 * cloud, was a stranger in their own workspace: not a member of the DMs and
 * private channels they are in on the machine, their own messages authored by
 * "someone else", their unread counts and note-to-self missing.
 *
 * The link is `(machine, cloud owner) ↔ local user id`. The desktop announces
 * its side on every relayed reply (`LOCAL_USER_HEADER`, set by the desktop's
 * auth middleware); until it has, the cloud reads it off the copy — the user
 * rows that machine pushed, oldest first, which is the desktop's single local
 * user (`local-bootstrap`). Only the machine's owner is ever linked: both
 * relays admit nobody else, and the copy guard below checks it too.
 *
 * With it, a request for a machine workspace is served as the local user, and
 * the reply swaps the local id back to the cloud one — the same two-way swap
 * the desktop does as a client of a cloud workspace (`local-cloud-proxy`).
 */

import type { Context, Next } from 'hono'
import { prisma } from './prisma'
import {
  translate,
  translatePathAndSearch,
  translateResponseBody,
  type IdentityMap,
} from './identity-translate'
import { machineInstanceIdOf } from './machine-workspace'

/** Desktop → cloud, on a relayed reply: the user the desktop served it as. */
export const LOCAL_USER_HEADER = 'x-shogo-local-user-id'

/**
 * Client → cloud, on a read of a machine workspace's copy: the machine workspace
 * it is for. Kept in step with `MACHINE_WORKSPACE_HEADER` in shared-app's
 * `remote-http-interceptor`.
 */
export const MACHINE_WORKSPACE_HEADER = 'x-shogo-machine-workspace'

export interface MachineIdentity {
  /** The owner as the machine's database knows them. */
  localUserId: string
  /** cloud id → local id: requests going to the machine's rows. */
  toMachine: IdentityMap
  /** local id → cloud id: replies coming back to the cloud client. */
  toCloud: IdentityMap
}

export function machineIdentityOf(localUserId: string | null | undefined, cloudUserId: string): MachineIdentity | null {
  if (!localUserId || localUserId === cloudUserId) return null
  return {
    localUserId,
    toMachine: new Map([[cloudUserId, localUserId]]),
    toCloud: new Map([[localUserId, cloudUserId]]),
  }
}

const announced = new Map<string, string>()
const derived = new Map<string, { userId: string | null; at: number }>()
const DERIVED_TTL_MS = 5 * 60_000

/** What the desktop said its owner is, from a relayed reply. */
export function rememberMachineLocalUser(instanceId: string, localUserId: string | null | undefined): void {
  if (!instanceId || !localUserId) return
  announced.set(instanceId, localUserId)
}

export function _resetMachineIdentityForTests(): void {
  announced.clear()
  derived.clear()
}

/**
 * The owner's user id in this machine's own database, or null when the cloud
 * cannot tell yet (no relayed reply seen, no user rows copied).
 */
export async function machineLocalUserId(instanceId: string): Promise<string | null> {
  const said = announced.get(instanceId)
  if (said) return said
  const cached = derived.get(instanceId)
  if (cached && Date.now() - cached.at < DERIVED_TTL_MS) return cached.userId
  let userId: string | null = null
  try {
    const rows = await (prisma as any).machineMirrorRow.findMany({
      where: { instanceId, model: 'User' },
      select: { recordId: true },
    })
    const ids = rows.map((row: { recordId: string }) => row.recordId)
    if (ids.length) {
      const oldest = await prisma.user.findFirst({
        where: { id: { in: ids } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
      userId = oldest?.id ?? null
    }
  } catch {
    userId = null
  }
  derived.set(instanceId, { userId, at: Date.now() })
  return userId
}

/** The link for a machine and a caller, if the caller is that machine's owner. */
export async function machineIdentityForOwner(instanceId: string, cloudUserId: string): Promise<MachineIdentity | null> {
  const instance = await prisma.instance.findUnique({ where: { id: instanceId }, select: { userId: true } })
  if (!instance?.userId || instance.userId !== cloudUserId) return null
  return machineIdentityOf(await machineLocalUserId(instanceId), cloudUserId)
}

/** A JSON request body with the caller's cloud id swapped for the local one. */
export function translateJsonBody(text: string | undefined, map: IdentityMap): string | undefined {
  if (!text || map.size === 0) return text
  try {
    return JSON.stringify(translate(JSON.parse(text), map))
  } catch {
    return text
  }
}

/**
 * Middleware: serve a read of a machine workspace's copy as the machine's own
 * account for its owner, and answer in their cloud id.
 *
 * Keyed on `MACHINE_WORKSPACE_HEADER` — reads by resource id
 * (`/api/conversations/<id>/messages`) name no workspace — and verified here:
 * the named workspace must be a machine copy, of a machine the caller owns.
 * The local id it then acts as only exists in that machine's copy. Writes never
 * reach a copy (`machineWorkspaceWriteGuard`), so only reads are handled.
 */
export function machineCopyIdentity() {
  return async (c: Context, next: Next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next()
    const workspaceId = c.req.header(MACHINE_WORKSPACE_HEADER)
    if (!workspaceId) return next()
    const auth = c.get('auth') as { userId?: string; via?: string } | undefined
    if (!auth?.userId || auth.via === 'tunnel') return next()
    const instanceId = await machineInstanceIdOf(workspaceId)
    if (!instanceId) return next()
    const identity = await machineIdentityForOwner(instanceId, auth.userId)
    if (!identity) return next()

    c.set('auth', { ...auth, userId: identity.localUserId } as any)
    const url = new URL(c.req.url)
    const { search } = translatePathAndSearch('', url.search, identity.toMachine)
    if (search !== url.search) {
      c.req.raw = new Request(`${url.origin}${url.pathname}${search}`, c.req.raw)
    }

    await next()

    const res = c.res
    if (!res?.body) return
    const body = await translateResponseBody(res, identity.toCloud)
    const headers = new Headers(res.headers)
    headers.delete('content-length')
    c.res = new Response(body, { status: res.status, statusText: res.statusText, headers })
  }
}
