// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "RBAC world": a seeded workspace with one user per role, guests,
 * open and restricted projects, a second tenant, API keys and a runtime
 * token, plus `buildRbacApp()` which mounts the real middleware stack and
 * real routers. Only Better Auth's session lookup is stubbed: the
 * `x-test-user` header names the signed-in user.
 *
 * Call `setupChannelsTestDb()` before importing this module:
 *
 *   const { dir } = setupChannelsTestDb()
 *   const { buildRbacApp, seedRbacWorld } = await import('./helpers/rbac-world')
 */

import { mock } from 'bun:test'
import { Hono } from 'hono'

mock.module('../../auth', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user')
        if (!id) return null
        return { user: { id, email: `${id}@example.com`, name: id }, session: { id: `s-${id}` } }
      },
    },
    handler: () => new Response('not found', { status: 404 }),
  },
  parseCookieHeader: () => null,
}))

const { prisma } = await import('../../lib/prisma')
const { createApp } = await import('../../app/create-app')
const { createGeneratedRoutes } = await import('../../generated/routes')
const { rbacRoutes } = await import('../../routes/rbac')
const { inviteLinkRoutes } = await import('../../routes/invite-links')
const { inviteLinkAcceptRoutes } = await import('../../routes/invite-link-accept')
const { apiKeyRoutes } = await import('../../routes/api-keys')
const { generateApiKey } = await import('../../lib/api-keys-mint')
const { deriveRuntimeToken } = await import('../../lib/runtime-token')
const { _setRbacModeForTests } = await import('../../lib/authz')
const { attachProjectPermissions } = await import('../../lib/authz/project-permissions')

export const db = prisma as any
export { _setRbacModeForTests }

export type WorldUser =
  | 'owner'
  | 'admin'
  | 'billingAdmin'
  | 'member'
  | 'viewer'
  | 'outsider'
  | 'guestEditor'
  | 'guestViewer'
  | 'ownerB'
  | 'superAdmin'

export interface RbacWorld {
  workspaceA: string
  workspaceB: string
  users: Record<WorldUser, string>
  projects: { open: string; restricted: string; restricted2: string; foreign: string }
  /** API key per workspace-A role (owned by that user, scoped to workspace A). */
  keys: Record<'owner' | 'admin' | 'member' | 'viewer', string> & { ownerB: string }
  /** Runtime token for `projects.open`. */
  runtimeToken: string
}

export async function seedRbacWorld(): Promise<RbacWorld> {
  const suffix = crypto.randomUUID().slice(0, 8)
  const names: WorldUser[] = [
    'owner', 'admin', 'billingAdmin', 'member', 'viewer', 'outsider', 'guestEditor', 'guestViewer', 'ownerB', 'superAdmin',
  ]
  const users = {} as Record<WorldUser, string>
  for (const name of names) {
    const u = await db.user.create({
      data: {
        name,
        email: `${name.toLowerCase()}-${suffix}@example.com`,
        ...(name === 'superAdmin' ? { role: 'super_admin' } : {}),
      },
    })
    users[name] = u.id
  }

  const a = await db.workspace.create({ data: { name: 'Acme', slug: `acme-${suffix}`, kind: 'team' } })
  const b = await db.workspace.create({ data: { name: 'Beta', slug: `beta-${suffix}`, kind: 'team' } })
  const ws = (userId: string, workspaceId: string, role: string, extra: Record<string, unknown> = {}) =>
    db.member.create({ data: { userId, workspaceId, role, ...extra } })
  await ws(users.owner, a.id, 'owner')
  await ws(users.admin, a.id, 'admin')
  await ws(users.billingAdmin, a.id, 'member', { isBillingAdmin: true })
  await ws(users.member, a.id, 'member')
  await ws(users.viewer, a.id, 'viewer')
  await ws(users.outsider, b.id, 'member')
  await ws(users.ownerB, b.id, 'owner')

  const open = await db.project.create({ data: { name: 'Open', workspaceId: a.id, createdBy: users.owner } })
  const restricted = await db.project.create({
    data: { name: 'Restricted', workspaceId: a.id, createdBy: users.owner, visibility: 'restricted' },
  })
  const restricted2 = await db.project.create({
    data: { name: 'Restricted Two', workspaceId: a.id, createdBy: users.owner, visibility: 'restricted' },
  })
  const foreign = await db.project.create({ data: { name: 'Foreign', workspaceId: b.id, createdBy: users.ownerB } })

  const pm = (userId: string, projectId: string, role: string) =>
    db.member.create({ data: { userId, projectId, workspaceId: a.id, role } })
  await pm(users.member, restricted.id, 'admin')
  await pm(users.guestEditor, restricted.id, 'member')
  await pm(users.guestViewer, open.id, 'viewer')

  const mkKey = async (userId: string, workspaceId: string) => {
    const { fullKey, keyHash, keyPrefix } = await generateApiKey()
    await db.apiKey.create({ data: { name: 'test', keyHash, keyPrefix, workspaceId, userId, kind: 'user' } })
    return fullKey
  }
  const keys = {
    owner: await mkKey(users.owner, a.id),
    admin: await mkKey(users.admin, a.id),
    member: await mkKey(users.member, a.id),
    viewer: await mkKey(users.viewer, a.id),
    ownerB: await mkKey(users.ownerB, b.id),
  }

  return {
    workspaceA: a.id,
    workspaceB: b.id,
    users,
    projects: { open: open.id, restricted: restricted.id, restricted2: restricted2.id, foreign: foreign.id },
    keys,
    runtimeToken: deriveRuntimeToken(open.id),
  }
}

/** Marker body returned by the catch-all project probe (request passed `requireProjectAccess`). */
export const PROBE = 'rbac-probe'

export function buildRbacApp(): Hono {
  const app = createApp({ profile: 'cloud' })
  app.route('/api', rbacRoutes())
  app.route('/api', inviteLinkRoutes())
  app.route('/api', inviteLinkAcceptRoutes({ resolveUserId: (c) => (c.get('auth') as any)?.userId ?? null }))
  app.route('/api', apiKeyRoutes())
  app.use('/api/projects', attachProjectPermissions)
  app.use('/api/projects/:id', attachProjectPermissions)
  app.route('/api', createGeneratedRoutes({ prisma: prisma as any }))
  // Stand-in for every other `/api/projects/:projectId/*` handler: reaching it
  // means the real `requireProjectAccess` let the request through.
  app.all('/api/projects/:projectId/*', (c) => c.json({ ok: true, probe: PROBE }))
  return app
}

export type Caller =
  | { user: string }
  | { apiKey: string }
  | { runtimeToken: string }
  | { tunnelUser: string }
  | null

export function callerHeaders(caller: Caller): Record<string, string> {
  if (!caller) return {}
  if ('user' in caller) return { 'x-test-user': caller.user }
  if ('apiKey' in caller) return { authorization: `Bearer ${caller.apiKey}` }
  if ('runtimeToken' in caller) return { 'x-runtime-token': caller.runtimeToken }
  return { 'x-tunnel-auth-user-id': caller.tunnelUser }
}

export async function call(
  app: Hono,
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method,
    headers: {
      ...callerHeaders(caller),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: res.status, body: parsed }
}
