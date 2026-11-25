// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SEC-28: `/channels/whatsapp/connect-link/instance` took any projectId, so an
 * API key for workspace A could bind a WhatsApp number into workspace B's
 * project. The binding check now runs when the link is issued and again when
 * the connection completes.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const projects: Record<string, { workspaceId: string }> = {
  'proj-a': { workspaceId: 'ws-a' },
  'proj-b': { workspaceId: 'ws-b' },
}
let canUpdate = true

mock.module('../lib/prisma', () => ({
  prisma: {
    project: { findUnique: async (args: any) => projects[args.where.id] ?? null },
  },
}))
mock.module('../lib/authz', () => ({
  loadAccess: async () => ({ permissions: new Set(canUpdate ? ['project:read', 'project:update'] : ['project:read']) }),
}))

const { whatsappBindingAllowed } = await import('../routes/channels-whatsapp')

beforeEach(() => { canUpdate = true })

describe('whatsappBindingAllowed', () => {
  test("a key for workspace A cannot bind into workspace B's project", async () => {
    expect(await whatsappBindingAllowed({ workspaceId: 'ws-a', projectId: 'proj-b', instanceId: null, userId: 'u-a' })).toBe(false)
    expect(await whatsappBindingAllowed({ workspaceId: 'ws-a', projectId: 'proj-b', instanceId: 'inst-a', userId: 'u-a' })).toBe(false)
  })

  test('its own project is allowed', async () => {
    expect(await whatsappBindingAllowed({ workspaceId: 'ws-a', projectId: 'proj-a', instanceId: null, userId: 'u-a' })).toBe(true)
  })

  test('a member who cannot edit the project is refused', async () => {
    canUpdate = false
    expect(await whatsappBindingAllowed({ workspaceId: 'ws-a', projectId: 'proj-a', instanceId: null, userId: 'u-viewer' })).toBe(false)
  })

  test("a desktop's local project (unknown here) binds only through its instance", async () => {
    expect(await whatsappBindingAllowed({ workspaceId: 'ws-a', projectId: 'local-proj', instanceId: 'inst-a', userId: 'u-a' })).toBe(true)
    expect(await whatsappBindingAllowed({ workspaceId: 'ws-a', projectId: 'local-proj', instanceId: null, userId: 'u-a' })).toBe(false)
  })

  test('completion re-checks the workspace from the signed state', async () => {
    expect(await whatsappBindingAllowed({ workspaceId: 'ws-a', projectId: 'proj-b', instanceId: null })).toBe(false)
    expect(await whatsappBindingAllowed({ workspaceId: 'ws-b', projectId: 'proj-b', instanceId: null })).toBe(true)
  })
})
