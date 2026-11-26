// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-590 §C, cloud side — the device key that hosts a workspace may read it.
 *
 * A paired desktop answers a hosted workspace's Analytics from the cloud (the
 * cloud is the meter), using its device key. Before this the api-key branch
 * refused every scope but the key's own workspace, so the read was a 403 and the
 * desktop showed nothing. The widening is the binding `machine-sync` ingest and
 * `resolveBillingWorkspaceId` already trust — the machine that hosts the
 * workspace, registered to that key's user in that key's workspace — and it is
 * still bounded by the user's own membership role there.
 *
 *   bun test apps/api/src/__tests__/hosted-workspace-device-key-access.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const KEY_WORKSPACE = 'ws-key-owner'
const HOSTED_WORKSPACE = 'ws-hosted'
const HOST_INSTANCE = 'inst-macbook'
const KEY_USER = 'user-owner'

let hostInstanceId: string | null = HOST_INSTANCE
let instance: { workspaceId: string; userId: string } | null = null
/** Workspace-scoped member rows, keyed `${workspaceId}:${userId}`. */
let members = new Set<string>()
let role = 'owner'

mock.module('../lib/prisma', () =>
  withPrismaExports({
    prisma: {
      workspace: {
        findUnique: async ({ where, select }: any) => {
          if (where.id !== HOSTED_WORKSPACE) return select?.hostInstanceId !== undefined ? null : null
          return select?.hostInstanceId !== undefined
            ? { id: HOSTED_WORKSPACE, hostInstanceId }
            : { id: HOSTED_WORKSPACE, parentWorkspaceId: null, hostInstanceId, kind: 'team', homeRegion: null }
        },
      },
      instance: {
        findUnique: async ({ where }: any) =>
          instance && where.id === HOST_INSTANCE ? instance : null,
      },
      member: {
        findFirst: async ({ where }: any) => {
          const { workspaceId, userId } = where
          if (typeof workspaceId === 'string' && typeof userId === 'string' && members.has(`${workspaceId}:${userId}`)) {
            return { id: `member-${workspaceId}-${userId}`, userId, role }
          }
          return null
        },
        findMany: async ({ where }: any) => {
          const userId = where?.userId
          const rows: any[] = []
          for (const key of members) {
            const [workspaceId, memberUserId] = key.split(':')
            if (memberUserId === userId) rows.push({ role, workspaceId, projectId: null, isBillingAdmin: false })
          }
          return rows
        },
      },
      user: { findUnique: async () => ({ role: 'user' }) },
      project: { findUnique: async () => null },
    },
  }),
)

const { loadAccess } = await import('../lib/authz')
const { _resetHostedUsageAttributionCache } = await import('../lib/hosted-usage-attribution')

const deviceKey = () => ({
  userId: KEY_USER,
  workspaceId: KEY_WORKSPACE,
  via: 'apiKey' as const,
  apiKeyKind: 'device',
})

beforeEach(() => {
  // The proof is memoised per key + hints (60s in production); a test that flips
  // the fixture must not read its predecessor's answer.
  _resetHostedUsageAttributionCache()
  hostInstanceId = HOST_INSTANCE
  instance = { workspaceId: KEY_WORKSPACE, userId: KEY_USER }
  members = new Set([`${KEY_WORKSPACE}:${KEY_USER}`, `${HOSTED_WORKSPACE}:${KEY_USER}`])
  role = 'owner'
})

const analyticsOnHosted = (principal: any) =>
  loadAccess(principal, { workspaceId: HOSTED_WORKSPACE })

describe('SHO-590 §C: a device key reads the workspace its machine hosts', () => {
  test('the hosting device key gets the user\'s role on the hosted workspace', async () => {
    const access = await analyticsOnHosted(deviceKey())
    expect(access.permissions.has('workspace.analytics:read')).toBe(true)
    expect(access.workspaceRole).toBe('owner')
  })

  test('the key\'s own workspace is unchanged', async () => {
    const access = await loadAccess(deviceKey(), { workspaceId: KEY_WORKSPACE })
    expect(access.permissions.has('workspace.analytics:read')).toBe(true)
  })

  test('the role on the hosted workspace is the role it has there, not the key\'s', async () => {
    role = 'member'
    members = new Set([`${KEY_WORKSPACE}:${KEY_USER}`, `${HOSTED_WORKSPACE}:${KEY_USER}`])
    const access = await analyticsOnHosted(deviceKey())
    expect(access.permissions.has('workspace.analytics:read')).toBe(false)
  })
})

describe('SHO-590 §C: everything the binding cannot prove is still refused', () => {
  test('a user key — a device key stands for a machine, a user key does not', async () => {
    const access = await analyticsOnHosted({ ...deviceKey(), apiKeyKind: 'user' })
    expect(access.permissions.size).toBe(0)
  })

  test('a workspace this machine does not host', async () => {
    hostInstanceId = null
    const access = await analyticsOnHosted(deviceKey())
    expect(access.permissions.size).toBe(0)
  })

  test('a workspace hosted by another workspace\'s machine', async () => {
    instance = { workspaceId: 'ws-someone-else', userId: KEY_USER }
    const access = await analyticsOnHosted(deviceKey())
    expect(access.permissions.size).toBe(0)
  })

  test('a workspace hosted by another user\'s machine', async () => {
    instance = { workspaceId: KEY_WORKSPACE, userId: 'user-other' }
    const access = await analyticsOnHosted(deviceKey())
    expect(access.permissions.size).toBe(0)
  })

  test('a workspace the key\'s user is not a member of', async () => {
    members = new Set([`${KEY_WORKSPACE}:${KEY_USER}`])
    const access = await analyticsOnHosted(deviceKey())
    expect(access.permissions.size).toBe(0)
  })

  test('a workspace that does not exist', async () => {
    const access = await loadAccess(deviceKey(), { workspaceId: 'ws-nope' })
    expect(access.permissions.size).toBe(0)
  })
})
